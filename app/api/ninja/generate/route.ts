import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, type AiConfig } from "@/lib/ai/model";
import { parseJson, type GroupInput, type SectionCode } from "@/app/admin/parse";

// AI question drafting for the admin console. The model returns the SAME
// group-array JSON the file uploader takes; parseJson validates it, the admin
// reviews the preview, and inserts go through admin_upsert_questions — the AI
// path adds no new write surface. Human review is the gate: nothing lands in
// the bank without the admin clicking upload.

const GEN_SYSTEM = `You are an expert CAT (Common Admission Test, India) question setter.
You write original, unambiguous, exam-grade multiple-choice questions.
Rules:
- Exactly ONE defensible correct answer per question; distractors must be plausible but clearly wrong on careful analysis.
- Every question gets exactly 4 options and a concise "explanation" that justifies the correct answer AND why the closest distractor fails.
- Difficulty is 1 (easy) to 5 (very hard); match the requested level.
- QUANT questions must be self-contained and numerically verified — recompute the answer before writing correct_index.
- DILR sets: put the full data description (table/arrangement/conditions) in the "passage" field as plain text; questions must be answerable from it alone.
- VARC passages: 350-550 words, original prose (no copyrighted text), CAT-style inference/tone/main-idea questions.
Output ONLY a JSON array (no markdown fences, no commentary) in this exact shape:
[{"section":"VARC","passage":"...or null","questions":[{"body":"...","options":["...","...","...","..."],"correct_index":0,"difficulty":3,"explanation":"..."}]}]
For standalone questions use "passage": null and one group per question or one group with several questions — either is accepted.`;

const SECTION_GUIDE: Record<SectionCode, string> = {
  VARC: "Verbal Ability & Reading Comprehension — reading comprehension, inference, tone, main idea, strengthening/weakening, vocabulary in context.",
  DILR: "Data Interpretation & Logical Reasoning — data tables, arrangements, scheduling, games, caselets. Describe all data fully in text.",
  QUANT: "Quantitative Ability — arithmetic, algebra, geometry, number systems, modern math. Show no working in the body; keep it exam-style.",
};

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON array");
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

  const rl = await rateLimitDb(supabase, user.id, "ninja-generate-user", { limit: 6, windowSeconds: 60, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-generate-ip", { limit: 12, windowSeconds: 60, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  const section = String(body?.section ?? "").toUpperCase() as SectionCode;
  if (!["VARC", "DILR", "QUANT"].includes(section)) {
    return NextResponse.json({ error: "section must be VARC|DILR|QUANT" }, { status: 400 });
  }
  const kind = body?.kind === "passage" && section !== "QUANT" ? "passage" : "standalone";
  const count = Math.min(Math.max(Number(body?.count) || 3, 1), 10);
  const difficulty = Math.min(Math.max(Number(body?.difficulty) || 3, 1), 5);
  const topic = typeof body?.topic === "string" ? body.topic.slice(0, 200).trim() : "";

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const prompt = [
    `Section: ${section} (${SECTION_GUIDE[section]})`,
    kind === "passage"
      ? `Write ONE ${section === "VARC" ? "reading passage" : "DILR data set"} with exactly ${count} questions on it (one group, "passage" filled).`
      : `Write exactly ${count} standalone questions ("passage": null).`,
    `Difficulty: ${difficulty}/5 for every question. Set "difficulty": ${difficulty}.`,
    topic ? `Topic focus: ${topic}` : "",
    `Section field of every group must be "${section}".`,
  ].filter(Boolean).join("\n");

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(config.provider, modelId),
        system: GEN_SYSTEM,
        prompt,
        temperature: config.temperature,
        // Generation needs headroom a solve-tuned max_tokens doesn't give.
        maxOutputTokens: Math.max(config.max_tokens, 6000),
      });
      const groups: GroupInput[] = parseJson(extractJsonArray(res.text));
      if (groups.length === 0) throw new Error("empty result");
      // The model occasionally mislabels sections — the request is authoritative.
      for (const g of groups) g.section = section;
      return NextResponse.json({ groups, model_id: modelId });
    } catch (e) {
      lastErr = e; // malformed JSON or provider error → try fallback model
    }
  }
  console.error("Ninja generate-questions failed:", lastErr);
  return NextResponse.json({ error: "Generation failed — try again" }, { status: 502 });
}
