import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// Every Ninja model call goes through OpenRouter. One key (OPENROUTER_API_KEY),
// one bill, one code path — model_id/fallback_model_id in ai_config pick the
// model, and OpenRouter picks the upstream. @ai-sdk/openai is the client here
// because OpenRouter speaks the OpenAI wire format; the package name is about
// protocol, not about who bills us.
//
// ponytail: no provider switch. The old one branched to OpenAI direct and was
// never used (the live row has been 'openrouter' since it was seeded), and it
// cost a second API key everywhere. Routing to a different upstream is what
// OpenRouter is for — prefix the model id (openai/…, google/…, anthropic/…).
export interface AiConfig {
  model_id: string;
  fallback_model_id: string | null;
  enabled: boolean;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function getModel(modelId: string): LanguageModel {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return createOpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey: key }).chat(modelId);
}

// get_profile's `curve` is every rating_history row ever, with no LIMIT in the
// RPC (the profile graph wants the whole thing). The coach must NOT hand that
// to the model: generateText replays every prior tool result at each of
// stepCountIs(6) steps, so the curve's token cost is quadratic in turns and
// linear in career length — on the priciest route in the app. Trend and recent
// form only need the tail. Lives here, not in coach.ts, because this file is
// alias-free and therefore node-loadable by the self-tests (see model.check.mts).
export const CURVE_POINTS = 30;

// `curve` is ascending by created_at, so slice(-N) is the most recent N.
export function trimCurve(data: unknown): unknown {
  const d = data as { curve?: unknown[] } | null;
  if (!d || !Array.isArray(d.curve) || d.curve.length <= CURVE_POINTS) return data;
  return {
    ...d,
    curve: d.curve.slice(-CURVE_POINTS),
    // Tell the model it's a tail, so it can't claim this is the full career.
    curve_note: `showing the ${CURVE_POINTS} most recent of ${d.curve.length} rating points`,
  };
}

// ── Weekly study plan ─────────────────────────────────────────────────────
// The plan is JSON, not prose, because the calendar renders cells: free text
// can't be laid out into a 7-column grid without the client re-parsing English.
// Lives here with buildQuestionPrompt for the same reason CURVE_POINTS does —
// this file is alias-free and therefore node-loadable by model.check.mts.

export const PLAN_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type PlanDay = (typeof PLAN_DAYS)[number];

// Sections the chips can colour. REST is a real answer — a 7/7 grind week is
// advice no one follows, so the model is allowed to say "rest".
const PLAN_SECTIONS = ["VARC", "DILR", "QUANT", "MIXED", "REST"] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

// Caps the render (and the tokens): 7 days x 4 tasks is a full week already,
// and a model that returns 40 tasks for Monday shouldn't be able to blow up
// the grid or the row it gets stored in.
export const PLAN_MAX_TASKS_PER_DAY = 4;

export interface PlanTask { section: PlanSection; task: string; minutes: number }
export interface StudyPlan {
  diagnosis: string;
  target: string;
  days: Partial<Record<PlanDay, PlanTask[]>>;
}

export const PLAN_SYSTEM = `You are Ninja, a CAT (Common Admission Test) prep coach building ONE week of study for a player on a 1v1 ELO-rated CAT battle app.
App modes you can prescribe: ranked mixed matches (3 VARC + 3 DILR + 3 Quant), friend challenges (rated/unrated, single-section mode), solo practice drills that auto-target weak sections, and post-match Ninja explanations of any wrong answer.

You are given the player's REAL rolled-up stats. Ground every choice in them — never generic CAT advice, never a number they didn't give you.
Read the stats like a coach:
- Lowest accuracy section, and whether it's an accuracy problem or a clock problem (mean_time_ms vs mean_cap_ms).
- skip_rate and timeouts are different failures: skipping is a choice, timing out is losing the clock.
- A TITA-vs-MCQ accuracy gap is real — TITA has no guess floor.
- The ELO band split says whether they lose on easy or hard questions. Those need different weeks.
- elo_trend (deviation + slope_per_match) says improving, plateaued, or sliding.

Reply with JSON ONLY — no markdown fence, no prose around it:
{"diagnosis":"one sentence, cites their numbers","target":"one measurable end-of-week goal from their current numbers","days":{"Mon":[{"section":"QUANT","task":"3 practice drills, TITA focus; review every miss with Ninja","minutes":45}],"Tue":[...],...}}
Rules: all 7 keys Mon..Sun. section is one of VARC, DILR, QUANT, MIXED, REST. 1-2 tasks per day, max ${PLAN_MAX_TASKS_PER_DAY}. minutes is an integer 0-240 (0 only for REST). task is one concrete sentence tied to an app mode and their weakness. Keep 1-2 light or rest days — a 7/7 plan gets abandoned.`;

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

