// Pure parsing helpers for the admin question uploader.
// No React / DOM deps so they can be unit-checked in isolation (see parse.check.mjs).

export type SectionCode = "VARC" | "DILR" | "QUANT";

export type QuestionInput = {
  id?: string;
  body: string;
  options: string[];
  correct_index: number;
  difficulty?: number;
  explanation?: string | null;
  duration_ms?: number | null;
  image_url?: string | null;
};

export type GroupInput = {
  section: SectionCode;
  passage: string | null;
  passage_id?: string | null;
  passage_image_url?: string | null;
  questions: QuestionInput[];
};

const SECTIONS: SectionCode[] = ["VARC", "DILR", "QUANT"];

function asSection(v: unknown, where: string): SectionCode {
  const s = String(v ?? "").trim().toUpperCase();
  if (!SECTIONS.includes(s as SectionCode)) {
    throw new Error(`${where}: section must be one of VARC|DILR|QUANT, got "${v ?? ""}"`);
  }
  return s as SectionCode;
}

function validateQuestion(q: unknown, where: string): QuestionInput {
  if (typeof q !== "object" || q === null) throw new Error(`${where}: question must be an object`);
  const o = q as Record<string, unknown>;
  const body = o.body;
  if (typeof body !== "string" || !body.trim()) throw new Error(`${where}: "body" is required`);
  if (!Array.isArray(o.options) || o.options.length < 2 || !o.options.every((x) => typeof x === "string" && x.trim())) {
    throw new Error(`${where}: "options" must be an array of 2+ non-empty strings`);
  }
  const ci = o.correct_index;
  if (typeof ci !== "number" || !Number.isInteger(ci) || ci < 0 || ci >= o.options.length) {
    throw new Error(`${where}: "correct_index" must be an integer in range 0..${o.options.length - 1}`);
  }
  const out: QuestionInput = { body, options: o.options as string[], correct_index: ci };
  if (o.id != null) out.id = String(o.id);
  if (o.difficulty != null) {
    const d = Number(o.difficulty);
    if (!Number.isFinite(d)) throw new Error(`${where}: "difficulty" must be a number`);
    out.difficulty = d;
  }
  if (o.explanation != null && o.explanation !== "") out.explanation = String(o.explanation);
  if (o.duration_ms != null && o.duration_ms !== "") {
    const dm = Number(o.duration_ms);
    if (!Number.isFinite(dm)) throw new Error(`${where}: "duration_ms" must be a number`);
    out.duration_ms = dm;
  }
  if (o.image_url != null && o.image_url !== "") {
    const u = String(o.image_url);
    if (!/^https:\/\//.test(u)) throw new Error(`${where}: "image_url" must be an https URL`);
    out.image_url = u;
  }
  return out;
}

/** Parse a JSON string into the group-array payload. Accepts either the group shape
 *  or a bare array of flat questions (each wrapped as a standalone group). */
export function parseJson(text: string): GroupInput[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new Error("Top level must be a JSON array");
  if (data.length === 0) return [];

  // Detect flat-question array vs group array.
  const first = data[0] as Record<string, unknown>;
  const isGroupShape = first && typeof first === "object" && "questions" in first;

  if (!isGroupShape) {
    // Bare array of flat questions → wrap each as its own standalone group.
    return data.map((q, i) => {
      const question = validateQuestion(q, `Question ${i + 1}`);
      const section = asSection((q as Record<string, unknown>).section, `Question ${i + 1}`);
      return { section, passage: null, questions: [question] };
    });
  }

  return data.map((g, gi) => {
    if (typeof g !== "object" || g === null) throw new Error(`Group ${gi + 1}: must be an object`);
    const o = g as Record<string, unknown>;
    const section = asSection(o.section, `Group ${gi + 1}`);
    if (!Array.isArray(o.questions) || o.questions.length === 0) {
      throw new Error(`Group ${gi + 1}: "questions" must be a non-empty array`);
    }
    const questions = o.questions.map((q, qi) => validateQuestion(q, `Group ${gi + 1} question ${qi + 1}`));
    const group: GroupInput = {
      section,
      passage: o.passage == null || o.passage === "" ? null : String(o.passage),
      questions,
    };
    if (o.passage_id != null && o.passage_id !== "") group.passage_id = String(o.passage_id);
    if (o.passage_image_url != null && o.passage_image_url !== "") {
      const u = String(o.passage_image_url);
      if (!/^https:\/\//.test(u)) throw new Error(`Group ${gi + 1}: "passage_image_url" must be an https URL`);
      group.passage_image_url = u;
    }
    return group;
  });
}

/** Split a single CSV line honoring quoted fields ("" = escaped quote). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Split CSV text into logical rows, keeping newlines that fall inside quoted fields together. */
function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let cur = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === "\n" && !inQuotes) {
      rows.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.length) rows.push(cur);
  return rows;
}

