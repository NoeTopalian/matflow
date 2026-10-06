// Restore versus purge: the coordination rules for a soft-deleted club.
//
// Operator security audit, 5 Oct 2026, finding 5. The retention cron's purge
// ran as a dozen separate transactions that never re-read `deletedAt`, and the
// operator's restore was an unconditional write with no window check. A
// restore that landed mid-purge returned 200 while the next step went on to
// delete the club it had just "restored".
//
// The authoritative state is the Tenant row itself:
//
//   deletedAt       set by soft-delete, cleared only by restore
//   purgeStartedAt  set once by the purge (the claim), never cleared
//
// Every transition is a CONDITIONAL single-row UPDATE with a count check, so
// Postgres serialises competing callers on the row lock and the loser
// re-evaluates its WHERE against the winner's committed row:
//
//   restore  WHERE deletedAt IS NOT NULL AND deletedAt >= now-30d AND purgeStartedAt IS NULL
//   claim    WHERE deletedAt IS NOT NULL AND deletedAt <  now-30d
//   guard    WHERE deletedAt IS NOT NULL AND purgeStartedAt = <claim>   (every destructive step)
//
// Restore-first: the claim matches nothing and the purge skips the club.
// Claim-first: the restore matches nothing and reports "deletion in progress"
// (or "permanently deleted" once the row is gone) — never success. Each purge
// step re-runs the guard inside its own transaction before it deletes, which
// also serialises a duplicate cron run step by step on the same row.
//
// The 30-day figure is the published promise (app/legal/privacy/page.tsx §6:
// "a gym marked for deletion is recoverable for 30 days, after which its
// records are permanently erased"), so restore refuses past it even when the
// purge has not reached the club yet.

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The published recovery window (privacy policy §6, DangerZone, hardDeleteAfter). */
export const TENANT_SOFT_DELETE_GRACE_MS = 30 * DAY_MS;

/** A club soft-deleted before this instant is past its recovery window. */
export function softDeleteCutoff(now: Date): Date {
  return new Date(now.getTime() - TENANT_SOFT_DELETE_GRACE_MS);
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export type RestoreOutcome =
  | { kind: "restored" }
  | { kind: "not-found" }
  | { kind: "not-deleted" }
  | { kind: "purge-in-progress"; purgeStartedAt: Date }
  | { kind: "window-expired"; deletedAt: Date }
  | { kind: "permanently-deleted" };

/**
 * Clear `deletedAt` only while the club is inside its recovery window and no
 * purge has claimed it. Run inside ONE transaction (the caller's): the
 * conditional update and the classification of a refusal read the same
 * committed state.
 */
export async function restoreSoftDeletedTenant(tx: Tx, tenantId: string, now: Date): Promise<RestoreOutcome> {
  const res = await tx.tenant.updateMany({
    where: {
      id: tenantId,
      deletedAt: { not: null, gte: softDeleteCutoff(now) },
      purgeStartedAt: null,
    },
    data: { deletedAt: null },
  });
  if (res.count === 1) return { kind: "restored" };

  const row = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { deletedAt: true, purgeStartedAt: true },
  });
  if (!row) {
    // The purge writes this row in the same transaction as the tenant delete,
    // so "gone with a hard-delete record" is a real permanent deletion and
    // "gone without one" is an id that never existed.
    const evidence = await tx.auditLog.findFirst({
      where: { action: "admin.tenant.hard_deleted", entityType: "Tenant", entityId: tenantId },
      select: { id: true },
    });
    return evidence ? { kind: "permanently-deleted" } : { kind: "not-found" };
  }
  if (row.purgeStartedAt) return { kind: "purge-in-progress", purgeStartedAt: row.purgeStartedAt };
  if (!row.deletedAt) return { kind: "not-deleted" };
  return { kind: "window-expired", deletedAt: row.deletedAt };
}

