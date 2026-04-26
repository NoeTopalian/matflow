import { auth } from "@/auth";
import { NextResponse } from "next/server";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/tenant",
  "/api/apply",
  "/apply",
  "/_next",
  "/favicon",
];

export default auth(function proxy(req) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const totpPending = (req.auth.user as any)?.totpPending;

  if (totpPending === true && pathname !== "/login/totp") {
    return NextResponse.redirect(new URL("/login/totp", req.url));
  }

  if (totpPending !== true && pathname === "/login/totp") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
