/**
 * Vercel cron entry — runs daily at 03:30 UTC.
 * Schedule defined in vercel.json: "30 3 * * *".
 *
 * Closes audit findings P0-4 (published retention policy was fiction — no
 * deleteMany existed anywhere for AuditLog / EmailLog / tokens / ImportJob),
 * P2-2 (expired auth tokens accumulated forever with email + IP + UA), and
 * P1-6 ("deleted" tenants were never actually deleted despite the operator
 * UI promising "reversible for 30 days, then a cron hard-deletes").
 *
 * Design rules, all deliberate:
 *
 *  - Every rule is INDEPENDENT. One failing rule must not stop the others,
 *    so each runs in its own try/catch and reports `{ deleted }` or
 *    `{ error }` into the JSON response. Failures are also console.error'd
 *    so they surface in Vercel logs even when the cron reports 200.
 *
 *  - Every rule is CHUNKED. Deletes run as `findMany({ select: { id }, take })`
 *    followed by `deleteMany({ where: { id: { in: … } } })`, each batch in its
 *    own transaction. A 300s function timeout therefore truncates the sweep
 *    mid-way at a committed batch boundary — never mid-cascade — and the next
 *    night's run picks up exactly where this one stopped. No poison state.
 *
 *  - Runtime is CAPPED. maxDuration is 300s; we stop starting new rules (and
 *    stop starting new batches inside a rule) after 240s. A rule cut short
 *    reports `{ partial: true, processed: n }` and an untouched rule reports
 *    `{ skipped: true }` — neither is a failure. Retention is eventually
 *    consistent by design: what's left tonight runs tomorrow.
 *
 * Retention windows are the ones published at /legal/privacy. Change them
 * together or the policy goes back to being fiction.
 */
import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import type { Prisma } from "@prisma/client";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { isVercelBlobUrl } from "@/lib/blob-url";
import { deleteMemberCascade } from "@/lib/member-delete";

export const runtime = "nodejs";
export const maxDuration = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per statement. Keeps each transaction inside the 15s budget. */
const BATCH = 1000;
/** Members per transaction — each one is ~10 statements via the cascade walk. */
const MEMBER_BATCH = 25;
/** Stop starting new work after this, leaving 60s of the 300s budget spare. */
const DEADLINE_MS = 240_000;
/** Tenant hard-delete is the most expensive rule; cap the blast radius. */
const MAX_TENANT_PURGES_PER_RUN = 2;

// Published retention windows (app/legal/privacy/page.tsx §6).
const AUDIT_LOG_RETENTION_MS = 365 * DAY_MS;
const EMAIL_LOG_RETENTION_MS = 365 * DAY_MS;
/**
 * 24h grace AFTER expiry rather than deleting on expiry: a sign-in link being
 * verified at the instant it lapses must still resolve to "this link has
 * expired" rather than "invalid link", and the row is what tells those apart.
 */
const EXPIRED_TOKEN_GRACE_MS = DAY_MS;
/** RateLimitHit windows are ≤1h; anything a day old is dead weight. */
const RATE_LIMIT_HIT_RETENTION_MS = DAY_MS;
/** Stripe's event replay window is ~30 days; 90 is a generous idempotency margin. */
const STRIPE_EVENT_RETENTION_MS = 90 * DAY_MS;
/** Abandoned CSV imports still hold member PII in blob storage. */
const IMPORT_JOB_RETENTION_MS = 30 * DAY_MS;
/** The window promised by DangerZone.tsx and stamped as `hardDeleteAfter`. */
const TENANT_SOFT_DELETE_GRACE_MS = 30 * DAY_MS;

/**
 * ImportJob status vocabulary (app/api/admin/import/*): pending | preview |
 * running | complete | failed. `complete` is the only terminal success — its
 * blob is already deleted by the commit route, and the row is import history
 * the owner can still see. Everything else older than the window is an
 * abandoned job whose CSV is still sitting in blob storage.
 */
const IMPORT_JOB_TERMINAL_STATUSES = ["complete"];

type RuleResult = {
  rule: string;
  deleted?: number;
  error?: string;
  skipped?: boolean;
  /**
   * True when the deadline cut the rule short. Not an error: every rule is
   * idempotent and resumes from a committed batch boundary on the next run.
   */
  partial?: boolean;
  /** Units the rule got through before the deadline (rule-specific noun). */
  processed?: number;
  details?: Record<string, unknown>;
};

