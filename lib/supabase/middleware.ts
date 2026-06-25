import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "@/lib/supabase/types";

const WAITLIST_ALLOWED = ["/", "/api/waitlist"];

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

  const { data: { user } } = await supabase.auth.getUser();

  const url = request.nextUrl.clone();
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/c/") ||
    pathname.startsWith("/leaderboard") ||
    pathname.startsWith("/profile");

  if (!user && !isPublicRoute) {
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  if (user && pathname.startsWith("/auth")) {
    url.pathname = "/lobby";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
