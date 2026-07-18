import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { type AiConfig } from "@/lib/ai/model";
import { runCoach, SOCRATIC_SYSTEM } from "@/lib/ai/coach";
import { inLiveMatch, LIVE_MATCH_ERROR } from "@/lib/ai/live-match";

// Ninja Coach: freeform "how am I doing / what should I work on" Q&A. The model
// autonomously pulls the caller's own stats (tools bound to their username
// server-side — it can't read anyone else) and answers grounded in real numbers.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (await inLiveMatch(supabase, user.id)) {
    return NextResponse.json({ error: LIVE_MATCH_ERROR }, { status: 403 });
  }

  // Metered LLM: fail-closed so a limiter blip can't become an unmetered-spend hole.
  const rl = await rateLimitDb(supabase, user.id, "ninja-coach-user", { limit: 10, windowSeconds: 3600, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-coach-ip", { limit: 20, windowSeconds: 3600, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "You've reached the coaching limit for now. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  // mode 'plan' is gone: the weekly plan is /api/ninja/plan, which caches per
  // week and returns JSON the calendar can render. Nothing here special-cases it.
  const isSocratic = body?.mode === "socratic";
  const system = isSocratic ? SOCRATIC_SYSTEM : undefined;
  const matchId = typeof body?.match_id === "string" ? body.match_id : null;
  // Chat page threads by conversation_id (UUID the client mints per chat).
  const conversationId = typeof body?.conversation_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.conversation_id)
    ? body.conversation_id : null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 2000) {
    return NextResponse.json({ error: "Ask a question (up to 2000 characters)." }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  // Resolve the caller's own username; all coach tools are bound to it server-side.
  const { data: prof } = await sb.from("profiles").select("username").eq("id", user.id).single();
  const username = prof?.username as string | undefined;
  if (!username) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  // Conversational memory: the last few turns of THIS thread (match bucket or
  // general).
  let priorTurns: { question: string; answer: string }[] = [];
  if (conversationId) {
    // Chat thread memory: last 8 turns of this conversation.
    const { data } = await sb.rpc("get_coach_conversation", { p_conversation_id: conversationId });
    priorTurns = ((data ?? []) as { question: string; answer: string }[])
      .slice(-8).map((t) => ({ question: t.question, answer: t.answer }));
  } else {
    const { data: turns } = await sb.rpc("get_recent_coach_turns", { p_match_id: matchId, p_limit: 8 });
    priorTurns = ((turns ?? []) as { question: string; answer: string }[])
      .map((t) => ({ question: t.question, answer: t.answer }));
  }

  try {
    const { text, model } = await runCoach(sb, username, question, config, system, priorTurns);
    // Persist the turn (best-effort — a save blip must not fail the answer).
    await sb.rpc("save_ninja_coach_turn", {
      p_match_id: matchId, p_question: question, p_answer: text, p_model: model,
      p_conversation_id: conversationId,
    }).then(({ error }: { error: unknown }) => { if (error) console.error("save coach turn:", error); });
    return NextResponse.json({ content: text, model_id: model });
  } catch (e) {
    console.error("Ninja coach failed:", e);
    return NextResponse.json({ error: "Ninja could not answer right now" }, { status: 502 });
  }
}
