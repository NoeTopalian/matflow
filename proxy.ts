import { auth } from "@/auth";
import { NextResponse } from "next/server";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/magic-link",      // moved out of /api/auth/ to escape NextAuth catch-all (Sprint 4-fix)
  "/api/tenant",
  "/api/apply",
  "/api/webhooks",        // Resend webhooks — Svix signature verified in handler
  "/api/stripe/webhook",  // Stripe webhook — signature verified in handler
  "/api/cron",            // Vercel cron — Bearer secret verified in handler
  "/api/checkin",         // QR check-in — HMAC token verified + rate-limited
  "/api/members/accept-invite", // LB-003: invite-token-gated, public by design
  "/apply",
  "/checkin",             // QR landing page (member-facing)
  "/legal",               // Public legal pages (terms, privacy, AUP, sub-processors)
  "/onboarding",          // Post-apply onboarding step
  "/preview",             // Public preview page
  "/_next",
  "/favicon",
  "/manifest.webmanifest",  // PWA manifest — must be reachable while logged-out or browsers log a parse error
  "/icons",                 // PWA icon assets referenced by the manifest
  "/robots.txt",
  "/sitemap.xml",
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
  const requireTotpSetup = (req.auth.user as any)?.requireTotpSetup;

  // Fix 4: mandatory TOTP for owners. An owner who hasn't enrolled is
  // pinned to /login/totp/setup until they do. The setup endpoint
  // (POST /api/auth/totp/setup) re-encodes the JWT with requireTotpSetup
  // cleared once enrolment succeeds.
  if (requireTotpSetup === true) {
    const allowedDuringSetup =
      pathname === "/login/totp/setup" ||
      pathname.startsWith("/api/auth/totp/setup") ||
      pathname.startsWith("/api/auth/signout") ||
      pathname.startsWith("/api/auth/csrf") ||
      pathname.startsWith("/api/auth/session");
    if (!allowedDuringSetup) {
      return NextResponse.redirect(new URL("/login/totp/setup", req.url));
    }
  }

  if (totpPending === true && pathname !== "/login/totp") {
    return NextResponse.redirect(new URL("/login/totp", req.url));
  }

  if (totpPending !== true && pathname === "/login/totp") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Inverse: an owner who already enrolled landing on /login/totp/setup
  // by accident (refresh, bookmark, etc.) shouldn't see the forced flow.
  if (requireTotpSetup !== true && pathname === "/login/totp/setup") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  const role = (req.auth.user as any)?.role as string | undefined;

  // Members must not access staff dashboard routes
  if (role === "member" && pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/member/home", req.url));
  }

  // Staff must not access member-only routes
  if (role !== "member" && pathname.startsWith("/member")) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
