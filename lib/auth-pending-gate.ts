import { NextResponse } from "next/server";
import { checkSessionVersion } from "@/lib/session-revocation";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";

/**
 * The revocation check for the two second-factor verify routes (SF-37 /
 * SEC-012, security campaign iteration 2, lane A2, 9 Oct 2026).
 *
 * /api/auth/totp/verify and /api/member/totp/verify read the half-signed-in
 * token with getToken(), which only DECODES the cookie — it never runs auth.ts
 * jwt(), so the revocation check never ran there. A token revoked after the
 * password step (log out everywhere, password reset, staff removal, a
 * disowned sign-in) could still spend an authenticator code and be re-issued
 * with `totpPending: false`. The next request then refused it, but the code
 * was spent and the refusal came one request late. Both routes now ask the
 * same question jwt() asks, before anything is spent:
 *
 *   revoked → 401 and the session cookie is cleared (proven: sign out);
 *   unknown → 503 + Retry-After, cookie untouched (the database could not
 *             answer; nothing is spent, the person retries — SF-44 semantics);
 *   ok      → null: carry on.
 */
export async function refuseRevokedPendingToken(token: {
  id?: unknown;
  memberId?: unknown;
  tenantId?: unknown;
  sessionVersion?: unknown;
}): Promise<NextResponse | null> {
  const verdict = await checkSessionVersion({
    memberId: typeof token.memberId === "string" ? token.memberId : null,
    userId: typeof token.id === "string" ? token.id : null,
    tokenVersion: token.sessionVersion,
    tenantId: typeof token.tenantId === "string" ? token.tenantId : null,
  });
  if (verdict === "ok") return null;
  if (verdict === "unknown") {
    return NextResponse.json(
      { error: "We couldn't confirm your sign-in just now. Please try again in a moment.", retryable: true },
      { status: 503, headers: { "retry-after": "15", "cache-control": "private, no-store" } },
    );
  }
  const res = NextResponse.json({ error: "This sign-in has ended. Please sign in again." }, { status: 401 });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: 0,
  });
  return res;
}
