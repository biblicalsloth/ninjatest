// Pure parsing helpers for the admin question uploader.
// No React / DOM deps so they can be unit-checked in isolation:
//   node app/admin/parse.check.mts

export type SectionCode = "VARC" | "DILR" | "QUANT";

export type QuestionType = "mcq" | "tita";

export type QuestionInput = {
  id?: string;
  body: string;
  /** Defaults to "mcq" when the upload omits it, so existing files keep working. */
  qtype: QuestionType;
  /** Always [] for tita — the answer is typed, not picked. */
  options: string[];
  /** Always 0 for tita; admin_upsert_questions ignores it on that branch. */
  correct_index: number;
  /** tita only: the exact expected answer, matched by tita_matches(). */
  answer_value?: string;
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

// Numeric TITA keys only: grouped thousands (1,234) or plain/decimal (8, 0.5, -3).
// Must stay in step with questions_tita_answer_numeric (20260717150000) and with
// TITA_INPUT in app/match/[matchId]/match-client.tsx.
const TITA_ANSWER = /^[+-]?[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?$|^[+-]?[0-9]*\.?[0-9]+$/;

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

  const qtype = (o.qtype == null || o.qtype === "" ? "mcq" : String(o.qtype).trim().toLowerCase()) as QuestionType;
  if (qtype !== "mcq" && qtype !== "tita") {
    throw new Error(`${where}: "qtype" must be "mcq" or "tita", got "${String(o.qtype)}"`);
  }

  // The two types are scored by different columns: MCQ by correct_index into
  // options, TITA by tita_matches() against answer_value. A TITA carries
  // neither option nor index, so mirror admin_upsert_questions and store the
  // ([], 0) placeholders the NOT NULL columns require.
  let options: string[] = [];
  let correct_index = 0;
  let answer_value: string | undefined;

  if (qtype === "tita") {
    const av = o.answer_value;
    if (typeof av !== "string" || !av.trim()) {
      throw new Error(`${where}: tita questions require a non-empty "answer_value"`);
    }
    if (av.trim().length > 200) throw new Error(`${where}: "answer_value" must be at most 200 chars`);
    if (!TITA_ANSWER.test(av.trim())) {
      // The in-match answer box accepts digits only, so a key carrying a unit
      // could never be matched by anyone. Mirrors the DB's
      // questions_tita_answer_numeric constraint.
      throw new Error(
        `${where}: "answer_value" must be numeric — no units, currency or words (e.g. 1900, not "Rs.1900")`
      );
    }
    answer_value = av.trim();
  } else {
    if (!Array.isArray(o.options) || o.options.length < 2 || !o.options.every((x) => typeof x === "string" && x.trim())) {
      throw new Error(`${where}: "options" must be an array of 2+ non-empty strings`);
    }
    const ci = o.correct_index;
    if (typeof ci !== "number" || !Number.isInteger(ci) || ci < 0 || ci >= o.options.length) {
      throw new Error(`${where}: "correct_index" must be an integer in range 0..${o.options.length - 1}`);
    }
    options = o.options as string[];
    correct_index = ci;
  }

  const out: QuestionInput = { body, qtype, options, correct_index };
  if (answer_value != null) out.answer_value = answer_value;
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
  const iQtype = col("qtype");
  const iAnswer = col("answer_value");
  if (iSection < 0 || iBody < 0) {
    throw new Error('CSV header must include at least: section, body');
  }
  // A TITA-only sheet legitimately has no options/correct_index columns, so
  // those are only mandatory for a sheet that never declares a qtype (i.e. every
  // pre-TITA file, whose error message is preserved exactly).
  if (iQtype < 0 && (iOptions < 0 || iCorrect < 0)) {
    throw new Error('CSV header must include at least: section, body, options, correct_index');
  }
  if (iQtype >= 0 && iAnswer < 0) {
    throw new Error('CSV header declares "qtype" but has no "answer_value" column for tita rows');
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
    const correctRaw = iCorrect >= 0 ? get(iCorrect) : "";
    const q = validateQuestion(
      {
        id: get(iId) || undefined,
        body: get(iBody),
        qtype: (iQtype >= 0 ? get(iQtype) : "") || undefined,
        options,
        // NaN, not Number(""), for a blank cell: Number("") is 0, which is a
        // VALID correct_index, so a row with an empty correct_index used to be
        // accepted silently as "option A is correct" instead of erroring.
        correct_index: correctRaw === "" ? NaN : Number(correctRaw),
        answer_value: (iAnswer >= 0 ? get(iAnswer) : "") || undefined,
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