/**
 * Structural view of the Prisma delegate methods the batch helper needs.
 * Prisma's generated delegates are overloaded generics, so the call sites
 * cast through `unknown`; the shape below is what actually gets used.
 */
type IdRow = { id: string };
type BatchDeletable = {
  findMany(args: { where: object; select: { id: true }; take: number }): Promise<IdRow[]>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
};
type PickModel = (tx: Prisma.TransactionClient) => BatchDeletable;

export async function GET(req: Request) {
  // Vercel cron sends Authorization: Bearer ${CRON_SECRET}
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const rules: Array<{ name: string; run: () => Promise<Omit<RuleResult, "rule">> }> = [
    {
      name: "auditLog",
      run: () =>
        deleteInBatches(
          (tx) => tx.auditLog as unknown as BatchDeletable,
          { createdAt: { lt: ago(AUDIT_LOG_RETENTION_MS) } },
          elapsed,
        ),
    },
    {
      name: "emailLog",
      run: () =>
        deleteInBatches(
          (tx) => tx.emailLog as unknown as BatchDeletable,
          { createdAt: { lt: ago(EMAIL_LOG_RETENTION_MS) } },
          elapsed,
        ),
    },
    {
      name: "magicLinkToken",
      run: () =>
        deleteInBatches(
          (tx) => tx.magicLinkToken as unknown as BatchDeletable,
          { expiresAt: { lt: ago(EXPIRED_TOKEN_GRACE_MS) } },
          elapsed,
        ),
    },
    {
      name: "passwordResetToken",
      run: () =>
        deleteInBatches(
          (tx) => tx.passwordResetToken as unknown as BatchDeletable,
          { expiresAt: { lt: ago(EXPIRED_TOKEN_GRACE_MS) } },
          elapsed,
        ),
    },
    {
      name: "rateLimitHit",
      run: () =>
        deleteInBatches(
          (tx) => tx.rateLimitHit as unknown as BatchDeletable,
          { hitAt: { lt: ago(RATE_LIMIT_HIT_RETENTION_MS) } },
          elapsed,
        ),
    },
    {
      // StripeEvent carries no createdAt — `processedAt @default(now())` is
      // the only timestamp on the model (schema:653-658).
      name: "stripeEvent",
      run: () =>
        deleteInBatches(
          (tx) => tx.stripeEvent as unknown as BatchDeletable,
          { processedAt: { lt: ago(STRIPE_EVENT_RETENTION_MS) } },
          elapsed,
        ),
    },
    { name: "importJob", run: () => purgeAbandonedImportJobs(ago(IMPORT_JOB_RETENTION_MS), elapsed) },
    { name: "tenantHardDelete", run: () => purgeSoftDeletedTenants(ago(TENANT_SOFT_DELETE_GRACE_MS), elapsed) },
  ];

  const results: RuleResult[] = [];
  for (const rule of rules) {
    if (elapsed() > DEADLINE_MS) {
      results.push({ rule: rule.name, skipped: true });
      continue;
    }
    try {
      results.push({ rule: rule.name, ...(await rule.run()) });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cron/retention] rule "${rule.name}" failed`, e);
      results.push({ rule: rule.name, error: message });
    }
  }

  return NextResponse.json({
    ok: results.every((r) => !r.error),
    ranAt: now.toISOString(),
    elapsedMs: elapsed(),
    results,
  });
}

// ─── Generic chunked delete ──────────────────────────────────────────────────

/**
 * Delete every row matching `where`, `BATCH` rows at a time, each batch in its
 * own transaction. Returns as soon as the deadline passes so the caller can
 * report the rule as partial rather than being killed mid-flight.
 */
async function deleteInBatches(
  pick: PickModel,
  where: object,
  elapsed: () => number,
): Promise<{ deleted: number; partial?: true; processed?: number }> {
  let deleted = 0;
  for (;;) {
    if (elapsed() > DEADLINE_MS) return { deleted, partial: true, processed: deleted };

    const rows = await withRlsBypass((tx) =>
      pick(tx).findMany({ where, select: { id: true }, take: BATCH }),
    );
    if (rows.length === 0) return { deleted };

    const res = await withRlsBypass((tx) =>
      pick(tx).deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }),
    );
    deleted += res.count;

    // A short page means we've reached the tail of the matching set.
    if (rows.length < BATCH) return { deleted };
  }
}

// ─── Rule f — abandoned CSV import jobs (rows + their blobs) ─────────────────

async function purgeAbandonedImportJobs(
  cutoff: Date,
  elapsed: () => number,
): Promise<{ deleted: number; partial?: true; processed?: number; details: Record<string, unknown> }> {
  const where = {
    status: { notIn: IMPORT_JOB_TERMINAL_STATUSES },
    createdAt: { lt: cutoff },
  };

  let deleted = 0;
  let blobsDeleted = 0;
  for (;;) {
    if (elapsed() > DEADLINE_MS) {
      return { deleted, partial: true, processed: deleted, details: { blobsDeleted } };
    }

    const jobs = await withRlsBypass((tx) =>
      tx.importJob.findMany({ where, select: { id: true, fileBlobUrl: true }, take: BATCH }),
    );
    if (jobs.length === 0) return { deleted, details: { blobsDeleted } };

    // Best-effort blob cleanup BEFORE the rows go: once the row is gone the
    // URL is unrecoverable and the CSV (member PII) is orphaned forever.
    // Guarded by isVercelBlobUrl so legacy/data: values never reach del().
    const blobUrls = jobs.map((j) => j.fileBlobUrl).filter(isVercelBlobUrl);
    if (blobUrls.length > 0) {
      blobsDeleted += await deleteBlobsBestEffort(blobUrls);
    }

    const res = await withRlsBypass((tx) =>
      tx.importJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } }),
    );
    deleted += res.count;

    if (jobs.length < BATCH) return { deleted, details: { blobsDeleted } };
  }
}

/**
 * del() the given blob URLs, swallowing failures. Blob storage is not the
 * source of truth — a failed delete must never roll back or abort a retention
 * sweep, it just leaves an orphan for the next pass to miss.
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

// ─── Rule g — hard-delete tenants past their soft-delete grace window ────────

async function purgeSoftDeletedTenants(
  cutoff: Date,
  elapsed: () => number,
): Promise<{ deleted: number; partial?: true; processed?: number; details: Record<string, unknown> }> {
  // Cross-tenant by definition — same rationale as cron/monthly-reports.
  // Oldest soft-delete first so a backlog drains in the order it was promised.
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: { id: true, name: true, deletedAt: true, logoUrl: true },
      orderBy: { deletedAt: "asc" },
      take: MAX_TENANT_PURGES_PER_RUN,
    }),
  );

  let deleted = 0;
  const failures: Array<{ tenantId: string; error: string }> = [];
  const purged: Array<{ tenantId: string; membersDeleted: number }> = [];
  const partialTenants: Array<{ tenantId: string; membersDeleted: number }> = [];
  let partial = false;

  for (const tenant of tenants) {
    if (elapsed() > DEADLINE_MS) {
      partial = true;
      break;
    }
    try {
      const outcome = await purgeTenant(tenant, elapsed);
      if (outcome.completed) {
        deleted += 1;
        purged.push({ tenantId: tenant.id, membersDeleted: outcome.membersDeleted });
      } else {
        // Deadline hit mid-purge. Everything deleted so far is committed and
        // the tenant is still soft-deleted, so tomorrow's run resumes from
        // where this one stopped. Not an error — report it as partial.
        partial = true;
        partialTenants.push({ tenantId: tenant.id, membersDeleted: outcome.membersDeleted });
        break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cron/retention] tenant hard-delete failed for ${tenant.id}`, e);
      failures.push({ tenantId: tenant.id, error: message });
    }
  }

  return {
    deleted,
    ...(partial ? { partial: true as const, processed: purged.length + partialTenants.length } : {}),
    details: { candidates: tenants.length, purged, partial: partialTenants, failures },
  };
}

