import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getToken, encode } from "next-auth/jwt";
import { verifySync } from "otplib";
import { checkRateLimit } from "@/lib/rate-limit";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: AUTH_SECRET_VALUE });

  if (!token?.id || token.totpPending !== true) {
    return NextResponse.json({ error: "No pending TOTP session" }, { status: 401 });
  }

  // Rate limit: 5 attempts per user per 10 min
  const rl = checkRateLimit(`totp:${token.id}`, 5, 10 * 60 * 1000);
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

  const user = await prisma.user.findUnique({
    where: { id: token.id as string },
    select: { totpSecret: true, totpEnabled: true },
  });

  if (!user?.totpSecret || !user.totpEnabled) {
    return NextResponse.json({ error: "TOTP not enabled" }, { status: 400 });
  }

  const result = verifySync({ token: code, secret: user.totpSecret });
  if (!result.valid) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const secure = process.env.NODE_ENV === "production";
  const cookieName = secure
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

  // Re-encode JWT with totpPending cleared
  const newToken = { ...token, totpPending: false };
  const encoded = await encode({
    token: newToken,
    secret: AUTH_SECRET_VALUE!,
    maxAge: 30 * 24 * 60 * 60,
    salt: cookieName,
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName, encoded, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
