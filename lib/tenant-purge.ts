// Explicit erasure of ONE closed club — the only path that permanently deletes
// a club's data. Product rule (Noe, 16 Oct 2026): clubs and their data are
// KEPT when a club closes so it can come back; MatFlow never deletes a club on
// its own. `purgeTenantById` runs only on the club's written request, by an
// operator, and only against a club that is already closed (`deletedAt` set).
// No cron calls it (tests/unit/keep-closed-clubs-ratchet.test.ts). The by-age
// bulk purge that the retention cron used to run was removed the same day.
//
// Moved out of app/api/cron/retention/route.ts (6 Oct 2026) so the
// reopen-versus-erase coordination can be exercised for ONE synthetic club
// against a real database — a route file can only export handlers.
//
// Coordination is in lib/tenant-lifecycle.ts: the erasure claims the club
// (`purgeStartedAt`) before anything irreversible happens, and every
// destructive step re-validates that claim inside its own transaction. A
// transaction that gives up waiting on the Tenant row (another writer held it)
// is thrown to the caller; `isTenantRowBusyError` tells it apart from a real
// failure, and the claim, if any, stands for a retry.

import { del } from "@vercel/blob";
import type { Prisma } from "@prisma/client";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { isTenantBlobUrl } from "@/lib/blob-url";
import { deleteMemberCascade } from "@/lib/member-delete";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";
import { assertPurgeClaim, claimTenantPurge, PurgeAbortedError } from "@/lib/tenant-lifecycle";

type Tx = Prisma.TransactionClient;

/** Rows deleted per statement. Keeps each transaction inside the 15s budget. */
const BATCH = 1000;
/**
 * Members per transaction. Each `deleteMemberCascade` walk is ~10 statements,
 * so 10 members is ~110 round trips — inside the explicit 60s budget below
 * (25 was marginal against the 15s default and P2028'd forever).
 */
const MEMBER_BATCH = 10;
const MEMBER_TX_TIMEOUT_MS = 60_000;

type IdRow = { id: string };
type BatchDeletable = {
  findMany(args: { where: object; select: { id: true }; take: number }): Promise<IdRow[]>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
};
type PickModel = (tx: Tx) => BatchDeletable;

/** Outcome for one club. `completed: false` = deadline; the claim stands and the next run resumes. */
export type PurgeOneOutcome =
  | { kind: "purged"; membersDeleted: number; resumed: boolean }
  | { kind: "partial"; membersDeleted: number }
  | { kind: "skipped"; reason: string }
  | { kind: "billing-blocked"; reason: string; claimed: boolean; cancelledBeforeBlock: number }
  | { kind: "gone-during-purge"; membersDeleted: number }
  | { kind: "aborted"; state: string; membersDeleted: number };

// ─── Billing preflight ───────────────────────────────────────────────────────

/**
 * Cancel every live Stripe subscription in the club before its rows are
 * destroyed; any refusal is fatal to this erasure of this club (it stays
 * closed and unclaimed — still reopenable — and the operator retries once
 * billing is sorted). The read is gated on the club still being closed, in
 * the same transaction.
 */
async function cancelTenantSubscriptions(
  tenantId: string,
): Promise<
  | { kind: "ok"; cancelled: number }
  | { kind: "blocked"; reason: string; claimed: boolean; cancelled: number }
  | { kind: "not-due"; reason: string }
