import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "@/lib/supabase/types";

export async function updateSession(request: NextRequest) {
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const url = request.nextUrl.clone();
  const isAuthRoute = url.pathname.startsWith("/auth");
  const isPublicRoute =
    url.pathname === "/" ||
    url.pathname.startsWith("/c/") ||
    url.pathname.startsWith("/leaderboard") ||
    url.pathname.startsWith("/profile");

  const devBypass = process.env.DEV_BYPASS === "true";

  if (!devBypass) {
    if (!user && !isAuthRoute && !isPublicRoute) {
      url.pathname = "/auth/login";
      return NextResponse.redirect(url);
    }
    if (user && isAuthRoute) {
      url.pathname = "/lobby";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
