/**
 * POST /api/account/password — a signed-in staff user changes their OWN
 * password after activation (8 Oct 2026, account-editing lane R, story C2).
 *
 * Body (strict): { currentPassword, newPassword, totpCode? }
 *
 * This is NOT the forced-change door. A temporary-password session is refused
 * here (requireApiStaff answers it 403, and the ROW is checked too) and is sent
 * to /api/auth/set-password, which is the only way out of a temporary
 * password. Also refused: support sessions, sign-ins still owing their code,
 * elevated roles not yet enrolled (requireApiStaff), members.
 *
 * Checks, in order: current password (bcrypt) → for an account with an
 * authenticator, a fresh 6-digit code, CHECKED (verifyUserTotpCode) before
 * anything about the new password is answered, then SPENT single use through
 * consumeUserTotp (shared with sign-in verify, recovery-code regeneration and
 * the login-email change) → the shared password rule (lib/password-policy.ts:
 * 10+ characters, upper, lower, number) → not the current password nor any of
 * the last PASSWORD_HISTORY_LIMIT. A wrong current password does not spend the
 * code. An account without an authenticator (a coach, where the role does not
 * require one) confirms with the current password alone.
 *
 * One transaction: the new hash (conditional on the hash that was checked, so
 * two racing changes cannot both land), the outgoing hash into PasswordHistory,
 * lockout counters cleared, `sessionVersion` bumped, outstanding reset codes
 * and sign-in links for the login email retired, audit `user.password.changed`
 * (no password, hash or code in it).
 *
 * Sessions: EVERY session, this one included, is signed out — the same
 * decision as the login-email change. The response clears this device's
 * cookie and says `signInAgain: true`; the person signs in with the new
 * password and their authenticator. Login email, role, tenant, authenticator
 * and recovery codes are unchanged.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireApiStaff, refuseSupportSession } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { withTenantContext } from "@/lib/prisma-tenant";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { consumeUserTotp, retireEmailBoundTokens, verifyUserTotpCode } from "@/lib/login-email";
import { requiresTotpEnrolment } from "@/lib/mfa-policy";
import { isTestingMode } from "@/lib/testing-mode";
import {
  PASSWORD_HISTORY_LIMIT,
  passwordReused,
  recentPasswordHashes,
  recordPasswordHistory,
  staffPasswordSchema,
} from "@/lib/password-policy";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().max(128),
    totpCode: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

const RL_MAX = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;
const REFUSED = "Your current password or authenticator code was not accepted.";

class StaleHash extends Error {}

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  // Staff role, no code owed, no temporary password, authenticator enrolled
  // where the role requires it (lib/api-authz.ts).
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session);
  if (support) return support;

  const { tenantId, userId } = gate;
  const rl = await checkRateLimit(`account-password:${userId}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter your current password, a new password and (if you use an authenticator) a 6-digit code." },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword, totpCode } = parsed.data;

  const loaded = await withTenantContext(tenantId, async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: userId, tenantId },
      select: {
        id: true, email: true, role: true, passwordHash: true, mustChangePassword: true,
        totpEnabled: true, totpSecret: true, totpLastUsedStep: true,
      },
    });
    if (!user) return null;
    return { user, history: await recentPasswordHashes(tx, user.id) };
  });
  if (!loaded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { user, history } = loaded;

  // The row, not only the token: a temporary password is replaced through
  // /set-password, never here.
  if (user.mustChangePassword) {
    return NextResponse.json({ error: "Choose your own password to continue." }, { status: 403 });
  }
  const enrolled = user.totpEnabled && !!user.totpSecret;
  // The password-only path is decided from the ROW and the role policy, not
  // the token alone (review D2): an elevated role that is not enrolled is
  // refused, whatever the session claims.
  if (!enrolled && requiresTotpEnrolment({ role: user.role, totpEnabled: false, testingMode: isTestingMode() })) {
    return NextResponse.json({ error: "Enrol your authenticator to continue." }, { status: 403 });
  }
  if (enrolled && !totpCode) {
    return NextResponse.json({ error: "Enter the 6-digit code from your authenticator app." }, { status: 400 });
  }
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: REFUSED }, { status: 400 });
  }
  // Review D1: the code is checked (not spent) BEFORE the strength and reuse
  // checks, so a caller without the authenticator learns nothing from them —
  // no "too short" / "used before" answer and no extra bcrypt work. It is
  // spent inside the transaction below, which is the single-use guarantee.
  if (enrolled && !verifyUserTotpCode({ totpSecret: user.totpSecret as string, totpLastUsedStep: user.totpLastUsedStep }, totpCode as string)) {
    return NextResponse.json({ error: REFUSED }, { status: 400 });
  }
  const strength = staffPasswordSchema.safeParse(newPassword);
  if (!strength.success) {
    return NextResponse.json({ error: strength.error.issues[0]?.message ?? "Choose a stronger password." }, { status: 400 });
  }
  if (await passwordReused(newPassword, user.passwordHash, history)) {
    return NextResponse.json(
      { error: `Choose a password you haven't used before (your current one and your last ${PASSWORD_HISTORY_LIMIT} are refused).` },
      { status: 400 },
    );
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      if (enrolled) {
        const spent = await consumeUserTotp(
          tx,
          { id: user.id, totpSecret: user.totpSecret as string, totpLastUsedStep: user.totpLastUsedStep },
          totpCode as string,
        );
        if (!spent) return "bad-code" as const;
      }
      const changed = await tx.user.updateMany({
        where: { id: user.id, tenantId, passwordHash: user.passwordHash, mustChangePassword: false },
        data: {
          passwordHash: newHash,
          failedLoginCount: 0,
          lockedUntil: null,
          sessionVersion: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new StaleHash();
      await recordPasswordHistory(tx, user.id, user.passwordHash);
      const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [user.email] });
      await logAudit({
        tx,
        tenantId,
        userId: user.id,
        action: "user.password.changed",
        entityType: "User",
        entityId: user.id,
        metadata: {
          confirmedWith: enrolled ? "password+totp" : "password",
          signedOutEverywhere: true,
          retired,
        },
        req,
      });
      return "ok" as const;
    });
    if (outcome === "bad-code") return NextResponse.json({ error: REFUSED }, { status: 400 });
  } catch (err) {
    if (err instanceof StaleHash) {
      return NextResponse.json(
        { error: "Your password changed while this was being saved, so nothing was changed. Sign in again and retry." },
        { status: 409 },
      );
    }
    console.error("[account/password] change failed; nothing changed", err);
    return NextResponse.json({ error: "Your password could not be changed. Nothing was changed." }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, signInAgain: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: 0,
  });
  return res;
}
