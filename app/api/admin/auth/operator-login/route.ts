/**
 * POST /api/admin/auth/operator-login
 * Body: { email: string, password: string }
 *
 * v1.5 of the /admin auth: per-operator account login. Authenticates against
 * the Operator table (bcrypt against passwordHash). On success, issues an
 * HMAC-signed session cookie (matflow_op_session) tied to operatorId +
 * sessionVersion + 8h expiry.
 *
 * The legacy MATFLOW_ADMIN_SECRET cookie remains a valid fallback path
 * (POST /api/admin/auth/login) for bootstrap and recovery.
 *
 * Rate-limited per IP (5 attempts / 15 min window).
 *
 * TOTP follow-up: if the operator has totpEnabled, this route returns
 * { totpRequired: true, operatorId } and DOES NOT set the cookie. A separate
 * route POST /api/admin/auth/operator-totp completes the second factor.
 * (TOTP follow-up route is deferred — for now totpEnabled accounts cannot
 * complete login via this endpoint; they must use the legacy secret path.)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  attemptOperatorLogin,
  issueOperatorSession,
  operatorCookieSetHeaders,
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
    // Generic failure — never reveal whether the email exists.
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // TOTP gate (deferred — see header docblock).
  if (result.operator.totpEnabled) {
    return NextResponse.json(
      { error: "TOTP-enabled operator login is not yet wired. Use the legacy secret path for now." },
      { status: 501 },
    );
  }

  const token = issueOperatorSession(result.operator.id, result.operator.sessionVersion);
  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...operatorCookieSetHeaders(token),
    },
  });
}
