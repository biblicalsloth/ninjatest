// One-off loader: bulk-insert the extracted QUANT question bank into `questions`.
// Reads the joined payload produced by the PDF ingest pipeline and inserts via the
// Supabase service-role key (bypasses RLS; questions has `using(false)`). The key is
// read from the environment and never logged.
//
// Usage:
//   1. Put SUPABASE_SERVICE_ROLE_KEY=... in .env.local (Supabase dashboard → Project
//      Settings → API → service_role secret). NEXT_PUBLIC_SUPABASE_URL must also be set.
//   2. node scripts/load-quant-questions.mjs <path-to-payload.json>
//
// payload.json shape: { "payload": [ {difficulty, body, options[], correct_index,
//   explanation, is_active, qtype, answer_value}, ... ] }
// Old QUANT rows are assumed already cleared (backed up to _backup_quant_temp_*).

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/load-quant-questions.mjs <payload.json>"); process.exit(1); }

const { payload } = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(payload) || payload.length === 0) { console.error("empty payload"); process.exit(1); }

const rows = payload.map((r) => ({
  section: "QUANT",
  difficulty: r.difficulty,
  body: r.body,
  options: r.options,               // jsonb array (empty for tita)
  correct_index: r.correct_index,   // 0 placeholder for tita (unused while inactive)
  explanation: r.explanation ?? null,
  is_active: r.is_active,
  qtype: r.qtype,                   // 'mcq' | 'tita'
  answer_value: r.answer_value ?? null,
  elo: 1000 + r.difficulty * 100,   // documented seed; question-ELO adapts from play
}));

const sb = createClient(url, key, { auth: { persistSession: false } });

const BATCH = 200;
let inserted = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { error, count } = await sb.from("questions").insert(chunk, { count: "exact" });
  if (error) { console.error(`batch @${i} failed:`, error.message); process.exit(1); }
  inserted += count ?? chunk.length;
  console.log(`inserted ${inserted}/${rows.length}`);
}
console.log(`\nDONE. ${inserted} QUANT questions inserted (${rows.filter(r=>r.is_active).length} active, ${rows.filter(r=>!r.is_active).length} inactive).`);
