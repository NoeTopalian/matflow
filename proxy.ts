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

// Public surfaces that still reach this middleware (i.e. NOT excluded by
// config.matcher below). These get the early-return + request-id stamp but
// skip the auth-required redirect. Self-authenticating surfaces — webhooks,
// cron, kiosk, health, magic-link, PWA static — are excluded at the matcher
// level so the `auth(...)` wrapper never fires for them. That avoids the
// NextAuth JWT callback cost on the high-volume public routes.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  // /api/auth/totp/recover is public-by-design (TOTP-lost recovery — same
  // pattern as forgot-password). It's a sub-route of /api/auth so already
  // covered by that prefix, but called out here for searchability.
  "/api/tenant",
  "/api/apply",
  "/api/admin",           // Super-admin surface — each route enforces MATFLOW_ADMIN_SECRET via header or cookie (lib/admin-auth.ts)
  "/admin",               // Super-admin pages — /admin/login is open; other /admin/* pages do client-side cookie check
  "/api/member/totp/recover",  // Public-by-design: no session required (mirrors /api/auth/totp/recover for the Member table)
  "/api/members/accept-invite", // LB-003: invite-token-gated, public by design
  "/api/account/pending-tenant", // Pre-Google-sign-in cookie set; tenant verified before signing
  "/apply",
  "/legal",               // Public legal pages (terms, privacy, AUP, sub-processors)
  "/onboarding",          // Post-apply onboarding step
  "/preview",             // Public preview page
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

// Audit iter-1-infra A7I1-S-4: hash both inputs to fixed-length SHA-256
// digests before comparison so the timing channel doesn't leak the
// expected MATFLOW_ADMIN_SECRET length. Edge runtime has no
// crypto.timingSafeEqual, so we do the constant-time XOR ourselves over
// 32-byte digests (always equal-length by construction).
async function constantTimeEq(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(ha);
  const ub = new Uint8Array(hb);
  let mismatch = 0;
  for (let i = 0; i < ua.length; i++) mismatch |= ua[i] ^ ub[i];
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
    const legacyOk = !!expected && !!legacyCookie && (await constantTimeEq(legacyCookie, expected));

    const opCookie = req.cookies.get("matflow_op_session")?.value;
    const authSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
    const opOk = await verifyOpSessionAtEdge(opCookie, authSecret);

    if (!legacyOk && !opOk) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
  }

  // Root is the public marketing landing page. Exact-match check because
  // pathname.startsWith("/") would be true for every request.
  if (pathname === "/") {
    const res = NextResponse.next();
    res.headers.set("x-request-id", requestId);
    return res;
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    const res = NextResponse.next();
    res.headers.set("x-request-id", requestId);
    return res;
  }

  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const authUser = req.auth.user as { totpPending?: boolean; role?: string } | undefined;
  const totpPending = authUser?.totpPending;

  // 2FA-optional spec (2026-05-07): the previous mandatory-TOTP-for-owners
  // gate has been removed. requireTotpSetup is still computed in auth.ts but
  // is now informational only — it drives the dashboard recommendation banner
  // (Recommend2FABanner). Users may visit /login/totp/setup voluntarily at
  // any time from the banner or settings page.
  //
  // Second-factor-in-progress (totpPending) is independent and remains
  // enforced: a user who has enrolled in TOTP must complete /login/totp
  // before reaching the dashboard.
  if (totpPending === true && pathname !== "/login/totp") {
    return NextResponse.redirect(new URL("/login/totp", req.url));
  }

  if (totpPending !== true && pathname === "/login/totp") {
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
  // Skip middleware entirely for: Next internals, static assets, PWA manifest +
  // icons, well-known URIs, and surfaces that authenticate themselves at the
  // route-handler level (webhooks via signature, cron via Bearer secret, kiosk
  // via HMAC token, health probe, pre-auth magic-link). Eliminates the
  // NextAuth JWT callback cost on these requests.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|robots.txt|sitemap.xml|\\.well-known/|api/webhooks|api/stripe/webhook|api/cron|api/health|api/kiosk|kiosk|api/magic-link).*)",
  ],
};
