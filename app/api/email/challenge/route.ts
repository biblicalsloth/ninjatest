import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendChallengeInvite } from "@/lib/email";
import { rateLimitDb, clientIp } from "@/lib/rate-limit";

// Conservative single-address email check. We intentionally reject arrays and
// anything that doesn't look like a lone address so this endpoint can't be used
// as a bulk mailer.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Per-user + per-IP throttle: invites are cheap to send, expensive to abuse.
  const rl = await rateLimitDb(supabase, user.id, "email-challenge-user", { limit: 5, windowSeconds: 60 });
  const rlIp = await rateLimitDb(supabase, clientIp(req), "email-challenge-ip", { limit: 10, windowSeconds: 60 });
  if (!rl.ok || !rlIp.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(rl.retryAfter, rlIp.retryAfter)) } }
    );
  }

  const body = await req.json().catch(() => null);
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  if (!to || to.length > 254 || !EMAIL_RE.test(to)) {
    return NextResponse.json({ error: "Valid recipient email required" }, { status: 400 });
  }
  if (!code || code.length > 64) {
    return NextResponse.json({ error: "Missing or invalid code" }, { status: 400 });
  }

  // AUTHORIZATION: only let the caller email-invite for a challenge they actually
  // created and that is still live. Without this, any signed-in user could send
  // branded mail to arbitrary addresses with arbitrary links (open relay / phishing).
  // Note: is_rated is taken from the DB row, never trusted from the client body.
  const { data: challenge } = await supabase
    .from("challenges")
    .select("code, host_id, is_rated, expires_at")
    .eq("code", code)
    .single();

  const ch = challenge as
    | { code: string; host_id: string; is_rated: boolean; expires_at: string }
    | null;

  if (!ch || ch.host_id !== user.id) {
    return NextResponse.json({ error: "Challenge not found" }, { status: 404 });
  }
  if (new Date(ch.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "Challenge expired" }, { status: 410 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, username")
    .eq("id", user.id)
    .single();

  const fromUsername = (profile as { display_name: string | null; username: string } | null)?.display_name
    ?? (profile as { display_name: string | null; username: string } | null)?.username
    ?? "Someone";

  const { error } = await sendChallengeInvite({
    to,
    fromUsername,
    code: ch.code,
    isRated: ch.is_rated,
  });
  if (error) return NextResponse.json({ error: "Failed to send email" }, { status: 500 });

  return NextResponse.json({ ok: true });
}
