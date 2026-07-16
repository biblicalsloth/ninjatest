import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createClient } from "@/lib/supabase/server";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";
import { getModel, type AiConfig } from "@/lib/ai/model";

// Admin anti-cheat narrator: reads admin_suspect_matches() server-side (no
// client-supplied data) and returns a prioritized plain-language read. Advisory
// only — the tool never punishes anyone.

const ANTICHEAT_SYSTEM = `You are a fair-play analyst for a 1v1 CAT quiz app. You get heuristic flags per (match, player): blur_correct (tab/window left, then correct after >15s — strongest external-solver signal), fast_correct (correct under 2s), hard_correct (correct on questions ≥400 ELO above the player).
Write a short prioritized read for the admin:
- Group by player (a player across multiple flagged matches matters more than one noisy match).
- For the top few, one line each: pattern, how consistent it is, and an innocent explanation if one is plausible (e.g. one blur = a notification; strong players hit hard questions legitimately).
- End with one line on who, if anyone, deserves a closer manual look.
Never recommend bans — evidence here is circumstantial. Plain text, max ~12 lines.`;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!prof?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rl = await rateLimitDb(supabase, user.id, "ninja-anticheat-user", { limit: 6, windowSeconds: 3600, failClosed: true });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "ninja-anticheat-ip", { limit: 12, windowSeconds: 3600, failClosed: true });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json({ error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } });
  }

  const { data: suspects, error: sErr } = await sb.rpc("admin_suspect_matches");
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
  if (!Array.isArray(suspects) || suspects.length === 0) {
    return NextResponse.json({ content: "No flagged matches in the last 14 days." });
  }

  const { data: cfg } = await sb.rpc("get_ai_config");
  const config = cfg as AiConfig | null;
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Ninja is currently disabled" }, { status: 503 });
  }

  const models = [config.model_id, config.fallback_model_id].filter(Boolean) as string[];
  let lastErr: unknown = null;
  for (const modelId of models) {
    try {
      const res = await generateText({
        model: getModel(config.provider, modelId),
        system: ANTICHEAT_SYSTEM,
        prompt: JSON.stringify(suspects),
        // No temperature: reasoning models reject anything but their default, so
        // pinning it here would break the provider/model switch in /admin.
        // Verdicts are advisory — a human acts on them, nothing is auto-enforced.
        maxOutputTokens: Math.max(config.max_tokens, 1500),
      });
      const text = res.text.trim();
      if (text) return NextResponse.json({ content: text, model_id: modelId });
    } catch (e) {
      lastErr = e;
    }
  }
  console.error("Ninja anticheat failed:", lastErr);
  return NextResponse.json({ error: "Analysis failed — try again" }, { status: 502 });
}
