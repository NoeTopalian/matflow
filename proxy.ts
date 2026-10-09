import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { isReservedSlug } from "@/lib/reserved-slugs";
import { isSupportSession, supportRequestDecision } from "@/lib/support-session";

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
  "/api/admin",           // Operator surface — each route runs its own operator gate (lib/admin-auth.ts / lib/operator-context.ts: MFA session + allowlist; shared secret in development/test only)
  "/admin",               // Super-admin pages — /admin/login is open; other /admin/* pages do client-side cookie check
  "/api/member/totp/recover",  // Public-by-design: no session required (mirrors /api/auth/totp/recover for the Member table)
  "/api/members/accept-invite", // LB-003: invite-token-gated, public by design
  "/api/account/pending-tenant", // Pre-Google-sign-in cookie set; tenant verified before signing
  "/waiver",              // Public no-login waiver signing page — the URL token is the credential
  "/api/waiver/open",     // Its data API (load + sign by token). /api/waiver/sign* stay protected.
  // The kiosk tablet has no staff session: these authenticate with the kiosk
  // device token (+ member token) and an unguessable waiver-token id. Without
  // them here the kiosk's "Send waiver link" always answered 401 (verifier
  // lane 2, 30 Sep 2026).
  "/api/waiver/kiosk-request",
  "/api/waiver/kiosk-status",
  "/apply",
  "/legal",               // Public legal pages (terms, privacy, AUP, sub-processors)
  "/onboarding",          // Post-apply onboarding step
  "/preview",             // Public preview page
];

/**
 * HMAC domain of a FULL (MFA-verified) operator session — a copy of
 * OP_SESSION_HMAC_DOMAIN in lib/operator-auth.ts, which this file cannot import
 * (it pulls Prisma). tests/unit/operator-auth-hardening.test.ts pins the two
 * together: a token from issueOperatorSession must pass here, and challenge,
 * enrolment and pre-6-Oct-2026 tokens must not.
 */
const OP_SESSION_HMAC_DOMAIN = "operator-session.mfa.v2.";

/**
 * Mirror of sharedAdminSecretPermitted() in lib/admin-auth.ts (same reason it
 * is a copy). The shared-secret cookie opens /admin pages only in a
 * development/test process that is not Vercel production and not on the
 * production database. No flag re-opens it.
 */
function sharedAdminSecretPermittedAtEdge(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  if ((process.env.DATABASE_URL ?? "").includes("ep-bold-wave-abt39t7x")) return false;
  return true;
}

/**
 * Mirror of isOperatorAllowed() in lib/operator-auth.ts (same reason it is a
 * copy; admin hub lane B, 9 Oct 2026). OPERATOR_ALLOWED_IDS is a comma-separated
 * list of Operator.ids, trimmed, exact match. Unset or blank: nobody in a
 * production-like process, everybody in development/test. Exported only for
 * tests/unit/operator-allowlist.test.ts, which pins it to the library version.
 */
export function operatorAllowedAtEdge(operatorId: string): boolean {
  if (!operatorId) return false;
  const raw = process.env.OPERATOR_ALLOWED_IDS;
  if (raw === undefined || raw.trim() === "") return sharedAdminSecretPermittedAtEdge();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .includes(operatorId);
}

/**
 * Edge-safe verification of the operator session cookie.
 * Verifies HMAC signature (MFA session domain) + non-expired exp, and returns
 * the operator id it names (null on any failure). Does NOT check sessionVersion
 * or TOTP state (no Prisma at edge); every /admin page and /api/admin route
 * does the full check itself (lib/admin-auth.ts / resolveOperatorFromCookie),
 * including revocation and the allowlist.
 */
