import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "@/lib/supabase/types";

// /auth stays reachable in waitlist mode so sign-in, the OAuth callback, and
// password reset keep working; app routes below remain blocked until launch.
// /c stays open so a logged-out friend can land on a challenge link — the page
// itself bounces them through /auth/login?next=/c/<code>.
const WAITLIST_ALLOWED = ["/", "/api/waitlist", "/auth", "/c", "/pricing"];

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Session client + auth run FIRST, even in waitlist mode, so signed-in users
  // can be let through to the app (soft launch) while anon visitors are held to
  // the landing page. The waitlist gate is applied after isAuthed is known.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims() verifies the JWT locally (asymmetric signing keys) instead of
  // making an Auth-server round-trip on every request like getUser() does. It
  // still refreshes the session cookie via the handlers above. This is the
  // single biggest per-request cost reduction for Fluid Compute + Supabase Auth.
  const { data: claimsData } = await supabase.auth.getClaims();
  const isAuthed = !!claimsData?.claims?.sub;

  // Authed pages must never sit in bfcache: after logout the browser Back button
  // restores the last rendered page WITHOUT re-running this middleware, leaking
  // an authed screen. no-store makes the browser skip bfcache and re-hit the
  // server (→ redirect to `/`) on Back. Applies to every authed response below.
  if (isAuthed) {
    supabaseResponse.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );
  }

  const url = request.nextUrl.clone();

  // Waitlist mode: the landing page is the public front door — anonymous
  // visitors get ONLY "/", "/api/waitlist", "/auth". SIGNED-IN users fall
  // through to the full app (soft launch): they can play while the public still
  // sees the waitlist. Removing the env var (the launch) makes this branch dead
  // and the whole site the app for everyone.
  if (process.env.NEXT_PUBLIC_APP_MODE === "waitlist" && !isAuthed) {
    const allowed = WAITLIST_ALLOWED.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    );
    if (!allowed) {
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  // /leaderboard is public in the real app (anon-callable RPC + public client
  // + ISR — see the caching notes in CLAUDE.md). PRIVATE_LEADERBOARD=1 is set
  // ONLY on the ninjatest-flbe project (the staging app, which builds `test`
  // and serves test.ninjatest.app), so its board isn't publicly browsable.
  // Project-scoped rather than a hostname check because that project also
  // answers on ninjatest-test.vercel.app; VERCEL_ENV is no use either, since
  // staging deploys as its own production.
  const privateLeaderboard = process.env.PRIVATE_LEADERBOARD === "1";

  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/c/") ||
    (!privateLeaderboard && pathname.startsWith("/leaderboard")) ||
    pathname.startsWith("/profile");

  if (!isAuthed && !isPublicRoute) {
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Onboarding gate — single chokepoint. Any authed user who hasn't finished
  // onboarding is funneled to /onboarding. The `nt_onboarded` cookie caches a
  // completed profile so we do the DB lookup at most once per session instead
  // of on every authed page nav (the getClaims() opt above exists to kill the
  // per-request roundtrip; this keeps it dead). Cookie is a UX hint only —
  // forging it just skips the onboarding screen, no server-authoritative gate.
  if (
    isAuthed &&
    !pathname.startsWith("/onboarding") &&
    !isPublicRoute &&
    request.cookies.get("nt_onboarded")?.value !== "1"
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profile } = await (supabase as any)
      .from("profiles")
      .select("onboarding_completed")
      .eq("id", claimsData!.claims.sub as string)
      .single();
    if (profile && !profile.onboarding_completed) {
      url.pathname = "/onboarding";
      return NextResponse.redirect(url);
    }
    if (profile) {
      // Completed — stop paying the roundtrip for the rest of the session.
      supabaseResponse.cookies.set("nt_onboarded", "1", {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
      });
    }
  }

  // Authed users bouncing off /auth go through the exam picker, not straight
  // to the lobby — every login funnels through /exams.
  if (isAuthed && pathname.startsWith("/auth")) {
    url.pathname = "/exams";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
