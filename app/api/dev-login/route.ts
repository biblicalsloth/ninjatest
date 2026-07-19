import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// DEV-ONLY session bootstrap for the local UI preview. Visiting this route signs
// in a seeded local test user (no login form) so every auth-gated screen opens
// directly with real data — for editing look-and-feel without the auth dance.
//
// Hard-guarded to the LOCAL Supabase stack: it refuses to run unless
// NEXT_PUBLIC_SUPABASE_URL points at 127.0.0.1/localhost, so it can never mint a
// session against the production project. Delete this file before shipping.
//
//   /dev-login            → sign in as playerA, go to /lobby
//   /dev-login?as=b       → sign in as playerB
//   /dev-login?as=spectator&next=/spectate/<id>
const USERS: Record<string, string> = {
  a: "playera@local.test",
  b: "playerb@local.test",
  spectator: "spectator@local.test",
};

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    return NextResponse.json(
      { error: "dev-login is local-stack only; refusing on a remote Supabase URL" },
      { status: 403 }
    );
  }

  const as = request.nextUrl.searchParams.get("as") ?? "a";
  const next = request.nextUrl.searchParams.get("next") ?? "/lobby";
  const email = USERS[as] ?? USERS.a;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: "password123",
  });
  if (error) {
    return NextResponse.json({ error: error.message, email }, { status: 500 });
  }

  const res = NextResponse.redirect(new URL(next, request.url));
  // Skip the onboarding chokepoint (test profiles are already onboarded; this
  // just spares the middleware DB lookup on the first nav).
  res.cookies.set("nt_onboarded", "1", { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax" });
  return res;
}
