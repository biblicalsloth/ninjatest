import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { type AiConfig } from "@/lib/ai/model";
import { runCoach } from "@/lib/ai/coach";

// Ninja Coach: freeform "how am I doing / what should I work on" Q&A. The model
// autonomously pulls the caller's own stats (tools bound to their username
// server-side — it can't read anyone else) and answers grounded in real numbers.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Metered LLM: fail-closed so a limiter blip can't become an unmetered-spend hole.
  const rl = await rateLimitDb(supabase, user.id, "ninja-coach-user", { limit: 10, windowSeconds: 3600, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-coach-ip", { limit: 20, windowSeconds: 3600, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "You've reached the coaching limit for now. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
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

  try {
    const { text, model } = await runCoach(sb, username, question, config);
    return NextResponse.json({ content: text, model_id: model });
  } catch (e) {
    console.error("Ninja coach failed:", e);
    return NextResponse.json({ error: "Ninja could not answer right now" }, { status: 502 });
  }
}
