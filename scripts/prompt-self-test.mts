// Self-check for buildQuestionPrompt. No network, no env, no deps:
//
//   node scripts/prompt-self-test.ts
//
// Node 24 strips types natively, so this needs no test runner. It guards the
// one thing that silently produces a WRONG answer rather than an error: a TITA
// question rendered through the MCQ branch, where options='[]' and
// correct_index=0 make "Correct answer: A. " — a blank key the model can't
// notice is missing.
import { buildQuestionPrompt } from "../lib/ai/model.ts";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) return;
  failed++;
  console.error(`FAIL: ${name}`);
}

const MCQ = {
  section: "QUANT",
  body: "What is 6 x 7?",
  options: ["40", "42", "44", "48"],
  correct_index: 1,
  explanation: "6 x 7 = 42",
  passage_body: null,
};

// ── MCQ: unchanged behaviour ──
const mcqWrong = buildQuestionPrompt({ ...MCQ, my_selected_index: 2, my_is_correct: false });
check("mcq lists options", mcqWrong.includes("A. 40") && mcqWrong.includes("B. 42"));
check("mcq states the key", mcqWrong.includes("Correct answer: B. 42"));
check("mcq names the wrong pick", mcqWrong.includes('WRONG option: "44"'));

const mcqSkip = buildQuestionPrompt({ ...MCQ, my_selected_index: null, my_is_correct: false });
check("mcq skip detected", mcqSkip.includes("skipped this question"));

// No answer row at all (question never reached / no attempt recorded) → no pick line.
const mcqNone = buildQuestionPrompt(MCQ);
check("mcq without an answer row makes no claim", !mcqNone.includes("skipped this question"));

// ── TITA: the regression this file exists for ──
const TITA = {
  section: "QUANT",
  body: "How many divisors does 60 have?",
  options: [] as string[],   // TITA rows really do carry '[]' and correct_index 0
  correct_index: 0,
  explanation: "60 = 2^2 x 3 x 5 → 12",
  passage_body: null,
  qtype: "tita",
  answer_value: "12",
};

const titaWrong = buildQuestionPrompt({ ...TITA, my_selected_index: null, my_is_correct: false, my_answer_text: "10" });
check("tita states the real key", titaWrong.includes("Correct answer: 12"));
check("tita never emits a blank letter key", !titaWrong.includes("Correct answer: A."));
check("tita emits no options block", !titaWrong.includes("Options:"));
check("tita declares its type", titaWrong.includes("TITA"));
check("tita names the typed answer", titaWrong.includes('WRONG answer: "10"'));
// The bug: selected_index is null for every TITA answer, so the MCQ branch
// called a typed attempt a skip.
check("tita typed answer is not a skip", !titaWrong.includes("skipped this question"));

const titaSkip = buildQuestionPrompt({ ...TITA, my_selected_index: null, my_is_correct: false, my_answer_text: null });
check("tita real skip detected", titaSkip.includes("skipped this question"));

const titaRight = buildQuestionPrompt({ ...TITA, my_selected_index: null, my_is_correct: true, my_answer_text: "12" });
check("tita correct answer confirmed", titaRight.includes("answered this correctly"));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("prompt-self-test: all checks passed");
