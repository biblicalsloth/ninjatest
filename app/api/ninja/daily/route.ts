import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, type AiConfig } from "@/lib/ai/model";
import { inLiveMatch, LIVE_MATCH_ERROR } from "@/lib/ai/live-match";

// Ninja daily focus: one personalized challenge line per day, cached in
// ninja_daily_focus. Single cheap non-agentic call — the route fetches the
// caller's section stats + recent form itself and hands them to the model.

const DAILY_SYSTEM = `You are Ninja, a CAT prep coach. Given a player's per-section stats and recent form, write EXACTLY ONE challenge line for today (max 140 characters).
It must be concrete, doable today inside the app (ranked matches, a section challenge vs a friend, practice drills), and target their sharpest current weakness. Mention the section by name. No quotes, no emoji, no preamble — output only the line itself.`;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // No LLM call of any kind while the caller is in a match. This one takes no
  // user input, so it isn't a cheat channel like coach/solve — it's here for one
  // rule, one place. The client reads the cache itself and hides on non-ok, so a
  // 403 mid-match costs nothing.
  if (await inLiveMatch(supabase, user.id)) {
    return NextResponse.json({ error: LIVE_MATCH_ERROR }, { status: 403 });
  }

  const rl = await rateLimitDb(supabase, user.id, "ninja-daily-user", { limit: 4, windowSeconds: 3600, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-daily-ip", { limit: 30, windowSeconds: 3600, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const { data: cachedRows } = await sb.rpc("get_ninja_daily_focus");
  const cached = Array.isArray(cachedRows) ? cachedRows[0] : null;
  if (cached?.content) {
    return NextResponse.json({ content: cached.content, cached: true });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const { data: prof } = await sb.from("profiles").select("username, elo").eq("id", user.id).single();
  if (!prof?.username) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  const [{ data: sections }, { data: deep }] = await Promise.all([
    sb.rpc("get_section_stats", { p_username: prof.username }),
    sb.rpc("get_profile_deep_stats", { p_username: prof.username }),
  ]);

  const prompt = JSON.stringify({
    elo: prof.elo,
    section_stats: sections ?? null,
    deep_stats: deep ?? null,
  });

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let text = "";
  let usedModel = "";
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(modelId),
        system: DAILY_SYSTEM,
        prompt,
        temperature: config.temperature,
        // Not 200. The output is one ~140-char line, but reasoning models spend
        // the output budget thinking BEFORE emitting any text — z-ai/glm-5.2
        // burns ~224 reasoning tokens on a trivial prompt, so a 200 cap returned
        // an empty string every time. The line is truncated below anyway.
        maxOutputTokens: Math.max(config.max_tokens, 1200),
      });
      text = res.text.trim().split("\n")[0].slice(0, 200);
      usedModel = modelId;
      if (text) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!text) {
    console.error("Ninja daily focus failed:", lastErr);
    return NextResponse.json({ error: "Unavailable" }, { status: 502 });
  }

  await sb.rpc("save_ninja_daily_focus", { p_model: usedModel, p_content: text });
  return NextResponse.json({ content: text, cached: false });
}
