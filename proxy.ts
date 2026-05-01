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

  if (totpPending === true && pathname !== "/login/totp") {
    return NextResponse.redirect(new URL("/login/totp", req.url));
  }

  if (totpPending !== true && pathname === "/login/totp") {
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
