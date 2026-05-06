/**
 * GET/POST /api/admin/auth/operator-totp/setup
 *
 * Requires an active v1.5 operator session. GET creates or returns a pending
 * TOTP secret for enrollment. POST verifies a 6-digit code, enables TOTP,
 * bumps sessionVersion, and refreshes the current operator session cookie.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  OP_SESSION_COOKIE,
  issueOperatorSession,
  operatorCookieSetHeaderValue,
  resolveOperatorFromCookie,
} from "@/lib/operator-auth";

export const runtime = "nodejs";

const schema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

async function requireOperatorSession() {
  const store = await cookies();
  const sessionValue = store.get(OP_SESSION_COOKIE)?.value;
  return await resolveOperatorFromCookie(sessionValue);
}

export async function GET() {
  const sessionOperator = await requireOperatorSession();
  if (!sessionOperator) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: sessionOperator.id },
    select: { id: true, email: true, totpEnabled: true, totpSecret: true },
  });
  if (!operator) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (operator.totpEnabled) {
    return NextResponse.json({ alreadyEnabled: true });
  }

  const secret = operator.totpSecret ?? generateSecret();
  if (!operator.totpSecret) {
    await prisma.operator.update({
      where: { id: operator.id },
      data: { totpSecret: secret, totpEnabled: false },
    });
  }

  const uri = generateURI({ label: operator.email, issuer: "MatFlow Admin", secret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json({ alreadyEnabled: false, secret, qrDataUrl });
}

export async function POST(req: Request) {
  const sessionOperator = await requireOperatorSession();
  if (!sessionOperator) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(`admin:operator-totp-setup:${sessionOperator.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: sessionOperator.id },
    select: { id: true, totpSecret: true },
  });
  if (!operator?.totpSecret) {
    return NextResponse.json({ error: "TOTP not initialised" }, { status: 400 });
  }

  const result = verifySync({ token: parsed.data.code, secret: operator.totpSecret });
  if (!result.valid) {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  const updated = await prisma.operator.update({
    where: { id: operator.id },
    data: {
      totpEnabled: true,
      sessionVersion: { increment: 1 },
    },
    select: { id: true, sessionVersion: true },
  });

  const sessionToken = issueOperatorSession(updated.id, updated.sessionVersion);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", operatorCookieSetHeaderValue(sessionToken));
  return res;
}