> {
  const preflight = await withTenantContext(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true, deletedAt: true, purgeStartedAt: true },
    });
    if (!tenant) return { due: false as const, reason: "gone" };
    // Due = closed (any age) or already claimed. An open club is never erased.
    const due = tenant.purgeStartedAt !== null || tenant.deletedAt !== null;
    if (!due) return { due: false as const, reason: "restored" };
    const members = await tx.member.findMany({
      where: { tenantId, stripeSubscriptionId: { not: null } },
      select: { id: true, name: true, stripeSubscriptionId: true },
    });
    return {
      due: true as const,
      members,
      stripeAccountId: tenant.stripeAccountId ?? null,
      claimed: tenant.purgeStartedAt !== null,
    };
  });

  if (!preflight.due) return { kind: "not-due", reason: preflight.reason };
  if (preflight.members.length === 0) return { kind: "ok", cancelled: 0 };
  if (!preflight.stripeAccountId) {
    return {
      kind: "blocked",
      reason:
        `${preflight.members.length} member(s) still carry a Stripe subscription but this gym ` +
        "has no connected Stripe account — cancel them directly in Stripe, then run the erasure again",
      claimed: preflight.claimed,
      cancelled: 0,
    };
  }

  let cancelled = 0;
  for (const member of preflight.members) {
    if (!member.stripeSubscriptionId) continue;
    const outcome = await cancelSubscriptionAtPeriodEnd({
      tenant: { stripeAccountId: preflight.stripeAccountId },
      stripeSubscriptionId: member.stripeSubscriptionId,
    });
    if (!outcome.ok) {
      return {
        kind: "blocked",
        reason:
          `Stripe cancellation failed for ${member.name} (${member.stripeSubscriptionId}): ${outcome.error}` +
          (cancelled > 0 ? ` (${cancelled} subscription(s) before it were already set to stop renewing)` : ""),
        claimed: preflight.claimed,
        cancelled,
      };
    }
    cancelled += 1;
  }
  return { kind: "ok", cancelled };
}

// ─── The walk ────────────────────────────────────────────────────────────────

/**
 * Irreversibly remove everything hanging off one club, in FK order (every FK
 * into Tenant is ON DELETE RESTRICT except Task). AuditLog is deliberately
 * kept: its tenantId has no FK and the erasure-evidence trail must outlive the
 * data it attests to.
 *
 * Destructive passes use withRlsBypass because the cascade reaches tables with
 * no tenantId column (RankHistory, ClassPackRedemption, ClassInstance,
 * ClassSchedule, PasswordHistory). Every deleteMany still carries a tenant
 * filter, directly or via an id set derived from one, and every one runs after
 * assertPurgeClaim in its own transaction.
 */
