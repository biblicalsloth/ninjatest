// Re-OCR single pages WITH image base64, save each figure as PNG and rewrite
// the page markdown's image refs to globally-unique filenames (img-<phys>-<n>.png).
// Usage: node scripts/ocr-images.mjs <slicedSinglePagePdf> <phys> <ocrDir> <assetDir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadEnvLocal } from "./env.mjs";
loadEnvLocal();
const KEY = process.env.MISTRAL_API_KEY;
if (!KEY) { console.error("MISTRAL_API_KEY missing"); process.exit(1); }

const [pdf, phys, ocrDir, assetDir] = process.argv.slice(2);
const b64 = readFileSync(pdf).toString("base64");
const res = await fetch("https://api.mistral.ai/v1/ocr", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "mistral-ocr-latest",
    document: { type: "document_url", document_url: `data:application/pdf;base64,${b64}` },
    include_image_base64: true,
  }),
});
if (!res.ok) { console.error("OCR failed", res.status, await res.text()); process.exit(1); }
const data = await res.json();
mkdirSync(assetDir, { recursive: true });
mkdirSync(ocrDir, { recursive: true });

let saved = 0;
const p = data.pages[0];
let md = p.markdown ?? "";
for (let i = 0; i < (p.images || []).length; i++) {
  const im = p.images[i];
  const fname = `img-${phys}-${i}.png`;
  const raw = (im.image_base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!raw) continue;
  writeFileSync(`${assetDir}/${fname}`, Buffer.from(raw, "base64"));
  // rewrite both the ![alt](id) target and any bare id occurrences
  md = md.split(`(${im.id})`).join(`(${fname})`).split(`![${im.id}]`).join(`![${fname}]`);
  saved++;
}
writeFileSync(`${ocrDir}/ocr-${phys}.md`, md);
console.log(`p${phys}: ${saved} images -> ${assetDir}`);
