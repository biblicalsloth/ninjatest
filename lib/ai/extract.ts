import { generateObject, jsonSchema } from "ai";
import { PDFDocument } from "pdf-lib";
import { getModel, type AiConfig } from "@/lib/ai/model";
import { chunkRanges } from "@/lib/ai/pdf-chunk.mjs";

// PDF → CAT questions extractor. Splits a big PDF into small page-chunks
// (pdf-lib), sends each chunk as a FILE part to a multimodal model, and gets
// back JSON shaped exactly like admin_upsert_questions' input (array of groups).
// The output is a PROPOSAL: the admin reviews/edits it in the console and hits
// the existing upsert. Never auto-inserts — a misread correct_index poisons the
// question bank (wrong scoring → wrong ELO for everyone who sees it).
//
// ponytail: sends the real PDF, not extracted text — text extraction mangles
// Quant math, DILR tables, and drops diagrams entirely. Requires a PDF-capable
// model (route your ai_config to Gemini/Claude via OpenRouter, or GPT-4o).

export const MAX_PAGES = 60;        // spend/latency ceiling; bigger → split the file
export const PAGES_PER_CHUNK = 4;   // keeps each call bounded on dense mock papers

export const EXTRACT_SYSTEM = `You extract CAT (Common Admission Test) prep questions from a PDF into structured JSON.

Rules:
- Group questions. A group is one section: "VARC", "DILR", or "QUANT". Detect the section from the content (reading comprehension/verbal → VARC; logical reasoning/data interpretation/sets → DILR; arithmetic/algebra/geometry → QUANT).
- If several questions share ONE reading passage or data set (common in VARC and DILR), put them in the SAME group and copy the full shared passage/data text into "passage". Standalone questions get their own group with passage null.
- "options" = the FULL TEXT of each choice (never "A"/"B"/letters). "correct_index" = 0-based index into options of the correct choice. If the source doesn't state the answer, make your best solved determination; do not guess blindly.
- "difficulty" = your integer estimate 1 (easy) to 5 (hard).
- "explanation" = the source's solution/explanation if present, else a brief correct one you derive. If a question depends on a diagram/figure/chart that cannot be read as text, still extract the text and PREFIX explanation with "[NEEDS DIAGRAM]" so the admin attaches an image.
- Do NOT invent questions. Extract only what is on these pages. If a passage is cut off at a page edge, extract what is visible.`;

export interface ExtractQuestion {
  body: string;
  options: string[];
  correct_index: number;
  difficulty: number;
  explanation: string | null;
}
export interface ExtractGroup {
  section: "VARC" | "DILR" | "QUANT";
  passage: string | null;
  questions: ExtractQuestion[];
}

// JSON Schema (matches the coach's jsonSchema() idiom — no zod dep). All fields
// required + additionalProperties:false to satisfy strict structured-output modes.
const SCHEMA = jsonSchema<{ groups: ExtractGroup[] }>({
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "passage", "questions"],
        properties: {
          section: { type: "string", enum: ["VARC", "DILR", "QUANT"] },
          passage: { type: ["string", "null"] },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["body", "options", "correct_index", "difficulty", "explanation"],
              properties: {
                body: { type: "string" },
                options: { type: "array", items: { type: "string" }, minItems: 2 },
                correct_index: { type: "integer", minimum: 0 },
                difficulty: { type: "integer", minimum: 1, maximum: 5 },
                explanation: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
});

// Split a PDF into ≤PAGES_PER_CHUNK-page sub-PDFs. Throws on empty/oversized.
export async function splitPdf(bytes: Uint8Array): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes);
  const n = src.getPageCount();
  if (n === 0) throw new Error("PDF has no pages");
  if (n > MAX_PAGES) throw new Error(`PDF has ${n} pages; split into files of ≤${MAX_PAGES} pages first`);

  const chunks: Uint8Array[] = [];
  for (const [start, end] of chunkRanges(n, PAGES_PER_CHUNK)) {
    const doc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await doc.copyPages(src, indices);
    pages.forEach((p) => doc.addPage(p));
    chunks.push(await doc.save());
  }
  return chunks;
}

// Run extraction over the whole PDF. A failed chunk is collected as a warning,
// never aborts the batch (mirrors admin_upsert_questions' per-row leniency).
// Returns groups ready to review + POST to admin_upsert_questions.
export async function extractQuestions(
  bytes: Uint8Array,
  config: AiConfig,
): Promise<{ groups: ExtractGroup[]; warnings: string[] }> {
  const chunks = await splitPdf(bytes);
  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  // Extraction emits many questions per chunk — the coach-tuned max_tokens is too
  // small; floor it. ponytail: 4096 fits ~a dense page of questions per chunk.
  const maxOutputTokens = Math.max(config.max_tokens, 4096);

  const groups: ExtractGroup[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    let done = false;
    let lastErr: unknown = null;
    for (const modelId of models) {
      try {
        const { object } = await generateObject({
          model: getModel(config.provider, modelId),
          schema: SCHEMA,
          system: EXTRACT_SYSTEM,
          temperature: config.temperature,
          maxOutputTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Chunk ${i + 1} of ${chunks.length} of a CAT prep PDF. Extract every question on these pages.` },
                { type: "file", data: chunks[i], mediaType: "application/pdf" },
              ],
            },
          ],
        });
        groups.push(...object.groups);
        done = true;
        break;
      } catch (e) {
        lastErr = e; // try fallback model
      }
    }
    if (!done) warnings.push(`chunk ${i + 1} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  return { groups, warnings };
}
