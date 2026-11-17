// Report near-duplicate questions. REPORT ONLY — never writes.
//
// High embedding similarity is NOT proof of a duplicate (measured 2026-11-17:
// of ~150 active pairs >=0.93, only ~10 shared an answer key — the rest were
// set siblings, shared templates, or generic stems). So this ranks candidates
// for a human, flags the strong signal (`same_key`), and leaves deactivation to
// SQL: `update questions set is_active = false where id = '…';`
//
// Run after every ingest: loader -> backfill-embeddings -> this, with --since.
// service_role via loadEnvLocal() -> hits PROD (see scripts/env.mjs).
//
//   node scripts/find-near-duplicates.mjs --self-test
//   node scripts/find-near-duplicates.mjs [--min 0.95] [--since 2026-11-18T00:00Z] [--out report.json]

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

// Same answer = the strongest duplicate signal we can compute without an LLM.
// MCQ: identical option set (any order) and the same correct option text.
// TITA: same numeric answer_value.
export function sameKey(x, y) {
  if (x.qtype !== y.qtype) return false;
  if (x.qtype === "tita") return x.answer_value != null && Number(x.answer_value) === Number(y.answer_value);
  const norm = (o) => String(o).replace(/\s+/g, " ").trim().toLowerCase();
  const ox = (x.options ?? []).map(norm), oy = (y.options ?? []).map(norm);
  if (!ox.length || ox.length !== oy.length) return false;
  return [...ox].sort().join("\u0000") === [...oy].sort().join("\u0000") && ox[x.correct_index] === oy[y.correct_index];
}

function selfTest() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const mcq = (options, correct_index) => ({ qtype: "mcq", options, correct_index });
  assert(!sameKey(mcq(["1", "2", "3"], 1), mcq(["3", "2", "1"], 0)), "shuffled options, different correct text");
  assert(sameKey(mcq(["1", "2", "3"], 1), mcq(["3", "2", "1"], 1)), "shuffled options, same correct text");
  assert(!sameKey(mcq(["a", "b"], 0), mcq(["a", "c"], 0)), "different option sets");
  assert(sameKey({ qtype: "tita", answer_value: "1900" }, { qtype: "tita", answer_value: "1900.0" }), "TITA numeric equality");
  assert(!sameKey({ qtype: "tita", answer_value: "3" }, { qtype: "tita", answer_value: "-3" }), "TITA sign matters");
  assert(!sameKey({ qtype: "tita", answer_value: "3" }, mcq(["3"], 0)), "type mismatch");
  console.log("self-test OK");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--self-test")) { selfTest(); process.exit(0); }

  const { loadEnvLocal } = await import("./env.mjs");
  const { createClient } = await import("@supabase/supabase-js");
  loadEnvLocal();
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Page: bare rpc() is silently capped at 1000 rows by PostgREST.
  const pairs = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .rpc("question_near_duplicates", { p_min_sim: Number(arg("--min") ?? 0.95), p_since: arg("--since") ?? null })
      .range(from, from + 999);
    if (error) { console.error("rpc failed:", error.message); process.exit(1); }
    pairs.push(...data);
    if (data.length < 1000) break;
  }

  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const byId = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb
      .from("questions")
      .select("id, qtype, body, options, correct_index, answer_value, passage_id, created_at")
      .in("id", ids.slice(i, i + 200));
    if (error) { console.error("fetch failed:", error.message); process.exit(1); }
    for (const q of data) byId[q.id] = q;
  }

  const rows = pairs
    .map((p) => ({ ...p, same_key: sameKey(byId[p.a], byId[p.b]), a_q: byId[p.a], b_q: byId[p.b] }))
    .sort((x, y) => Number(y.same_key) - Number(x.same_key) || y.similarity - x.similarity);

  const short = (q) => String(q?.body ?? "").replace(/\s+/g, " ").slice(0, 90);
  for (const r of rows) {
    console.log(`${r.same_key ? "SAME-KEY" : "        "} ${r.similarity.toFixed(3)} ${r.section}`);
    console.log(`   ${r.a}  ${short(r.a_q)}`);
    console.log(`   ${r.b}  ${short(r.b_q)}`);
  }
  console.log(`\n${rows.length} pairs, ${rows.filter((r) => r.same_key).length} with the same answer key. Nothing written.`);
  if (arg("--out")) {
    writeFileSync(arg("--out"), JSON.stringify(rows, null, 1));
    console.log(`report -> ${arg("--out")}`);
  }
}