/**
 * Irreversibly remove one tenant and everything hanging off it.
 *
 * Ordering is dictated by the FK graph in prisma/migrations — every FK into
 * Tenant is ON DELETE RESTRICT except Task (CASCADE), so the Tenant row only
 * drops once User, Member, Class, ClassRoster, RankSystem, Notification,
 * Announcement, MembershipTier, MemberPhoto, PushSubscription and LoginEvent
 * are empty for it. Within those, Member is itself RESTRICTed by ~8 history
 * tables — which is exactly what lib/member-delete.ts already walks, so we
 * reuse it rather than re-deriving the order here.
 *
 * DELIBERATELY KEPT: AuditLog. Its `tenantId` is a plain String with no FK
 * (schema:596-628), so audit rows survive the tenant they describe. That is
 * correct — the erasure-evidence trail (including `member.dsar_erase` rows a
 * restore has to replay, see docs/runbooks/db-restore.md) must outlive the
 * data it attests to. Those rows age out on their own 12-month rule above.
 *
 * Transaction policy: reads use withTenantContext (defence in depth, mirrors
 * cron/monthly-reports); destructive passes use withRlsBypass because the
 * cascade reaches tables with no tenantId column at all (RankHistory,
 * ClassPackRedemption, ClassInstance, ClassSchedule, PasswordHistory), which
 * a tenant-scoped policy cannot authorise. Every deleteMany still carries an
 * application-layer tenant filter, directly or via an id set derived from one.
 */
