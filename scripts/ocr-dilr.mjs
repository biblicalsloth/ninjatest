// Mistral OCR (mistral-ocr-latest) over a sliced PDF -> per-page markdown.
// Usage: node scripts/ocr-dilr.mjs <sliced.pdf> <outDir> [firstPhysPage]
//   firstPhysPage: physical page number of slice page 1, only for output filenames.
// Needs MISTRAL_API_KEY in .env.local. No chat model, deterministic, no Anthropic filter.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadEnvLocal } from "./env.mjs";

loadEnvLocal();
const KEY = process.env.MISTRAL_API_KEY;
if (!KEY) { console.error("MISTRAL_API_KEY missing in .env.local"); process.exit(1); }

const [pdfPath, outDir, firstPhys] = process.argv.slice(2);
if (!pdfPath || !outDir) { console.error("usage: node scripts/ocr-dilr.mjs <sliced.pdf> <outDir> [firstPhysPage]"); process.exit(1); }
const base = firstPhys ? parseInt(firstPhys, 10) : 1;

const b64 = readFileSync(pdfPath).toString("base64");
const res = await fetch("https://api.mistral.ai/v1/ocr", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "mistral-ocr-latest",
    document: { type: "document_url", document_url: `data:application/pdf;base64,${b64}` },
    include_image_base64: false,
  }),
});
if (!res.ok) { console.error("OCR failed", res.status, await res.text()); process.exit(1); }
const data = await res.json();

mkdirSync(outDir, { recursive: true });
for (const p of data.pages) {
  const phys = base + p.index; // p.index is 0-based within the submitted doc
  writeFileSync(`${outDir}/ocr-${phys}.md`, p.markdown ?? "");
}
writeFileSync(`${outDir}/ocr-raw.json`, JSON.stringify(data, null, 1));
console.log(`pages: ${data.pages.length}  ->  ${outDir}/ocr-<phys>.md`);
console.log("usage:", JSON.stringify(data.usage_info ?? {}));