async function walkTenant(
  tenantId: string,
  claimedAt: Date,
  outOfTime: () => boolean,
): Promise<{ membersDeleted: number; completed: boolean }> {
  const guarded = <T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }) =>
    withRlsBypass(async (tx) => {
      await assertPurgeClaim(tx, tenantId, claimedAt);
      return fn(tx);
    }, opts);

  const sweep = async (pick: PickModel, where: object): Promise<boolean> => {
    for (;;) {
      if (outOfTime()) return false;
      const n = await guarded(async (tx) => {
        const rows = await pick(tx).findMany({ where, select: { id: true }, take: BATCH });
        if (rows.length === 0) return 0;
        await pick(tx).deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
        return rows.length;
      });
      if (n < BATCH) return true;
    }
  };

  // 1. Tasks (they reference Member and User).
  if (!(await sweep((tx) => tx.task as unknown as BatchDeletable, { tenantId }))) {
    return { membersDeleted: 0, completed: false };
  }

  // 2. Members, KIDS FIRST: Member has a non-deferrable CHECK (kids need a
  //    parent) and parentMemberId is ON DELETE SET NULL, so deleting a parent
  //    before its kids aborts the transaction (migration 20260515000001).
  const memberPasses: Prisma.MemberWhereInput[] = [
    { tenantId, parentMemberId: { not: null } },
    { tenantId },
  ];
  let membersDeleted = 0;
  for (const where of memberPasses) {
    const pass = await drainMembers(tenantId, where, guarded, outOfTime);
    membersDeleted += pass.membersDeleted;
    if (!pass.completed) return { membersDeleted, completed: false };
  }

  // 3. Classes and their instance tree (ClassInstance/ClassSchedule have no tenantId).
  if (outOfTime()) return { membersDeleted, completed: false };
  const classIds = (
    await withTenantContext(tenantId, (tx) => tx.class.findMany({ where: { tenantId }, select: { id: true } }))
  ).map((c) => c.id);
  if (classIds.length > 0) {
    for (;;) {
      if (outOfTime()) return { membersDeleted, completed: false };
      const n = await guarded(async (tx) => {
        const instances = await tx.classInstance.findMany({
          where: { classId: { in: classIds } },
          select: { id: true },
          take: BATCH,
        });
        if (instances.length === 0) return 0;
        const instanceIds = instances.map((i) => i.id);
        await tx.attendanceRecord.deleteMany({ where: { classInstanceId: { in: instanceIds } } });
        await tx.classWaitlist.deleteMany({ where: { classInstanceId: { in: instanceIds } } });
        await tx.classInstance.deleteMany({ where: { id: { in: instanceIds } } });
        return instances.length;
      });
      if (n === 0) break;
    }
    await guarded(async (tx) => {
      await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classSubscription.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classRoster.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classMembershipTier.deleteMany({ where: { classId: { in: classIds } } });
      await tx.class.deleteMany({ where: { id: { in: classIds }, tenantId } });
    });
  }

  // 4. Rank systems.
  await guarded(async (tx) => {
    await tx.rankRequirement.deleteMany({ where: { tenantId } });
    await tx.rankSystem.deleteMany({ where: { tenantId } });
  });

  // 5. Everything else keyed by tenantId (order matters where one RESTRICTs another).
  const tenantScoped: Array<[string, PickModel]> = [
    ["importedMembership", (tx) => tx.importedMembership as unknown as BatchDeletable],
    ["importedBooking", (tx) => tx.importedBooking as unknown as BatchDeletable],
    ["importSourceMapping", (tx) => tx.importSourceMapping as unknown as BatchDeletable],
    ["importUpload", (tx) => tx.importUpload as unknown as BatchDeletable],
    ["memberPhoto", (tx) => tx.memberPhoto as unknown as BatchDeletable],
    ["pushSubscription", (tx) => tx.pushSubscription as unknown as BatchDeletable],
    ["loginEvent", (tx) => tx.loginEvent as unknown as BatchDeletable],
    ["notification", (tx) => tx.notification as unknown as BatchDeletable],
    ["announcement", (tx) => tx.announcement as unknown as BatchDeletable],
    ["membershipTier", (tx) => tx.membershipTier as unknown as BatchDeletable],
    ["location", (tx) => tx.location as unknown as BatchDeletable],
    // Mats: the classes that pointed at them went in step 3.
    ["mat", (tx) => tx.mat as unknown as BatchDeletable],
    ["signedWaiver", (tx) => tx.signedWaiver as unknown as BatchDeletable],
    ["memberClassPack", (tx) => tx.memberClassPack as unknown as BatchDeletable],
    ["classPack", (tx) => tx.classPack as unknown as BatchDeletable],
    ["magicLinkToken", (tx) => tx.magicLinkToken as unknown as BatchDeletable],
    ["passwordResetToken", (tx) => tx.passwordResetToken as unknown as BatchDeletable],
    ["emailLog", (tx) => tx.emailLog as unknown as BatchDeletable],
    ["payment", (tx) => tx.payment as unknown as BatchDeletable],
    ["dispute", (tx) => tx.dispute as unknown as BatchDeletable],
    ["order", (tx) => tx.order as unknown as BatchDeletable],
    ["product", (tx) => tx.product as unknown as BatchDeletable],
    ["monthlyReport", (tx) => tx.monthlyReport as unknown as BatchDeletable],
    ["initiative", (tx) => tx.initiative as unknown as BatchDeletable],
    ["googleDriveConnection", (tx) => tx.googleDriveConnection as unknown as BatchDeletable],
    ["indexedDriveFile", (tx) => tx.indexedDriveFile as unknown as BatchDeletable],
  ];
  for (const [, pick] of tenantScoped) {
    if (!(await sweep(pick, { tenantId }))) return { membersDeleted, completed: false };
  }

  // 6. Import jobs — blobs first (best-effort), then rows under the guard.
  for (;;) {
    if (outOfTime()) return { membersDeleted, completed: false };
    const jobs = await withRlsBypass((tx) =>
      tx.importJob.findMany({ where: { tenantId }, select: { id: true, fileBlobUrl: true }, take: BATCH }),
    );
    if (jobs.length === 0) break;
    await deleteBlobsBestEffort(jobs.map((j) => j.fileBlobUrl).filter((u) => isTenantBlobUrl(u, tenantId)));
    await guarded((tx) => tx.importJob.deleteMany({ where: { tenantId, id: { in: jobs.map((j) => j.id) } } }));
  }

  // 7. Staff users (PasswordHistory cascades; AuditLog.userId is SET NULL).
  if (!(await sweep((tx) => tx.user as unknown as BatchDeletable, { tenantId }))) {
    return { membersDeleted, completed: false };
  }

  return { membersDeleted, completed: true };
}

