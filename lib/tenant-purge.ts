// Rule g of the retention cron: permanently delete clubs past their 30-day
// soft-delete window. Moved out of app/api/cron/retention/route.ts (6 Oct 2026)
// so the restore-versus-purge coordination can be exercised for ONE synthetic
// club against a real database — a route file can only export handlers.
//
// Coordination is in lib/tenant-lifecycle.ts: the purge claims the club
// (`purgeStartedAt`) before anything irreversible happens, and every
// destructive step re-validates that claim inside its own transaction.

import { del } from "@vercel/blob";
import type { Prisma } from "@prisma/client";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { isTenantBlobUrl } from "@/lib/blob-url";
import { deleteMemberCascade } from "@/lib/member-delete";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";
import {
  assertPurgeClaim,
  claimTenantPurge,
  isTenantRowBusyError,
  PurgeAbortedError,
  softDeleteCutoff,
} from "@/lib/tenant-lifecycle";

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
/** Tenant hard-delete is the most expensive rule; cap the blast radius. */
export const MAX_TENANT_PURGES_PER_RUN = 2;

type IdRow = { id: string };
type BatchDeletable = {
  findMany(args: { where: object; select: { id: true }; take: number }): Promise<IdRow[]>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
};
type PickModel = (tx: Tx) => BatchDeletable;

export type TenantPurgeResult = {
  deleted: number;
  /**
   * Set when a club was left part-deleted by something other than the deadline
   * (an aborted claim, a thrown step). The route turns any rule error into a
   * 500 so a half state is never reported as a clean run. A billing refusal is
   * not an error when the club was unclaimed: nothing was deleted, though
   * the club is past its recovery window and so is not restorable either —
   * the next run retries (review of lane C, D1).
   */
  error?: string;
  partial?: true;
  processed?: number;
  details: Record<string, unknown>;
};

/** Outcome for one club. `completed: false` = deadline; the claim stands and the next run resumes. */
export type PurgeOneOutcome =
  | { kind: "purged"; membersDeleted: number; resumed: boolean }
  | { kind: "partial"; membersDeleted: number }
  | { kind: "skipped"; reason: string }
  | { kind: "billing-blocked"; reason: string; claimed: boolean; cancelledBeforeBlock: number }
  | { kind: "gone-during-purge"; membersDeleted: number }
  | { kind: "aborted"; state: string; membersDeleted: number };

/**
 * The cron entry for rule g: pick the oldest candidates and purge each.
 * Candidates already claimed by an earlier run are included — resuming them
 * is how a deadline-cut or crashed purge finishes.
 */
