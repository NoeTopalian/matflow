import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { getToken, encode } from "next-auth/jwt";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { checkRateLimit } from "@/lib/rate-limit";

// Per-user rate limit on the POST verify endpoint to prevent brute-forcing
// the 6-digit code during initial enrolment. Mirrors the limit on
// /api/auth/totp/verify (post-login challenge).
const VERIFY_LIMIT_MAX = 5;
const VERIFY_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// GET — generate or re-fetch TOTP secret + QR code
export async function GET() {
  const session = await auth();
  // 2FA-optional spec (2026-05-07): widened from owner-only to any User role
  // (owner/manager/coach/admin). Members enrol via /api/member/totp/setup.
  if (!session || session.user.role === "member") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.findUnique({
      where: { id: session.user.id },
      select: { totpSecret: true, totpEnabled: true, email: true },
    }),
  );
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // If already enabled, do NOT re-expose the secret. The seed is write-once-
  // read-never after enrolment verification — leaking it on subsequent GET
  // calls would let anyone with a stolen session cookie clone the
  // authenticator. Caller should branch on `alreadyEnabled` and skip the
  // QR/secret rendering. (Security audit 2026-05-07, severity MEDIUM.)
  if (user.totpEnabled) {
    return NextResponse.json({ alreadyEnabled: true });
  }

  const secret = generateSecret();
  await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.update({
      where: { id: session.user.id },
      data: { totpSecret: secret, totpEnabled: false },
    }),
  );

  const uri = generateURI({ label: user.email, issuer: "MatFlow", secret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json({ secret, qrDataUrl, alreadyEnabled: false });
}

// POST — verify code and enable TOTP
export async function POST(req: NextRequest) {
  const session = await auth();
  // 2FA-optional spec (2026-05-07): widened from owner-only to any User role
  // (owner/manager/coach/admin). Members enrol via /api/member/totp/setup.
  if (!session || session.user.role === "member") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(
    `totp-setup-verify:${session.user.id}`,
    VERIFY_LIMIT_MAX,
    VERIFY_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { code } = body as { code?: string };
  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }

  const user = await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.findUnique({
      where: { id: session.user.id },
      select: { totpSecret: true },
    }),
  );
  if (!user?.totpSecret) {
    return NextResponse.json({ error: "TOTP not initialised — call GET first" }, { status: 400 });
  }

  const result = verifySync({ token: code, secret: user.totpSecret });
  if (!result.valid) return NextResponse.json({ error: "Invalid code" }, { status: 400 });

  await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.update({
      where: { id: session.user.id },
      data: { totpEnabled: true },
    }),
  );

  // Fix 4: re-encode the JWT to clear requireTotpSetup so the proxy stops
  // redirecting the owner to /login/totp/setup. Mirrors the pattern used by
  // /api/auth/totp/verify after second-factor success.
  // Must pass cookieName + secureCookie explicitly: getToken's defaults
  // use the non-secure cookie name (`authjs.session-token`) which doesn't
  // match the actual `__Secure-authjs.session-token` cookie on prod —
  // causing the decode to fail silently (token === {}). Caused the
  // noe-locked-out-2 incident on 2026-05-06 (after the cookie-name fix
  // shipped, this second layer of the bug surfaced).
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  });
  if (token) {
    // NextAuth v5 cookie name (matches @auth/core defaults). The legacy v4
    // cookie name was used here previously and silently broke the JWT
    // mutation in production. See lib/auth-cookie.ts for the full story.
    // 2FA-optional spec: flip totpEnabled too so the dashboard recommendation
    // banner disappears on the next request without waiting for the brand-refresh
    // window to re-read the User row.
    const newToken = { ...token, requireTotpSetup: false, totpEnabled: true };
    const encoded = await encode({
      token: newToken,
      secret: AUTH_SECRET_VALUE,
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

  return NextResponse.json({ ok: true });
}