async function verifyOpSessionAtEdge(
  cookieValue: string | undefined,
  secret: string | undefined,
): Promise<string | null> {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!id || !ver || !exp || !sig) return null;
  const expMs = Number(exp);
  const sessionVersion = Number(ver);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) return null;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;
  if (!/^[a-f0-9]{64}$/i.test(sig)) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${OP_SESSION_HMAC_DOMAIN}${id}.${ver}.${exp}`));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expectedHex.length !== sig.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return mismatch === 0 ? id : null;
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

/**
 * What an unauthenticated request is answered with.
 *
 * A page gets the redirect it has always had — the browser is a person and the
 * person needs the sign-in form. An `/api/*` request gets a real 401 instead,
 * because `fetch` follows a 307 and hands the caller the login PAGE as a 200
 * with `content-type: text/html`. Every caller that checks `res.ok` then reads
 * a refused request as a successful one, and a refused WRITE as a write that
 * landed. `components/dashboard/CardScanner.tsx:365-380` is the only caller in
 * the product that guessed right, and only because it sets `redirect: "manual"`
 * and sniffs `res.type === "opaqueredirect"` by hand.
 *
 * The body is the refusal shape the rest of the API uses, `{ ok: false, error }`,
 * so a client cannot tell this refusal apart from a route-level one and does not
 * need to.
 *
 * Exported for `tests/unit/proxy-matcher.test.ts`: the branch is one line inside
 * a NextAuth-wrapped handler, and a pure function is the only way to assert the
 * status and the body without standing up the whole session stack.
 */
export function unauthenticatedResponse(
  pathname: string,
  requestUrl: string,
  requestId: string,
): NextResponse {
  // The trailing slash matters: without it `/apiary` would be refused as JSON.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }
  return NextResponse.redirect(new URL("/login", requestUrl));
}

/**
 * What a request is answered with when its session could not be CHECKED
 * (SF-44, security campaign iteration 2, lane A2, 9 Oct 2026): the revocation
 * lookup failed, so auth.ts kept the token, marked it for revalidation and
 * gave it no authority. Not "signed out" — nothing here clears the cookie, and
 * the next request is checked afresh — and not admitted either.
 *
 * An `/api/*` request gets a retryable 503 in the API's refusal shape with
 * Retry-After. A page gets a small 503 page that retries itself, so the person
 * lands back where they were once the database answers, still signed in.
 * Exported for tests/unit/sec-a2-proxy-outage-cookie.test.ts.
 */
