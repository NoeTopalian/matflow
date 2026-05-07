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

export async function POST(req: NextRequest) {
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  });

  if (!token?.id || !token.memberId || token.totpPending !== true) {
    return NextResponse.json({ error: "No pending TOTP session" }, { status: 401 });
  }

  const rl = await checkRateLimit(`totp-member:${token.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { code } = body as { code?: string };
  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }

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

  const newToken = { ...token, totpPending: false };
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
