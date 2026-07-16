import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, type AiConfig } from "@/lib/ai/model";

// AI distractor improvement for an existing bank question. The admin client
// sends the question content it already holds (from admin_list_questions);
// the proposal goes back for review and is applied via the narrow
// admin_update_question_options RPC, which re-validates everything.

const DISTRACTOR_SYSTEM = `You improve the answer options of CAT (Common Admission Test) multiple-choice questions.
Given a question and its correct answer, produce a 4-option set where:
- The correct answer text is preserved EXACTLY as one option (minor formatting cleanup allowed).
- The 3 distractors each encode a specific, plausible mistake (sign error, off-by-one step, misread condition, tempting misinference) — no throwaway options.
- No two options are equivalent; exactly one is defensible.
Output ONLY a JSON object (no fences):
{"options":["...","...","...","..."],"correct_index":0,"explanation":"why correct is correct and what mistake each distractor represents","rationale":"one line on what was weak about the old options"}`;

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
  return text.slice(start, end + 1);
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!prof?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rl = await rateLimitDb(supabase, user.id, "ninja-distractor-user", { limit: 10, windowSeconds: 60, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-distractor-ip", { limit: 20, windowSeconds: 60, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  const qBody = typeof body?.body === "string" ? body.body.slice(0, 8000) : "";
  const options = Array.isArray(body?.options) ? body.options.map(String).slice(0, 8) : [];
  const correctIndex = Number.isInteger(body?.correct_index) ? body.correct_index : -1;
  const explanation = typeof body?.explanation === "string" ? body.explanation.slice(0, 4000) : "";
  const passage = typeof body?.passage_body === "string" ? body.passage_body.slice(0, 20000) : "";
  const section = typeof body?.section === "string" ? body.section : "";
  if (!qBody || options.length < 2 || correctIndex < 0 || correctIndex >= options.length) {
    return NextResponse.json({ error: "Missing question fields" }, { status: 400 });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const prompt = [
    section ? `Section: ${section}` : "",
    passage ? `Passage/context:\n${passage}` : "",
    `Question:\n${qBody}`,
    `Current options:\n${options.map((o: string, i: number) => `${i}. ${o}`).join("\n")}`,
    `Correct answer (index ${correctIndex}): ${options[correctIndex]}`,
    explanation ? `Current explanation: ${explanation}` : "",
    "Propose the improved 4-option set.",
  ].filter(Boolean).join("\n\n");

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(modelId),
        system: DISTRACTOR_SYSTEM,
        prompt,
        temperature: config.temperature,
        maxOutputTokens: Math.max(config.max_tokens, 2000),
      });
      const parsed = JSON.parse(extractJsonObject(res.text));
      const newOpts = Array.isArray(parsed.options) ? parsed.options.map(String) : [];
      const ci = Number(parsed.correct_index);
      if (newOpts.length !== 4 || !Number.isInteger(ci) || ci < 0 || ci > 3 || newOpts.some((o: string) => !o.trim())) {
        throw new Error("bad proposal shape");
      }
      return NextResponse.json({
        options: newOpts,
        correct_index: ci,
        explanation: typeof parsed.explanation === "string" ? parsed.explanation.slice(0, 4000) : null,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 1000) : null,
        model_id: modelId,
      });
    } catch (e) {
      lastErr = e;
    }
  }
  console.error("Ninja distractors failed:", lastErr);
  return NextResponse.json({ error: "Generation failed — try again" }, { status: 502 });
}