async function purgeTenant(
  tenant: { id: string; name: string; logoUrl: string | null },
  elapsed: () => number,
): Promise<{ membersDeleted: number; completed: boolean }> {
  const tenantId = tenant.id;
  const outOfTime = () => elapsed() > DEADLINE_MS;

  // 1. Tasks. Task_tenantId is the one CASCADE, but Task.assigneeMemberId /
  //    createdById reference Member and User, so clearing tasks first keeps
  //    the rest of the walk free of surprises.
  const tasksOutcome = await deleteInBatches(
    (tx) => tx.task as unknown as BatchDeletable,
    { tenantId },
    elapsed,
  );
  if (tasksOutcome.partial) return { membersDeleted: 0, completed: false };

  // 2. Members, through the shared cascade helper. Also collects the blobs
  //    those members own (photos, waiver signatures) so an erased gym doesn't
  //    leave its members' images behind in blob storage.
  let membersDeleted = 0;
  for (;;) {
    if (outOfTime()) return { membersDeleted, completed: false };
    const members = await withTenantContext(tenantId, (tx) =>
      tx.member.findMany({ where: { tenantId }, select: { id: true }, take: MEMBER_BATCH }),
    );
    if (members.length === 0) break;
    const memberIds = members.map((m) => m.id);

    const [photos, waivers] = await Promise.all([
      withTenantContext(tenantId, (tx) =>
        tx.memberPhoto.findMany({ where: { tenantId, memberId: { in: memberIds } }, select: { url: true } }),
      ),
      withTenantContext(tenantId, (tx) =>
        tx.signedWaiver.findMany({
          where: { tenantId, memberId: { in: memberIds } },
          select: { signatureImageUrl: true },
        }),
      ),
    ]);
    const blobUrls = [
      ...photos.map((p) => p.url),
      ...waivers.map((w) => w.signatureImageUrl ?? ""),
    ].filter(isVercelBlobUrl);
    await deleteBlobsBestEffort(blobUrls);

    let removed = 0;
    await withRlsBypass(async (tx) => {
      for (const id of memberIds) {
        const outcome = await deleteMemberCascade(tx, { id, tenantId });
        if (outcome.kind === "ok") removed += 1;
      }
    });
    // Guard against an unbounded loop if a row refuses to go (e.g. a new FK
    // the cascade helper doesn't know about yet) — fail loudly instead.
    if (removed === 0) {
      throw new Error(`tenant ${tenantId}: member purge stalled with ${members.length} rows remaining`);
    }
    membersDeleted += removed;
  }

  // 3. Classes and their instance tree. ClassInstance/ClassSchedule have no
  //    tenantId, so they're reached through the tenant's class ids.
  if (outOfTime()) return { membersDeleted, completed: false };
  const classIds = (
    await withTenantContext(tenantId, (tx) =>
      tx.class.findMany({ where: { tenantId }, select: { id: true } }),
    )
  ).map((c) => c.id);
  if (classIds.length > 0) {
    for (;;) {
      if (outOfTime()) return { membersDeleted, completed: false };
      const instances = await withRlsBypass((tx) =>
        tx.classInstance.findMany({
          where: { classId: { in: classIds } },
          select: { id: true },
          take: BATCH,
        }),
      );
      if (instances.length === 0) break;
      const instanceIds = instances.map((i) => i.id);
      await withRlsBypass(async (tx) => {
        // Both RESTRICT ClassInstance and both require a memberId, so they are
        // already empty after step 2 — kept as belt and braces.
        await tx.attendanceRecord.deleteMany({ where: { classInstanceId: { in: instanceIds } } });
        await tx.classWaitlist.deleteMany({ where: { classInstanceId: { in: instanceIds } } });
        await tx.classInstance.deleteMany({ where: { id: { in: instanceIds } } });
      });
    }
    await withRlsBypass(async (tx) => {
      await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classSubscription.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classRoster.deleteMany({ where: { classId: { in: classIds } } });
      await tx.class.deleteMany({ where: { id: { in: classIds }, tenantId } });
    });
  }

  // 4. Rank systems. RankRequirement RESTRICTs RankSystem; MemberRank went
  //    with the members in step 2 and Class.requiredRankId/maxRankId are
  //    SET NULL on classes that no longer exist.
  await withRlsBypass(async (tx) => {
    await tx.rankRequirement.deleteMany({ where: { tenantId } });
    await tx.rankSystem.deleteMany({ where: { tenantId } });
  });

  // 5. Everything else keyed by tenantId. Order within the list matters only
  //    where one RESTRICTs another (MemberClassPack before ClassPack).
  const tenantScoped: Array<[string, PickModel]> = [
    ["memberPhoto", (tx) => tx.memberPhoto as unknown as BatchDeletable],
    ["pushSubscription", (tx) => tx.pushSubscription as unknown as BatchDeletable],
    ["loginEvent", (tx) => tx.loginEvent as unknown as BatchDeletable],
    ["notification", (tx) => tx.notification as unknown as BatchDeletable],
    ["announcement", (tx) => tx.announcement as unknown as BatchDeletable],
    ["membershipTier", (tx) => tx.membershipTier as unknown as BatchDeletable],
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
    // InitiativeAttachment is ON DELETE CASCADE from Initiative.
    ["initiative", (tx) => tx.initiative as unknown as BatchDeletable],
    ["googleDriveConnection", (tx) => tx.googleDriveConnection as unknown as BatchDeletable],
    ["indexedDriveFile", (tx) => tx.indexedDriveFile as unknown as BatchDeletable],
  ];
  for (const [, pick] of tenantScoped) {
    const outcome = await deleteInBatches(pick, { tenantId }, elapsed);
    if (outcome.partial) return { membersDeleted, completed: false };
  }

  // 6. Abandoned import CSVs for this tenant — blobs first, same as rule f.
  for (;;) {
    if (outOfTime()) return { membersDeleted, completed: false };
    const jobs = await withRlsBypass((tx) =>
      tx.importJob.findMany({ where: { tenantId }, select: { id: true, fileBlobUrl: true }, take: BATCH }),
    );
    if (jobs.length === 0) break;
    await deleteBlobsBestEffort(jobs.map((j) => j.fileBlobUrl).filter(isVercelBlobUrl));
    await withRlsBypass((tx) =>
      tx.importJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } }),
    );
  }

  // 7. Staff users. PasswordHistory CASCADEs; AuditLog.userId is SET NULL so
  //    the audit rows survive with their attribution dropped — the same
  //    trade-off the staff-delete route already makes.
  const usersOutcome = await deleteInBatches(
    (tx) => tx.user as unknown as BatchDeletable,
    { tenantId },
    elapsed,
  );
  if (usersOutcome.partial) return { membersDeleted, completed: false };

  // 8. Tenant branding blob, then the row itself. The audit row is written in
  //    the SAME transaction as the delete so the evidence and the erasure
  //    commit together — the pattern DSAR erase established (write the
  //    fulfilment record before destroying the data it attests to).
  if (tenant.logoUrl && isVercelBlobUrl(tenant.logoUrl)) {
    await deleteBlobsBestEffort([tenant.logoUrl]);
  }
  await withRlsBypass(async (tx) => {
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
          reason: "Soft-delete grace window elapsed (30 days)",
        },
      },
    });
    await tx.tenant.delete({ where: { id: tenantId } });
  });

  return { membersDeleted, completed: true };
}
