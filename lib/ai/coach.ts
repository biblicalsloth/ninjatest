// Ninja Coach: agentic performance coach. Given a user's freeform question,
// the model autonomously pulls that user's own stats via read-RPC-backed tools
// (profile, sections, deep stats, recent opponents/margins, dailies), then
// answers grounded in the numbers it fetched. No hallucinated stats: the model
// supplies no inputs to any tool — every tool is bound server-side to the
// authenticated caller's username, so it can only ever read the caller's data.
//
// Reuses the ai_config model routing (model/fallback/dials) but NOT its
// system_prompt — that one is tuned to solve a single question ("Answer: <x>").
// Coaching needs its own persona.

import { generateText, tool, jsonSchema, stepCountIs, type ToolSet } from "ai";
import { getModel, trimCurve, CURVE_POINTS, type AiConfig } from "@/lib/ai/model";

export const COACH_SYSTEM = `You are Ninja, a sharp, encouraging CAT (Common Admission Test) prep coach.
The user is a player on a 1v1 ELO-rated CAT battle app (9 questions/match: VARC, DILR, Quant).

Before making ANY claim about the user's performance, call the tools to fetch their real stats.
Never invent a number — if you need a figure, get it from a tool. If a tool returns nothing, say so.

When you answer:
- Lead with their WEAKEST section (lowest accuracy or slowest vs the time cap) — that's where advice pays off.
- Use score margins from recent matches (narrow losses vs blowouts) and their ELO trend to judge whether they're improving, plateaued, or sliding.
- Reference opponent ELO relative to theirs to explain whether recent matchups were favorable or tough.
- Be concise, specific, and actionable. No generic "practice more." Give a concrete next step tied to the data.`;

// Socratic study-buddy mode: same agentic loop + tools + memory, but the model
// guides with questions and one hint at a time instead of dumping the solution.
// Multi-turn — relies on runCoach's message history to build on prior turns.
export const SOCRATIC_SYSTEM = `You are Ninja, a CAT (Common Admission Test) prep study buddy using the Socratic method.
Guide the user to the answer with questions and ONE small hint at a time — never give the full solution up front.

- Ask a focused question or give one hint, then STOP and wait for their reply. Keep each turn short (1-3 sentences).
- Build on what they just said. If they stay stuck after 2-3 hints on the same step, give that step, then probe the next.
- When they get it, confirm briefly and move to the next step.
- Ground yourself in real data when relevant: call the tools to reference their weak sections or their actual recent mistakes (get_my_recent_mistakes).
- Never dump the whole explanation in one message. The point is to make them think.`;

// Study-plan mode: same agentic loop and tools, different output contract.
// The plan leans on the SAME grounded stats (rating curve, section stats,
// recent form) — never generic advice.
export const PLAN_SYSTEM = `You are Ninja, a CAT (Common Admission Test) prep coach building a personal 7-day study plan.
The user plays on a 1v1 ELO-rated CAT battle app with: ranked mixed matches (3 VARC + 3 DILR + 3 Quant), friend challenges (rated/unrated, single-section mode available), solo practice drills that auto-target weak sections, and post-match Ninja explanations.

FIRST call the tools to fetch their real stats (profile + rating curve, section stats, deep stats, recent matches). Never invent a number.

Then output EXACTLY this shape (plain text, no markdown headers):
1. One-sentence diagnosis: ELO trend (improving/plateaued/sliding, with numbers) + weakest section and why.
2. Seven lines, "Mon:" through "Sun:", each ONE concrete task tied to an app mode and their weakness (e.g. "Wed: 2 practice drills — focus DILR sets; review every wrong answer with Ninja"). Keep rest/light days realistic (1-2 per week).
3. Final line "Target: " — one measurable end-of-week goal from their current numbers (accuracy %, ELO, or streak).
Be specific and terse. No filler, no motivational padding.`;

// Tools take NO model-supplied input — bound to the caller's own username in the
// closure. Empty input schema; the model just decides *whether* to call each.
const NO_INPUT = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

function buildCoachTools(sb: Sb, username: string): ToolSet {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(fn, args);
    // Never forward error.message: it's raw Postgres text going into model
    // context and possibly into the user-visible answer. Log it, don't ship it.
    if (error) {
      console.error(`coach tool ${fn} failed:`, error.message);
      return { error: "That data is unavailable right now." };
    }
    return data ?? null;
  };
  return {
    get_my_profile: tool({
      description: `The user's profile: current & peak ELO, global rank, wins/losses/draws, current & best streak, plus their ${CURVE_POINTS} most recent rating points.`,
      inputSchema: NO_INPUT,
      execute: async () => trimCurve(await call("get_profile", { p_username: username })),
    }),
    get_my_section_stats: tool({
      description: "Per-section (VARC/DILR/Quant) accuracy and timing — the primary source for identifying the user's weakest section.",
      inputSchema: NO_INPUT,
      execute: () => call("get_section_stats", { p_username: username }),
    }),
    get_my_deep_stats: tool({
      description: "Deep match-derived stats: recent form (last 10 W/L/D), avg/best score, avg victory & defeat margins, best ELO gain / worst drop, per-section wrong/skip counts & times, and top rivals with head-to-head records.",
      inputSchema: NO_INPUT,
      execute: () => call("get_profile_deep_stats", { p_username: username }),
    }),
    get_my_recent_matches: tool({
      description: "The user's last 10 matches: opponent, both scores (for the margin), result, and ELO delta.",
      inputSchema: NO_INPUT,
      execute: () => call("get_profile_matches", { p_username: username, p_limit: 10 }),
    }),
    get_my_daily_progress: tool({
      description: "The user's progress on today's daily tasks (matches played today, wins today).",
      inputSchema: NO_INPUT,
      execute: () => call("get_daily_progress", {}),
    }),
    get_my_recent_mistakes: tool({
      description: "The user's recent WRONG or SKIPPED questions across matches: section, question text, their answer vs the correct answer, and the explanation. Use this for concrete, question-specific coaching or to pick something to drill — not for stats (use the stats tools for numbers).",
      inputSchema: NO_INPUT,
      execute: () => call("get_recent_mistakes", { p_limit: 10 }),
    }),
  };
}

// Runs the agentic loop against config's model, falling back to fallback_model_id
// on error (mirrors /api/ninja/ask). Returns the final grounded answer + model used.
export async function runCoach(
  sb: Sb,
  username: string,
  question: string,
  config: AiConfig,
  system: string = COACH_SYSTEM,
  priorTurns: { question: string; answer: string }[] = [],
): Promise<{ text: string; model: string }> {
  const tools = buildCoachTools(sb, username);
  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  // Conversational memory: replay prior turns so multi-turn (esp. Socratic)
  // builds on context. Empty for one-shot modes → same as a bare prompt.
  const history = priorTurns.flatMap((t) => [
    { role: "user" as const, content: t.question },
    { role: "assistant" as const, content: t.answer },
  ]);
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(modelId),
        system,
        messages: [...history, { role: "user", content: question }],
        tools,
        stopWhen: stepCountIs(6), // cap tool-call rounds; metered LLM
        temperature: config.temperature,
        maxOutputTokens: config.max_tokens,
      });
      const text = res.text.trim();
      if (text) return { text, model: modelId };
    } catch (e) {
      lastErr = e; // try fallback
    }
  }
  throw lastErr ?? new Error("empty response");
}
