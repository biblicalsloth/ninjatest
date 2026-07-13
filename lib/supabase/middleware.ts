import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "@/lib/supabase/types";

// /auth stays reachable in waitlist mode so sign-in, the OAuth callback, and
// password reset keep working; app routes below remain blocked until launch.
const WAITLIST_ALLOWED = ["/", "/api/waitlist", "/auth"];

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Waitlist mode: block all app routes
  if (process.env.NEXT_PUBLIC_APP_MODE === "waitlist") {
    const allowed = WAITLIST_ALLOWED.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    );
    if (!allowed) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  // Live mode: full auth middleware
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

  const url = request.nextUrl.clone();
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/c/") ||
    pathname.startsWith("/leaderboard") ||
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

  if (isAuthed && pathname.startsWith("/auth")) {
    url.pathname = "/lobby";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
