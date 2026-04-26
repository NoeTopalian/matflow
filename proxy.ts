import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/tenant",
  "/api/apply",
  "/apply",
  "/_next",
  "/favicon",
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = await getToken({ req, secret: AUTH_SECRET_VALUE });

  if (!token?.id) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (token.totpPending === true && pathname !== "/login/totp") {
    return NextResponse.redirect(new URL("/login/totp", req.url));
  }

  if (token.totpPending !== true && pathname === "/login/totp") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
