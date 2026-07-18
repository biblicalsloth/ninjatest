import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, parsePlan, PLAN_SYSTEM, type AiConfig, type StudyPlan } from "@/lib/ai/model";
import { inLiveMatch, LIVE_MATCH_ERROR } from "@/lib/ai/live-match";

// Ninja weekly study plan. One plan per user per week, cached in
// ninja_study_plans, grounded in get_learner_profile (their real rolled-up
// weak areas + ELO trend), returned as JSON the calendar renders.
//
// Single non-agentic call, unlike the coach it grew out of: the learner profile
// IS the grounding, so there is nothing for a tool loop to go and fetch. That
// drops the plan from a $0.007-0.043 stepCountIs(6) transcript replay to one
// ~$0.002 call — and the cache means most page loads cost nothing at all.

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // No LLM while in a match — same rule, one definition (lib/ai/live-match.ts).
  // Fail-closed. This route takes no free text, but it rides the rule with the
  // rest so there is never a user-facing Ninja route outside the gate.
  if (await inLiveMatch(supabase, user.id)) {
    return NextResponse.json({ error: LIVE_MATCH_ERROR }, { status: 403 });
  }

  // Metered LLM: fail-closed, so a limiter blip can't open an unmetered-spend hole.
  const rl = await rateLimitDb(supabase, user.id, "ninja-plan-user", { limit: 4, windowSeconds: 3600, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-plan-ip", { limit: 20, windowSeconds: 3600, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "You've reached the plan limit for now. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  const regenerate = body?.regenerate === true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  // The server owns "this week" (date_trunc('week', now())), so a client in
  // another timezone can't mint itself a second billable week.
  const { data: rows, error: readErr } = await sb.rpc("get_ninja_study_plan", { p_week_start: null });
  if (readErr) {
    console.error("get_ninja_study_plan failed:", readErr.message);
    return NextResponse.json({ error: "Unavailable" }, { status: 502 });
  }
  const cached = (Array.isArray(rows) ? rows[0] : null) as
    { week_start: string; plan: StudyPlan | null; regens: number } | null;
  if (!cached) return NextResponse.json({ error: "Unavailable" }, { status: 502 });

  // Cache hit and no explicit regenerate: never re-bill. A user hammering the
  // page costs one read.
  if (cached.plan && !regenerate) {
    return NextResponse.json({ week_start: cached.week_start, plan: cached.plan, regens: cached.regens, cached: true });
  }
  // Bounded regenerate, checked PRE-spend: one rewrite per week. save_ninja_study_plan
  // enforces the same bound, so this check only saves the user a wasted call.
  if (regenerate && cached.plan && cached.regens >= 1) {
    return NextResponse.json({ error: "You've already regenerated this week's plan. A fresh one unlocks Monday." }, { status: 429 });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const { data: learner, error: lpErr } = await sb.rpc("get_learner_profile", { p_limit: 50 });
  if (lpErr) {
    console.error("get_learner_profile failed:", lpErr.message);
    return NextResponse.json({ error: "Unavailable" }, { status: 502 });
  }
  // A player with no rated matches has nothing to ground a plan in, and a plan
  // invented from zero data is exactly the generic CAT advice this replaces.
  if (!learner || (learner as { matches_analyzed?: number }).matches_analyzed === 0) {
    return NextResponse.json({ error: "Play a few ranked matches first — Ninja builds the plan from your real results." }, { status: 400 });
  }

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let plan: StudyPlan | null = null;
  let usedModel = "";
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(modelId),
        system: PLAN_SYSTEM,
        prompt: JSON.stringify(learner),
        temperature: config.temperature,
        // glm-5.2 spends output budget on reasoning BEFORE emitting any text,
        // so a cap sized to the visible JSON returns an empty string. Floor it.
        maxOutputTokens: Math.max(config.max_tokens, 2000),
      });
      plan = parsePlan(res.text);
      usedModel = modelId;
      // Unparseable counts as failure, so the fallback model actually gets a
      // turn instead of the loop breaking on a truthy-but-useless response.
      if (plan) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!plan) {
    console.error("Ninja plan failed:", lastErr);
    return NextResponse.json({ error: "Ninja could not build your plan right now" }, { status: 502 });
  }

  const { error: saveErr } = await sb.rpc("save_ninja_study_plan", {
    p_plan: plan, p_model: usedModel, p_week_start: null, p_replace: regenerate,
  });
  if (saveErr) console.error("save_ninja_study_plan failed:", saveErr.message);

  // Re-read: on a first-write-wins race another request's plan is the stored
  // one, and returning the discarded local copy would show a plan the next
  // reload contradicts.
  const { data: after } = await sb.rpc("get_ninja_study_plan", { p_week_start: null });
  const fresh = (Array.isArray(after) ? after[0] : null) as
    { week_start: string; plan: StudyPlan | null; regens: number } | null;
  return NextResponse.json({
    week_start: fresh?.week_start ?? cached.week_start,
    plan: fresh?.plan ?? plan,
    regens: fresh?.regens ?? 0,
    cached: false,
  });
}
