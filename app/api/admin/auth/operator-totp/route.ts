/**
 * POST /api/admin/auth/operator-totp
 * Body: { code: "123456" }
 *
 * Completes the second factor after /api/admin/auth/operator-login has set a
 * short-lived HttpOnly challenge cookie. On success, clears the challenge and
 * issues the full matflow_op_session cookie.
 *
 * 6 Oct 2026: the code is SPENT (lib/operator-auth.ts consumeOperatorTotp), so a
 * code that has signed someone in once cannot sign anyone in again, on any
 * instance. A replayed code counts as a wrong code towards the lockout.
 *
 * 9 Oct 2026: an operator not named in OPERATOR_ALLOWED_IDS is refused here,
 * after a valid code and before any session exists (403, audited).
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import {
  OPERATOR_REFUSED_MESSAGE,
  OP_TOTP_CHALLENGE_COOKIE,
  completeOperatorLogin,
  consumeOperatorTotp,
  isOperatorAllowed,
  issueOperatorSession,
  operatorCookieSetHeaderValue,
  operatorTotpChallengeCookieClearHeaderValue,
  recordOperatorRefusal,
  verifyOperatorTotpChallenge,
} from "@/lib/operator-auth";

import { logAudit } from "@/lib/audit-log";

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
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

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
    select: { id: true, sessionVersion: true, totpEnabled: true, totpSecret: true, totpLastUsedStep: true, lockedUntil: true },
  });

  if (
    !operator ||
    operator.sessionVersion !== challenge.sessionVersion ||
    !operator.totpEnabled ||
    !operator.totpSecret
  ) {
    return jsonWithClearedChallenge({ error: "TOTP challenge expired" }, 401);
  }

  // A lock set by wrong codes on THIS challenge must hold for the rest of it:
  // previously a locked operator still holding a live challenge cookie could
  // keep guessing (the lock was only read at the password step).
  if (operator.lockedUntil && operator.lockedUntil > new Date()) {
    return jsonWithClearedChallenge({ error: "Account temporarily locked. Try again in a few minutes." }, 423);
  }

  const accepted = await consumeOperatorTotp(
    { id: operator.id, totpSecret: operator.totpSecret, totpLastUsedStep: operator.totpLastUsedStep },
    parsed.data.code,
  );
  if (!accepted) {
    // Audit iter-2 A2H2-2: increment the account-level failedLoginCount on
    // TOTP failure and apply lockout if threshold reached. Previously the
    // TOTP phase only consumed the per-IP / per-operator rate-limit bucket
    // — Operator.lockedUntil was never reached via TOTP brute force, so an
    // attacker with the password could cycle: bcrypt-success → 5 TOTP
    // attempts → 10-min wait → repeat (and bypass IP-limit by rotating IPs).
    // Threshold + TTL match the bcrypt-side lockout (lib/operator-auth.ts).
    const TOTP_LOCKOUT_THRESHOLD = 5;
    const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
    const current = await prisma.operator.findUnique({
      where: { id: operator.id },
      select: { failedLoginCount: true },
    });
    const newCount = (current?.failedLoginCount ?? 0) + 1;
    const shouldLock = newCount >= TOTP_LOCKOUT_THRESHOLD;
    await prisma.operator.update({
      where: { id: operator.id },
      data: shouldLock
        ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) }
        : { failedLoginCount: newCount },
    });
    if (shouldLock) {
      // 423 Locked is more precise than 401 — the challenge cookie is also
      // cleared so the client must restart the login flow after the lockout
      // window expires (assuming password is still valid).
      return jsonWithClearedChallenge(
        { error: "Too many invalid codes. Account locked for 15 minutes." },
        423,
      );
    }
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  // Allowlist (admin hub lane B, 9 Oct 2026): the password and the code may be
  // right, but only an operator named in OPERATOR_ALLOWED_IDS gets a session.
  // Checked only AFTER both factors, so the refusal tells nothing to someone
  // holding just the password. The code is spent; the challenge is cleared.
  if (!isOperatorAllowed(operator.id)) {
    await recordOperatorRefusal(operator.id, "session_mint", req);
    return jsonWithClearedChallenge({ error: OPERATOR_REFUSED_MESSAGE }, 403);
  }

  // Operator sign-in is recorded DURABLY before the session exists (review
  // finding D5, 6 Oct 2026): there used to be no sign-in row at all. If it
  // cannot be written, no session is issued; the challenge cookie is kept so
  // the operator can try again with the next code.
  try {
    await logAudit({
      tenantId: null,
      action: "admin.operator.signed_in",
      entityType: "Operator",
      entityId: operator.id,
      actAsUserId: operator.id,
      req,
      durable: true,
      outcome: "succeeded",
    });
  } catch (err) {
    console.error("[operator-totp] sign-in audit write failed; no session issued", err);
    return NextResponse.json(
      { error: "Sign-in could not be recorded, so it did not complete. Try again with the next code." },
      { status: 500 },
    );
  }

  const completed = await completeOperatorLogin(operator.id);
  const sessionToken = issueOperatorSession(completed.id, completed.sessionVersion);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", operatorCookieSetHeaderValue(sessionToken));
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  return res;
}
