// One-off: upload question diagram SVGs to the `question-assets` bucket and
// point questions.image_url at them. Optionally activates the question.
//
// The match client renders diagrams as <img src={image_url}> and the DB CHECKs
// image_url ~ '^https://', so diagrams must be hosted, not inlined. The bucket
// is public-read, so the returned public URL works for anonymous spectators too.
//
// Usage:
//   node --env-file=.env.local scripts/upload-question-diagrams.mjs <manifest.json> [--activate]
//
// manifest.json: [ { "id": "<question uuid>", "svg": "/abs/path/to/file.svg" }, ... ]

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const manifestPath = process.argv[2];
const activate = process.argv.includes("--activate");
if (!manifestPath) { console.error("Usage: node scripts/upload-question-diagrams.mjs <manifest.json> [--activate]"); process.exit(1); }

const items = JSON.parse(readFileSync(manifestPath, "utf8"));
const sb = createClient(url, key, { auth: { persistSession: false } });
const BUCKET = "question-assets";

let ok = 0, failed = 0;
for (const { id, svg } of items) {
  const bytes = readFileSync(svg);
  const path = `diagrams/${id}.svg`;

  const up = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/svg+xml",
    upsert: true,            // re-runnable: a redraw replaces the old file
    cacheControl: "31536000",
  });
  if (up.error) { console.error(`upload failed ${id}: ${up.error.message}`); failed++; continue; }

  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  const image_url = pub.publicUrl;
  if (!/^https:\/\//.test(image_url)) { console.error(`refusing non-https url for ${id}: ${image_url}`); failed++; continue; }

  const patch = activate ? { image_url, is_active: true } : { image_url };
  const { error } = await sb.from("questions").update(patch).eq("id", id);
  if (error) { console.error(`db update failed ${id}: ${error.message}`); failed++; continue; }
  ok++;
  console.log(`${ok}/${items.length} ${id} -> ${image_url}${activate ? " (activated)" : ""}`);
}
console.log(`\nDONE. ${ok} uploaded${activate ? " + activated" : ""}, ${failed} failed.`);
