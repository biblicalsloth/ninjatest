import { type NextRequest, NextResponse } from "next/server";

// Main branch = waitlist mode. Only / and /api/waitlist are accessible.
const WAITLIST_ALLOWED = ["/", "/api/waitlist"];

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
