// Live end-to-end probe for the Ninja ask path. SPENDS MONEY — one real
// OpenRouter call per question probed (~$0.002 each on z-ai/glm-5.2).
//
//   node scripts/ninja-live-probe.mts --dry-run   # print the prompts, call nothing
//   node scripts/ninja-live-probe.mts             # make the real calls
//
// Why this exists: /api/ninja/ask can't be exercised without a finished match,
// and the DB has none. This probe reproduces exactly what that route does —
// reads the LIVE ai_config, pulls a REAL bank question through the same fields
// get_question_for_ninja returns, builds the prompt with the SAME
// buildQuestionPrompt, and calls the same model through the same base URL.
// What it does NOT cover: auth, the reach/attempt guards, and save_ninja_response.
//
// It probes a TITA question specifically. That is the path 20260716201821
// fixed: before it, the prompt carried a blank key ("Correct answer: A. ") and
// the model was graded against nothing.
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal } from "./env.mjs";
import { buildQuestionPrompt, OPENROUTER_BASE_URL } from "../lib/ai/model.ts";

loadEnvLocal(); // .env.local beats a stale shell export — see CLAUDE.md

const dryRun = process.argv.includes("--dry-run");
const key = process.env.OPENROUTER_API_KEY;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !svc) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
if (!dryRun && !key) throw new Error("OPENROUTER_API_KEY not set");

const sb = createClient(url, svc, { auth: { persistSession: false } });

// Live routing config — the same row every route reads at request time.
const { data: cfg, error: cfgErr } = await sb.rpc("get_ai_config");
if (cfgErr) throw cfgErr;
console.log(`ai_config: model=${cfg.model_id} fallback=${cfg.fallback_model_id ?? "(none)"} temp=${cfg.temperature} max_tokens=${cfg.max_tokens} enabled=${cfg.enabled}`);
if (!cfg.enabled) throw new Error("Ninja is disabled in ai_config");

// A real TITA row, read through the columns get_question_for_ninja now returns.
// service_role bypasses RLS — that is what makes this readable outside a match.
const { data: qs, error: qErr } = await sb
  .from("questions")
  .select("id, section, body, options, correct_index, explanation, qtype, answer_value")
  .eq("qtype", "tita")
  .eq("is_active", true)
  .order("difficulty", { ascending: true })
  .limit(2);
if (qErr) throw qErr;
if (!qs?.length) throw new Error("no active TITA questions found");

let failed = 0;

for (const q of qs) {
  // Simulate a user who typed a WRONG answer, so the distractor-aware pick line
  // is exercised too — that branch read a TITA attempt as a "skip" before the fix.
  const prompt = buildQuestionPrompt({
    section: q.section,
    body: q.body,
    options: Array.isArray(q.options) ? q.options : [],
    correct_index: q.correct_index,
    explanation: q.explanation,
    passage_body: null,
    my_selected_index: null,
    my_is_correct: false,
    qtype: q.qtype,
    answer_value: q.answer_value,
    my_answer_text: "0",
  });

  console.log(`\n${"=".repeat(70)}\n[${q.qtype}] ${q.id}  expected answer: ${q.answer_value}\n${"=".repeat(70)}`);
  console.log(prompt);

  if (dryRun) continue;

  const models = [cfg.model_id, cfg.fallback_model_id].filter(Boolean) as string[];
  let text = "";
  let used = "";
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: createOpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey: key! }).chat(modelId),
        system: cfg.system_prompt,
        prompt,
        temperature: cfg.temperature,
        maxOutputTokens: cfg.max_tokens,
      });
      text = res.text.trim();
      used = modelId;
      console.log(`\n--- ${modelId} · in ${res.usage?.inputTokens} / out ${res.usage?.outputTokens} tokens ---`);
      if (text) break; // empty text ⇒ fall through to the fallback, as /api/ninja/ask now does
      console.log("(empty content — falling through to fallback)");
    } catch (e) {
      lastErr = e;
      console.log(`\n--- ${modelId} threw: ${e instanceof Error ? e.message : String(e)} ---`);
    }
  }
  if (!text) {
    failed++;
    console.error(`NO ANSWER for ${q.id}:`, lastErr);
    continue;
  }

  console.log(`\n${text}\n`);
  // Grade it: the expected value must appear in the model's answer.
  const hit = text.includes(String(q.answer_value));
  console.log(hit
    ? `✅ ${used} produced the expected answer (${q.answer_value})`
    : `❌ ${used} did NOT contain the expected answer (${q.answer_value})`);
  if (!hit) failed++;
}

console.log(`\n${dryRun ? "DRY RUN — no calls made." : failed ? `${failed} probe(s) failed.` : "All probes answered correctly."}`);
process.exit(failed ? 1 : 0);