export async function purgeSoftDeletedTenants(
  now: Date,
  outOfTime: () => boolean,
  dryRun = false,
): Promise<TenantPurgeResult> {
  const cutoff = softDeleteCutoff(now);
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: { id: true, name: true, deletedAt: true, purgeStartedAt: true },
      orderBy: { deletedAt: "asc" },
      take: MAX_TENANT_PURGES_PER_RUN,
    }),
  );

  if (dryRun) {
    return {
      deleted: 0,
      details: {
        candidates: tenants.length,
        wouldPurge: tenants.map((t) => ({
          tenantId: t.id,
          name: t.name,
          deletedAt: t.deletedAt?.toISOString() ?? null,
          purgeStartedAt: t.purgeStartedAt?.toISOString() ?? null,
        })),
      },
    };
  }

  let deleted = 0;
  let partial = false;
  const purged: Array<{ tenantId: string; membersDeleted: number; resumed: boolean }> = [];
  const partialTenants: Array<{ tenantId: string; membersDeleted: number }> = [];
  const skipped: Array<{ tenantId: string; reason: string }> = [];
  const failures: Array<{ tenantId: string; error?: string; reason?: string; cancelledBeforeBlock?: number }> = [];

  for (const t of tenants) {
    if (outOfTime()) {
      partial = true;
      break;
    }
    try {
      const outcome = await purgeTenantById(t.id, now, outOfTime);
      switch (outcome.kind) {
        case "purged":
          deleted += 1;
          purged.push({ tenantId: t.id, membersDeleted: outcome.membersDeleted, resumed: outcome.resumed });
          break;
        case "partial":
          partial = true;
          partialTenants.push({ tenantId: t.id, membersDeleted: outcome.membersDeleted });
          break;
        case "skipped":
        case "gone-during-purge":
          skipped.push({ tenantId: t.id, reason: outcome.kind === "skipped" ? outcome.reason : "purged by another run" });
          break;
        case "billing-blocked":
          console.error(`[cron/retention] tenant ${t.id} skipped: ${outcome.reason}`);
          // Unclaimed: nothing was deleted (it is past its recovery window, so
          // not restorable either; the next run retries), so
          // this is a reason, not an error. Already claimed (a resumed purge):
          // the club may be part-deleted, so it must surface as an error.
          failures.push(
            // `claimed` comes from the preflight's own in-transaction read, not
            // the candidate list read earlier (review of lane C, D2).
            outcome.claimed
              ? { tenantId: t.id, error: `resumed purge blocked on billing: ${outcome.reason}`, cancelledBeforeBlock: outcome.cancelledBeforeBlock }
              : { tenantId: t.id, reason: outcome.reason, cancelledBeforeBlock: outcome.cancelledBeforeBlock },
          );
          break;
        case "aborted":
          console.error(`[cron/retention] tenant ${t.id} purge aborted: ${outcome.state}`);
          failures.push({ tenantId: t.id, error: `purge aborted (${outcome.state})` });
          break;
      }
      if (outcome.kind === "partial") break;
    } catch (e) {
      // Another writer (a restore, a duplicate run's step) held the Tenant row
      // past this step's budget. The step rolled back; any claim stands and the
      // next run resumes it, exactly as after the deadline (review of lane C, D3).
      if (isTenantRowBusyError(e)) {
        skipped.push({ tenantId: t.id, reason: "busy" });
        continue;
      }
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cron/retention] tenant hard-delete failed for ${t.id}`, e);
      failures.push({ tenantId: t.id, error: message });
    }
  }

  const hard = failures.filter((f) => f.error);
  return {
    deleted,
    ...(hard.length ? { error: `${hard.length} club purge(s) failed part-way: ${hard.map((f) => f.tenantId).join(", ")}` } : {}),
    ...(partial ? { partial: true as const, processed: purged.length + partialTenants.length } : {}),
    details: { candidates: tenants.length, purged, partial: partialTenants, skipped, failures },
  };
}

// ─── Billing preflight ───────────────────────────────────────────────────────

/**
 * Cancel every live Stripe subscription in the club before its rows are
 * destroyed; any refusal is fatal to tonight's purge of this club (it stays
 * soft-deleted and unclaimed — not restorable, since it is past its window —
 * and tomorrow retries). The read is
 * gated on the club still being due, in the same transaction.
 */
async function cancelTenantSubscriptions(
  tenantId: string,
  now: Date,
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
    const due =
      tenant.purgeStartedAt !== null ||
      (tenant.deletedAt !== null && tenant.deletedAt.getTime() < softDeleteCutoff(now).getTime());
    if (!due) return { due: false as const, reason: tenant.deletedAt ? "not-due" : "restored" };
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
        "has no connected Stripe account — cancel them directly in Stripe, then the next run purges",
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
 * Purge one club, or explain why not. Order:
 *
 *   1. Billing preflight (fail-closed, idempotent Stripe calls). It runs
 *      BEFORE the claim so a club whose billing refuses to stop is left
 *      intact — nothing irreversible has happened to its data. It is past its
 *      recovery window, so restore still refuses it; the next run retries.
 *      Subscriptions cancelled before the refusal are reported
 *      (cancelledBeforeBlock), since those calls are not undone. Its member read
 *      is gated on the club still being due, so a club restored before this
 *      point is not touched at all.
 *   2. Claim (conditional; restore is refused from here on).
 *   3. The walk, each destructive transaction opening with assertPurgeClaim.
 *   4. The tenant row, conditionally, with the evidence row in the same
 *      transaction.
 */
export async function purgeTenantById(
  tenantId: string,
  now: Date,
  outOfTime: () => boolean,
): Promise<PurgeOneOutcome> {
  const billing = await cancelTenantSubscriptions(tenantId, now);
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
            reason: "Soft-delete grace window elapsed (30 days)",
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
 * has committed. That is safe only because a claim is irreversible — restore
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
    console.warn("[cron/retention] blob delete failed (best-effort)", e);
    return 0;
  }
}
