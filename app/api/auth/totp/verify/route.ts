import { withTenantContext } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { getToken, encode } from "next-auth/jwt";
import { consumeUserTotp } from "@/lib/login-email";
import { checkRateLimit } from "@/lib/rate-limit";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { refuseRevokedPendingToken } from "@/lib/auth-pending-gate";
import { z } from "zod";

// Lane C2 (9 Oct 2026): the challenge page sends exactly { code } (app/login/totp/page.tsx).
const bodySchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: NextRequest) {
  // Must pass cookieName + secureCookie explicitly — getToken's default
  // cookie-name auto-detection picks the wrong one on production
  // (non-secure default vs the actual __Secure-authjs.session-token).
  // See lib/auth-cookie.ts for full context.
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  });

  if (!token?.id || token.totpPending !== true) {
    return NextResponse.json({ error: "No pending TOTP session" }, { status: 401 });
  }

  // Revoked since the password step? Ask before anything is spent (SF-37,
  // lib/auth-pending-gate.ts). getToken() only decodes the cookie.
  const revoked = await refuseRevokedPendingToken(token);
  if (revoked) return revoked;

  // Rate limit: 5 attempts per user per 10 min
  const rl = await checkRateLimit(`totp:${token.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  // Strict (lane C2): a null/array/string body used to throw on destructuring (500), and an
  // array code like ["123456"] coerced past the regex into the verifier. Now one 400.
  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }
  const { code } = parsedBody.data;

  // Single use (7 Oct 2026, handover lane P residual): the code is spent with a
  // conditional update on totpLastUsedStep, so the code that just signed in
  // cannot be replayed within its 30-second window — e.g. to confirm a
  // login-email change — on this or any other server instance.
  const outcome = await withTenantContext(token.tenantId as string, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: token.id as string },
      select: { id: true, totpSecret: true, totpEnabled: true, totpLastUsedStep: true },
    });
    if (!user?.totpSecret || !user.totpEnabled) return "not_enabled" as const;
    const ok = await consumeUserTotp(tx, { id: user.id, totpSecret: user.totpSecret, totpLastUsedStep: user.totpLastUsedStep }, code);
    return ok ? ("ok" as const) : ("invalid" as const);
  });

  if (outcome === "not_enabled") {
    return NextResponse.json({ error: "TOTP not enabled" }, { status: 400 });
  }
  if (outcome === "invalid") {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  // Re-encode JWT with totpPending cleared. NextAuth v5 cookie name (legacy
  // v4 name was used here previously and silently broke the JWT mutation —
  // see lib/auth-cookie.ts).
  const newToken: Record<string, unknown> = { ...token, totpPending: false };
  // Checked just now: nothing awaits revalidation (SF-44 marker, auth.ts).
  delete newToken.revalidateSince;
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
