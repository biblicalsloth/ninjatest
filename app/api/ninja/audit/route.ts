import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, type AiConfig } from "@/lib/ai/model";

// AI quality audit over a small batch of bank questions (admin-only). The
// client sends question content it already holds; the model re-solves each and
// reports key/ambiguity problems. Verdicts are session-only — the admin acts
// on them via the existing active toggles.

const AUDIT_SYSTEM = `You are a CAT (Common Admission Test) question-bank quality auditor.
For EACH question given, independently solve it from scratch, then check:
1. KEY: does your independently-derived answer match the marked correct_index?
2. AMBIGUITY: is more than one option defensible, or no option correct?
3. CLARITY: missing data, contradictory conditions, or unanswerable from the given text?
Be strict but not pedantic — flag real defects, not stylistic taste.
Output ONLY a JSON array, one object per question, same order as given:
[{"id":"<echoed id>","verdict":"ok"|"suspect","issues":"empty string if ok, else one concise sentence naming the defect and the option you believe is correct"}]`;

type AuditItem = {
  id: string;
  section: string;
  body: string;
  options: string[];
  correct_index: number;
  passage_body: string | null;
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

  const rl = await rateLimitDb(supabase, user.id, "ninja-audit-user", { limit: 10, windowSeconds: 60, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-audit-ip", { limit: 20, windowSeconds: 60, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  const raw = Array.isArray(body?.questions) ? body.questions.slice(0, 5) : [];
  const items: AuditItem[] = raw
    .map((q: Record<string, unknown>) => ({
      id: String(q?.id ?? ""),
      section: String(q?.section ?? ""),
      body: String(q?.body ?? "").slice(0, 8000),
      options: Array.isArray(q?.options) ? (q.options as unknown[]).map(String).slice(0, 8) : [],
      correct_index: Number.isInteger(q?.correct_index) ? (q.correct_index as number) : -1,
      passage_body: typeof q?.passage_body === "string" ? q.passage_body.slice(0, 20000) : null,
    }))
    .filter((q: AuditItem) => q.id && q.body && q.options.length >= 2
      && q.correct_index >= 0 && q.correct_index < q.options.length);
  if (items.length === 0) {
    return NextResponse.json({ error: "No auditable questions in payload (max 5 per call)" }, { status: 400 });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const prompt = items.map((q, i) => [
    `--- Question ${i + 1} (id: ${q.id}, section: ${q.section}) ---`,
    q.passage_body ? `Passage/context:\n${q.passage_body}` : "",
    `Body:\n${q.body}`,
    `Options:\n${q.options.map((o, oi) => `${oi}. ${o}`).join("\n")}`,
    `Marked correct_index: ${q.correct_index}`,
  ].filter(Boolean).join("\n")).join("\n\n");

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(config.provider, modelId),
        system: AUDIT_SYSTEM,
        prompt,
        temperature: 0, // auditing wants determinism, not the solve-tuned dial
        maxOutputTokens: Math.max(config.max_tokens, 4000),
      });
      const parsed = JSON.parse(extractJsonArray(res.text));
      if (!Array.isArray(parsed)) throw new Error("bad verdict shape");
      const validIds = new Set(items.map((q) => q.id));
      const verdicts = parsed
        .filter((v: Record<string, unknown>) => validIds.has(String(v?.id)))
        .map((v: Record<string, unknown>) => ({
          id: String(v.id),
          verdict: v.verdict === "suspect" ? "suspect" : "ok",
          issues: typeof v.issues === "string" ? v.issues.slice(0, 1000) : "",
        }));
      if (verdicts.length === 0) throw new Error("no verdicts matched sent ids");
      return NextResponse.json({ verdicts, model_id: modelId });
    } catch (e) {
      lastErr = e;
    }
  }
  console.error("Ninja audit failed:", lastErr);
  return NextResponse.json({ error: "Audit failed — try again" }, { status: 502 });
}