/** Operator-facing wording and status for each refusal. British English. */
export function restoreRefusal(outcome: Exclude<RestoreOutcome, { kind: "restored" }>): {
  status: number;
  error: string;
  state: string;
} {
  switch (outcome.kind) {
    case "not-found":
      return { status: 404, error: "Tenant not found", state: "not-found" };
    case "not-deleted":
      return { status: 409, error: "Tenant is not soft-deleted", state: "not-deleted" };
    case "purge-in-progress":
      return {
        status: 409,
        error:
          "Permanent deletion of this club is already in progress and cannot be undone. " +
          "Some of its data may already be gone.",
        state: "deletion-in-progress",
      };
    case "window-expired":
      return {
        status: 409,
        error:
          "The 30-day recovery window for this club has passed. It is due for permanent deletion " +
          "and can no longer be restored.",
        state: "recovery-window-expired",
      };
    case "permanently-deleted":
      return { status: 409, error: "This club has already been permanently deleted.", state: "permanently-deleted" };
  }
}

// ─── Purge claim and per-step guard ──────────────────────────────────────────

export type PurgeClaimOutcome =
  | { kind: "claimed"; claimedAt: Date; resumed: boolean }
  | { kind: "skipped"; reason: "restored" | "not-due" | "gone" };

/**
 * Claim a club for permanent deletion. A fresh claim stamps `purgeStartedAt`
 * only when the club is still soft-deleted and past its window; an existing
 * claim (a run cut short by the deadline, a crash, or a duplicate run) is
 * resumed with its original timestamp so every runner guards on one value.
 * Once claimed, restore is refused for good.
 */
export async function claimTenantPurge(tx: Tx, tenantId: string, now: Date): Promise<PurgeClaimOutcome> {
  const fresh = await tx.tenant.updateMany({
    where: {
      id: tenantId,
      deletedAt: { not: null, lt: softDeleteCutoff(now) },
      purgeStartedAt: null,
    },
    data: { purgeStartedAt: now },
  });
  if (fresh.count === 1) return { kind: "claimed", claimedAt: now, resumed: false };

  const row = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { deletedAt: true, purgeStartedAt: true },
  });
  if (!row) return { kind: "skipped", reason: "gone" };
  if (!row.deletedAt) return { kind: "skipped", reason: "restored" };
  if (row.purgeStartedAt) return { kind: "claimed", claimedAt: row.purgeStartedAt, resumed: true };
  return { kind: "skipped", reason: "not-due" };
}

/**
 * True when a transaction gave up waiting on the Tenant row (review of lane C,
 * D3). A purge step can hold that row lock for up to its 60 s member budget,
 * longer than the 15 s default transaction budget of a competing restore or
 * duplicate run; the waiter then fails with Prisma P2028 (transaction expired
 * or could not start) or, if a lock_timeout is set, Postgres 55P03. Nothing
 * was written by the waiter — its transaction rolled back — so the honest
 * answer is "busy, try again", not an error.
 */
export function isTenantRowBusyError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (err.code === "P2028" || err.code === "55P03" || err.meta?.code === "55P03") return true;
  const message = typeof err.message === "string" ? err.message : "";
  return /lock timeout|could not obtain lock|expired transaction|Transaction already closed/i.test(message);
}

export class PurgeAbortedError extends Error {
  constructor(
    readonly tenantId: string,
    readonly state: "gone" | "restored" | "claim-lost",
  ) {
    super(`tenant ${tenantId}: purge aborted (${state})`);
    this.name = "PurgeAbortedError";
  }
}

/**
 * Re-validate the claim inside the transaction that is about to delete. The
 * no-op write takes the Tenant row lock, so a competing writer (a restore, a
 * duplicate run's step) waits for this step to commit and then re-evaluates.
 * Throws PurgeAbortedError — rolling the step back — when the club is gone,
 * no longer soft-deleted, or carries a different claim.
 */
export async function assertPurgeClaim(tx: Tx, tenantId: string, claimedAt: Date): Promise<void> {
  const held = await tx.tenant.updateMany({
    where: { id: tenantId, deletedAt: { not: null }, purgeStartedAt: claimedAt },
    data: { purgeStartedAt: claimedAt },
  });
  if (held.count === 1) return;
  const row = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { deletedAt: true },
  });
  if (!row) throw new PurgeAbortedError(tenantId, "gone");
  throw new PurgeAbortedError(tenantId, row.deletedAt ? "claim-lost" : "restored");
}
