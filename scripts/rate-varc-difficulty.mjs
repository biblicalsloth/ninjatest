// Rate VARC question difficulty with an LLM and re-seed the pointing system.
//
// The extracted VARC bank was seeded flat: every question difficulty=3, elo=1300.
// DILR/Quant vary (difficulty 1-5 -> elo 1100-1500 via 1000 + difficulty*100), so
// their picker adapts to a player's level; VARC couldn't tell an easy RC from a
// hard one. This reads each question (with its passage, for RC) and assigns a real
// 1-5 difficulty, then writes difficulty + elo on the same scale.
//
// Safe: only touches times_seen=0 rows, so a learned elo is never stomped (same
// rule as admin_upsert_questions). Writes difficulty/elo only — NOT body — so the
// embedding staleness trigger does not fire and no re-embed is needed. Idempotent
// enough to re-run (it just re-rates; a played question is skipped).
//
// Batched per RC passage (model sees the passage once + all its sub-questions) and
// in small groups for standalone (vocab/para-jumble/completion). Routed through
// OpenRouter with the ai_config chat model, like every other LLM call here.
// GLM emits reasoning tokens that eat the output budget, so maxOutputTokens is
// sized well above the JSON (repo footgun #1).
//
//   node scripts/rate-varc-difficulty.mjs --self-test     # offline logic, no env
//   node scripts/rate-varc-difficulty.mjs --sample 40      # rate ~40, print, NO write
//   node scripts/rate-varc-difficulty.mjs                  # rate all, print, NO write
//   node scripts/rate-varc-difficulty.mjs --apply          # rate all + write

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createClient } from "@supabase/supabase-js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const STANDALONE_BATCH = 8;
const CONCURRENCY = 5;

const RUBRIC = `Rate each CAT VARC (verbal) question's difficulty on a 1-5 integer scale:
1 = very easy: answer is explicit in the text, plain language, no traps.
2 = easy.
3 = medium: needs light inference or a careful read.
4 = hard: multi-step inference, abstract/dense passage, two close options.
5 = very hard: subtle inference or tone/assumption, dense abstract prose, strong trap options.
Judge the passage's complexity AND the specific question+options. Spread your ratings — do not give everything a 3.`;

// Extract the first JSON object from model text (tolerates ``` fences / prose).
export function parseRatings(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("no JSON object in model output");
  const obj = JSON.parse(text.slice(s, e + 1));
  const out = {};
  for (const r of obj.ratings ?? []) {
    const d = Math.round(Number(r.difficulty));
    if (Number.isFinite(d) && r.id) out[r.id] = Math.min(5, Math.max(1, d));
  }
  return out;
}

// Build LLM work units: one per RC passage, and STANDALONE_BATCH-sized groups of
// standalone questions. Exported for the self-test.
export function buildUnits(questions, passageBody) {
  const byPassage = new Map();
  const standalone = [];
  for (const q of questions) {
    if (q.passage_id) {
      if (!byPassage.has(q.passage_id)) byPassage.set(q.passage_id, []);
      byPassage.get(q.passage_id).push(q);
    } else standalone.push(q);
  }
  const units = [];
  for (const [pid, qs] of byPassage) units.push({ passage: passageBody.get(pid) ?? null, questions: qs });
  for (let i = 0; i < standalone.length; i += STANDALONE_BATCH)
    units.push({ passage: null, questions: standalone.slice(i, i + STANDALONE_BATCH) });
  return units;
}

