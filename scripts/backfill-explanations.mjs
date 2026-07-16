// Backfill `questions.explanation` with AI-generated step-by-step solutions.
//
// The bank was ingested from PDFs that carry answer keys but no worked solutions,
// so ~588 questions (535 of them ACTIVE) render a blank reveal screen. This fills
// them in offline; the reveal UI already renders whatever is in the column.
//
// SELF-CHECK (the whole point): the model never sees the answer key. It solves each
// question from scratch and returns the answer it derived. We compare that to the
// stored key ourselves:
//   agree    -> write the explanation
//   disagree -> write NOTHING, report the question for admin review
// A disagreement means the key is wrong, the question is broken, or the model is —
// all three are reasons not to ship a confident explanation that contradicts the
// scored answer. Re-runs are safe: the query only picks up rows still missing one.
//
// Usage:
//   node --env-file=.env.local scripts/backfill-explanations.mjs --dry-run --limit 5
//   node --env-file=.env.local scripts/backfill-explanations.mjs --section QUANT
//   node scripts/backfill-explanations.mjs --self-test     # no network, no env needed
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (bypasses `questions`
// RLS `using(false)`), OPENROUTER_API_KEY.
//
// Flags: --section VARC|DILR|QUANT  --limit N  --concurrency N (default 4)
//        --dry-run (solve + compare, write nothing)  --out <path> (review report)

import { writeFileSync } from "node:fs";
import { loadEnvLocal } from "./env.mjs";
import { createClient } from "@supabase/supabase-js";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const EXPLANATION_MAX = 4000; // matches the cap admin_upsert_questions validates

const SYSTEM = `You are a CAT (Common Admission Test) tutor writing the worked solution shown to a student the moment after they answer.

Solve the question from scratch. You are NOT told the correct answer — derive it.

Write the solution as numbered steps, one per line:
1. <the first move, and why it is the move>
2. <next step>
...
Close with a final line naming the answer.

Rules:
- Show the actual arithmetic/reasoning, not a restatement of the question.
- Name the technique or trap where a student would plausibly go wrong.
- Be concise: a student reads this in ~15 seconds under time pressure. Aim under 900 characters.
- Plain text only. No markdown, no LaTeX, no fences.

Output ONLY a JSON object (no fences):
{"steps":"1. ...\\n2. ...\\nAnswer: ...","answer_index":<0-based index of the option you derived, MCQ only>,"answer_value":"<your derived numeric answer, TITA only>","confident":true|false}
Set confident=false if the question is missing data, ambiguous, or you could not solve it.`;

function parseArgs(argv) {
  const a = { concurrency: 4, dryRun: false, selfTest: false, out: null, section: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dry-run") a.dryRun = true;
    else if (v === "--self-test") a.selfTest = true;
    else if (v === "--section") a.section = argv[++i];
    else if (v === "--limit") a.limit = Number(argv[++i]);
    else if (v === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (v === "--out") a.out = argv[++i];
  }
  return a;
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
  return text.slice(start, end + 1);
}

// TITA keys in the bank are plain integers, but models emit "Rs. 4,000" / "48.0".
// Strip formatting, compare numerically with a tolerance for float answers.
export function titaMatches(derived, key) {
  // Drop digit separators, then take the first numeric token. Stripping
  // non-numerics instead would turn "Rs. 4,000" into ".4000" -> 0.4.
  const num = (s) => {
    const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number.parseFloat(m[0]) : NaN;
  };
  const a = num(derived);
  const b = num(key);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) < 0.01;
}

export function checkAnswer(q, parsed) {
  if (parsed.confident === false) return { ok: false, why: "model not confident" };
  if (q.qtype === "tita") {
    if (!titaMatches(parsed.answer_value, q.answer_value)) {
      return { ok: false, why: `derived "${parsed.answer_value}" != key "${q.answer_value}"` };
    }
    return { ok: true };
  }
  const i = Number(parsed.answer_index);
  if (!Number.isInteger(i) || i < 0 || i >= q.options.length) {
    return { ok: false, why: `answer_index ${parsed.answer_index} out of range` };
  }
  if (i !== q.correct_index) {
    return { ok: false, why: `derived "${q.options[i]}" != key "${q.options[q.correct_index]}"` };
  }
  return { ok: true };
}

function buildPrompt(q) {
  const lines = [`Section: ${q.section}`];
  if (q.passage_body) lines.push(`Passage:\n${q.passage_body}`);
  lines.push(`Question:\n${q.body}`);
  if (q.qtype === "tita") {
    lines.push("Type: TITA (type-in-the-answer, no options). Derive the numeric answer.");
  } else {
    lines.push(`Options:\n${q.options.map((o, i) => `${i}. ${o}`).join("\n")}`);
    lines.push("Type: MCQ. Derive which option index is correct.");
  }
  return lines.join("\n\n");
}

// Mirrors lib/ai/model.ts: every model call goes through OpenRouter, one key.
// ponytail: duplicated rather than imported — plain .mjs cannot import the .ts.
function getModel(modelId) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return createOpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: key }).chat(modelId);
}

