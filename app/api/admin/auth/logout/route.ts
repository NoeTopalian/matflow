/**
 * POST /api/admin/auth/logout — signs the operator out, server-side.
 *
 * Clearing cookies alone is not revocation: a copied `matflow_op_session` value
 * stayed valid for the rest of its 8 hours (audit 5 Oct 2026, Q1). When the
 * request carries a valid operator session (full or enrolment), the operator's
 * `sessionVersion` is bumped, so EVERY token minted for them — this browser,
 * any other device, any copy — is refused from the next request. The cost is
 * that signing out on one device signs the operator out everywhere; for the
 * operator console that is the safer default.
 *
 * 9 Oct 2026: the session is resolved WITHOUT the operator allowlist
 * (resolveOperatorForSignOut), so a session of an operator who is no longer
 * allow-listed can still be revoked here. Revoking only takes authority away.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/csrf";
import { adminCookieClearHeaderValue } from "@/lib/admin-auth";
import {
  OP_ENROL_COOKIE,
  OP_SESSION_COOKIE,
  operatorCookieClearHeaderValue,
  operatorEnrolmentCookieClearHeaderValue,
  operatorTotpChallengeCookieClearHeaderValue,
  resolveOperatorEnrolment,
  resolveOperatorForSignOut,
} from "@/lib/operator-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const store = await cookies();
  const op =
    (await resolveOperatorForSignOut(store.get(OP_SESSION_COOKIE)?.value)) ??
    (await resolveOperatorEnrolment(store.get(OP_ENROL_COOKIE)?.value, "sign-out-only"));
  if (op) {
    // Conditional on the version the token carried: a concurrent sign-in that
    // already moved it on is not bumped twice.
    await prisma.operator.updateMany({
      where: { id: op.id, sessionVersion: op.sessionVersion },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", adminCookieClearHeaderValue());
  res.headers.append("Set-Cookie", operatorCookieClearHeaderValue());
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  res.headers.append("Set-Cookie", operatorEnrolmentCookieClearHeaderValue());
  return res;
}
