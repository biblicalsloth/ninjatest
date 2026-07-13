import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, buildQuestionPrompt, type AiConfig } from "@/lib/ai/model";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = await rateLimitDb(supabase, user.id, "ninja-ask-user", { limit: 15, windowSeconds: 60 });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-ask-ip", { limit: 30, windowSeconds: 60 });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  const matchId = typeof body?.match_id === "string" ? body.match_id : "";
  const index = Number.isInteger(body?.question_index) ? body.question_index : -1;
  if (!matchId || index < 0 || index > 8) {
    return NextResponse.json({ error: "Missing match_id or question_index" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  // Ownership + reach guard lives in the RPC (raises 'forbidden' for non-participants).
  const { data: rows, error: qErr } = await sb.rpc("get_question_for_ninja", { p_match_id: matchId, p_index: index });
  const q = Array.isArray(rows) ? rows[0] : null;
  if (qErr || !q) {
    return NextResponse.json({ error: "Not allowed for this question" }, { status: 403 });
  }

  const prompt = buildQuestionPrompt({
    section: q.section, body: q.body,
    options: Array.isArray(q.options) ? q.options : [],
    correct_index: q.correct_index, explanation: q.explanation, passage_body: q.passage_body,
  });

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let text = "";
  let usedModel = "";
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(config.provider, modelId),
        system: config.system_prompt,
        prompt,
        temperature: config.temperature,
        maxOutputTokens: config.max_tokens,
      });
      text = res.text.trim();
      usedModel = modelId;
      break;
    } catch (e) {
      lastErr = e; // try fallback
    }
  }
  if (!text) {
    console.error("Ninja generate failed:", lastErr);
    return NextResponse.json({ error: "Ninja could not answer right now" }, { status: 502 });
  }

  // Server-side save (definer RPC) — client never asserts authorship.
  const { data: savedId } = await sb.rpc("save_ninja_response", {
    p_match_id: matchId, p_index: index, p_model: usedModel, p_content: text,
  });

  return NextResponse.json({ id: savedId ?? null, content: text, model_id: usedModel });
}
