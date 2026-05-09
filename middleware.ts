import { NextResponse, type NextRequest } from "next/server";

// Defence-in-depth tripwire: if a /dashboard, /member, or /onboarding route
// is ever shipped without a server-side requireSession()/requireStaff()
// guard, this middleware still redirects unauthenticated users to /login
// before the page renders. Real JWT verification stays in auth.ts and the
// per-route helpers — this is presence-only on the session cookie.
//
// API routes are deliberately NOT in the matcher. They return 401 from their
// own guards rather than redirecting; intercepting them here would break
// fetch() calls and OAuth callbacks.

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

export function middleware(req: NextRequest) {
  const hasSession = SESSION_COOKIE_NAMES.some((name) => req.cookies.has(name));
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/member/:path*",
    "/onboarding/:path*",
  ],
};
