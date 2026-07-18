// Loader: insert engine-ready DILR payload into `questions`, upload each diagram
// PNG to the `question-assets` bucket, and set image_url. Service-role (bypasses
// RLS; questions is `using(false)`). The match client renders image_url as <img>,
// DB CHECKs image_url ~ '^https://', bucket is public-read.
//
// Usage:
//   node --env-file=.env.local scripts/load-dilr-questions.mjs <payload.json>            # DRY RUN
//   node --env-file=.env.local scripts/load-dilr-questions.mjs <payload.json> --commit    # writes
//
// payload row: {section,difficulty,body,options[],correct_index,qtype,answer_value,
//   explanation,is_active,image_file(abs path|null)}
// Does NOT touch the 45 old DILR temp rows — handle those separately before/after.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const file = process.argv[2];
const commit = process.argv.includes("--commit");
if (!file) { console.error("usage: load-dilr-questions.mjs <payload.json> [--commit]"); process.exit(1); }

const { payload } = JSON.parse(readFileSync(file, "utf8"));
// validate before touching prod
for (const r of payload) {
  if (r.qtype === "tita") {
    if (r.answer_value == null || !/^-?\d+(\.\d+)?$/.test(String(r.answer_value))) { console.error("bad tita answer_value", r.subsection, r.qnum, r.answer_value); process.exit(1); }
  } else {
    if (!Array.isArray(r.options) || r.options.length < 2) { console.error("bad options", r.subsection, r.qnum); process.exit(1); }
    if (r.correct_index < 0 || r.correct_index >= r.options.length) { console.error("bad correct_index", r.subsection, r.qnum); process.exit(1); }
  }
  if (r.image_file && !existsSync(r.image_file)) { console.error("missing image", r.image_file); process.exit(1); }
}
const withImg = payload.filter((r) => r.image_file).length;
console.log(`payload ${payload.length} | active ${payload.filter(r => r.is_active).length} | diagrams ${withImg} | tita ${payload.filter(r => r.qtype === "tita").length} | 5-opt ${payload.filter(r => r.options.length === 5).length}`);
if (!commit) { console.log("DRY RUN — validated OK. Re-run with --commit to write."); process.exit(0); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const BUCKET = "question-assets";
const toRow = (r) => ({
  section: "DILR", difficulty: r.difficulty, body: r.body, options: r.options,
  correct_index: r.correct_index, explanation: r.explanation ?? null,
  is_active: r.is_active, qtype: r.qtype, answer_value: r.answer_value ?? null,
  elo: 1000 + r.difficulty * 100 + (r.qtype === "tita" ? 100 : 0),
});

let inserted = 0, uploaded = 0;
const BATCH = 200;
for (let i = 0; i < payload.length; i += BATCH) {
  const chunk = payload.slice(i, i + BATCH);
  const { data, error } = await sb.from("questions").insert(chunk.map(toRow)).select("id");
  if (error) { console.error(`insert @${i}:`, error.message); process.exit(1); }
  inserted += data.length;
  // upload diagrams for this chunk, set image_url by returned id (order preserved)
  for (let j = 0; j < chunk.length; j++) {
    if (!chunk[j].image_file) continue;
    const id = data[j].id;
    const path = `diagrams/${id}.png`;
    const up = await sb.storage.from(BUCKET).upload(path, readFileSync(chunk[j].image_file), { contentType: "image/png", upsert: true, cacheControl: "31536000" });
    if (up.error) { console.error(`upload ${id}:`, up.error.message); process.exit(1); }
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    const { error: ue } = await sb.from("questions").update({ image_url: pub.publicUrl }).eq("id", id);
    if (ue) { console.error(`set image_url ${id}:`, ue.message); process.exit(1); }
    uploaded++;
  }
  console.log(`inserted ${inserted}/${payload.length}, diagrams ${uploaded}/${withImg}`);
}
console.log(`DONE. ${inserted} DILR inserted, ${uploaded} diagrams wired.`);
