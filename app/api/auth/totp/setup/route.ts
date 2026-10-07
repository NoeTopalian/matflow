import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { generateSecret, generateURI } from "otplib";
import QRCode from "qrcode";
import { getToken, encode } from "next-auth/jwt";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { refuseSupportSession } from "@/lib/support-session";
import { consumeUserTotp } from "@/lib/login-email";
import { generateRecoveryCodes } from "@/lib/recovery-codes";

// Per-user rate limit on the POST verify endpoint to prevent brute-forcing
// the 6-digit code during initial enrolment. Mirrors the limit on
// /api/auth/totp/verify (post-login challenge).
const VERIFY_LIMIT_MAX = 5;
const VERIFY_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// Review finding D4 (6 Oct 2026): /api/auth/* is outside the proxy matcher, so
// the proxy's temporary-password gate never reached this route. A session still
// on a temporary password (mustChangePassword — expired or not) must choose its
// own password BEFORE it can pin an authenticator to the account: whoever saw
// the temporary password on its way to the owner must not be able to enrol
// their own device. Same message as the proxy gate.
const PASSWORD_FIRST = "Choose your own password to continue.";
function passwordFirst() {
  return NextResponse.json({ error: PASSWORD_FIRST }, { status: 403 });
}

// GET — generate or re-fetch TOTP secret + QR code
export async function GET() {
  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  // 2FA-optional spec (2026-05-07): widened from owner-only to any User role
  // (owner/manager/coach/admin). Members enrol via /api/member/totp/setup.
  if (!session || session.user.role === "member") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.mustChangePassword === true) return passwordFirst();

  const user = await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.findUnique({
      where: { id: session.user.id },
      select: { totpSecret: true, totpEnabled: true, email: true, mustChangePassword: true },
    }),
  );
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The ROW is authoritative: an expired temporary password is still
  // mustChangePassword, so this refuses it too.
  if (user.mustChangePassword === true) return passwordFirst();

  // If already enabled, do NOT re-expose the secret. The seed is write-once-
  // read-never after enrolment verification — leaking it on subsequent GET
  // calls would let anyone with a stolen session cookie clone the
  // authenticator. Caller should branch on `alreadyEnabled` and skip the
  // QR/secret rendering. (Security audit 2026-05-07, severity MEDIUM.)
  if (user.totpEnabled) {
    return NextResponse.json({ alreadyEnabled: true });
  }

  const secret = generateSecret();
  await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.update({
      where: { id: session.user.id },
      data: { totpSecret: secret, totpEnabled: false },
    }),
  );

  const uri = generateURI({ label: user.email, issuer: "MatFlow", secret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json({ secret, qrDataUrl, alreadyEnabled: false });
}

// POST — verify code and enable TOTP
export async function POST(req: NextRequest) {
  // Defence-in-depth: TOTP enrolment is account-takeover-adjacent — a
  // cross-origin POST that swaps a victim's TOTP secret would let an
  // attacker lock them out. Same-origin only.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  // 2FA-optional spec (2026-05-07): widened from owner-only to any User role
  // (owner/manager/coach/admin). Members enrol via /api/member/totp/setup.
  if (!session || session.user.role === "member") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.mustChangePassword === true) return passwordFirst();

  const rl = await checkRateLimit(
    `totp-setup-verify:${session.user.id}`,
    VERIFY_LIMIT_MAX,
    VERIFY_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { code, issueRecoveryCodes } = body as { code?: string; issueRecoveryCodes?: unknown };
  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }

  // Atomic read-verify-enable to close the TOCTOU window between reading
  // totpSecret and writing totpEnabled. Without a single transaction, a
  // concurrent GET from the same session could overwrite totpSecret with a
  // freshly-generated one, leaving totpEnabled=true with a secret that
  // doesn't match the code the user just verified — locking them out until
  // they recover via recovery codes. (Security audit iteration 2 / M9.)
  const verifyResult = await withTenantContext(session.user.tenantId, async (tx) => {
    const u = await tx.user.findUnique({
      where: { id: session.user.id },
      select: { totpSecret: true, mustChangePassword: true, totpLastUsedStep: true },
    });
    if (u?.mustChangePassword === true) return { kind: "password-first" as const };
    if (!u?.totpSecret) return { kind: "not-initialised" as const };
    // Single use (review defect 10, 7 Oct 2026): the code that confirms the
    // enrolment is SPENT, so it cannot then be replayed within its window to
    // complete a sign-in, regenerate recovery codes or change the login email.
    const spent = await consumeUserTotp(
      tx,
      { id: session.user.id, totpSecret: u.totpSecret, totpLastUsedStep: u.totpLastUsedStep ?? null },
      code,
    );
    if (!spent) {
      return { kind: "invalid-code" as const };
    }
    // The wizard asks for its recovery codes here, in the enabling write,
    // because the code it used to replay into /recovery-codes is now spent.
    const recovery = issueRecoveryCodes === true ? generateRecoveryCodes() : null;
    await tx.user.update({
      where: { id: session.user.id },
      data: {
        totpEnabled: true,
        // A fresh enrolment discards every recovery code minted before it
        // (3 Oct 2026). Recovery codes belong to an authenticator; codes left
        // over from an earlier enrolment — or from before an account was
        // handed to its owner — would otherwise outlive the new device, and
        // /api/auth/totp/recover would accept one to strip the authenticator
        // the owner just set up. The forced enrolment flow issues no new
        // codes, so after this the operator TOTP reset is the recovery path
        // until codes are issued from /api/auth/totp/recovery-codes.
        // With issueRecoveryCodes, the fresh set (hashes only) replaces them.
        totpRecoveryCodes: recovery ? recovery.map((c) => c.hash) : Prisma.JsonNull,
      },
    });
    // Enrolment is a credential change: it writes an audit row in the same
    // transaction, so a factor is never enrolled without a record of who
    // enrolled it (operator audit 5 Oct 2026, Q9). An enrolment under a
    // support session would carry the operator in metadata.actingAs. No
    // secret, code or recovery material is recorded.
    await logAudit({
      tx,
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "auth.totp.enrolled",
      entityType: "User",
      entityId: session.user.id,
      metadata: { role: session.user.role },
      req,
    });
    if (recovery) {
      await logAudit({
        tx,
        tenantId: session.user.tenantId,
        userId: session.user.id,
        action: "auth.totp.recovery_codes.generated",
        entityType: "User",
        entityId: session.user.id,
        metadata: { count: recovery.length, regenerated: false, atEnrolment: true },
        req,
      });
    }
    return { kind: "ok" as const, recoveryCodes: recovery ? recovery.map((c) => c.display) : undefined };
  });

  if (verifyResult.kind === "password-first") return passwordFirst();
  if (verifyResult.kind === "not-initialised") {
    return NextResponse.json({ error: "TOTP not initialised — call GET first" }, { status: 400 });
  }
  if (verifyResult.kind === "invalid-code") {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  // Fix 4: re-encode the JWT to clear requireTotpSetup so the proxy stops
  // redirecting the owner to /login/totp/setup. Mirrors the pattern used by
  // /api/auth/totp/verify after second-factor success.
  // Must pass cookieName + secureCookie explicitly: getToken's defaults
  // use the non-secure cookie name (`authjs.session-token`) which doesn't
  // match the actual `__Secure-authjs.session-token` cookie on prod —
  // causing the decode to fail silently (token === {}). Caused the
  // noe-locked-out-2 incident on 2026-05-06 (after the cookie-name fix
  // shipped, this second layer of the bug surfaced).
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  });
  if (token) {
    // NextAuth v5 cookie name (matches @auth/core defaults). The legacy v4
    // cookie name was used here previously and silently broke the JWT
    // mutation in production. See lib/auth-cookie.ts for the full story.
    // 2FA-optional spec: flip totpEnabled too so the dashboard recommendation
    // banner disappears on the next request without waiting for the brand-refresh
    // window to re-read the User row.
    const newToken = { ...token, requireTotpSetup: false, totpEnabled: true };
    const encoded = await encode({
      token: newToken,
      secret: AUTH_SECRET_VALUE,
      maxAge: 30 * 24 * 60 * 60,
      salt: SESSION_COOKIE_NAME,
    });
    const res = NextResponse.json({ ok: true, recoveryCodes: verifyResult.recoveryCodes });
    res.cookies.set(SESSION_COOKIE_NAME, encoded, {
      httpOnly: true,
      sameSite: "lax",
      secure: SESSION_COOKIE_SECURE,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return res;
  }

  return NextResponse.json({ ok: true, recoveryCodes: verifyResult.recoveryCodes });
}
