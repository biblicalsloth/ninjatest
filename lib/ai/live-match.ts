// No LLM help while you're in a match.
//
// get_question_for_ninja already refuses an ask on a live match server-side, but
// /api/ninja/{coach,solve} take arbitrary user input — a second tab with the
// question pasted in (or screenshotted into a PDF) is the same cheat by another
// door. /api/ninja/daily takes no input and isn't a cheat channel; it's gated on
// the same rule anyway so "no LLM while in a match" has one definition and every
// user-facing route reads it from here.
// Live = the canonical notion used by join_queue: status in
// ('active','pending') for the caller (pending is bounded — advance_timed_out
// abandons no-shows after 2 min).
//
// Reads `matches` through RLS (participants-only), so no new RPC. Fail-closed:
// an error blocks the call, matching the metered-LLM limiters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function inLiveMatch(sb: any, userId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("matches")
    .select("id")
    .or(`player_a.eq.${userId},player_b.eq.${userId}`)
    .in("status", ["active", "pending"])
    .limit(1);
  if (error) {
    console.error("inLiveMatch check failed:", error);
    return true;
  }
  return Array.isArray(data) && data.length > 0;
}

export const LIVE_MATCH_ERROR = "Ninja is off while you're in a match. Finish the match first.";

// Waitlist mode: the app isn't launched, so no metered LLM route may run at all.
// proxy.ts's matcher excludes /api, so the middleware waitlist gate never sees
// these routes — signing up still works in waitlist mode, which would otherwise
// leave /api/ninja/solve ($0.06–0.31 per PDF) open on the public domain to
// anyone with an account. Every user-facing ninja route checks this first.
export const APP_LOCKED = process.env.NEXT_PUBLIC_APP_MODE === "waitlist";
export const APP_LOCKED_ERROR = "Ninjatest is in private beta. Join the waitlist at ninjatest.app.";
