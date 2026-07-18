// One-off loader: bulk-insert the extracted VARC question bank (RC passage groups +
// standalone para-jumbles/vocab) into `passages` + `questions` via the service-role key
// (bypasses RLS; both tables are `using(false)`). Key read from env, never logged.
//
// Prereq: the old temp VARC rows must already be cleared/deactivated — run
// scripts/varc-clear-old.sql first (backs up to _backup_varc_temp_*, FK-safe).
//
// Usage:
//   1. SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in .env.local
//   2. node scripts/load-varc-questions.mjs scratchpad/ingest/varc/varc-all-staged.json [--dry-run]
//
// Payload shape: { passages:[{passage_num, body}], questions:[{section,qtype,difficulty,
//   body,options[],correct_index,passage_num|null,is_active,...}] }  (only is_active rows load)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal } from "./env.mjs";

loadEnvLocal();
const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) { console.error("Usage: node scripts/load-varc-questions.mjs <payload.json> [--dry-run]"); process.exit(1); }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dryRun && (!url || !key)) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env."); process.exit(1); }

const { passages, questions } = JSON.parse(readFileSync(file, "utf8"));
const active = questions.filter((q) => q.is_active);

// passage groups actually referenced by active RC questions
const usedPassNums = new Set(active.filter((q) => q.passage_num != null).map((q) => q.passage_num));
const passRows = passages.filter((p) => usedPassNums.has(p.passage_num));

const eloSeed = (d) => 1000 + d * 100;

console.log(`payload: ${active.length} active questions (${active.filter(q=>q.passage_num!=null).length} RC / ${active.filter(q=>q.passage_num==null).length} standalone), ${passRows.length} passages`);
if (dryRun) {
  console.log("DRY RUN — no writes. Sample question:", JSON.stringify({ ...active[0], body: active[0].body.slice(0, 60) + "…" }, null, 1).slice(0, 400));
  process.exit(0);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

// ── 1. insert passages, map passage_num -> new uuid ──
const passIdByNum = {};
{
  const BATCH = 100;
  for (let i = 0; i < passRows.length; i += BATCH) {
    const chunk = passRows.slice(i, i + BATCH);
    const { data, error } = await sb.from("passages")
      .insert(chunk.map((p) => ({ section: "VARC", body: p.body, is_active: true })))
      .select("id");
    if (error) { console.error(`passage batch @${i} failed:`, error.message); process.exit(1); }
    chunk.forEach((p, j) => { passIdByNum[p.passage_num] = data[j].id; });
    console.log(`passages inserted ${Math.min(i + BATCH, passRows.length)}/${passRows.length}`);
  }
}

// ── 2. insert questions with passage_id ──
const rows = active.map((q) => ({
  section: "VARC",
  difficulty: q.difficulty ?? 3,
  body: q.body,
  options: q.options,                       // jsonb array
  correct_index: q.correct_index,
  explanation: null,
  is_active: true,
  qtype: "mcq",
  answer_value: null,
  passage_id: q.passage_num != null ? passIdByNum[q.passage_num] : null,
  elo: eloSeed(q.difficulty ?? 3),
}));
// guard: no RC row lost its passage mapping
const orphans = active.filter((q, i) => q.passage_num != null && !rows[i].passage_id);
if (orphans.length) { console.error(`ABORT: ${orphans.length} RC questions have no passage_id mapping`); process.exit(1); }

const BATCH = 200;
let inserted = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { error, count } = await sb.from("questions").insert(chunk, { count: "exact" });
  if (error) { console.error(`question batch @${i} failed:`, error.message); process.exit(1); }
  inserted += count ?? chunk.length;
  console.log(`questions inserted ${inserted}/${rows.length}`);
}
console.log(`\nDONE. ${passRows.length} passages + ${inserted} VARC questions inserted.`);
console.log(`  RC (grouped): ${rows.filter(r=>r.passage_id).length}  |  standalone: ${rows.filter(r=>!r.passage_id).length}`);
