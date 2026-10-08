/**
 * Staff password rules, shared (8 Oct 2026, account-editing lane R).
 *
 * One strength rule and one history rule for every staff password door: at
 * least 10 characters with an upper-case letter, a lower-case letter and a
 * number; not the current password and not any of the last
 * PASSWORD_HISTORY_LIMIT passwords. Used by the self-service change
 * (/api/account/password), /api/auth/set-password, /api/auth/reset-password
 * (staff rows; members keep no history) and, strength only, the temporary
 * password an owner sets for a member of staff (PATCH /api/staff/[id]) — 8 Oct
 * 2026, lanes R and S-staff. Pinned by tests/unit/account-password.test.ts and
 * tests/unit/password-policy-doors.test.ts.
 */
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

// ONE history length for every door: 8. (Until 8 Oct 2026 set-password kept
// 5 and reset-password 8; 8 never shortens either window.)
export const PASSWORD_HISTORY_LIMIT = 8;

export const staffPasswordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128)
  .regex(/[A-Z]/, "Include an upper-case letter")
  .regex(/[a-z]/, "Include a lower-case letter")
  .regex(/[0-9]/, "Include a number");

/** True when `password` matches the current hash or any hash in `history`. */
export async function passwordReused(password: string, currentHash: string, history: string[]): Promise<boolean> {
  // In parallel, as reset-password does (AH-10: serial bcrypt is a timeout risk).
  const flags = await Promise.all([currentHash, ...history].map((hash) => bcrypt.compare(password, hash)));
  return flags.some(Boolean);
}

/** The last PASSWORD_HISTORY_LIMIT history hashes for a user, newest first. */
export async function recentPasswordHashes(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const rows = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: PASSWORD_HISTORY_LIMIT,
    select: { passwordHash: true },
  });
  return rows.map((r) => r.passwordHash);
}

/** Record the outgoing hash and trim history to PASSWORD_HISTORY_LIMIT rows. */
export async function recordPasswordHistory(tx: Prisma.TransactionClient, userId: string, outgoingHash: string): Promise<void> {
  await tx.passwordHistory.create({ data: { userId, passwordHash: outgoingHash } });
  const all = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (all.length > PASSWORD_HISTORY_LIMIT) {
    await tx.passwordHistory.deleteMany({ where: { id: { in: all.slice(PASSWORD_HISTORY_LIMIT).map((h) => h.id) } } });
  }
}
