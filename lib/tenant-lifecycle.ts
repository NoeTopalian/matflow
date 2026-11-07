// Reopen versus erase: the coordination rules for a closed club.
//
// Product rule (Noe, 16 Oct 2026): a club that closes is KEPT — its data, its
// members, its blobs — with sign-in disabled, so it can come back. MatFlow
// never deletes a club or its data on its own. Erasure happens only on the
// club's explicit written request, run by an operator through
// `purgeTenantById` (lib/tenant-purge.ts). There is no recovery window: a
// closed club can be reopened at any time, unless an explicit erasure has
// already claimed it.
//
// Operator security audit, 5 Oct 2026, finding 5 set the race rules that
// remain. An erasure runs as a dozen separate transactions; a reopen that
// landed mid-erasure must never answer 200 while the next step goes on to
// delete the club it just "reopened".
//
// The authoritative state is the Tenant row itself:
//
//   deletedAt       set by close ("soft-delete"), cleared only by reopen ("restore")
//   purgeStartedAt  set once by an explicit erasure (the claim), never cleared
//
// Every transition is a CONDITIONAL single-row UPDATE with a count check, so
// Postgres serialises competing callers on the row lock and the loser
// re-evaluates its WHERE against the winner's committed row:
//
//   restore  WHERE deletedAt IS NOT NULL AND purgeStartedAt IS NULL
//   claim    WHERE deletedAt IS NOT NULL AND purgeStartedAt IS NULL
//   guard    WHERE deletedAt IS NOT NULL AND purgeStartedAt = <claim>   (every destructive step)
//
// Restore-first: the claim matches nothing and the erasure skips the club.
// Claim-first: the restore matches nothing and reports "deletion in progress"
// (or "permanently deleted" once the row is gone) — never success. Each
// erasure step re-runs the guard inside its own transaction before it deletes,
// which also serialises a duplicate run step by step on the same row.
//
// An erasure still requires the club to be CLOSED first (`deletedAt` set): an
// open club is never erased. The route and audit action names keep their
// historical "soft_delete"/"restore" spelling; the hub says "close"/"reopen".

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// ─── Restore (reopen) ────────────────────────────────────────────────────────

export type RestoreOutcome =
  | { kind: "restored" }
  | { kind: "not-found" }
  | { kind: "not-deleted" }
  | { kind: "purge-in-progress"; purgeStartedAt: Date }
  | { kind: "permanently-deleted" };

/**
 * Clear `deletedAt` whenever the club is closed and no erasure has claimed it.
 * No age limit. Run inside ONE transaction (the caller's): the conditional
 * update and the classification of a refusal read the same committed state.
 * Nothing here is time-dependent: the clock argument went with the window.
 */
export async function restoreSoftDeletedTenant(tx: Tx, tenantId: string): Promise<RestoreOutcome> {
  const res = await tx.tenant.updateMany({
    where: {
      id: tenantId,
      deletedAt: { not: null },
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
  // Closed, unclaimed, yet the conditional write matched nothing: another
  // writer moved the row between our UPDATE and this read. Honest answer is
  // the state we can see; the operator retries.
  return { kind: "not-deleted" };
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
      return { status: 409, error: "Tenant is not closed", state: "not-deleted" };
    case "purge-in-progress":
      return {
        status: 409,
        error:
          "Permanent erasure of this club (on its written request) is already in progress and cannot be undone. " +
          "Some of its data may already be gone.",
        state: "deletion-in-progress",
      };
    case "permanently-deleted":
      return { status: 409, error: "This club has already been permanently deleted.", state: "permanently-deleted" };
  }
}

// ─── Erasure claim and per-step guard ────────────────────────────────────────

export type PurgeClaimOutcome =
  | { kind: "claimed"; claimedAt: Date; resumed: boolean }
  | { kind: "skipped"; reason: "restored" | "not-due" | "gone" };

/**
 * Claim a club for permanent erasure (explicit written request, operator-run).
 * A fresh claim stamps `purgeStartedAt` only when the club is CLOSED and
 * unclaimed — no age requirement; an open club is never claimable. An existing
 * claim (a run cut short by the deadline, a crash, or a duplicate run) is
 * resumed with its original timestamp so every runner guards on one value.
 * Once claimed, reopen is refused for good.
 */
export async function claimTenantPurge(tx: Tx, tenantId: string, now: Date): Promise<PurgeClaimOutcome> {
  const fresh = await tx.tenant.updateMany({
    where: {
      id: tenantId,
      deletedAt: { not: null },
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
  // Closed and unclaimed, yet the conditional write matched nothing: a
  // competing writer moved the row in between. Nothing was stamped; retry.
  return { kind: "skipped", reason: "not-due" };
}

/**
 * True when a transaction gave up waiting on the Tenant row (review of lane C,
 * D3). An erasure step can hold that row lock for up to its 60 s member budget,
 * longer than the 15 s default transaction budget of a competing restore or
 * duplicate run. The waiter fails with Postgres 55P03 ("canceling statement
 * due to lock timeout"): every tenant transaction sets lock_timeout BELOW its
 * statement_timeout (10 s / 15 s, extended 45 s / 60 s — lib/prisma-tenant.ts,
 * R10-5, lane L2 12 Oct 2026). Before that change the two were equal and the
 * statement bound fired first, so the wait ended as 57014 and this check —
 * correctly — did not read it as busy. A 57014 statement timeout is still NOT
 * busy here: it also means "this query is too slow", and calling that "busy"
 * would hide it. P2028 (the transaction budget expired, or a start timed out)
 * is busy as before. Nothing was written by the waiter — its transaction
 * rolled back — so the honest answer is "busy, try again", not an error.
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
 * no-op write takes the Tenant row lock, so a competing writer (a reopen, a
 * duplicate run's step) waits for this step to commit and then re-evaluates.
 * Throws PurgeAbortedError — rolling the step back — when the club is gone,
 * no longer closed, or carries a different claim.
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