// Parse the model's plan. Tolerant of the two things models actually do wrong
// (fence the JSON, chat around it), strict about everything else: an unknown
// section or a NaN minutes drops the task rather than reaching the grid, and a
// plan with no valid task at all is a failure, so the route tries its fallback
// model instead of caching a blank week forever.
export function parsePlan(raw: string): StudyPlan | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const rawDays = (o.days ?? {}) as Record<string, unknown>;

  const days: Partial<Record<PlanDay, PlanTask[]>> = {};
  let total = 0;
  for (const day of PLAN_DAYS) {
    const items = rawDays[day];
    if (!Array.isArray(items)) continue;
    const tasks: PlanTask[] = [];
    // Cap VALID tasks, not raw items: slicing the input first lets a couple of
    // junk entries eat the day's slots and silently drop good tasks behind
    // them. The raw scan is bounded separately so a 10k-item day can't spin.
    for (const it of items.slice(0, 20)) {
      if (tasks.length >= PLAN_MAX_TASKS_PER_DAY) break;
      const t = (it ?? {}) as Record<string, unknown>;
      const section = String(t.section ?? "").toUpperCase() as PlanSection;
      const task = clean(t.task, 200);
      if (!PLAN_SECTIONS.includes(section) || !task) continue;
      // Math.round(NaN) is NaN and NaN comparisons are all false, so clamp with
      // an explicit finite check — otherwise a "minutes":"forty" lands NaN in
      // the JSON column and renders as "NaN min".
      const n = Math.round(Number(t.minutes));
      tasks.push({ section, task, minutes: Number.isFinite(n) ? Math.min(Math.max(n, 0), 240) : 0 });
    }
    if (tasks.length) {
      days[day] = tasks;
      total += tasks.length;
    }
  }
  if (!total) return null;
  return { diagnosis: clean(o.diagnosis, 400), target: clean(o.target, 200), days };
}

// Build the user prompt from the (server-fetched) question. Correct answer +
// explanation are included so Ninja can grade itself; they never reach the client.
// The caller's own answer (canonical index for MCQ, typed text for TITA) makes
// the explanation distractor-aware: the model names the trap the user fell for.
// MCQ option references use TEXT, not letters — per-player display shuffle
// means letters don't match what the user saw.
//
// TITA questions carry options = '[]' and correct_index = 0, so the MCQ branch
// would render "Correct answer: A. " — a blank key. Branch on qtype, never on
// options.length: the key lives in answer_value and the user's attempt in
// answer_text (selected_index stays null, which the MCQ branch misreads as a skip).
export function buildQuestionPrompt(q: {
  section: string;
  body: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  passage_body: string | null;
  my_selected_index?: number | null;
  my_is_correct?: boolean | null;
  qtype?: string | null;
  answer_value?: string | null;
  my_answer_text?: string | null;
}): string {
  const isTita = q.qtype === "tita";
  const letters = "ABCDEFGH";

  // Did the user attempt it at all? Same notion the DB scores against:
  // no canonical pick AND no typed answer = skip.
  const attempted = isTita ? q.my_answer_text != null : q.my_selected_index != null;
  const answered = q.my_is_correct != null; // an answer row exists for this question

  let pickLine = "";
  if (isTita) {
    if (attempted) {
      pickLine = q.my_is_correct
        ? `The user answered this correctly (typed "${q.my_answer_text}"). Briefly confirm the fastest correct approach.`
        : `The user typed the WRONG answer: "${q.my_answer_text}". After solving, explain the specific slip or trap that produces that value, and why it fails.`;
    } else if (answered) {
      pickLine = "The user skipped this question. After solving, say whether it was worth attempting and what the fastest route was.";
    }
  } else if (attempted && q.options[q.my_selected_index as number] != null) {
    pickLine = q.my_is_correct
      ? `The user answered this correctly (picked "${q.options[q.my_selected_index as number]}"). Briefly confirm the fastest correct approach.`
      : `The user picked the WRONG option: "${q.options[q.my_selected_index as number]}". After solving, explain the specific mistake or trap that makes that option tempting, and why it fails. Refer to options by their text, not letters.`;
  } else if (answered) {
    pickLine = "The user skipped this question. After solving, say whether it was worth attempting and what the fastest route was.";
  }

  return [
    `Section: ${q.section}`,
    q.passage_body ? `Passage:\n${q.passage_body}\n` : "",
    `Question:\n${q.body}`,
    isTita
      ? "This is a TITA (Type-In-The-Answer) question: there are no options — the answer is typed in exactly. Give your final answer as the exact value, not as an option letter."
      : `Options:\n${q.options.map((o, i) => `${letters[i]}. ${o}`).join("\n")}`,
    isTita
      ? `Correct answer: ${q.answer_value ?? "(not recorded)"}`
      : `Correct answer: ${letters[q.correct_index]}. ${q.options[q.correct_index] ?? ""}`,
    q.explanation ? `Official explanation: ${q.explanation}` : "",
    pickLine,
  ].filter(Boolean).join("\n\n");
}
