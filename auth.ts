import * as Sentry from "@sentry/nextjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { shouldRefreshBrand } from "@/lib/brand-refresh";
import { readPendingTenantSlug, clearPendingTenantSlug } from "@/lib/pending-tenant-cookie";
import { isTestingMode, isProductionDatabase } from "@/lib/testing-mode";
import { deviceHash } from "@/lib/login-fingerprint";
import {
  ADDR_MAX,
  KNOWN_DEVICE_DAYS,
  LOCKOUT_WINDOW_MS,
  SIGN_IN_THROTTLED_MESSAGE,
  clearPairOnSuccess,
  lockoutKeys,
  lockoutState,
  recordFailure,
  requestClientIp,
} from "@/lib/auth-lockout";
import { requiresTotpEnrolment } from "@/lib/mfa-policy";
import { recordLoginEvent } from "@/lib/login-event";
import { after } from "next/server";
import { emailField } from "@/lib/email-normalise";
import { tenantAdmission, admissionErrorCode } from "@/lib/tenant-admission";
import { checkSessionVersion } from "@/lib/session-revocation";
import { resolveActiveImpersonation, hasImpersonationCookie } from "@/lib/impersonation";
import { isTempPasswordExpired } from "@/lib/temp-password";
import { isLoginEmailProvisional } from "@/lib/login-email";
// SF-36: the explicit Google link seam (no store yet: always "no link").
import { linkedExternalIdentity } from "@/lib/external-identity";