/**
 * Delete every member matching `where`, MEMBER_BATCH at a time. Blob URLs are
 * read and the blobs dropped before the rows go (a crash then leaves rows
 * pointing at missing images, never images nobody can find). The cascade
 * transaction re-selects the batch after the guard, so a duplicate run that
 * already took some of these members is not mistaken for a stall.
 */
async function drainMembers(
  tenantId: string,
  where: Prisma.MemberWhereInput,
  guarded: <T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }) => Promise<T>,
  outOfTime: () => boolean,
): Promise<{ membersDeleted: number; completed: boolean }> {
  let membersDeleted = 0;
  for (;;) {
    if (outOfTime()) return { membersDeleted, completed: false };

    const members = await withTenantContext(tenantId, (tx) =>
      tx.member.findMany({ where, select: { id: true }, take: MEMBER_BATCH }),
    );
    if (members.length === 0) return { membersDeleted, completed: true };
    const memberIds = members.map((m) => m.id);

    const [photos, waivers] = await Promise.all([
      withTenantContext(tenantId, (tx) =>
        tx.memberPhoto.findMany({ where: { tenantId, memberId: { in: memberIds } }, select: { url: true } }),
      ),
      withTenantContext(tenantId, (tx) =>
        tx.signedWaiver.findMany({ where: { tenantId, memberId: { in: memberIds } }, select: { signatureImageUrl: true } }),
      ),
    ]);
    await deleteBlobsBestEffort(
      [...photos.map((p) => p.url), ...waivers.map((w) => w.signatureImageUrl ?? "")].filter((u) => isTenantBlobUrl(u, tenantId)),
    );

    const pass = await guarded(
      async (tx) => {
        const still = await tx.member.findMany({
          where: { AND: [where, { id: { in: memberIds } }] },
          select: { id: true },
        });
        let removed = 0;
        for (const { id } of still) {
          const outcome = await deleteMemberCascade(tx, { id, tenantId });
          if (outcome.kind === "ok") removed += 1;
        }
        return { found: still.length, removed };
      },
      { timeout: MEMBER_TX_TIMEOUT_MS },
    );
    // A row that refuses to go (a new FK the cascade helper does not know)
    // must fail loudly rather than loop forever.
    if (pass.found > 0 && pass.removed === 0) {
      throw new Error(`tenant ${tenantId}: member purge stalled with ${pass.found} rows remaining`);
    }
    membersDeleted += pass.removed;
  }
}

// ─── One club, end to end ────────────────────────────────────────────────────