async function solve(q, cfg, models) {
  let lastErr = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(modelId),
        system: SYSTEM,
        prompt: buildPrompt(q),
        // No temperature: reasoning models reject anything but their default, and
        // this backfill generates once and stores, so reproducible sampling buys
        // nothing. The answer self-check below is what guards quality.
        maxOutputTokens: Math.max(cfg.max_tokens, 2000),
      });
      const parsed = JSON.parse(extractJsonObject(res.text));
      const steps = typeof parsed.steps === "string" ? parsed.steps.trim() : "";
      if (!steps) throw new Error("model returned no steps");
      return { parsed, steps: steps.slice(0, EXPLANATION_MAX), modelId };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all models failed");
}

// ponytail: fixed-size worker pool, no p-limit dep. Fine for a one-off backfill.
async function pool(items, n, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

function selfTest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); };

  assert(titaMatches("48", "48"), "exact int");
  assert(titaMatches("Rs. 4,000", "4000"), "currency + separators stripped");
  assert(titaMatches("48.0", "48"), "float form of int");
  assert(!titaMatches("49", "48"), "off by one rejected");
  assert(!titaMatches("", "48"), "empty rejected");
  assert(!titaMatches("abc", "48"), "non-numeric rejected");
  assert(titaMatches("-5", "-5"), "negative");
  assert(titaMatches("Answer: 48", "48"), "prose prefix");
  assert(titaMatches("1,00,000", "100000"), "indian digit grouping");

  const mcq = { qtype: "mcq", options: ["a", "b", "c", "d"], correct_index: 2 };
  assert(checkAnswer(mcq, { answer_index: 2 }).ok, "mcq agree");
  assert(!checkAnswer(mcq, { answer_index: 1 }).ok, "mcq disagree");
  assert(!checkAnswer(mcq, { answer_index: 9 }).ok, "mcq out of range");
  assert(!checkAnswer(mcq, { answer_index: 2, confident: false }).ok, "not confident blocks write");
  // index 0 is falsy — the guard must not treat it as missing
  assert(checkAnswer({ ...mcq, correct_index: 0 }, { answer_index: 0 }).ok, "index 0 agree");

  const tita = { qtype: "tita", answer_value: "245" };
  assert(checkAnswer(tita, { answer_value: "245" }).ok, "tita agree");
  assert(!checkAnswer(tita, { answer_value: "244" }).ok, "tita disagree");

  console.log("self-test OK");
}

const args = parseArgs(process.argv.slice(2));

if (args.selfTest) {
  selfTest();
  process.exit(0);
}

// .env.local beats the ambient shell env, and says so when they differ — see
// scripts/env.mjs. A stale exported OPENROUTER_API_KEY silently winning here is
// a `User not found.` 401 that names nothing.
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: cfgRows, error: cfgErr } = await sb
  .from("ai_config")
  // `enabled` is deliberately not read: it gates user-facing Ninja, not a
  // deliberate offline admin backfill.
  .select("model_id, fallback_model_id, max_tokens")
  .limit(1);