export const AUTH_UNAVAILABLE_RETRY_AFTER_S = 15;
export function authUnavailableResponse(pathname: string, requestId: string): NextResponse {
  const headers = {
    "retry-after": String(AUTH_UNAVAILABLE_RETRY_AFTER_S),
    "cache-control": "private, no-store",
    "x-request-id": requestId,
  };
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "We couldn't confirm your sign-in just now. Please try again in a moment.", retryable: true },
      { status: 503, headers },
    );
  }
  const html =
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta http-equiv="refresh" content="${AUTH_UNAVAILABLE_RETRY_AFTER_S}">` +
    "<title>Temporarily unavailable</title>" +
    "<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f8;color:#1a1a1a;display:grid;place-items:center;min-height:100vh;padding:16px}" +
    "main{max-width:28rem}a{color:inherit}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>" +
    "</head><body><main><h1>We couldn't confirm your sign-in</h1>" +
    "<p>MatFlow can't reach its database for a moment. You're still signed in. This page will try again automatically.</p>" +
    '<p><a href="">Try again now</a></p></main></body></html>';
  return new NextResponse(html, { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
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

  // Support (impersonation) sessions are READ-ONLY (remediation lane B, 6 Oct
  // 2026; policy and allow-list in lib/support-session.ts). Checked BEFORE the
  // public-prefix early return so /api/admin/* and every other prefix is
  // covered, and before anything else can let the request through. Proxy runs
  // on the Node runtime (Next 16), so auth.ts jwt() — which binds and validates
  // the support session on every request — has already run and
  // `req.auth.user.impersonatedBy` is present exactly when support is live.
  // A Server Action is a POST to a page, so it is refused here too. The
  // routes outside the matcher (/api/auth/*) guard themselves
  // (lib/api-authz.ts refuseSupportSession).
  if (isSupportSession(req.auth)) {
    const method = (req as { method?: string }).method;
    const decision = supportRequestDecision(method, pathname);
    if (!decision.allowed) {
      const isRead = !method || ["GET", "HEAD"].includes(method.toUpperCase());
      if (!pathname.startsWith("/api/") && isRead) {
        // A page on the operator plane: back to the club view, where the
        // support banner offers the way out.
        return NextResponse.redirect(new URL("/dashboard", req.url));
      }
      return NextResponse.json(
        { ok: false, error: decision.message, supportReadOnly: true },
        { status: 403, headers: { "x-request-id": requestId } },
      );
    }
  }

  // Super-admin pages: edge-time gate. /admin is in PUBLIC_PREFIXES so
  // session-less access can reach /admin/login, but the rest of /admin/* needs
  // either:
  //   - matflow_op_session cookie with a valid MFA-session HMAC + unexpired
  //     exp, naming an allow-listed operator (OPERATOR_ALLOWED_IDS; every
  //     environment), OR
  //   - in development/test only, the matflow_admin cookie holding
  //     MATFLOW_ADMIN_SECRET. Never in production (6 Oct 2026).
  //
  // The edge check verifies signature + expiry only — it does NOT check
  // sessionVersion or TOTP state (no Prisma at edge). Every /admin page calls
  // isAdminPageAuthed() and every /api/admin route its own gate, which do the
  // full check including revocation; this is the first fence, not the only one.
  if (
    pathname.startsWith("/admin") &&
    pathname !== "/admin/login" &&
    !pathname.startsWith("/admin/login/")
  ) {
    const legacyCookie = req.cookies.get("matflow_admin")?.value;
    const expected = process.env.MATFLOW_ADMIN_SECRET;
    const legacyOk =
      sharedAdminSecretPermittedAtEdge() &&
      !!expected &&
      !!legacyCookie &&
      (await constantTimeEq(legacyCookie, expected));

    const opCookie = req.cookies.get("matflow_op_session")?.value;
    const authSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
    const opId = await verifyOpSessionAtEdge(opCookie, authSecret);
    const opOk = opId !== null && operatorAllowedAtEdge(opId);

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

  // A BARE single non-reserved path segment (e.g. /totalbjj) is a club's short
  // URL — app/[slug]/page.tsx, which redirects to that club's branded login
  // (/login?club=<slug>) and 404s a reserved segment. This is only safe because every
  // authenticated single-segment route (/dashboard, /member, /admin, …) is in
  // RESERVED_SLUGS and so falls through to the auth checks below; the reserved
  // list is pinned against the real app/ folders by a unit test. Only a bare
  // segment matches, so /dashboard/members and every deeper route keep their
  // auth. Public prefixes (/login, /apply, …) already returned above.
  const slugMatch = /^\/([a-z0-9-]+)\/?$/.exec(pathname.toLowerCase());
  if (slugMatch && !isReservedSlug(slugMatch[1])) {
    const res = NextResponse.next();
    res.headers.set("x-request-id", requestId);
    return res;
  }

  // A session with no user id ({ user: undefined } — an invalidated token, or
  // an identity-less support carrier) is signed out, not a session (review of
  // lane I, 6 Oct 2026; lib/api-authz.ts already checks the user).
  // Checked BEFORE the signed-out branch: a session awaiting revalidation has
  // no user, and must not be answered as signed out (SF-44).
  // (Read inline rather than through a helper imported from @/auth: the
  // many tests that replace @/auth wholesale would otherwise lose this branch.)
  if ((req.auth as { authUnavailable?: unknown } | null)?.authUnavailable === true) {
    return authUnavailableResponse(pathname, requestId);
  }

  if (!req.auth || !(req.auth.user as { id?: unknown } | undefined)?.id) {
    return unauthenticatedResponse(pathname, req.url, requestId);
  }

  const authUser = req.auth.user as {
    totpPending?: boolean;
    requireTotpSetup?: boolean;
    mustChangePassword?: boolean;
    role?: string;
  } | undefined;
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

  // Mandatory TOTP for owners (re-introduced 1 Oct 2026 for the Total BJJ
  // launch, superseding the 2026-05-07 optional gate above). An owner who has
  // not yet enrolled a second factor (`requireTotpSetup`) may reach ONLY the
  // enrolment flow and the forced password change; every other page redirects
  // to /login/totp/setup. requireTotpSetup is owner-only and suppressed under
  // TESTING_MODE (auth.ts), so this gate is inert locally and in e2e and bites
  // only in production — the API half of the gate lives in lib/api-authz.ts so
  // a direct protected API call before enrolment is refused too.
  // The middleware is the SINGLE enforcement point for mandatory owner TOTP, so
  // it covers every route — not just the ones whose handler calls requireApi*
  // (W3-MFA-1: ~82 routes authenticate with a bare auth() and would otherwise
  // let a not-yet-enrolled owner read tenant data). A page gets a redirect to
  // the enrolment flow; an /api route gets a JSON 403 (never a 307 to HTML,
  // which a fetch() would parse as JSON — the data-loss shape api-authz.ts
  // guards against). /api/auth/* (enrolment, set-password, session) is excluded
  // from the matcher below, so enrolment itself stays reachable.
  const MFA_SETUP_PATHS = new Set(["/login/totp/setup", "/set-password"]);

  // Temporary password (3 Oct 2026). An operator reset (or an owner setting a
  // staff password) flags the row `mustChangePassword`; auth.ts carries it on
  // the token. Until the person chooses their own password, every page goes to
  // /set-password and every /api route is a JSON 403 — previously only
  // app/dashboard/layout.tsx enforced it, so the temp password could drive the
  // API directly. Runs BEFORE the authenticator gate below: the activation
  // order is temp password -> own password -> enrol TOTP -> club data, and a
  // session carrying both flags is sent to the step it must take next. The
  // same two paths stay reachable (/login/totp/setup itself sends a
  // mustChangePassword account to /set-password first); /api/auth/* —
  // set-password, csrf, session, signout, totp — never reaches this function
  // (matcher exclusion below).
  if (authUser?.mustChangePassword === true && !MFA_SETUP_PATHS.has(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Choose your own password to continue." },
        { status: 403, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.redirect(new URL("/set-password", req.url));
  }

  if (authUser?.requireTotpSetup === true && !MFA_SETUP_PATHS.has(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Enrol your authenticator to continue." },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/login/totp/setup", req.url));
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
  // `apple-touch-icon.png` and `icon.png` sit here for the same reason as
  // `favicon.ico`: the document links them unauthenticated, so without the
  // exclusion iOS asks for the home-screen icon, gets a 307 to /login, and
  // renders an HTML page as the icon — the app installs with no mark.
  //
  // `api/auth` joined them on 20 Sep 2026, and it is a correctness fix rather
  // than a saving. NextAuth's `auth()` wrapper — the one this file's default
  // export is wrapped in — makes an internal SESSION request and then appends
  // that response's cookies to whatever the route returns
  // (`node_modules/next-auth/lib/index.js:182-185`:
  // `for (const cookie of sessionResponse.headers.getSetCookie())
  //  finalResponse.headers.append("set-cookie", cookie)`).
  // On `/api/auth/csrf`, whose whole job is to set `authjs.csrf-token` and
  // return the matching token in its body, that append produced the cookie
  // TWICE in one response. Browsers keep the last, so no user was affected;
  // a client that replays cookies in header order sent the other one and was
  // refused `MissingCSRF`, which cost another lane twenty minutes and would
  // cost any non-browser integration the same.
  //
  // Nothing is lost by the exclusion: `/api/auth` is already in
  // `PUBLIC_PREFIXES`, so the body of this middleware early-returned for it,
  // and `MAINTENANCE_MODE` exempts it by name above. Only the `x-request-id`
  // stamp goes, exactly as it already does for cron, kiosk, health and
  // magic-link — and these routes are the auth handlers themselves, so running
  // the auth wrapper in front of them was always a round trip to ask NextAuth
  // about a session on its way to NextAuth.
  //
  // The TRAILING SLASH on `api/auth/` is load-bearing, for the same reason the
  // one in `unauthenticatedResponse`'s `startsWith("/api/")` is: written bare,
  // the lookahead also swallows `/api/authz` and anything else beginning with
  // those eight letters, and a tenant-scoped route would escape the middleware
  // entirely by virtue of its name. `icons/` and `.well-known/` carry it for
  // the same reason. `tests/unit/proxy-matcher.test.ts` asserts both halves —
  // it is what caught this when the entry first went in bare.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-touch-icon.png|icon.png|manifest.webmanifest|icons/|robots.txt|sitemap.xml|\\.well-known/|api/webhooks|api/stripe/webhook|api/cron|api/health|api/kiosk|kiosk|leaderboard|api/magic-link|api/auth/).*)",
  ],
};