/**
 * Erase one CLOSED club on its explicit written request, or explain why not.
 * Never called by a cron; an operator runs it. Order:
 *
 *   1. Billing preflight (fail-closed, idempotent Stripe calls). It runs
 *      BEFORE the claim so a club whose billing refuses to stop is left
 *      intact — nothing irreversible has happened to its data, and it can
 *      still be reopened. Subscriptions cancelled before the refusal are
 *      reported (cancelledBeforeBlock), since those calls are not undone. Its
 *      member read is gated on the club still being closed, so a club
 *      reopened before this point is not touched at all.
 *   2. Claim (conditional; reopen is refused from here on).
 *   3. The walk, each destructive transaction opening with assertPurgeClaim.
 *   4. The tenant row, conditionally, with the evidence row in the same
 *      transaction.
 *
 * A row-lock wait (another writer on the Tenant row) is thrown as-is; the
 * caller reads it with `isTenantRowBusyError` and retries later.
 */
export async function purgeTenantById(
  tenantId: string,
  now: Date,
  outOfTime: () => boolean,
): Promise<PurgeOneOutcome> {
  const billing = await cancelTenantSubscriptions(tenantId);
  if (billing.kind === "not-due") return { kind: "skipped", reason: billing.reason };
  if (billing.kind === "blocked") {
    return { kind: "billing-blocked", reason: billing.reason, claimed: billing.claimed, cancelledBeforeBlock: billing.cancelled };
  }

  const claim = await withRlsBypass((tx) => claimTenantPurge(tx, tenantId, now));
  if (claim.kind === "skipped") return { kind: "skipped", reason: claim.reason };

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, logoUrl: true } }),
  );
  if (!tenant) return { kind: "gone-during-purge", membersDeleted: 0 };

  let membersDeleted = 0;
  try {
    const walk = await walkTenant(tenantId, claim.claimedAt, outOfTime);
    membersDeleted = walk.membersDeleted;
    if (!walk.completed) return { kind: "partial", membersDeleted };

    if (tenant.logoUrl && isTenantBlobUrl(tenant.logoUrl, tenantId)) {
      await deleteBlobsBestEffort([tenant.logoUrl]);
    }
    await withRlsBypass(async (tx) => {
      await assertPurgeClaim(tx, tenantId, claim.claimedAt);
      const gone = await tx.tenant.deleteMany({
        where: { id: tenantId, deletedAt: { not: null }, purgeStartedAt: claim.claimedAt },
      });
      if (gone.count !== 1) throw new PurgeAbortedError(tenantId, "claim-lost");
      // Written in the same transaction as the delete: the evidence and the
      // erasure commit together, and a restore that waited on this row reads
      // the evidence to report "permanently deleted" rather than "not found".
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: null,
          action: "admin.tenant.hard_deleted",
          entityType: "Tenant",
          entityId: tenantId,
          metadata: {
            tenantName: tenant.name,
            membersDeleted,
            stripeSubscriptionsCancelled: billing.cancelled,
            purgeStartedAt: claim.claimedAt.toISOString(),
            resumed: claim.resumed,
            reason: "Explicit erasure on the club's written request (operator-run)",
          },
        },
      });
    });
    return { kind: "purged", membersDeleted, resumed: claim.resumed };
  } catch (e) {
    if (e instanceof PurgeAbortedError) {
      // "gone": a duplicate run finished this club first — nothing lost.
      if (e.state === "gone") return { kind: "gone-during-purge", membersDeleted };
      return { kind: "aborted", state: e.state, membersDeleted };
    }
    throw e;
  }
}

/**
 * Invariant (review of lane C): every blob deletion in this file runs OUTSIDE
 * a database transaction, and only after the club's claim (`purgeStartedAt`)
 * has committed. That is safe only because a claim is irreversible — reopen
 * refuses a claimed club forever — so a file deleted here can never belong to
 * a club that is later brought back. Do not move a blob deletion before
 * `claimTenantPurge`, and do not add a way to clear `purgeStartedAt`.
 */
async function deleteBlobsBestEffort(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  try {
    await del(urls);
    return urls.length;
  } catch (e) {
    console.warn("[tenant-purge] blob delete failed (best-effort)", e);
    return 0;
  }
}
