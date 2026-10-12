/**
 * POST /api/auth/set-password
 *
 * A signed-in staff user replaces a temporary password with one of their own.
 * The operator console's "Reset password" hands the owner a temporary
 * password and flags the account `mustChangePassword`; the dashboard layout
 * sends them here until this route clears the flag (customer simulation
 * 26 Sep 2026, F-3: the owner was never asked to choose their own password).
 *
 * Same password rules and history handling as /api/auth/reset-password: both
 * use lib/password-policy.ts (8 Oct 2026; this door kept 5 previous passwords
 * until then, now 8 — PASSWORD_HISTORY_LIMIT). The change is audited.
 *
 * Sessions (3 Oct 2026). The temporary password may have been seen by someone
 * else on the way to its owner, so choosing a new one bumps `sessionVersion`:
 * every OTHER device still signed in on the temporary password is signed out
 * on its next request (auth.ts re-checks the version on every Node pass,
 * proxy included — no interval). THIS device is kept signed in: its JWT is
 * re-issued with the new version and without the `mustChangePassword` claim,
 * the same re-encode /api/auth/totp/setup uses to clear `requireTotpSetup`.
 * If the cookie cannot be decoded, the response says `signInAgain: true` and
 * this device is signed out too — never the reverse.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { getToken, encode } from "next-auth/jwt";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { withTenantContext } from "@/lib/prisma-tenant";
import { isTempPasswordExpired } from "@/lib/temp-password";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { STAFF_ROLES } from "@/lib/authz";
import { refuseSupportSession } from "@/lib/support-session";
import { passwordReused, recentPasswordHashes, recordPasswordHistory, staffPasswordSchema } from "@/lib/password-policy";

export const runtime = "nodejs";

const bodySchema = z.object({
  // Same strength as reset-password and accept-invite (verifier lane 1, 30 Sep
  // 2026: this door alone accepted ten lower-case letters). Shared rule since
  // 8 Oct 2026: lib/password-policy.ts.
  password: staffPasswordSchema,
});

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // A sign-in that still owes its authenticator code may not change the
  // password (handover review, 3 Oct 2026: this route also signs every other
  // session out, so on a code-less session it was a lock-out lever).
  if (session.user.totpPending === true) {
    return NextResponse.json({ error: "Enter your authenticator code to continue." }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }
  const { password } = parsed.data;
  const tenantId: string = session.user.tenantId;
  const userId: string = session.user.id;

  const current = await withTenantContext(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, passwordHash: true, mustChangePassword: true, tempPasswordExpiresAt: true } });
    if (!user) return null;
    const history = await recentPasswordHashes(tx, user.id);
    return { user, history };
  });
  if (!current) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // This is the forced-change door, not a general change-password screen: the
  // ROW must say a change is owed. A session on an already-chosen password has
  // nothing to do here and must not be able to rotate the password and evict
  // the owner's other devices.
  if (current.user.mustChangePassword !== true) {
    return NextResponse.json({ error: "No password change is pending for this account." }, { status: 403 });
  }
  // A temporary password has a deadline (6 Oct 2026). A session opened with it
  // before the deadline cannot be used to choose a password after it: the
  // session is setup-only, so this leaves it with nothing to do, and the owner
  // asks MatFlow support for a new temporary password. Null = no expiry
  // recorded (rows from before the column existed): those expire at
  // LEGACY_TEMP_PASSWORD_DEADLINE (review D2, lib/temp-password.ts).
  if (isTempPasswordExpired(current.user)) {
    return NextResponse.json(
      { error: "This temporary password has expired. Ask whoever gave it to you for a new one." },
      { status: 403 },
    );
  }

  if (await passwordReused(password, current.user.passwordHash, current.history)) {
    return NextResponse.json({ error: "Choose a password you haven't used before." }, { status: 400 });
  }

  const newHash = await bcrypt.hash(password, 12);
  const newVersion = await withTenantContext(tenantId, async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        // Evicts every other session minted on the temporary password.
        sessionVersion: { increment: 1 },
      },
      select: { sessionVersion: true },
    });
    await recordPasswordHistory(tx, userId, current.user.passwordHash);
    return typeof updated?.sessionVersion === "number" ? updated.sessionVersion : null;
  });

  await logAudit({
    tenantId,
    userId,
    action: "user.password.set_own",
    entityType: "User",
    entityId: userId,
    req,
  });

  // Keep THIS device signed in: re-issue its token at the new version with the
  // flag cleared. Explicit cookie name + secure flag for the reason given in
  // app/api/auth/totp/setup/route.ts (getToken's defaults miss the
  // __Secure- cookie in production and decode to nothing).
  const token = newVersion === null
    ? null
    : await getToken({
        req,
        secret: AUTH_SECRET_VALUE,
        cookieName: SESSION_COOKIE_NAME,
        secureCookie: SESSION_COOKIE_SECURE,
      }).catch(() => null);
  if (!token || newVersion === null) {
    // The bump has already happened, so this device is signed out on its next
    // request too. Say so, so the page can send the person to sign in with
    // the password they have just chosen.
    return NextResponse.json({ ok: true, signInAgain: true });
  }
  const encoded = await encode({
    token: { ...token, sessionVersion: newVersion, mustChangePassword: false },
    secret: AUTH_SECRET_VALUE,
    maxAge: 30 * 24 * 60 * 60,
    salt: SESSION_COOKIE_NAME,
  });
  const res = NextResponse.json({ ok: true, signInAgain: false });
  res.cookies.set(SESSION_COOKIE_NAME, encoded, {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
