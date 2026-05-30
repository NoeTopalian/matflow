/**
 * Member-side TOTP self-enrolment (2FA-optional spec, 2026-05-07).
 *
 * Mirrors /api/auth/totp/setup but operates on the Member table and gates
 * by `session.user.memberId` instead of role. Magic-link-only members and
 * kid accounts cannot reach this route — they have no session.user.memberId
 * since they're not authenticated via password.
 *
 *   GET  → generate / re-fetch TOTP secret + QR
 *   POST → verify the typed 6-digit code, enable TOTP, re-encode JWT
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { getToken, encode } from "next-auth/jwt";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";

const VERIFY_LIMIT_MAX = 5;
const VERIFY_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export async function GET() {
  const session = await auth();
  if (!session?.user?.memberId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memberId = session.user.memberId;

  const member = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: { id: true, totpSecret: true, totpEnabled: true, email: true, passwordHash: true },
    }),
  );
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Spec: only password-bearing members may enrol. Kids + magic-link-only
  // members never have passwordHash.
  if (member.passwordHash === null) {
    return NextResponse.json(
      { error: "Set a password before enabling 2FA. Magic-link login is the second factor for passwordless accounts." },
      { status: 400 },
    );
  }

  // Mirror the User-side fix from iteration 1: once a member has TOTP
  // enabled, never re-expose the secret on subsequent GETs. The seed is
  // write-once-read-never after enrolment — leaking it would let anyone
  // with a stolen session cookie clone the authenticator. The client
  // branches on `alreadyEnabled` and skips QR rendering. (Security audit
  // iteration 2 / M7, 2026-05-07.)
  if (member.totpEnabled) {
    return NextResponse.json({ alreadyEnabled: true });
  }

  const secret = generateSecret();
  await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.update({
      where: { id: member.id },
      data: { totpSecret: secret, totpEnabled: false },
    }),
  );
  const uri = generateURI({ label: member.email, issuer: "MatFlow", secret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json({ secret, qrDataUrl, alreadyEnabled: false });
}

export async function POST(req: NextRequest) {
  // Audit iter-1-auth-boundary AH-1: TOTP enrolment is account-takeover-
  // adjacent — a cross-origin POST that swaps a victim's TOTP secret would
  // lock them out. Mirrors the User-side CSRF guard at
  // app/api/auth/totp/setup/route.ts:62.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user?.memberId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memberId = session.user.memberId;

  const rl = await checkRateLimit(
    `totp-setup-verify-member:${memberId}`,
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
  const { code } = body as { code?: string };
  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }

  // Audit iter-1-auth-boundary AH-2: atomic read-verify-enable inside one
  // withTenantContext transaction. The previous implementation did
  // findFirst → verifySync → update in three separate calls; a concurrent
  // GET from the same session could overwrite totpSecret with a freshly-
  // generated value between the read and the update, leaving totpEnabled=true
  // with a secret that doesn't match the code the user just verified —
  // locking them out. Mirrors the User-side fix at
  // app/api/auth/totp/setup/route.ts:98-112.
  const verifyResult = await withTenantContext(session.user.tenantId, async (tx) => {
    const m = await tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: { totpSecret: true, passwordHash: true },
    });
    if (!m?.totpSecret) return { kind: "not-initialised" as const };
    if (m.passwordHash === null) return { kind: "no-password" as const };
    if (!verifySync({ token: code, secret: m.totpSecret }).valid) {
      return { kind: "invalid-code" as const };
    }
    await tx.member.update({
      where: { id: memberId },
      data: { totpEnabled: true },
    });
    return { kind: "ok" as const };
  });

  if (verifyResult.kind === "not-initialised") {
    return NextResponse.json({ error: "TOTP not initialised — call GET first" }, { status: 400 });
  }
  if (verifyResult.kind === "no-password") {
    return NextResponse.json(
      { error: "Set a password before enabling 2FA." },
      { status: 400 },
    );
  }
  if (verifyResult.kind === "invalid-code") {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  // Re-encode JWT so the recommendation banner clears immediately.
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  });
  if (token) {
    const newToken = { ...token, totpEnabled: true };
    const encoded = await encode({
      token: newToken,
      secret: AUTH_SECRET_VALUE,
      maxAge: 30 * 24 * 60 * 60,
      salt: SESSION_COOKIE_NAME,
    });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE_NAME, encoded, {
      httpOnly: true,
      sameSite: "lax",
      secure: SESSION_COOKIE_SECURE,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return res;
  }
  return NextResponse.json({ ok: true });
}
