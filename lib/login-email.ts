/**
 * Login email: provisional identifier vs verified mailbox (7 Oct 2026).
 *
 * A staff login email is two things at once — the identifier typed at sign-in
 * and, normally, a mailbox the person controls. For the first real club owner
 * those two came apart: MatFlow was given an address to sign him in with, and
 * nobody has shown that he reads it. While `User.loginEmailProvisionalSince`
 * is set the address is the IDENTIFIER ONLY:
 *
 *   - forgot-password and magic-link request mint and send nothing, and answer
 *     exactly as for an unknown address;
 *   - magic-link verify and reset-password refuse any token for the account;
 *   - Google (or any external identity provider) sign-in is refused;
 *   - password + authenticator sign-in is unaffected.
 *
 * Mail-dark lane (M) also calls `isLoginEmailProvisional` before sending
 * anything to a staff address.
 *
 * Set by: the operator ("mark provisional", "change login email") and the
 * owner's own change (there is no verification flow yet, so a new address is
 * provisional too). Cleared by: an operator attestation only — see
 * docs/runbooks/OWNER-LOGIN-EMAIL-CHANGE.md.
 */
import { createHash } from "node:crypto";
import { verifySync } from "otplib";
import type { Prisma } from "@prisma/client";

/** True when the row's login email is a provisional identifier, not a verified mailbox. */
export function isLoginEmailProvisional(
  user: { loginEmailProvisionalSince?: Date | string | null } | null | undefined,
): boolean {
  return user?.loginEmailProvisionalSince != null;
}

/** SHA-256 of the normalised address, for audit rows that must not hold the address. */
export function emailDigest(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Audit reason minimum for operator login-email actions. */
export const LOGIN_EMAIL_REASON_MIN = 10;

/**
 * Is `email` free to become a login for user `userId` in `tenantId`?
 * Login is per tenant (auth.ts resolves the club first, then the address),
 * and a User row takes precedence over a Member row with the same address —
 * so an address held by ANY other user or ANY member of the same club would
 * shadow or be shadowed by this account. The caller answers a collision
 * without saying whose it is.
 */
export async function loginEmailTaken(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; userId: string; email: string },
): Promise<boolean> {
  const [user, member] = await Promise.all([
    tx.user.findFirst({
      where: { tenantId: args.tenantId, email: args.email, id: { not: args.userId } },
      select: { id: true },
    }),
    tx.member.findFirst({
      where: { tenantId: args.tenantId, email: args.email },
      select: { id: true },
    }),
  ]);
  return user !== null || member !== null;
}

/**
 * Retire every email-bound sign-in and reset token for these addresses in this
 * club: outstanding password-reset codes and login/activation links. Marked
 * used (not deleted) so the rows stay as evidence. A waiver link is not a
 * sign-in credential (magic-link verify refuses that purpose) and is left alone.
 */
export async function retireEmailBoundTokens(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; emails: string[] },
): Promise<{ resetCodes: number; signInLinks: number }> {
  const emails = [...new Set(args.emails.map((e) => e.trim().toLowerCase()))];
  const now = new Date();
  const resets = await tx.passwordResetToken.updateMany({
    where: { tenantId: args.tenantId, email: { in: emails }, used: false },
    data: { used: true },
  });
  const links = await tx.magicLinkToken.updateMany({
    where: {
      tenantId: args.tenantId,
      email: { in: emails },
      used: false,
      purpose: { in: ["login", "first_time_signup"] },
    },
    data: { used: true, usedAt: now },
  });
  return { resetCodes: resets.count, signInLinks: links.count };
}

/**
 * Check a staff user's authenticator code WITHOUT spending it (8 Oct 2026,
 * account-editing review D1): same rules as `consumeUserTotp` (six digits,
 * valid now, from a time-step later than the last one accepted). A route uses
 * it to refuse a wrong code BEFORE answering anything that depends on other
 * secrets, then spends the code with `consumeUserTotp` inside its transaction
 * — the spend is still the single-use guarantee.
 */
export function verifyUserTotpCode(
  user: { totpSecret: string; totpLastUsedStep: number | null },
  code: string,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({
    token: code,
    secret: user.totpSecret,
    ...(user.totpLastUsedStep !== null ? { afterTimeStep: user.totpLastUsedStep } : {}),
  });
  return result.valid === true;
}

/**
 * Verify a staff user's authenticator code and SPEND it (single use across
 * instances), as `consumeOperatorTotp` does for operators: the code must be
 * valid and from a time-step later than the last one accepted for this user,
 * and the step is recorded with a conditional update so two requests racing
 * the same code cannot both win.
 */
export async function consumeUserTotp(
  tx: Prisma.TransactionClient,
  user: { id: string; totpSecret: string; totpLastUsedStep: number | null },
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({
    token: code,
    secret: user.totpSecret,
    ...(user.totpLastUsedStep !== null ? { afterTimeStep: user.totpLastUsedStep } : {}),
  });
  if (!result.valid) return false;
  const step = (result as { timeStep?: number }).timeStep;
  if (typeof step !== "number" || !Number.isSafeInteger(step)) return false;
  const spent = await tx.user.updateMany({
    where: {
      id: user.id,
      OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
    },
    data: { totpLastUsedStep: step },
  });
  return spent.count === 1;
}
