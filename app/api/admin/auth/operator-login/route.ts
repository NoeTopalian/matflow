/**
 * POST /api/admin/auth/operator-login
 * Body: { email: string, password: string }
 *
 * Password step of operator sign-in. It NEVER issues a full session
 * (operator auth hardening, 6 Oct 2026 — TOTP is mandatory for operators):
 *
 *   - operator has an authenticator → short-lived challenge cookie,
 *     { totpRequired: true }; /api/admin/auth/operator-totp finishes sign-in.
 *   - operator has none yet → short-lived ENROLMENT cookie (Path=/api/admin/auth),
 *     { enrolmentRequired: true }; only /api/admin/auth/operator-totp/setup
 *     accepts it, and it mints the full session once a code verifies.
 *
 * Previously an operator without TOTP got the full session here, on the
 * password alone (audit 5 Oct 2026, Q1).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import {
  attemptOperatorLogin,
  issueOperatorEnrolmentSession,
  issueOperatorTotpChallenge,
  operatorEnrolmentCookieClearHeaderValue,
  operatorEnrolmentCookieSetHeaderValue,
  operatorTotpChallengeCookieClearHeaderValue,
  operatorTotpChallengeCookieSetHeaderValue,
} from "@/lib/operator-auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  // Login CSRF: refuse a cross-site form post that would sign this browser
  // into someone else's operator account.
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`admin:operator-login:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const result = await attemptOperatorLogin(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    if (result.reason === "locked") {
      return NextResponse.json(
        { error: "Account temporarily locked. Try again in a few minutes." },
        { status: 423 },
      );
    }
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  if (result.operator.totpEnabled) {
    const challenge = issueOperatorTotpChallenge(result.operator.id, result.operator.sessionVersion);
    const res = NextResponse.json({ ok: true, totpRequired: true }, { status: 200 });
    res.headers.append("Set-Cookie", operatorTotpChallengeCookieSetHeaderValue(challenge));
    res.headers.append("Set-Cookie", operatorEnrolmentCookieClearHeaderValue());
    return res;
  }

  const enrolment = issueOperatorEnrolmentSession(result.operator.id, result.operator.sessionVersion);
  const res = NextResponse.json({ ok: true, enrolmentRequired: true }, { status: 200 });
  res.headers.append("Set-Cookie", operatorEnrolmentCookieSetHeaderValue(enrolment));
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  return res;
}
