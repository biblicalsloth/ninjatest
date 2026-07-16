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
