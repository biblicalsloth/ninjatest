import { NextResponse, after } from "next/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { createPublicClient } from "@/lib/supabase/server";

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// Clamp a free-text field to a sane length; reject non-strings.
function field(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

export async function POST(req: Request) {
  // This endpoint is unauthenticated, so throttle hard by IP to keep it from
  // being used to flood the downstream Google Sheet.
  const rl = rateLimit(`waitlist:${clientIp(req)}`, { limit: 5, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const email = field(raw.email, 254).toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const payload = {
    name: field(raw.name, 120),
    email,
    phone: field(raw.phone, 32),
    year: field(raw.year, 16),
    percentile: field(raw.percentile, 16),
    section: field(raw.section, 64),
  };

  // Postgres is the source of truth: durable, RLS-validated, queryable from
  // Supabase Studio. Plain insert (not upsert) — RLS only grants anon INSERT,
  // not UPDATE, so a resubmission can't be used to overwrite someone else's
  // row by guessing their email. Duplicate email (23505) is treated as success.
  const supabase = createPublicClient();
  const { error: dbError } = await (supabase as any).from("waitlist").insert(payload);
  if (dbError && dbError.code !== "23505") {
    console.error("Waitlist DB insert error", dbError.message);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  // Google Sheets is a best-effort mirror for the marketing team's workflow —
  // its failure (e.g. a stale Apps Script deployment) must not fail the signup.
  // Run via after() so the serverless function stays alive long enough for the
  // fetch to actually complete instead of being frozen the instant the
  // response is sent (a bare un-awaited fetch here can silently never finish).
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (webhookUrl) {
    after(async () => {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) console.error("Google Sheets webhook error", res.status);
      } catch (err) {
        console.error("Google Sheets webhook error", err);
      }
    });
  }

  return NextResponse.json({ ok: true });
}
