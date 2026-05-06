/**
 * POST /api/admin/auth/operator-totp
 * Body: { code: "123456" }
 *
 * Completes the second factor after /api/admin/auth/operator-login has set a
 * short-lived HttpOnly challenge cookie. On success, clears the challenge and
 * issues the full matflow_op_session cookie.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifySync } from "otplib";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  OP_TOTP_CHALLENGE_COOKIE,
  completeOperatorLogin,
  issueOperatorSession,
  operatorCookieSetHeaderValue,
  operatorTotpChallengeCookieClearHeaderValue,
  verifyOperatorTotpChallenge,
} from "@/lib/operator-auth";

export const runtime = "nodejs";

const schema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

function jsonWithClearedChallenge(body: unknown, status: number) {
  const res = NextResponse.json(body, { status });
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  return res;
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const ipLimit = await checkRateLimit(`admin:operator-totp-ip:${ip}`, 20, 15 * 60 * 1000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const store = await cookies();
  const challengeValue = store.get(OP_TOTP_CHALLENGE_COOKIE)?.value;
  const challenge = challengeValue ? verifyOperatorTotpChallenge(challengeValue) : null;
  if (!challenge) {
    return jsonWithClearedChallenge({ error: "No pending TOTP challenge" }, 401);
  }

  const operatorLimit = await checkRateLimit(
    `admin:operator-totp:${challenge.operatorId}`,
    5,
    10 * 60 * 1000,
  );
  if (!operatorLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(operatorLimit.retryAfterSeconds) } },
    );
  }

  const operator = await prisma.operator.findUnique({
    where: { id: challenge.operatorId },
    select: { id: true, sessionVersion: true, totpEnabled: true, totpSecret: true },
  });

  if (
    !operator ||
    operator.sessionVersion !== challenge.sessionVersion ||
    !operator.totpEnabled ||
    !operator.totpSecret
  ) {
    return jsonWithClearedChallenge({ error: "TOTP challenge expired" }, 401);
  }

  const result = verifySync({ token: parsed.data.code, secret: operator.totpSecret });
  if (!result.valid) {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  const completed = await completeOperatorLogin(operator.id);
  const sessionToken = issueOperatorSession(completed.id, completed.sessionVersion);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", operatorCookieSetHeaderValue(sessionToken));
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  return res;
}