if (cfgErr) { console.error("ai_config read failed:", cfgErr.message); process.exit(1); }
const cfg = cfgRows?.[0];
if (!cfg) { console.error("no ai_config row"); process.exit(1); }
const models = [cfg.model_id, cfg.fallback_model_id].filter(Boolean);
console.log(`models=${models.join(" -> ")} (via OpenRouter)`);

// PostgREST caps an unbounded select at 1000 rows (the `max-rows` setting) and
// reports nothing — you just get a short list that looks complete. Currently 588
// rows need one so it doesn't bite yet, but the bank is growing past 1000. Page
// explicitly so the count printed below is the real one.
const PAGE = 1000;
const rows = [];
for (let from = 0; ; from += PAGE) {
  const want = args.limit ? Math.min(PAGE, args.limit - rows.length) : PAGE;
  let q = sb
    .from("questions")
    .select("id, section, qtype, body, options, correct_index, answer_value, is_active, passages(body)")
    .or("explanation.is.null,explanation.eq.")
    .order("is_active", { ascending: false }) // active questions are the ones users hit
    .order("id", { ascending: true })         // tiebreak: is_active alone is not a stable sort, so pages could overlap/skip
    .range(from, from + want - 1);
  if (args.section) q = q.eq("section", args.section);

  const { data, error } = await q;
  if (error) { console.error("fetch failed:", error.message); process.exit(1); }
  rows.push(...(data ?? []));
  if (!data?.length || data.length < want) break;
  if (args.limit && rows.length >= args.limit) break;
}
if (!rows.length) { console.log("nothing to backfill."); process.exit(0); }

const questions = rows.map((r) => ({
  ...r,
  options: Array.isArray(r.options) ? r.options : [],
  passage_body: r.passages?.body ?? null,
}));
console.log(`${questions.length} questions missing an explanation${args.dryRun ? " (DRY RUN)" : ""}\n`);

const review = [];
let written = 0, mismatched = 0, failed = 0, done = 0;

await pool(questions, args.concurrency, async (item) => {
  const tag = `${item.section}/${item.qtype}/${item.id.slice(0, 8)}`;
  try {
    const { parsed, steps, modelId } = await solve(item, cfg, models);
    const verdict = checkAnswer(item, parsed);

    if (!verdict.ok) {
      mismatched++;
      review.push({
        id: item.id, section: item.section, qtype: item.qtype, is_active: item.is_active,
        body: item.body, options: item.options,
        key: item.qtype === "tita" ? item.answer_value : item.options[item.correct_index],
        model_said: item.qtype === "tita" ? parsed.answer_value : item.options[parsed.answer_index],
        why: verdict.why, model_id: modelId, steps,
      });
      console.log(`[${++done}/${questions.length}] REVIEW  ${tag} — ${verdict.why}`);
      return;
    }

    if (!args.dryRun) {
      const { error: upErr } = await sb.from("questions").update({ explanation: steps }).eq("id", item.id);
      if (upErr) throw upErr;
    }
    written++;
    console.log(`[${++done}/${questions.length}] ok      ${tag} (${steps.length} chars)`);
  } catch (e) {
    failed++;
    console.log(`[${++done}/${questions.length}] FAIL    ${tag} — ${e.message}`);
  }
});

const outPath = args.out ?? "scripts/.explanation-review.json";
if (review.length) {
  writeFileSync(outPath, JSON.stringify(review, null, 2));
}

console.log(`\nDONE. written=${written} needs-review=${mismatched} failed=${failed}`);
if (review.length) {
  console.log(`\n${review.length} questions where the model's answer disagreed with the stored key.`);
  console.log(`No explanation written for these — the key or the question may be wrong.`);
  console.log(`Report: ${outPath}`);
  console.log(`Review them in /admin (filter by section, find by body text) and fix or deactivate.`);
}
if (failed) console.log(`\n${failed} failed outright — safe to re-run, it only picks up rows still missing one.`);