// Resolve the public app URL once for outbound links (e.g. the disown-login
// link in P1.6 emails). Falls back to a sensible string in dev so the helper
// never throws — emails sent without NEXTAUTH_URL are clearly broken anyway.
function appUrl(reqHeaders?: Headers): string {
  const env = process.env.NEXTAUTH_URL ?? process.env.APP_URL;
  if (env) return env;
  if (reqHeaders) {
    const proto = reqHeaders.get("x-forwarded-proto") ?? "https";
    const host = reqHeaders.get("host");
    if (host) return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

// P1.5: Google OAuth as an alternative login. Disabled by default so the
// existing credentials/magic-link flow keeps working until GCP credentials
// + ENABLE_GOOGLE_OAUTH=true are set. Tenant context is supplied by a
// signed `pendingTenantSlug` cookie set at the club-code step — Google
// itself never decides which gym you log into.
const GOOGLE_OAUTH_ENABLED =
  process.env.ENABLE_GOOGLE_OAUTH === "true" &&
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET;

// Pre-computed bcrypt hash used to keep response times constant on the
// user-not-found path, preventing email enumeration via timing differences.
const DUMMY_HASH = bcrypt.hashSync("constant-time-padding-only", 12);

// Production runtime guards (skipped during `next build` page-data collection)
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  if (process.env.DEMO_MODE === "true") {
    throw new Error("DEMO_MODE must not be enabled in production");
  }
  // Only warn on REAL production (Vercel main). Preview deployments run with
  // NODE_ENV=production but VERCEL_ENV=preview — TESTING_MODE is honoured there.
  if (process.env.VERCEL_ENV === "production" && process.env.TESTING_MODE === "true") {
    console.warn("[auth] TESTING_MODE=true ignored in production");
  }
  if (!process.env.NEXTAUTH_SECRET && !process.env.AUTH_SECRET) throw new Error("NEXTAUTH_SECRET or AUTH_SECRET is required in production");
  // Reject obviously weak secrets in production. A 32-byte (~43 char base64)
  // value is the minimum recommended for HS256 JWT signing. Catches the
  // canonical mistake of leaving "dev-secret-..." values in Vercel env vars.
  // (Security audit 2026-05-07, severity LOW: bare-minimum hardening.)
  // Resolution order MUST match lib/auth-secret.ts:4 + proxy.ts:147 — both
  // prefer NEXTAUTH_SECRET. Inverted precedence here would cause the length
  // check to validate a different secret than the one used for signing /
  // verification. (Security audit iteration 2 / M11, 2026-05-07.)
  const productionSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
  if (process.env.VERCEL_ENV === "production" && productionSecret.length < 32) {
    throw new Error("AUTH_SECRET / NEXTAUTH_SECRET must be at least 32 characters in production. Generate a fresh one with `openssl rand -base64 32`.");
  }
  if (!process.env.NEXTAUTH_URL)    console.warn("[auth] NEXTAUTH_URL not set — defaulting to Vercel deployment URL");

  // RESEND_FROM left at the resend.dev default lands every transactional
  // email (password reset, owner activation, payment failed, login alerts)
  // in spam. Loud-warn at boot so it's visible in Vercel logs the moment
  // the app starts.
  const resendFrom = process.env.RESEND_FROM ?? "";
  if (!resendFrom || /resend\.dev>?$/.test(resendFrom)) {
    console.warn(
      "[auth] RESEND_FROM is unset or still pointing at resend.dev — " +
      "transactional emails will be flagged as spam. " +
      "Verify a domain in Resend and set RESEND_FROM=\"MatFlow <noreply@your-domain>\".",
    );
  }
}

const loginSchema = z.object({
  // Normalised, like every recovery path in the product already did on read.
  // The login lookup used the RAW string, so a row stored as "Noe@example.com"
  // could be signed into with that exact spelling and could never be recovered
  // — magic link, forgot password and reset all search lowercased and silently
  // found nothing. Writes now normalise too (lib/email-normalise.ts), so the
  // two halves finally agree.
  email: emailField(),
  password: z.string().min(8),
  tenantSlug: z.string().min(1),
});

function normalizeRole(r: unknown): string {
  return (typeof r === "string" ? r : "").toLowerCase().trim();
}

// LB-004 brand refresh helpers live in lib/brand-refresh.ts so vitest can
// import them without booting the NextAuth runtime.

/**
 * Where the JWT keeps the operator's OWN claims while they are impersonating
 * someone, so that stopping can give them back. The swap used to be an in-place
 * overwrite with nothing kept, which is why a stopped impersonation went on
 * reporting the target's club and carrying an `impersonatedBy` claim.
 */
const IMPERSONATION_STASH = "impersonatorClaims";

/** Mirrors the identity half of `types/next-auth.d.ts`'s `JWT`, so a claim that
 *  gains a field here cannot be quietly dropped on the way back. */
interface ImpersonatorClaims {
  id: string | undefined;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  role: string;
  sessionVersion: unknown;
  memberId: string | null;
  totpPending: boolean;
  requireTotpSetup: boolean;
  totpEnabled: boolean;
  /** Optional: a stash written before this claim existed has no such key. */
  mustChangePassword?: boolean;
  /** True when the token stashed was a support CARRIER (no identity) — see SUPPORT_CARRIER_CLAIM. */
  supportCarrier?: boolean;
  /** Optional: a stash written before lane J item 9 has no such keys (restore leaves the token's alone). */
  name?: string | null;
  email?: string | null;
}

/**
 * A support CARRIER token (E2E flow 6, 6 Oct 2026). Auth.js only runs jwt()
 * when the request carries a session-token cookie, and operator sign-in never
 * mints one — so in a clean operator browser the support swap below never ran
 * and /dashboard bounced to /login. POST /api/admin/impersonate therefore sets
 * a carrier ({ supportCarrier: true }, NO identity; minted by
 * mintSupportCarrier() in app/api/admin/impersonate/route.ts) when the browser
 * has no Auth.js session. A carrier is only ever a vehicle for the swap:
 * whenever support is not active, a carrier token — or a restored stash that
 * was one — is signed out (null), never left as an identity-less session. Same
 * literal as that route's carrier claim (not imported: a route file may export
 * only HTTP handlers; tests/unit/support-carrier-start.test.ts pins the match).
 */
const SUPPORT_CARRIER_CLAIM = "supportCarrier";

/**
 * Keep the sign-in record (review of lane I, 6 Oct 2026). It used to be
 * an un-awaited `void` call — fire-and-forget, which a serverless function
 * frozen after the response can lose, and the row is now the activation
 * evidence scripts/readiness/activation-verdict.mjs reads. Handed to Next's
 * after() instead: it runs once the response is sent, within the route's max
 * duration, and works in Route Handlers and Server Functions — where Auth.js
 * runs authorize() and the signIn callback. Outside a request scope after()
 * throws; then the write is awaited (recordLoginEvent never throws).
 */
async function keepLoginEvent(args: Parameters<typeof recordLoginEvent>[0]): Promise<void> {
  try {
    after(() => recordLoginEvent(args));
  } catch {
    await recordLoginEvent(args);
  }
}

/**
 * The per-IP / per-email sign-in throttle. **Defaults ON.**
 *
 * It was briefly a hard-coded `false` (15 Sep) because live-portal testing kept
 * tripping "too many sign in attempts". That is a real annoyance and a bad
 * trade: the constant shipped to production, where it removed the only brake in
 * front of the lockout. Account lockout still stops someone grinding ONE
 * account, but nothing then throttled password-spraying ACROSS accounts, and
 * turning it back on needed a code change and a deploy rather than a dashboard
 * toggle — the commit message said `LOGIN_THROTTLE_ENABLED=false`, which reads
 * like an env var it was not.
 *
 * So it is one now, and the default is the safe direction: absent, empty, or
 * anything other than the exact string "false" leaves the throttle ON. A
 * preview or a laptop can opt out; production cannot do so by omission.
 *
 * Scope is unchanged: only the sign-in throttle. Account lockout below and
 * every other `checkRateLimit` caller (apply, kiosk, waiver, magic-link) are
 * untouched by this flag.
 */
const LOGIN_THROTTLE_ENABLED = process.env.LOGIN_THROTTLE_ENABLED !== "false";

/**
 * Whether the per-IP sign-in throttle runs (SF-59, lane A2, 9 Oct 2026).
 * LOGIN_THROTTLE_ENABLED has existed on Vercel Production and Preview since
 * 23 Sep with a value nobody can read back (lane E2, `vercel env ls`, 9 Oct
 * 2026). If it is "false", the six newest builds have no sign-in throttle. So
 * "false" is now honoured only where nothing real is at stake: never in any
 * Vercel deployment (production or preview — previews share production
 * secrets, lane E SEC-067) and never against the production database. Absent,
 * empty or malformed was already ON and stays ON.
 */
function loginThrottleActive(): boolean {
  if (LOGIN_THROTTLE_ENABLED) return true;
  if (process.env.VERCEL || process.env.VERCEL_ENV || isProductionDatabase()) {
    console.warn("[auth] LOGIN_THROTTLE_ENABLED=false ignored: not permitted on a Vercel deployment or the production database");
    return true;
  }
  return false;
}

/**
 * The E2E harness (throttle skip + E2E_BYPASS_TOKEN as a password) — SF-37,
 * lane A2, 9 Oct 2026. Previously `isTestingMode() && isLocalhost`, where
 * "localhost" was read from x-forwarded-for / x-real-ip: client-controlled, and
 * "unknown" (no proxy headers at all) counted as local. Now an explicit flag,
 * E2E_AUTH_BYPASS=true, which is refused on ANY Vercel deployment (VERCEL is
 * set at build and run time there) and wherever isTestingMode() refuses
 * (VERCEL_ENV=production, the production database). No request header can
 * turn it on or off.
 */
function e2eHarnessPermitted(): boolean {
  if (process.env.E2E_AUTH_BYPASS !== "true") return false;
  if (process.env.VERCEL || process.env.VERCEL_ENV) return false;
  return isTestingMode();
}

/**
 * Sign-in refusals that must reach the person at the door.
 *
 * These extend `CredentialsSignin` rather than `Error` for one reason: only that
 * class carries a `code`, and the code is the ONLY thing that survives the trip
 * back to the browser (next-auth/react reads it off the redirect URL —
 * node_modules/next-auth/react.js:175). A plain Error's message is logged on the
 * server and lost to the user.
 *
 * Why that matters: app/login/page.tsx rendered ONE hard-coded string,
 * "Incorrect email or password.", for every failure. So a member who had locked
 * themselves out, a member being rate-limited, and the owner of a suspended club
 * were all told their password was wrong. Each would go and reset a password
 * that was perfectly fine, fail again, and conclude the product is broken.
 *
 * Found by driving the login screen for a suspended club in
 * tests/e2e/campaign/identity.spec.ts.
 *
 * The codes are deliberately coarse. They say what the person must DO next and
 * nothing about whether the address exists, so they cannot be used to enumerate
 * accounts.
 */
import { CredentialsSignin } from "next-auth";

/**
 * Every throttle and every failure lockout answers with this one code (SF-35,
 * lane A2, 9 Oct 2026). There used to be a second, `account_locked`, thrown
 * only for an account that exists — an existence oracle after ten guesses.
 * The counters behind this code are keyed on the address string, so it means
 * the same thing whether or not the account exists.
 */
class RateLimitedError extends CredentialsSignin {
  code = "rate_limited";
  constructor() {
    super(SIGN_IN_THROTTLED_MESSAGE);
  }
}

/**
 * The password was right, but it was a TEMPORARY one (operator reset) and its
 * time is up (6 Oct 2026). Only reachable with the correct temporary password,
 * so it says nothing to someone guessing. The fix is a new temporary password
 * from whoever issued it — MatFlow support for an owner, the club's owner for
 * staff — not a reset link (magic and reset links are refused while
 * `mustChangePassword` is set). Same words as app/login/page.tsx shows.
 */
class TemporaryPasswordExpiredError extends CredentialsSignin {
  code = "temp_password_expired";
  constructor() {
    super("This temporary password has expired. Ask whoever gave it to you for a new one.");
  }
}

/** The CLUB cannot be signed into — nothing to do with these credentials. */
class TenantRefusedError extends CredentialsSignin {
  code: string;
  constructor(reason: "suspended" | "cancelled" | "deleted") {
    super(`This club's account is ${reason}.`);
    // One translation for every door — see lib/tenant-admission.ts.
    this.code = admissionErrorCode(reason);
  }
}

/**
 * An id no User or Member row can have (ids are cuids). The failure path runs
 * its known-device lookup and row-counter write against it when the address
 * has no account, so both paths cost the same round trips (SF-35, lane A3).
 */
const NO_ACCOUNT_ROW_ID = "no-account";

/**
 * The revalidation marker (SF-44, security campaign iteration 2, lane A2,
 * 9 Oct 2026).
 *
 * When the revocation check CANNOT RUN (the database timed out, dropped the
 * connection, refused the query, or answered with something unreadable) the
 * verdict is "unknown". Since AH-G7 that verdict never admits a request. It
 * used to be answered by jwt() returning null — and null makes Auth.js clear
 * the session cookie, which proxy.ts (wrapped by next-auth) copies onto every
 * page and API reply (review R-1). A database blip therefore signed out every
 * user who made a request during it.
 *
 * Now jwt() keeps the token and stamps it with this claim instead. The token
 * carries NO authority while the claim is present: session() answers
 * "unavailable" (no user), the exported auth() below turns that into null for
 * every route and page, and proxy.ts answers a retryable 503 without touching
 * the cookie. The claim is removed only by a later pass whose check succeeds,
 * so the next request revalidates before anything can succeed; a pass that
 * does not run the check (Edge) leaves it in place and stays refused.
 *
 * "revoked" is unchanged: proven revocation returns null and the cookie IS
 * cleared. A token that proves its own revocation (malformed version) is
 * cleared even while the database is down.
 *
 * Bounded: the claim records when the check first failed. A token that has
 * gone REVALIDATE_MAX_MS without one successful check is ended (null) instead
 * of being re-issued indefinitely — re-issuing slides the cookie's expiry, and
 * a session must not outlive its 30 days on the strength of checks that never
 * ran. No cached verdict is ever used as a fallback: the marker only refuses.
 */
const REVALIDATE_CLAIM = "revalidateSince";
const REVALIDATE_MAX_MS = 24 * 60 * 60 * 1000;

function revalidateSince(token: Record<string, unknown>): number | null {
  const v = token[REVALIDATE_CLAIM];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "unknown": keep the cookie, refuse the request, revalidate next time — or end it once the bound is passed. */
function markForRevalidation<T extends Record<string, unknown>>(token: T, reason: string): T | null {
  const now = Date.now();
  const prior = revalidateSince(token);
  const since = prior !== null && prior <= now ? prior : now;
  if (now - since > REVALIDATE_MAX_MS) {
    console.error("[auth] session could not be revalidated within the bound — session ended", {
      reason,
      pendingForMs: now - since,
    });
    return null;
  }
  (token as Record<string, unknown>)[REVALIDATE_CLAIM] = since;
  console.warn("[auth] request refused as unavailable; session kept for revalidation", { reason });
  return token;
}

/**
 * A session object auth() may hand to a caller: one with a user id and not
 * awaiting revalidation. Anything else is "signed out" for that caller — a
 * user-less session is truthy, and 57 call sites check only `if (!session)`.
 */
export function usableSession<S>(session: S): S | null {
  const s = session as { user?: { id?: unknown } | null; authUnavailable?: unknown } | null | undefined;
  if (!s || s.authUnavailable === true) return null;
  if (!s.user || typeof s.user.id !== "string" || !s.user.id) return null;
  return session;
}

const nextAuth = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    ...(GOOGLE_OAUTH_ENABLED
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            // Force the account chooser so a previously-signed-in Google
            // account on a shared device can't silently grant access.
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
    Credentials({
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password, tenantSlug } = parsed.data;

        // The client IP, by the product's trust order (x-vercel-forwarded-for,
        // x-real-ip, then the LAST x-forwarded-for hop). This read the FIRST
        // x-forwarded-for entry — the one a client writes — so a rotating
        // header bought a fresh per-IP bucket on every attempt.
        const ip = requestClientIp(request.headers);
        const userAgent = request.headers.get("user-agent");

        // THE E2E HARNESS IS AN EXPLICIT FLAG, NOT A HEADER (SF-37, lane A2,
        // 9 Oct 2026). It skipped the throttle and enabled the password bypass
        // when the request "looked local" — an x-forwarded-for of 127.0.0.1 or
        // no proxy headers at all, both of which a client can arrange. It now
        // needs E2E_AUTH_BYPASS=true in a TESTING_MODE process that is not on
        // Vercel at all and not on the production database (e2eHarnessPermitted).
        const harness = e2eHarnessPermitted();

        // Per-IP attempt brake across all addresses (password spraying). Only
        // this brake follows LOGIN_THROTTLE_ENABLED, and production cannot turn
        // it off (loginThrottleActive). The per-ADDRESS attempt limit that sat
        // here (5 per 15 minutes from every source) was itself a lockout anyone
        // could trigger for anyone; the address is now guarded by the failure
        // counters below, which a known device of the account is exempt from.
        if (loginThrottleActive() && !harness) {
          const ipRl = await checkRateLimit(`login:ip:${ip}`, 30, 30 * 60 * 1000);
          if (!ipRl.allowed) throw new RateLimitedError();
        }
        try {
          // Pre-session lookup: caller has no JWT yet. Use bypass to fetch the
          // tenant by slug, then switch to tenant-scoped reads once we have id.
          const tenant = await withRlsBypass((tx) =>
            tx.tenant.findUnique({ where: { slug: tenantSlug } }),
          );
          if (!tenant) return null;
          // Reject login for suspended, cancelled or soft-deleted tenants. The
          // admin hub Danger Zone sets these states. Now via the shared helper,
          // so the magic-link and Google doors enforce the same rule — they
          // previously enforced none of it.
          // THROW, do not `return null`. A bare null is rendered by the login
          // page as "Incorrect email or password.", which sends the owner of a
          // suspended club off to reset a password that was never the problem.
          // The thrown error carries a `code` that survives to the browser.
          const admission = tenantAdmission(tenant);
          if (!admission.admits) throw new TenantRefusedError(admission.reason);

          // Sprint 4-A US-404: parallelise user + member lookups. Most logins are
          // members, so the previous "find user, then maybe find member" was always
          // a 2-roundtrip path for the common case. One extra read when staff logs in
          // is a worthwhile trade for ~30-80ms saved on every member login.
          const [user, memberRowRaw] = await withTenantContext(tenant.id, (tx) =>
            Promise.all([
              tx.user.findUnique({
                where: { tenantId_email: { tenantId: tenant.id, email } },
              }),
              tx.member.findUnique({
                where: { tenantId_email: { tenantId: tenant.id, email } },
              }),
            ]),
          );
          const memberRow = !user ? memberRowRaw : null;

          const subject: { id: string; lockedUntil: Date | null; failedLoginCount: number } | null =
            user
              ? { id: user.id, lockedUntil: user.lockedUntil, failedLoginCount: user.failedLoginCount }
              : memberRow
              ? { id: memberRow.id, lockedUntil: memberRow.lockedUntil, failedLoginCount: memberRow.failedLoginCount }
              : null;
          // A row lock now comes only from "Wasn't me?" (disown-login) or an
          // operator — never from failed passwords (lockout v2 below).
          const rowLocked = !!(subject?.lockedUntil && subject.lockedUntil > new Date());

          // LOCKOUT v2 (SF-35 + SF-59, lane A2, 9 Oct 2026; lib/auth-lockout.ts).
          // Counted against the address STRING, so an address with no account
          // reaches the same state after the same requests. Read BEFORE the
          // password is judged; a database error throws and refuses (fail
          // closed). The known-device lookup runs for every address once the
          // address-wide cap is reached — against an id that matches nothing
          // when there is no account — so both paths cost one query.
          // When not blocked, this attempt now HOLDS a failure slot in both
          // counters, taken atomically before bcrypt (R6-N1, lane A4): a
          // concurrent burst gets exactly ADDR_MAX verdicts, not one per
          // request in flight. A correct password gives the slot back below.
          const keys = lockoutKeys(tenantSlug, email, ip);
          const lock = await lockoutState(keys, () =>
            withTenantContext(tenant.id, async (tx) => {
              const dh = deviceHash(ip, userAgent);
              const since = new Date(Date.now() - KNOWN_DEVICE_DAYS * 24 * 60 * 60 * 1000);
              const row = await tx.loginEvent.findFirst({
                where: user
                  ? { userId: user.id, deviceHash: dh, disownedAt: null, lastSeenAt: { gte: since } }
                  : { memberId: memberRow?.id ?? NO_ACCOUNT_ROW_ID, deviceHash: dh, disownedAt: null, lastSeenAt: { gte: since } },
                select: { id: true },
              });
              return !!row;
            }),
          );

          // Always run bcrypt to prevent email enumeration via timing differences.
          // Falls back to DUMMY_HASH when neither record exists — bcrypt still runs
          // but valid will be false, and we return null below.
          const targetHash =
            user?.passwordHash ??
            memberRow?.passwordHash ??
            DUMMY_HASH;

          // E2E bypass: skip bcrypt when the harness is explicitly permitted
          // (see e2eHarnessPermitted) AND the password matches E2E_BYPASS_TOKEN
          // (lives in gitignored .env.test).
          const e2eTokenValid =
            harness &&
            !!process.env.E2E_BYPASS_TOKEN &&
            password === process.env.E2E_BYPASS_TOKEN;
          const valid = e2eTokenValid || (await bcrypt.compare(password, targetHash));

          // ONE answer for every throttle and lock, whether or not the address
          // has an account; the detail goes to the server log only (SF-35).
          if (lock.blocked) {
            console.warn("[auth] sign-in refused: failure lockout", {
              counter: lock.reason,
              tenantId: tenant.id,
              subject: subject ? (user ? "user" : "member") : "none",
              subjectId: subject?.id ?? null,
            });
            throw new RateLimitedError();
          }
          // EVERY refused attempt is counted against the address, BEFORE any
          // row-state branch (lane A3, review R3-2). A row locked by "Wasn't
          // me?" or an operator used to return null here before the failure
          // was recorded, so it answered refused for ever while an address
          // with no account was capped after ADDR_MAX: twelve guesses told a
          // locked account apart (and it answered ~200 ms sooner). Now a
          // locked row — right or wrong password — costs and answers exactly
          // what any other address does at the same count.
          if (rowLocked || !valid) {
            // The failure was recorded when the slot was reserved, before the
            // password was judged (R6-N1); this only reads its count. Fail
            // closed: a missing reservation throws and the attempt stays refused.
            const addrFailures = await recordFailure(keys, lock.reservation);
            // The row counter is kept for the owner's and operator's view of
            // an account under attack; it no longer locks anything. The
            // database does the arithmetic ({ increment: 1 }), so overlapping
            // attempts are all counted (tests/unit/account-lockout-counter).
            //
            // It runs UNCONDITIONALLY (lane A3, review R3-3): with no account
            // the same single-statement transaction targets an id that matches
            // nothing, so a wrong password costs the same round trips whether
            // or not the address exists (+205..263 ms on the review link
            // before; tests/unit/sec-a3-failure-path-cost pins the equality).
            try {
              await withTenantContext(tenant.id, async (tx) => {
                if (user) {
                  await tx.user.update({
                    where: { id: user.id },
                    data: { failedLoginCount: { increment: 1 } },
                    select: { failedLoginCount: true },
                  });
                } else if (memberRow) {
                  await tx.member.update({
                    where: { id: memberRow.id },
                    data: { failedLoginCount: { increment: 1 } },
                    select: { failedLoginCount: true },
                  });
                } else {
                  await tx.member.updateMany({
                    where: { id: NO_ACCOUNT_ROW_ID, tenantId: tenant.id },
                    data: { failedLoginCount: { increment: 1 } },
                  });
                }
              });
            } catch (err) {
              console.error("[auth] failed-login row counter NOT recorded (the address lockout still counted)", {
                subject: user ? "user" : memberRow ? "member" : "none",
                subjectId: subject?.id ?? null,
                tenantId: tenant.id,
                error: err instanceof Error ? err.message : String(err),
              });
              Sentry.captureException(err, {
                tags: { area: "auth", control: "account-lockout", failMode: "closed" },
              });
            }
            if (rowLocked) {
              console.warn("[auth] sign-in refused: account row locked (disown or operator)", {
                tenantId: tenant.id,
                subjectId: subject?.id ?? null,
              });
            }
            if (subject && addrFailures === ADDR_MAX) {
              // The owner sees an account under attack in the activity log.
              // After the response, so the audit write adds no timing signal.
              const auditArgs = {
                tenantId: tenant.id,
                userId: user?.id ?? null,
                action: "auth.account.locked",
                entityType: user ? "User" : "Member",
                entityId: subject.id,
                metadata: { reason: "failed_login_cap", scope: "unrecognised_devices", threshold: ADDR_MAX, windowMinutes: LOCKOUT_WINDOW_MS / 60000 },
              };
              const write = async () => {
                try {
                  const { logAudit } = await import("@/lib/audit-log");
                  await logAudit(auditArgs);
                } catch { /* best-effort */ }
              };
              try {
                after(write);
              } catch {
                await write();
              }
            }
            // The generic refusal a wrong password gets, for a locked row too:
            // its own message would say the address has an account.
            return null;
          }

          // The password was right: give this attempt's address slot back and
          // start this network's counter again, BEFORE any later refusal (an
          // expired temporary password is not a guess). Best-effort: a failure
          // here only keeps one slot spent (R6-N1 refund, lane A4).
          try {
            await clearPairOnSuccess(keys, lock.reservation);
          } catch { /* best-effort */ }

          // A temporary password stops working at its expiry (operator reset,
          // 6 Oct 2026). Null expiry on a temporary password (rows from before
          // the column existed) = LEGACY_TEMP_PASSWORD_DEADLINE (review D2);
          // passwords people chose themselves never expire. Checked only after
          // the password matched, so it reveals nothing to a guesser. Not
          // TESTING_MODE-suppressed, like the mustChangePassword gate itself.
          if (user && isTempPasswordExpired(user)) {
            throw new TemporaryPasswordExpiredError();
          }

          // Successful login — reset failed counter + clear any stale lock.
          if (subject && (subject.failedLoginCount > 0 || subject.lockedUntil)) {
            try {
              await withTenantContext(tenant.id, async (tx) => {
                if (user) {
                  await tx.user.update({
                    where: { id: user.id },
                    data: { failedLoginCount: 0, lockedUntil: null },
                  });
                } else if (memberRow) {
                  await tx.member.update({
                    where: { id: memberRow.id },
                    data: { failedLoginCount: 0, lockedUntil: null },
                  });
                }
              });
            } catch { /* swallow — best-effort */ }
          }

          if (user) {
            const role = normalizeRole(user.role);
            // P1.6: new-device detection, run after the response (keepLoginEvent).
            // Internal try/catch means a DB blip or Resend outage cannot break
            // the login response.
            await keepLoginEvent({
              subject: {
                kind: "user",
                id: user.id,
                email: user.email,
                tenantId: tenant.id,
                role,
                notifyOnNewLogin: user.notifyOnNewLogin,
              },
              ip,
              ua: request.headers.get("user-agent"),
              appUrl: appUrl(request.headers),
              gymName: tenant.name,
            });
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              sessionVersion: user.sessionVersion,
              tenantId: user.tenantId,
              tenantSlug: tenant.slug,
              tenantName: tenant.name,
              primaryColor: tenant.primaryColor,
              secondaryColor: tenant.secondaryColor,
              textColor: tenant.textColor,
              // THE CHALLENGE FOLLOWS ENROLMENT, NOT RANK (Noe, 19 Sep 2026).
              // This read `isOwner && user.totpEnabled === true`, so a manager,
              // coach or admin who had enrolled a second factor — which
              // `app/api/auth/totp/setup/route.ts` lets any staff role do, and
              // whose secret is stored on their own row — was never once asked
              // for a code. The product took the secret, showed the QR, cleared
              // the nudge, and then signed them in on the password alone: 2FA
              // that exists in the database and nowhere in the door. Meanwhile
              // members (`:475` below) were challenged correctly, so the two
              // populations were exactly inverted.
              //
              // Nothing becomes mandatory here. `totpEnabled` is still opt-in
              // for every non-owner; this only makes the opt-in mean something.
              totpPending: !isTestingMode() && user.totpEnabled === true,
              // Mandatory authenticator for ELEVATED roles (1 Oct 2026): owner,
              // manager and admin are held at /login/totp/setup (proxy.ts) and
              // refused 403 on every /api route until enrolled. A coach keeps
              // optional 2FA. One policy: lib/mfa-policy.ts.
              requireTotpSetup: requiresTotpEnrolment({ role, totpEnabled: user.totpEnabled, testingMode: isTestingMode() }),
              // 2FA-optional spec: ground-truth totpEnabled for the dashboard
              // banner (any role). Banner is shown when this is false.
              totpEnabled: user.totpEnabled,
              // A temporary password (operator reset, or an owner setting a
              // staff password) is not the person's own. Carried on the token
              // so proxy.ts and lib/api-authz.ts can refuse the API as well as
              // the dashboard page until /set-password clears it (3 Oct 2026:
              // the flag was enforced by app/dashboard/layout.tsx alone, so a
              // temp-password session could read every /api route directly).
              // NOT TESTING_MODE-suppressed: the page gate never was either.
              mustChangePassword: user.mustChangePassword === true,
            };
          }

          if (memberRow?.passwordHash) {
            await keepLoginEvent({
              subject: {
                kind: "member",
                id: memberRow.id,
                email: memberRow.email,
                tenantId: tenant.id,
                notifyOnNewLogin: memberRow.notifyOnNewLogin,
              },
              ip,
              ua: request.headers.get("user-agent"),
              appUrl: appUrl(request.headers),
              gymName: tenant.name,
            });
            return {
              id: memberRow.id,
              email: memberRow.email,
              name: memberRow.name,
              role: "member",
              sessionVersion: memberRow.sessionVersion,
              tenantId: memberRow.tenantId,
              tenantSlug: tenant.slug,
              tenantName: tenant.name,
              primaryColor: tenant.primaryColor,
              secondaryColor: tenant.secondaryColor,
              textColor: tenant.textColor,
              memberId: memberRow.id,
              // 2FA-optional spec (2026-05-07): mirror the User TOTP fields for
              // password-bearing members. totpPending fires the second-factor
              // /login/totp challenge when the member has enrolled.
              totpPending: !isTestingMode() && memberRow.totpEnabled === true,
              totpEnabled: memberRow.totpEnabled,
            };
          }

          // THE E2E BYPASS RESOLVES THE ACCOUNT THE EMAIL NAMES, OR NOTHING.
          //
          // There used to be a fallback here: when the bypass token was used
          // and no account matched the address, this looked up the tenant's
          // FIRST OWNER and returned it, "so the test session still works". It
          // worked far too well. Lane L-D signed in as `member@totalbjj.com` —
          // an address the seed does not create — and was handed the club's
          // owner, with `role: "owner"`, so six cells asserting that a MEMBER is
          // refused recorded 200s and 201s as passes. The tell in their log is
          // that the "member" out-ranked `admin` and `coach`, which were
          // correctly refused in the same loop, and that its own check-in 404'd
          // because the session had no `Member` row at all.
          //
          // That is privilege escalation triggered by a typo, and its whole
          // value was saving a test author from finding out that their address
          // was wrong. Silence about a wrong address is not a feature. An
          // unmatched email now falls through to the same `return null` every
          // other unmatched login takes, so the harness learns at the login
          // screen instead of six assertions later.
          //
          // The bypass ITSELF is untouched: `e2eTokenValid` (:305-310) still
          // stands in for the bcrypt comparison, so a seeded account signs in
          // with the token exactly as before. Only the invention of a subject
          // nobody asked for is gone. Production was never exposed —
          // `isTestingMode()` refuses `VERCEL_ENV=production` and any process
          // pointed at the production branch — but every test host was, and a
          // control that silently upgrades an unknown caller to owner is worth
          // removing wherever it runs.

          // Reached only when DUMMY_HASH was used (no matching account)
          return null;
        } catch (err) {
          // Every message-bearing refusal must survive this catch. Adding a new
          // one WITHOUT adding it here silently reverts it to "Incorrect email
          // or password." — which is precisely how the suspension refusal was
          // swallowed the first time.
          if (
            err instanceof RateLimitedError ||
            err instanceof TenantRefusedError ||
            err instanceof TemporaryPasswordExpiredError
          ) throw err;
          // DB unavailable — DEMO_MODE fallback is dev-only. Wrapping the early
          // return on NODE_ENV first lets bundlers (Next.js + terser) eliminate
          // the demo credential map from production builds entirely. The
          // existing prod-runtime guard above (line ~48) prevents DEMO_MODE
          // from ever being honoured at runtime in prod, but keeping the
          // credentials out of the shipped JS removes the optics concern in
          // any code-review-grade diligence.
          if (process.env.NODE_ENV === "production") return null;
          if (process.env.DEMO_MODE !== "true") return null;

          const DEMO_USERS: Record<string, { name: string; role: string }> = {
            "owner@totalbjj.com":  { name: "Owner",      role: "owner" },
            "coach@totalbjj.com":  { name: "Coach Mike", role: "coach" },
            "admin@totalbjj.com":  { name: "Admin",      role: "admin" },
            "member@totalbjj.com": { name: "John Smith", role: "member" },
          };
          if (tenantSlug === "totalbjj" && DEMO_USERS[email] && password === "password123") {
            const demo = DEMO_USERS[email];
            return {
              id: `demo-${email}`,
              email,
              name: demo.name,
              role: demo.role,
              sessionVersion: 0,
              tenantId: "demo-tenant",
              tenantSlug: "totalbjj",
              tenantName: "Total BJJ",
              primaryColor: "#3b82f6",
              secondaryColor: "#2563eb",
              textColor: "#ffffff",
            };
          }
          return null;
        }
      },
    }),
  ],
  callbacks: {
    // P1.5: gate Google OAuth. The Credentials provider's authorize() already
    // returns its own user object; this only fires substantive logic on the
    // OAuth path.
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      // Google must have verified the email — without this, anyone who
      // controls a Google account with an unverified email matching a real
      // member could log in.
      if (!(profile as { email_verified?: boolean })?.email_verified) {
        return "/login?error=GoogleEmailUnverified";
      }

      const slug = await readPendingTenantSlug();
      if (!slug) return "/login?error=NoTenantContext";

      const email = user.email?.toLowerCase().trim();
      if (!email) return "/login?error=NoTenantContext";

      const tenant = await withRlsBypass((tx) =>
        tx.tenant.findUnique({ where: { slug } }),
      );
      if (!tenant) return "/login?error=NoTenantContext";

      // The club's account state. This callback used to check only that the
      // tenant EXISTED, so Google was an open side door around a suspension the
      // credentials provider below enforced properly.
      const googleAdmission = tenantAdmission(tenant);
      if (!googleAdmission.admits) {
        // Same translation as the credentials door and the magic-link door.
        // This line built its code by interpolation too, so the Google path
        // refused a paused club and then told the person their password was
        // wrong — on a door that never asked for a password.
        return `/login?error=${admissionErrorCode(googleAdmission.reason)}`;
      }

      const [dbUser, memberRow] = await withTenantContext(tenant.id, (tx) =>
        Promise.all([
          tx.user.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          }),
          tx.member.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          }),
        ]),
      );
      // No auto-provisioning. Only existing accounts can use Google login.
      // ONE code with the no-link refusal below (lane A3, review R3 §5): this
      // answered NoAccountForGym, so the door told the mailbox owner whether
      // the address has an account in this club. When the link store lands
      // the lookup by (club, provider, sub) runs BEFORE this email lookup and
      // refuses with the same code (SF-36 proposal, "Lookup").
      if (!dbUser && !memberRow) return "/login?error=google_link_required";
      // A staff account still on its temporary password is in bootstrap: its
      // only credential is that password, handed over privately. Proving
      // control of the mailbox (which is all Google proves) must not reach
      // /set-password — the same rule the magic-link door applies (3 Oct 2026).
      if (dbUser?.mustChangePassword === true) return "/login?error=invalid_link";
      // A PROVISIONAL login email (7 Oct 2026, lib/login-email.ts) is an
      // identifier, not a mailbox anyone has shown to be this person's — and a
      // verified Google account proves exactly the mailbox and nothing more. No
      // external identity provider signs a provisional identifier in. Audited;
      // the answer is the one a dead link gets. Password + authenticator only.
      if (isLoginEmailProvisional(dbUser)) {
        try {
          const { logAudit } = await import("@/lib/audit-log");
          await logAudit({
            tenantId: tenant.id,
            userId: null,
            action: "auth.external_signin.refused_provisional",
            entityType: "User",
            entityId: dbUser!.id,
            metadata: { provider: "google", reason: "login_email_provisional" },
          });
        } catch {
          // Best-effort: the refusal stands whether or not the row is written.
        }
        return "/login?error=invalid_link";
      }

      // EXPLICIT LINKING ONLY (SF-36, security campaign iteration 2, lane A2,
      // 9 Oct 2026). Everything above proves one thing: Google says this
      // person controls a mailbox whose address matches an account here.
      // That used to be enough to sign in as the account — linking by email
      // alone — so a member with no password (whom the magic-link door
      // refuses) got in, and anyone who ever controlled the address at Google
      // (a recycled Workspace mailbox, a former employee's alias) would too.
      // A Google identity now opens an account only through an explicit link
      // the account itself created while proven (signed in AND re-entering its
      // password or authenticator), keyed on Google's stable subject id, never
      // the address. The link store is a proposed migration (ExternalIdentity,
      // docs/security/evidence/A2/REPORT.md); until it exists no identity is
      // linked, so every Google sign-in is refused here — safe interim, never
      // a silent link. Production: ENABLE_GOOGLE_OAUTH, GOOGLE_CLIENT_ID and
      // GOOGLE_CLIENT_SECRET are absent from the Vercel variables (lane E
      // listing, 9 Oct 2026), so the provider is not even registered there.
      const link = await linkedExternalIdentity("google", account?.providerAccountId, tenant.id);
      const linkedToThisAccount =
        !!link && (dbUser ? link.userId === dbUser.id : link.memberId === memberRow?.id);
      if (!linkedToThisAccount) {
        console.warn("[auth] Google sign-in refused: no explicit link to this account", {
          tenantId: tenant.id,
          subject: dbUser ? "user" : "member",
        });
        return "/login?error=google_link_required";
      }

      // Hydrate the `user` object so the jwt() callback below populates the
      // token with the same shape as the Credentials path produces.
      const member = !dbUser ? memberRow : null;
      Object.assign(user, dbUser
        ? {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            role: dbUser.role,
            sessionVersion: dbUser.sessionVersion,
            tenantId: dbUser.tenantId,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            primaryColor: tenant.primaryColor,
            secondaryColor: tenant.secondaryColor,
            textColor: tenant.textColor,
            // Same rule as the password door above: enrolment, not rank. The
            // Google path had the identical `isOwner` gate, so a coach who had
            // enrolled skipped the second factor here too. `requireTotpSetup`
            // is the elevated-role enrolment gate (lib/mfa-policy.ts).
            totpPending: !isTestingMode() && dbUser.totpEnabled === true,
            requireTotpSetup: requiresTotpEnrolment({ role: normalizeRole(dbUser.role), totpEnabled: dbUser.totpEnabled, testingMode: isTestingMode() }),
            totpEnabled: dbUser.totpEnabled,
            // A bootstrap (temporary-password) staff account was refused
            // above, so a Google sign-in that reaches here never owes a change.
            mustChangePassword: false,
          }
        : {
            id: member!.id,
            email: member!.email,
            name: member!.name,
            role: "member",
            sessionVersion: member!.sessionVersion,
            tenantId: member!.tenantId,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            primaryColor: tenant.primaryColor,
            secondaryColor: tenant.secondaryColor,
            textColor: tenant.textColor,
            memberId: member!.id,
            totpPending: !isTestingMode() && member!.totpEnabled === true,
            totpEnabled: member!.totpEnabled,
          });

      // P1.6: new-device detection on the OAuth path too. Fire-and-forget;
      // signIn() doesn't get a Request, so we read headers via next/headers.
      try {
        const { headers } = await import("next/headers");
        const h = await headers();
        // The product's trust order, as on the credentials path (lane A3,
        // review R3 §5). This read the FIRST x-forwarded-for entry — the one
        // the client writes — and the login event it feeds decides which
        // devices are "known" (new-device mail, the address-cap exemption).
        const ip = requestClientIp(h);
        const ua = h.get("user-agent");
        const subjectArgs = dbUser
          ? {
              kind: "user" as const,
              id: dbUser.id,
              email: dbUser.email,
              tenantId: tenant.id,
              role: normalizeRole(dbUser.role),
              notifyOnNewLogin: dbUser.notifyOnNewLogin,
            }
          : {
              kind: "member" as const,
              id: memberRow!.id,
              email: memberRow!.email,
              tenantId: tenant.id,
              notifyOnNewLogin: memberRow!.notifyOnNewLogin,
            };
        await keepLoginEvent({
          subject: subjectArgs,
          ip,
          ua,
          appUrl: appUrl(h),
          gymName: tenant.name,
        });
      } catch { /* best-effort */ }

      // Tenant decision is final — clear the cookie so it can't be reused.
      await clearPendingTenantSlug();
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = normalizeRole(user.role);
        token.sessionVersion = user.sessionVersion ?? 0;
        token.tenantId = user.tenantId;
        token.tenantSlug = user.tenantSlug;
        token.tenantName = user.tenantName;
        token.primaryColor = user.primaryColor;
        token.secondaryColor = user.secondaryColor;
        token.textColor = user.textColor;
        token.memberId = user.memberId ?? null;
        token.totpPending = user.totpPending ?? false;
        token.requireTotpSetup = user.requireTotpSetup ?? false;
        token.totpEnabled = user.totpEnabled ?? false;
        // Minted from the DB row at sign-in and never refreshed per request.
        // That is safe because every write that SETS the flag also bumps
        // `sessionVersion` (admin force-password-reset, owner resetting a
        // staff password in app/api/staff/[id]), so no token can outlive the
        // flag being turned on; and /api/auth/set-password, which CLEARS it,
        // bumps the version and re-issues this device's token without it.
        // tests/unit/owner-activation-order.test.ts pins that invariant.
        token.mustChangePassword = (user as { mustChangePassword?: boolean }).mustChangePassword === true;
        // LB-004: stamp brand-fetch timestamp so the periodic refresh below
        // knows when to re-query Tenant.* without forcing the user to log out.
        token.brandFetchedAt = Date.now();
        // A record of when the version was last known good. Nothing gates on
        // it any more — see the revocation block below, which used to skip for
        // ten minutes on the strength of this stamp and no longer does.
        token.sessionVersionCheckedAt = Date.now();
        // A real sign-in is never a support carrier.
        delete (token as Record<string, unknown>)[SUPPORT_CARRIER_CLAIM];
        return token;
      }

      // A carrier exists only for the Node-runtime support swap below. Where
      // that cannot run, it is nothing — never an identity-less session.
      if (
        process.env.NEXT_RUNTIME === "edge" &&
        (token as Record<string, unknown>)[SUPPORT_CARRIER_CLAIM] === true
      ) {
        return null;
      }

      // Upgrade stale demo-tenant tokens to real DB ids on next request
      if (token.tenantId === "demo-tenant" && token.tenantSlug) {
        try {
          // withRlsBypass, not the bare client. Production connects as a
          // BYPASSRLS role, so these worked and would go on appearing to work
          // right up until the planned cutover to the restricted role — at
          // which point they return zero rows and this silently stops
          // upgrading, with nothing anywhere to say so. Same reason as the
          // revocation check below; see lib/session-revocation.ts.
          const upgraded = await withRlsBypass(async (tx) => {
            const t = await tx.tenant.findUnique({
              where: { slug: token.tenantSlug as string },
            });
            if (!t) return null;
            const u = await tx.user.findFirst({
              where: { tenantId: t.id, email: token.email as string },
            });
            return u ? { tenant: t, dbUser: u } : null;
          });
          if (upgraded) {
            {
              const { tenant, dbUser } = upgraded;
              token.id = dbUser.id;
              token.tenantId = tenant.id;
              token.tenantName = tenant.name;
              token.sessionVersion = dbUser.sessionVersion;
              token.primaryColor = tenant.primaryColor;
              token.secondaryColor = tenant.secondaryColor;
              token.textColor = tenant.textColor;
              token.memberId = null;
            }
          }
        } catch { /* DB still unavailable — keep demo token */ }
        return token;
      }

      // Super-admin impersonation override.
      // If a valid `matflow_impersonation` cookie is present, swap the token to
      // the target user's identity. Subsequent gates (sessionVersion check,
      // brand refresh, TOTP enforcement in proxy.ts) then operate on the TARGET
      // user — which is correct: if the target gets disowned mid-session, the
      // impersonation dies. Bypasses the target's TOTP because a named operator
      // proved their own MFA and a fresh step-up code to start it.
      //
      // THE SWAP IS A LOAN, NOT A TRANSFER. Two defects lane L-G found by
      // driving it, both of which come from the swap having been written as an
      // in-place overwrite:
      //
      // 1. Nothing remembered the operator's own claims, so when the cookie
      //    went away the block was simply skipped and the JWT kept the
      //    borrowed identity — and the `impersonatedBy` claim — for as long as
      //    the browser kept the token. `DELETE /api/admin/impersonate`
      //    returned 200, wrote its `admin.impersonate.end` audit row, cleared
      //    the cookie, and the session went on reporting the tenant
      //    (`lg-2:187`: `expect(user.impersonatedBy).toBeUndefined()` received
      //    `"__matflow_super_admin__"`). The operator kept an identity they
      //    had borrowed from a club after they had stopped borrowing it.
      //    So: stash the operator's own claims under `impersonatorClaims` on
      //    the first swap, and put them back the moment the cookie is gone.
      //
      // 2. `token.sessionVersion` was re-read from the database on EVERY pass,
      //    immediately before the revocation check below compares token against
      //    database. The two could never differ, so the one mechanism that can
      //    take access away from a live session was inert for exactly the
      //    sessions that most need it — `lg-2:222` bumped the target's
      //    `sessionVersion` and the impersonated session carried on. That is
      //    the opposite of what this comment promised. So the version is minted
      //    ONCE, when the impersonation starts, and thereafter the token's copy
      //    is left alone to go stale and be caught.
      //
      // The stash-once guard does both jobs, and it is load-bearing in a way
      // that is easy to miss: on the second request the token ALREADY holds the
      // target's claims, so stashing again would file the target's identity as
      // the operator's and turn the restore into a no-op.
      //
      // SUPPORT SESSIONS ARE BOUND AND READ-ONLY (6 Oct 2026, remediation lane
      // B). resolveActiveImpersonation() re-checks, on EVERY request, the
      // cookie's signature and expiry, the operator's own live MFA session
      // (same operator, same sessionVersion), the nonce recorded on the
      // Operator row (cleared by the stop), the target's sessionVersion as it
      // was at start, and the club's admission. A binding that fails is "no
      // support session": the restore branch below hands the operator their
      // own claims back. Whatever the swap grants is read-only:
      // lib/support-session.ts, proxy.ts.
      //
      // A resolver THROW (database error) is different (review finding D1,
      // 6 Oct 2026). It used to be treated as "no support" too, which failed
      // OPEN: the proxy's jwt() restored the operator, so proxy.ts saw no
      // support session and let a POST through; the route handler's own auth()
      // then re-ran jwt() on the same JWT cookie, the resolver could succeed
      // that time, and the handler ran as the TARGET owner. So when support may
      // be live — a support cookie on the request, or a stash / impersonatedBy
      // claim on the token — a throw ends the session for this request (null)
      // instead of guessing. Cookie presence is read BEFORE the resolver; an
      // unreadable cookie store counts as no cookie (the resolver reads the
      // same store, so it cannot succeed where this read failed).
      if (process.env.NEXT_RUNTIME !== "edge") {
        let supportCookiePresent = false;
        try {
          supportCookiePresent = await hasImpersonationCookie();
        } catch {
          supportCookiePresent = false;
        }
        let active: Awaited<ReturnType<typeof resolveActiveImpersonation>> = null;
        try {
          active = await resolveActiveImpersonation();
        } catch (err) {
          const bag = token as Record<string, unknown>;
          if (
            supportCookiePresent ||
            bag[IMPERSONATION_STASH] ||
            bag.impersonatedBy ||
            bag[SUPPORT_CARRIER_CLAIM] === true
          ) {
            console.error("[auth] support session could not be checked — session refused for this request", {
              error: err instanceof Error ? err.message : String(err),
            });
            Sentry.captureException(err, {
              tags: { area: "auth", control: "support-session", failMode: "closed" },
            });
            return null;
          }
          active = null;
        }
        try {
          if (active) {
            const { payload: imp, target } = active;
            {
              const bag = token as Record<string, unknown>;
              const starting = !bag[IMPERSONATION_STASH];
              // Mirror of D6 (review N3, 6 Oct 2026): a legacy token that already
              // carries impersonatedBy but no stash must never have its (target)
              // claims stashed as the operator's — the stop would "restore" the
              // target. End it instead.
              if (starting && bag.impersonatedBy) return null;
              if (starting) {
                // The operator's own claims, kept whole so the stop can hand
                // them back. Written exactly once per impersonation.
                bag[IMPERSONATION_STASH] = {
                  // `token.id` is `unknown` on the base JWT; the rest are typed
                  // by types/next-auth.d.ts and need no help.
                  id: token.id as string | undefined,
                  tenantId: token.tenantId,
                  tenantSlug: token.tenantSlug,
                  tenantName: token.tenantName,
                  primaryColor: token.primaryColor,
                  secondaryColor: token.secondaryColor,
                  textColor: token.textColor,
                  role: token.role,
                  sessionVersion: token.sessionVersion,
                  memberId: token.memberId ?? null,
                  totpPending: token.totpPending ?? false,
                  requireTotpSetup: token.requireTotpSetup ?? false,
                  totpEnabled: token.totpEnabled ?? false,
                  mustChangePassword: token.mustChangePassword === true,
                  name: token.name ?? null,
                  email: token.email ?? null,
                  ...(bag[SUPPORT_CARRIER_CLAIM] === true ? { supportCarrier: true } : {}),
                } satisfies ImpersonatorClaims;
              }
              // The target's version AS IT WAS WHEN SUPPORT STARTED, carried
              // in the signed cookie — never re-read from the database. Reading
              // it fresh on every pass is what made a `sessionVersion` bump
              // unable to evict an impersonated session (defect 2 above), and
              // minting it once at the first swap still let a restore-then-
              // re-swap re-mint it. resolveActiveImpersonation() also refuses a
              // moved version outright.
              token.sessionVersion = imp.tsv;
              token.id = target.id;
              // The person being supported, not whoever this browser was
              // before (that name leaked into the avatar) and not nothing (a
              // carrier has no name: every dashboard page 500'd) — lane J item 9.
              token.name = target.name ?? null;
              token.email = target.email ?? null;
              token.tenantId = target.tenantId;
              token.tenantSlug = target.tenant.slug;
              token.tenantName = target.tenant.name;
              token.primaryColor = target.tenant.primaryColor;
              token.secondaryColor = target.tenant.secondaryColor;
              token.textColor = target.tenant.textColor;
              token.role = normalizeRole(target.role);
              token.memberId = null;
              token.totpPending = false;
              token.requireTotpSetup = false;
              // Support suppresses the recommend-2FA banner — operator
              // is acting on someone else's account; nudging them to enrol the
              // target's authenticator would be confusing.
              token.totpEnabled = true;
              // The target's temporary-password gate does not hold the
              // operator at /set-password: support is read-only, so the
              // operator can neither choose the owner's password nor enrol the
              // owner's authenticator (lib/support-session.ts) — lifting the
              // gates only lets support SEE the dashboard.
              token.mustChangePassword = false;
              token.brandFetchedAt = Date.now();
              bag.impersonatedBy = imp.adminUserId;
              bag.impersonationReason = imp.reason;
            }
          } else {
            // No valid support session (no cookie, expired, stopped, operator
            // signed out or revoked, target or club changed, or a database
            // error): the impersonation is over. Hand the operator their own
            // identity back and drop every trace of the borrowed one. This runs
            // on the first request after the stop, so the claim cannot outlive
            // the cookie even by one page.
            const bag = token as Record<string, unknown>;
            const stashed = bag[IMPERSONATION_STASH] as ImpersonatorClaims | undefined;
            // A carrier (clean-browser support start) has no identity of its
            // own to give back: support over — stop, expiry, any binding
            // failure, or a carrier presented alone — means signed out.
            if (bag[SUPPORT_CARRIER_CLAIM] === true || stashed?.supportCarrier === true) return null;
            // Review finding D6 (6 Oct 2026): a token carrying impersonatedBy
            // with NO stash (pre-19-Sep in-place swap) has no operator identity
            // to give back — keeping it keeps the borrowed one. End it.
            if (!stashed && bag.impersonatedBy) return null;
            if (stashed) {
              token.id = stashed.id;
              token.tenantId = stashed.tenantId;
              token.tenantSlug = stashed.tenantSlug;
              token.tenantName = stashed.tenantName;
              token.primaryColor = stashed.primaryColor;
              token.secondaryColor = stashed.secondaryColor;
              token.textColor = stashed.textColor;
              token.role = stashed.role;
              token.sessionVersion = stashed.sessionVersion;
              token.memberId = stashed.memberId;
              token.totpPending = stashed.totpPending;
              token.requireTotpSetup = stashed.requireTotpSetup;
              token.totpEnabled = stashed.totpEnabled;
              token.mustChangePassword = stashed.mustChangePassword === true;
              if ("name" in stashed) token.name = stashed.name ?? null;
              if ("email" in stashed) token.email = stashed.email ?? null;
              delete bag[IMPERSONATION_STASH];
              delete bag.impersonatedBy;
              delete bag.impersonationReason;
              // The restored subject is a different row from the one the last
              // request checked, so nothing about it has been verified yet. The
              // revocation check below runs on every pass and will do it.
              token.brandFetchedAt = 0;
            }
          }
        } catch (err) {
          // FAIL CLOSED (SEC-012, 9 Oct 2026). This block only does work when a
          // support session is starting, live or ending; a throw part-way
          // through leaves the token half-swapped between the operator and the
          // target. It used to be swallowed ("best-effort") and the half-swapped
          // token carried on. Ending the session is the only safe answer.
          console.error("[auth] support swap/restore failed — session ended", {
            error: err instanceof Error ? err.message : String(err),
          });
          Sentry.captureException(err, {
            tags: { area: "auth", control: "support-session", failMode: "closed" },
          });
          return null;
        }
      }

      // Non-user refresh: verify the token's sessionVersion still matches DB.
      // Mismatch = force sign-out (clear identity fields; session() returns no user).
      // Skip in Edge runtime (proxy.ts) — Prisma is Node-only; the layout's
      // auth() call (Node runtime) re-runs this callback and enforces the check.
      //
      // REVOCATION IS NOT CACHED. It used to be, behind a 10-minute window
      // ("force-logout propagates within that window"), and that window was the
      // whole of the guarantee three separate screens make:
      //
      //   • Topbar.tsx:81-86 — "Sign out from all devices? You will need to
      //     sign in again on every device, including this one."
      //   • SettingsPage.tsx:1063 — removing a member of staff: "They will
      //     lose access to this gym's dashboard immediately."
      //   • the password reset, which bumps `sessionVersion` precisely so that
      //     whoever knew the old password is thrown out.
      //
      // None of the three was true. An owner who removed a coach — the action
      // you take when you have just stopped trusting someone — watched the
      // dialog say "immediately" while that coach kept the roster, the member
      // details and the exports for up to ten more minutes, on a token the
      // product had already decided to reject. The same window applied to a
      // stolen session after a password reset.
      //
      // So the check runs on every Node-runtime pass. The cost is one indexed
      // primary-key read of a single column, against a request that already
      // makes several; the thing being bought with it is the only mechanism in
      // the product that can take access away from someone who still holds a
      // valid-looking JWT. `brandFetchedAt` below keeps its interval — stale
      // branding for half an hour is a cosmetic delay, not a security one.
      if (
        process.env.NEXT_RUNTIME !== "edge" &&
        token.id && token.tenantId && token.tenantId !== "demo-tenant"
      ) {
        {
          // A MISSING row is a revoked session. This used to read the version
          // through `?.`, so a hard-deleted staff member produced `undefined`,
          // the guard's own `!== undefined` short-circuit skipped the check, and
          // the removed coach kept a working dashboard for the rest of the JWT's
          // 30 days — while the confirmation dialog promised "immediately".
          // Deleting a row cannot bump a sessionVersion on a row that is gone, so
          // deletion was the one action revocation could not see.
          //
          // Extracted to lib/session-revocation so it can be tested at all: this
          // lived inline in a NextAuth config object, which is why the product's
          // revocation control had no test.
          const verdict = await checkSessionVersion(
            {
              memberId: token.memberId as string | null,
              userId: token.id as string,
              tokenVersion: token.sessionVersion,
              tenantId: token.tenantId as string,
            },
            // The display name follows a profile edit on every device (8 Oct
            // 2026). The row is the one this check reads anyway.
            (name) => {
              if (token.name !== name) token.name = name;
            },
          );
          // "revoked" AND "unknown" both refuse (AH-G7 / SEC-012, security
          // campaign lane A, 9 Oct 2026). Until then "unknown" kept the token
          // and session() returned the full user, so for as long as this lookup
          // kept failing every revocation in the product (password reset, log
          // out everywhere, staff removal, suspension) failed OPEN on any
          // request whose later queries happened to succeed.
          //
          // They refuse DIFFERENTLY (SF-44, lane A2, 9 Oct 2026). "revoked" is
          // proven: null, and Auth.js clears the cookie. "unknown" is a
          // dependency failure, not a verdict about this person: the token is
          // kept, marked for revalidation, and carries no authority until a
          // later check succeeds (see REVALIDATE_CLAIM above). Returning null
          // for "unknown" — the AH-G7 version — signed every user out during a
          // database blip, because proxy.ts copies the cookie-clearing
          // Set-Cookie onto the reply (review R-1).
          if (verdict === "revoked") return null;
          if (verdict === "unknown") return markForRevalidation(token, "revocation-check-unavailable");
          // `sessionVersionCheckedAt` is now a record of the last successful
          // check and nothing gates on it: no branch above may read it back as
          // permission to skip the check, which is what made the guarantee
          // above untrue for ten minutes at a time.
          token.sessionVersionCheckedAt = Date.now();

          // A staff token minted before `mustChangePassword` was a claim has no
          // such key. Read the row ONCE and stamp it, so a temp-password session
          // that predates the deploy is gated like a fresh one instead of
          // reading `undefined` as "no change needed" for up to 30 days. Only
          // legacy tokens pay this read; every new token carries the claim.
          // On a DB error this request is refused (fail closed, like the
          // revocation check above); the next request reads the row again.
          if (
            typeof token.mustChangePassword !== "boolean" &&
            !token.memberId &&
            !(token as Record<string, unknown>).impersonatedBy
          ) {
            try {
              const row = await withRlsBypass((tx) =>
                tx.user.findUnique({ where: { id: token.id as string }, select: { mustChangePassword: true } }),
              );
              if (row) token.mustChangePassword = row.mustChangePassword === true;
            } catch {
              // Cannot tell whether this legacy token is a temporary-password
              // session: refuse this request rather than read "absent" as "no
              // change needed" (SEC-012). A dependency failure, so refused as
              // "unknown" above is: kept, marked, revalidated next time (SF-44).
              return markForRevalidation(token, "legacy-temp-password-read-unavailable");
            }
          }
          // Every check this pass owed has now succeeded: only here may the
          // revalidation marker go.
          delete (token as Record<string, unknown>)[REVALIDATE_CLAIM];
        }

        // LB-004 (audit H10): refresh tenant branding every 30 minutes so
        // settings changes propagate without forcing users to log out (was
        // previously cached for the entire 30-day JWT lifetime).
        if (shouldRefreshBrand(token.brandFetchedAt as number | undefined)) {
          try {
            // withRlsBypass — after the cutover a bare lookup returns nothing
            // and every club's branding silently freezes at whatever it was
            // when the token was minted.
            const tenant = await withRlsBypass((tx) =>
              tx.tenant.findUnique({
                where: { id: token.tenantId as string },
                select: { name: true, primaryColor: true, secondaryColor: true, textColor: true },
              }),
            );
            if (tenant) {
              token.tenantName = tenant.name;
              token.primaryColor = tenant.primaryColor;
              token.secondaryColor = tenant.secondaryColor;
              token.textColor = tenant.textColor;
              token.brandFetchedAt = Date.now();
            }
          } catch { /* DB transient — keep stale brand */ }
        }
      }

      return token;
    },
    session({ session, token }) {
      if (!token || !token.id) {
        // Token was invalidated (sessionVersion bumped) — return empty session.
        // NextAuth will treat this as "unauthenticated" on `auth()` calls.
        // `DefaultSession.user` is optional, which is exactly the shape of a
        // user-less session, so this needs no cast.
        return { ...session, user: undefined };
      }
      // Awaiting revalidation (SF-44): no identity, and say why, so proxy.ts
      // and /api/auth/session can answer a retryable 503 instead of "signed
      // out". The exported auth() below returns null for this shape.
      if (revalidateSince(token as Record<string, unknown>) !== null) {
        return { ...session, user: undefined, authUnavailable: true } as unknown as typeof session;
      }
      session.user.id = token.id as string;
      session.user.role = (normalizeRole(token.role) as "owner" | "manager" | "coach" | "admin" | "member");
      session.user.tenantId = token.tenantId as string;
      session.user.tenantSlug = token.tenantSlug as string;
      session.user.tenantName = token.tenantName as string;
      session.user.primaryColor = token.primaryColor as string;
      session.user.secondaryColor = token.secondaryColor as string;
      session.user.textColor = token.textColor as string;
      session.user.memberId = (token.memberId as string) ?? undefined;
      session.user.totpPending = (token.totpPending as boolean) ?? false;
      session.user.requireTotpSetup = (token.requireTotpSetup as boolean) ?? false;
      session.user.totpEnabled = (token.totpEnabled as boolean) ?? false;
      // Read by proxy.ts (req.auth.user) and lib/api-authz.ts. Not declared in
      // types/next-auth.d.ts yet, hence the widened write.
      (session.user as unknown as Record<string, unknown>).mustChangePassword = token.mustChangePassword === true;
      // Impersonation context, propagated from jwt() override above.
      const impersonatedBy = (token as Record<string, unknown>).impersonatedBy;
      const impersonationReason = (token as Record<string, unknown>).impersonationReason;
      if (typeof impersonatedBy === "string") {
        (session.user as unknown as Record<string, unknown>).impersonatedBy = impersonatedBy;
        (session.user as unknown as Record<string, unknown>).impersonationReason =
          typeof impersonationReason === "string" ? impersonationReason : null;
      }
      return session;
    },
  },
});

export const { handlers, signIn, signOut } = nextAuth;

/**
 * auth(), with one rule added for the no-argument form every page, layout and
 * route handler uses (SF-44, lane A2, 9 Oct 2026): a session that is not
 * usable — no user id, or awaiting revalidation — is returned as null, the
 * answer every caller already reads as "signed out". The server-side
 * no-argument form sets no cookie, so this refuses the request without
 * touching the browser's session. Every other form (the proxy.ts wrapper, the
 * Request form) passes through unchanged; proxy.ts reads the unavailable shape
 * itself and answers 503.
 */
export const auth = ((...args: unknown[]) => {
  if (args.length === 0) {
    return (nextAuth.auth as () => Promise<unknown>)().then((s) => usableSession(s));
  }
  return (nextAuth.auth as (...a: unknown[]) => unknown)(...args);
}) as typeof nextAuth.auth;