function unitPrompt(unit) {
  const qlines = unit.questions
    .map((q) => {
      const opts = Array.isArray(q.options) && q.options.length
        ? "\n  Options: " + q.options.map((o, i) => `(${i + 1}) ${o}`).join("  ")
        : "";
      return `- id ${q.id}: ${q.body}${opts}`;
    })
    .join("\n");
  const passage = unit.passage ? `PASSAGE:\n${unit.passage}\n\n` : "These are standalone questions (no shared passage).\n\n";
  return `${RUBRIC}\n\n${passage}QUESTIONS:\n${qlines}\n\nReturn ONLY JSON: {"ratings":[{"id":"<uuid>","difficulty":<1-5>}]} — one entry per question above.`;
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

function selfTest() {
  // parse tolerance
  const p = parseRatings('reasoning… ```json\n{"ratings":[{"id":"a","difficulty":4},{"id":"b","difficulty":"7"}]}\n``` done');
  console.assert(p.a === 4, "parse a", p);
  console.assert(p.b === 5, "clamp 7->5", p); // clamped
  console.assert(Object.keys(p).length === 2, "two ratings", p);
  // unit building
  const qs = [
    { id: "1", body: "q1", options: ["x"], passage_id: "P" },
    { id: "2", body: "q2", options: [], passage_id: "P" },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, body: "s", options: [], passage_id: null })),
  ];
  const units = buildUnits(qs, new Map([["P", "the passage"]]));
  console.assert(units.length === 3, "1 passage + 2 standalone batches, got", units.length);
  console.assert(units[0].passage === "the passage" && units[0].questions.length === 2, "passage unit");
  console.assert(units[1].questions.length === STANDALONE_BATCH, "batch of 8");
  console.assert(units[2].questions.length === 1, "remainder batch");
  console.assert(unitPrompt(units[0]).includes("the passage"), "prompt has passage");
  console.log("self-test OK");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const { loadEnvLocal } = await import("./env.mjs");
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const routerKey = process.env.OPENROUTER_API_KEY;
  if (!url || !key) throw new Error("need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  if (!routerKey) throw new Error("need OPENROUTER_API_KEY");

  const apply = process.argv.includes("--apply");
  const sampleI = process.argv.indexOf("--sample");
  const sampleN = sampleI >= 0 ? Number(process.argv[sampleI + 1]) : 0;

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data: cfg } = await sb.from("ai_config").select("model_id, fallback_model_id, max_tokens").eq("id", true).single();
  const modelId = cfg?.model_id ?? "z-ai/glm-5.2";
  const provider = createOpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey: routerKey });
  const model = provider.chat(modelId);
  const maxOutputTokens = Math.max(cfg?.max_tokens ?? 0, 4000); // room for GLM reasoning + JSON

  // never stomp a learned elo: times_seen=0 only.
  // PostgREST caps a select at max-rows (1000) regardless of .limit(), so page
  // explicitly or the bank is silently truncated (same trap as backfill).
  const PAGE = 1000;
  const questions = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("questions")
      .select("id, body, options, qtype, passage_id")
      .eq("section", "VARC").eq("is_active", true).eq("times_seen", 0)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    questions.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  const pids = [...new Set(questions.filter((q) => q.passage_id).map((q) => q.passage_id))];
  const passageBody = new Map();
  for (let i = 0; i < pids.length; i += 300) {
    const { data: ps } = await sb.from("passages").select("id, body").in("id", pids.slice(i, i + 300));
    for (const p of ps ?? []) passageBody.set(p.id, p.body);
  }

  let pool = questions;
  if (sampleN) pool = questions.slice(0, sampleN);
  const units = buildUnits(pool, passageBody);
  console.log(`VARC to rate: ${pool.length} questions in ${units.length} units (model ${modelId})`);

  let done = 0;
  const results = await mapPool(units, CONCURRENCY, async (unit) => {
    for (const id of [modelId, cfg?.fallback_model_id].filter(Boolean)) {
      try {
        const m = id === modelId ? model : provider.chat(id);
        const { text } = await generateText({ model: m, prompt: unitPrompt(unit), temperature: 0, maxOutputTokens });
        if (text) {
          const r = parseRatings(text);
          if (Object.keys(r).length) { process.stdout.write(`\r  units done: ${++done}/${units.length}`); return r; }
        }
      } catch (e) { /* try fallback */ }
    }
    console.warn(`\n  unit failed (${unit.questions.length} qs) — left at current elo`);
    return {};
  });
  process.stdout.write("\n");

  // Keep only ratings whose id is a real question we sent — the model sometimes
  // returns a truncated or hallucinated uuid, which would crash the write.
  const validIds = new Set(pool.map((q) => q.id));
  const ratings = {};
  let dropped = 0;
  for (const [id, d] of Object.entries(Object.assign({}, ...results))) {
    if (validIds.has(id)) ratings[id] = d; else dropped++;
  }
  if (dropped) console.log(`dropped ${dropped} rating(s) with unknown/invalid id`);
  const dist = {};
  for (const d of Object.values(ratings)) dist[d] = (dist[d] || 0) + 1;
  const rated = Object.keys(ratings).length;
  console.log(`rated: ${rated}/${pool.length}   distribution {difficulty:count}:`, dist);

  if (!apply) {
    console.log("\nNO WRITE (dry run). Re-run with --apply to write difficulty + elo.");
    return;
  }
  // one UPDATE per difficulty value: elo = 1000 + difficulty*100
  let written = 0;
  for (let d = 1; d <= 5; d++) {
    const ids = Object.entries(ratings).filter(([, v]) => v === d).map(([id]) => id);
    if (!ids.length) continue;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: ue } = await sb
        .from("questions")
        .update({ difficulty: d, elo: 1000 + d * 100 })
        .in("id", chunk)
        .eq("times_seen", 0); // re-guard at write time
      if (ue) throw ue;
      written += chunk.length;
    }
  }
  console.log(`DONE. wrote difficulty + elo on ${written} VARC questions.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
