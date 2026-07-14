import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, type AiConfig } from "@/lib/ai/model";

// Post-match debrief: one cached AI analysis per player per match. The data
// RPC enforces participant + finished; the save RPC is first-write-wins, so a
// double-click can't double-bill.

const DEBRIEF_SYSTEM = `You are Ninja, a CAT prep performance analyst. You get the numeric story of one finished 9-question 1v1 match (per-question section, difficulty as question ELO, time cap, and both players' correctness/points/time).
Write a debrief for "me" (not the opponent). Format, exactly:
- 3 to 5 short bullet lines, each starting with "- ".
- First bullet: the single biggest reason for the result (points swing, e.g. "You lost ~120 pts to two slow VARC misses").
- Middle bullets: sharpest weakness pattern (slow vs cap, snap-guessing under 10s, skips) and one genuine strength, each tied to concrete numbers (section, question numbers, seconds vs cap).
- Last bullet: ONE concrete, doable next step.
No headers, no praise-padding, no generic advice. Times are in ms; convert to seconds. A "skipped" answer scored 0; wrong answers score negative.`;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = await rateLimitDb(supabase, user.id, "ninja-debrief-user", { limit: 6, windowSeconds: 60, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-debrief-ip", { limit: 12, windowSeconds: 60, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const body = await req.json().catch(() => null);
  const matchId = typeof body?.match_id === "string" ? body.match_id : "";
  if (!matchId) return NextResponse.json({ error: "Missing match_id" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  // Cached? Return it — never re-bill.
  const { data: existingRows } = await sb.rpc("get_ninja_debrief", { p_match_id: matchId });
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing?.content) {
    return NextResponse.json({ content: existing.content, model_id: existing.model_id, cached: true });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const { data: story, error: dErr } = await sb.rpc("get_debrief_data", { p_match_id: matchId });
  if (dErr || !story) {
    const msg = dErr?.message ?? "";
    if (msg.includes("not finished")) return NextResponse.json({ error: "Match not finished yet" }, { status: 400 });
    return NextResponse.json({ error: "Not allowed for this match" }, { status: 403 });
  }

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let text = "";
  let usedModel = "";
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(config.provider, modelId),
        system: DEBRIEF_SYSTEM,
        prompt: JSON.stringify(story),
        temperature: config.temperature,
        maxOutputTokens: Math.max(config.max_tokens, 1200),
      });
      text = res.text.trim();
      usedModel = modelId;
      if (text) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!text) {
    console.error("Ninja debrief failed:", lastErr);
    return NextResponse.json({ error: "Ninja could not analyze this match right now" }, { status: 502 });
  }

  await sb.rpc("save_ninja_debrief", { p_match_id: matchId, p_model: usedModel, p_content: text });
  return NextResponse.json({ content: text, model_id: usedModel, cached: false });
}
