import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// Provider switch driven by ai_config. OpenRouter is OpenAI-compatible, so one
// provider package covers both — OpenRouter via a custom baseURL, OpenAI direct
// via the default. Add a new provider by extending the switch, not the callers.
// ponytail: two providers, one package; add @ai-sdk/anthropic etc. only if a
// non-OpenAI-compatible provider is ever needed.
export interface AiConfig {
  provider: "openrouter" | "openai";
  model_id: string;
  fallback_model_id: string | null;
  enabled: boolean;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
}

export function getModel(provider: AiConfig["provider"], modelId: string): LanguageModel {
  if (provider === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY not set");
    return createOpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: key }).chat(modelId);
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  return createOpenAI({ apiKey: key }).chat(modelId);
}

// Build the user prompt from the (server-fetched) question. Correct answer +
// explanation are included so Ninja can grade itself; they never reach the client.
export function buildQuestionPrompt(q: {
  section: string;
  body: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  passage_body: string | null;
}): string {
  const letters = "ABCDEFGH";
  const opts = q.options.map((o, i) => `${letters[i]}. ${o}`).join("\n");
  const correct = `${letters[q.correct_index]}. ${q.options[q.correct_index] ?? ""}`;
  return [
    `Section: ${q.section}`,
    q.passage_body ? `Passage:\n${q.passage_body}\n` : "",
    `Question:\n${q.body}`,
    `Options:\n${opts}`,
    `Correct answer: ${correct}`,
    q.explanation ? `Official explanation: ${q.explanation}` : "",
  ].filter(Boolean).join("\n\n");
}
