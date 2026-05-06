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
  // Per-tenant iPad kiosk URLs. The `[token]` segment IS the credential —
  // each request hashes it with HMAC-SHA256 and looks up Tenant.kioskTokenHash.
  // No NextAuth session is ever issued; the kiosk is fully isolated from the
  // admin / dashboard surface. Owner regenerates from settings → integrations.
  "/kiosk",
  "/api/kiosk",
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

/**
 * Edge-safe verification of the v1.5 admin operator session cookie.
 * Verifies HMAC signature + non-expired exp. Does NOT check sessionVersion
 * (no Prisma at edge); the route handler (lib/admin-auth.ts /
 * resolveOperatorFromCookie) does the full check including revocation.
 */
async function verifyOpSessionAtEdge(
  cookieValue: string | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!cookieValue || !secret) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return false;
  const [id, ver, exp, sig] = parts;
  if (!id || !ver || !exp || !sig) return false;
  const expMs = Number(exp);
  const sessionVersion = Number(ver);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) return false;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return false;
  if (!/^[a-f0-9]{64}$/i.test(sig)) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ver}.${exp}`));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expectedHex.length !== sig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return mismatch === 0;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export default auth(async function proxy(req) {
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

  // Super-admin pages: edge-time gate. /admin is in PUBLIC_PREFIXES so
  // session-less access can reach /admin/login, but the rest of /admin/* needs
  // either:
  //   - matflow_admin cookie holding MATFLOW_ADMIN_SECRET (v1 path), OR
  //   - matflow_op_session cookie with valid HMAC + non-expired exp (v1.5 path)
  //
  // The v1.5 edge check verifies signature + expiry only — it does NOT check
  // sessionVersion (no Prisma at edge). The full check (including revocation
  // via sessionVersion mismatch) happens in lib/admin-auth.ts at the route
  // handler level. So a revoked session can render the page shell until its
  // 8h expiry, but every API route that reads it will reject.
  if (
    pathname.startsWith("/admin") &&
    pathname !== "/admin/login" &&
    !pathname.startsWith("/admin/login/")
  ) {
    const legacyCookie = req.cookies.get("matflow_admin")?.value;
    const expected = process.env.MATFLOW_ADMIN_SECRET;
    const legacyOk = !!expected && !!legacyCookie && constantTimeEq(legacyCookie, expected);

    const opCookie = req.cookies.get("matflow_op_session")?.value;
    const authSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
    const opOk = await verifyOpSessionAtEdge(opCookie, authSecret);

    if (!legacyOk && !opOk) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    const res = NextResponse.next();
    res.headers.set("x-request-id", requestId);
    return res;
  }

  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const authUser = req.auth.user as { totpPending?: boolean; requireTotpSetup?: boolean; role?: string } | undefined;
  const totpPending = authUser?.totpPending;
  const requireTotpSetup = authUser?.requireTotpSetup;

  // Fix 4: mandatory TOTP for owners. An owner who hasn't enrolled is
  // pinned to /login/totp/setup until they do. The setup endpoint
  // (POST /api/auth/totp/setup) re-encodes the JWT with requireTotpSetup
  // cleared once enrolment succeeds.
  if (requireTotpSetup === true) {
    // The owner-onboarding wizard now hosts TOTP enrolment as a step inside
    // its own flow, so logged-in owners with requireTotpSetup=true must be
    // able to reach /onboarding (+ the wizard's own API surface) — otherwise
    // they get pinned to /login/totp/setup before they can finish signup.
    // Standalone /login/totp/setup stays as the recovery surface.
    const allowedDuringSetup =
      pathname === "/login/totp/setup" ||
      pathname.startsWith("/onboarding") ||
      pathname.startsWith("/api/onboarding") ||
      pathname.startsWith("/api/settings") ||
      pathname.startsWith("/api/ranks") ||
      pathname.startsWith("/api/classes") ||
      pathname.startsWith("/api/instances") ||
      pathname.startsWith("/api/upload") ||
      pathname.startsWith("/api/stripe/connect") ||
      pathname.startsWith("/api/auth/totp/setup") ||
      pathname.startsWith("/api/auth/totp/recovery-codes") ||
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

  const role = authUser?.role;

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
