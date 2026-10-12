/**
 * Member-side TOTP second-factor verify (2FA-optional spec, 2026-05-07).
 * Mirrors /api/auth/totp/verify but operates on Member instead of User.
 *
 * Hit by the existing /login/totp page when the JWT carries totpPending=true
 * for a Member session (memberId set + totpEnabled true).
 */
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { getToken, encode } from "next-auth/jwt";
import { verifySync } from "otplib";
import { checkRateLimit } from "@/lib/rate-limit";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { refuseRevokedPendingToken } from "@/lib/auth-pending-gate";
import { assertSameOrigin } from "@/lib/csrf";
import { z } from "zod";

// Lane C2 (9 Oct 2026): exactly { code }.
const bodySchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: NextRequest) {
  // Audit iter-1-member-surface M-A5-1 (upgraded with adjacent fix): CSRF
  // guard on second-factor verify. Narrow window (attacker needs an
  // intercepted 6-digit code) but the convention is explicit.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  });

  if (!token?.id || !token.memberId || token.totpPending !== true) {
    return NextResponse.json({ error: "No pending TOTP session" }, { status: 401 });
  }

  // Revoked since the password step? Ask before anything is spent (SF-37,
  // lib/auth-pending-gate.ts). getToken() only decodes the cookie.
  const revoked = await refuseRevokedPendingToken(token);
  if (revoked) return revoked;

  const rl = await checkRateLimit(`totp-member:${token.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  // Strict (lane C2): a null/array/string body used to throw on destructuring (500), and an
  // array code like ["123456"] coerced past the regex into verifySync. Now one 400.
  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }
  const { code } = parsedBody.data;

  const member = await withTenantContext(token.tenantId as string, (tx) =>
    tx.member.findUnique({
      where: { id: token.memberId as string },
      select: { totpSecret: true, totpEnabled: true },
    }),
  );

  if (!member?.totpSecret || !member.totpEnabled) {
    return NextResponse.json({ error: "TOTP not enabled" }, { status: 400 });
  }

  const result = verifySync({ token: code, secret: member.totpSecret });
  if (!result.valid) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const newToken: Record<string, unknown> = { ...token, totpPending: false };
  // Checked just now: nothing awaits revalidation (SF-44 marker, auth.ts).
  delete newToken.revalidateSince;
  const encoded = await encode({
    token: newToken,
    secret: AUTH_SECRET_VALUE!,
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
