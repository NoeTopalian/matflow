/**
 * POST /api/admin/auth/operator-login
 * Body: { email: string, password: string }
 *
 * v1.5 of /admin auth: per-operator email/password login. If TOTP is enabled,
 * this sets a short-lived challenge cookie and returns { totpRequired: true }.
 * Otherwise it issues the full HMAC-signed matflow_op_session cookie.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  attemptOperatorLogin,
  completeOperatorLogin,
  issueOperatorTotpChallenge,
  issueOperatorSession,
  operatorCookieSetHeaders,
  operatorTotpChallengeCookieClearHeaderValue,
  operatorTotpChallengeCookieSetHeaderValue,
} from "@/lib/operator-auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
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
    return NextResponse.json(
      { ok: true, totpRequired: true },
      { status: 200, headers: { "Set-Cookie": operatorTotpChallengeCookieSetHeaderValue(challenge) } },
    );
  }

  const operator = await completeOperatorLogin(result.operator.id);
  const token = issueOperatorSession(operator.id, operator.sessionVersion);
  const res = NextResponse.json({ ok: true }, { status: 200, headers: operatorCookieSetHeaders(token) });
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  return res;
}
