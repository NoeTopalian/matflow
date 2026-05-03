import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Request-ID propagation. Read inbound x-request-id (Vercel sets one;
// most uptime monitors do too) or mint a fresh UUID. Stamp on the
// response header so client errors / Sentry breadcrumbs / log lines
// can correlate to a single request.
function ensureRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  if (incoming && /^[a-zA-Z0-9_-]{8,128}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  // /api/auth/totp/recover is public-by-design (TOTP-lost recovery — same
  // pattern as forgot-password). It's a sub-route of /api/auth so already
  // covered by that prefix, but called out here for searchability.
  "/api/magic-link",      // moved out of /api/auth/ to escape NextAuth catch-all (Sprint 4-fix)
  "/api/tenant",
  "/api/apply",
  "/api/webhooks",        // Resend webhooks — Svix signature verified in handler
  "/api/stripe/webhook",  // Stripe webhook — signature verified in handler
  "/api/cron",            // Vercel cron — Bearer secret verified in handler
  "/api/admin",           // Super-admin surface — each route enforces MATFLOW_ADMIN_SECRET via header or cookie (lib/admin-auth.ts)
  "/admin",               // Super-admin pages — /admin/login is open; other /admin/* pages do client-side cookie check
  "/api/members/accept-invite", // LB-003: invite-token-gated, public by design
  "/api/health",          // Public uptime probe — DB ping only, no env/tenant info
  "/api/account/pending-tenant", // Pre-Google-sign-in cookie set; tenant verified before signing
  "/apply",
  "/legal",               // Public legal pages (terms, privacy, AUP, sub-processors)
  "/onboarding",          // Post-apply onboarding step
  "/preview",             // Public preview page
  "/_next",
  "/favicon",
  "/manifest.webmanifest",  // PWA manifest — must be reachable while logged-out or browsers log a parse error
  "/icons",                 // PWA icon assets referenced by the manifest
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known",         // security.txt and other RFC 8615 well-known URIs
];

export default auth(function proxy(req) {
  const { pathname } = req.nextUrl;
  const requestId = ensureRequestId(req);

  // Global kill switch. Flip MAINTENANCE_MODE=true in Vercel env to return
  // 503 from every route except the health probe and auth callbacks (so
  // operators can still sign in and uptime services can detect the state).
  // No code deploy needed to engage or disengage.
  if (
    process.env.MAINTENANCE_MODE === "true" &&
    !pathname.startsWith("/api/health") &&
    !pathname.startsWith("/api/auth") &&
    !pathname.startsWith("/_next") &&
    pathname !== "/login"
  ) {
    return new NextResponse(
      JSON.stringify({ error: "MatFlow is temporarily down for maintenance." }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "120",
          "x-request-id": requestId,
        },
      },
    );
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    const res = NextResponse.next();
    res.headers.set("x-request-id", requestId);
    return res;
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

  const res = NextResponse.next();
  res.headers.set("x-request-id", requestId);
  return res;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
