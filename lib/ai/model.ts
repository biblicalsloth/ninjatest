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
// my_selected_index/my_is_correct (canonical, from the caller's own answer row)
// make the explanation distractor-aware: the model names the trap the user fell
// for. Option references use TEXT, not letters — per-player display shuffle
// means letters don't match what the user saw.
export function buildQuestionPrompt(q: {
  section: string;
  body: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  passage_body: string | null;
  my_selected_index?: number | null;
  my_is_correct?: boolean | null;
}): string {
  const letters = "ABCDEFGH";
  const opts = q.options.map((o, i) => `${letters[i]}. ${o}`).join("\n");
  const correct = `${letters[q.correct_index]}. ${q.options[q.correct_index] ?? ""}`;

  let pickLine = "";
  if (q.my_selected_index != null && q.options[q.my_selected_index] != null) {
    pickLine = q.my_is_correct
      ? `The user answered this correctly (picked "${q.options[q.my_selected_index]}"). Briefly confirm the fastest correct approach.`
      : `The user picked the WRONG option: "${q.options[q.my_selected_index]}". After solving, explain the specific mistake or trap that makes that option tempting, and why it fails. Refer to options by their text, not letters.`;
  } else if (q.my_selected_index === null && q.my_is_correct != null) {
    pickLine = "The user skipped this question. After solving, say whether it was worth attempting and what the fastest route was.";
  }

  return [
    `Section: ${q.section}`,
    q.passage_body ? `Passage:\n${q.passage_body}\n` : "",
    `Question:\n${q.body}`,
    `Options:\n${opts}`,
    `Correct answer: ${correct}`,
    q.explanation ? `Official explanation: ${q.explanation}` : "",
    pickLine,
  ].filter(Boolean).join("\n\n");
}
