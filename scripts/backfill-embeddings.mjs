// Backfill `questions.embedding` with text-embedding-3-small vectors.
//
// Re-runs are safe and are the intended repair path: this only selects rows
// where embedding IS NULL, and the questions_null_stale_embedding trigger nulls
// the column whenever a body is edited. So "someone changed questions in /admin"
// is fixed by running this again — no diffing, no bookkeeping.
//
// Routed through OpenRouter like every other model call (OPENROUTER_API_KEY is
// the only LLM key this repo uses). OpenRouter proxies OpenAI's embedding models
// on the standard /embeddings path even though they are absent from its /models
// catalog — that listing has no embedding models at all, so don't conclude from
// a catalog search that this is unsupported. Verified live: it returns a real
// 1536-d vector.
//
// Anthropic publishes no embedding model, so there is no Claude option for this
// slot. NOT driven by ai_config either: that row holds Ninja's *chat* model
// (GLM), which is a separate concern. The embedding model is pinned here because
// the column width (1536) and the read-time query vector both depend on it —
// changing it means a migration + a full re-embed, not a config edit.
//
// Usage:
//   node scripts/backfill-embeddings.mjs --self-test        # no network, no env
//   node scripts/backfill-embeddings.mjs --dry-run --limit 5
//   node scripts/backfill-embeddings.mjs --section QUANT
//   node scripts/backfill-embeddings.mjs                    # embed everything missing
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (bypasses `questions`
// RLS `using(false)`), OPENROUTER_API_KEY.
//
// Flags: --section VARC|DILR|QUANT  --limit N  --batch N (default 96)  --dry-run

import { pathToFileURL } from "node:url";
import { loadEnvLocal } from "./env.mjs";
import { createClient } from "@supabase/supabase-js";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";

// ponytail: URL duplicated from lib/ai/model.ts rather than imported. Node 24
// does strip types, so importing the .ts would work — but it warns, and it would
// break on any older node. scripts/backfill-explanations.mjs inlines its own
// helpers for the same reason. It is a constant; leave it duplicated.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter accepts the bare "text-embedding-3-small" too (both return 200) —
// the namespaced id is used to match how every other model id in this repo is
// written, e.g. ai_config.model_id = "z-ai/glm-5.2".
const MODEL = "openai/text-embedding-3-small";
const DIMS = 1536; // must match the vector(1536) column in 20260716180000

// THE CONTRACT. Whatever eventually embeds a *query* at read time must call this
// same function, or the query vector lands in a different space than the bank and
// similarity is quietly garbage. Body only: the stem carries the topic, and
// options are mostly distractor noise.
export function embedInput(q) {
  return String(q.body ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const a = { batch: 96 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dry-run") a.dryRun = true;
    else if (v === "--self-test") a.selfTest = true;
    else if (v === "--section") a.section = argv[++i];
    else if (v === "--limit") a.limit = Number(argv[++i]);
    else if (v === "--batch") a.batch = Number(argv[++i]);
  }
  return a;
}

function selfTest() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  assert(embedInput({ body: "  a\n\nb  " }) === "a b", "collapses whitespace");
  assert(embedInput({ body: "x" }) === embedInput({ body: "\tx \n" }), "stable across formatting");
  assert(embedInput({ body: null }) === "", "null body does not throw");
  // A row that embeds to "" would burn an API call and store a meaningless
  // vector; the fetch filter must drop it.
  assert(!isEmbeddable({ body: "   " }), "blank body is skipped");
  assert(isEmbeddable({ body: "What is 2+2?" }), "real body is embeddable");

  console.log("self-test OK");
}

export function isEmbeddable(q) {
  return embedInput(q).length > 0;
}

// Run the backfill only when invoked as a command. Without this guard, importing
// embedInput — which the contract above tells read-time code to do — silently ran
// a full backfill and exited the importing process.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {

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
const routerKey = process.env.OPENROUTER_API_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!routerKey) {
  console.error("Missing OPENROUTER_API_KEY.");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
// OpenRouter is OpenAI-compatible, so the OpenAI provider package covers it via
// baseURL — same trick lib/ai/model.ts uses for chat.
const model = createOpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey: routerKey })
  .textEmbeddingModel(MODEL);

// PostgREST caps an unbounded select at 1000 rows (the `max-rows` setting) and
// says nothing about it — the first run of this script reported "1000 questions
// missing" against a 1255-row bank and looked complete. Page explicitly so the
// count printed below is the real one.
const PAGE = 1000;
const rows = [];
for (let from = 0; ; from += PAGE) {
  const want = args.limit ? Math.min(PAGE, args.limit - rows.length) : PAGE;
  let q = sb
    .from("questions")
    .select("id, section, body")
    .is("embedding", null)
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

const questions = rows.filter(isEmbeddable);
const skipped = rows.length - questions.length;
if (!questions.length) {
  console.log(`nothing to backfill.${skipped ? ` (${skipped} blank-body rows skipped)` : ""}`);
  process.exit(0);
}
console.log(`${questions.length} questions missing an embedding${skipped ? `, ${skipped} blank skipped` : ""}${args.dryRun ? " (DRY RUN)" : ""}\n`);

let written = 0, failed = 0;

for (let i = 0; i < questions.length; i += args.batch) {
  const chunk = questions.slice(i, i + args.batch);
  const tag = `[${i + 1}-${i + chunk.length}/${questions.length}]`;
  try {
    const { embeddings } = await embedMany({ model, values: chunk.map(embedInput) });

    if (embeddings.length !== chunk.length) {
      throw new Error(`got ${embeddings.length} embeddings for ${chunk.length} inputs`);
    }
    // A width mismatch means the column and the model disagree; writing would
    // fail per-row anyway, but failing loudly here names the actual cause.
    const bad = embeddings.find((e) => e.length !== DIMS);
    if (bad) throw new Error(`model returned ${bad.length} dims, column is vector(${DIMS})`);

    if (!args.dryRun) {
      // One UPDATE per row: upsert would need every not-null column echoed back,
      // and 1255 rows total makes the round-trip count a non-issue.
      for (let j = 0; j < chunk.length; j++) {
        const { error: upErr } = await sb
          .from("questions")
          .update({ embedding: JSON.stringify(embeddings[j]) })
          .eq("id", chunk[j].id);
        if (upErr) throw upErr;
      }
    }
    written += chunk.length;
    console.log(`${tag} ok`);
  } catch (e) {
    failed += chunk.length;
    console.log(`${tag} FAIL — ${e.message}`);
  }
}

console.log(`\nDONE. embedded=${written} failed=${failed}`);
if (failed) console.log(`safe to re-run — it only picks up rows still missing one.`);

} // end isMain