/** Parse the CSV template shape into the group-array payload.
 *  Columns: section, passage_group, passage_body, body, options (pipe-separated),
 *  correct_index, difficulty?, explanation?, duration_ms?  (id? optional too). */
export function parseCsv(text: string): GroupInput[] {
  const rows = splitCsvRows(text).filter((r) => r.trim().length > 0);
  if (rows.length < 2) throw new Error("CSV needs a header row and at least one data row");

  const header = splitCsvLine(rows[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iSection = col("section");
  const iBody = col("body");
  const iOptions = col("options");
  const iCorrect = col("correct_index");
  if (iSection < 0 || iBody < 0 || iOptions < 0 || iCorrect < 0) {
    throw new Error('CSV header must include at least: section, body, options, correct_index');
  }
  const iGroup = col("passage_group");
  const iPassage = col("passage_body");
  const iDifficulty = col("difficulty");
  const iExplanation = col("explanation");
  const iDuration = col("duration_ms");
  const iImage = col("image_url");
  const iPassageImage = col("passage_image_url");
  const iId = col("id");

  // Preserve insertion order of groups.
  const groups: GroupInput[] = [];
  const byKey = new Map<string, GroupInput>();

  for (let r = 1; r < rows.length; r++) {
    const cells = splitCsvLine(rows[r]);
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : "");
    const where = `CSV row ${r + 1}`;

    const section = asSection(get(iSection), where);
    const optionsRaw = get(iOptions);
    const options = optionsRaw.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    const q = validateQuestion(
      {
        id: get(iId) || undefined,
        body: get(iBody),
        options,
        correct_index: Number(get(iCorrect)),
        difficulty: get(iDifficulty) || undefined,
        explanation: get(iExplanation) || undefined,
        duration_ms: get(iDuration) || undefined,
        image_url: (iImage >= 0 ? get(iImage) : "") || undefined,
      },
      where
    );

    const groupTag = iGroup >= 0 ? get(iGroup) : "";
    const passageBody = iPassage >= 0 ? get(iPassage) : "";
    const passageImage = iPassageImage >= 0 ? get(iPassageImage) : "";
    if (passageImage && !/^https:\/\//.test(passageImage)) {
      throw new Error(`${where}: "passage_image_url" must be an https URL`);
    }

    if (!groupTag) {
      // Standalone question → its own group.
      groups.push({ section, passage: passageBody || null, passage_image_url: passageImage || undefined, questions: [q] });
      continue;
    }

    const key = `${section}::${groupTag}`;
    let g = byKey.get(key);
    if (!g) {
      g = { section, passage: passageBody || null, passage_image_url: passageImage || undefined, questions: [] };
      byKey.set(key, g);
      groups.push(g);
    } else {
      if (passageBody && !g.passage) g.passage = passageBody;
      if (passageImage && !g.passage_image_url) g.passage_image_url = passageImage;
    }
    g.questions.push(q);
  }

  return groups;
}

/** Flatten groups → questions in payload row order (1-based index used by RPC error.row). */
export function flattenQuestions(groups: GroupInput[]): { group: GroupInput; question: QuestionInput; groupIndex: number }[] {
  const flat: { group: GroupInput; question: QuestionInput; groupIndex: number }[] = [];
  groups.forEach((g, gi) => g.questions.forEach((q) => flat.push({ group: g, question: q, groupIndex: gi })));
  return flat;
}
