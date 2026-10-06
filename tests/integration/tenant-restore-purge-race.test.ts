// Restore versus purge, against a real Postgres (operator audit 5 Oct 2026,
// finding 5). Two real connections, explicit barriers, no sleeps standing in
// for ordering: the first transaction holds the Tenant row (uncommitted) at a
// barrier; the second is started and confirmed BLOCKED on that row lock in
// pg_stat_activity; only then is the first released.
//
// Restore and purge are given different clocks on purpose. With one clock
// their time predicates are disjoint (restore inside 30 days, purge past it),
// so the row-level claim matters exactly where those clocks disagree —
// different instances, the boundary instant — which is what is modelled.
//
// Synthetic clubs only, unique slugs, everything removed in afterAll. Run with
// the TEST branch runner (scratchpad att/run-engine.sh); skips without a DB.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined) }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: false, status: 500, error: "no Stripe in tests" })),
}));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import {
  claimTenantPurge,
  restoreRefusal,
  restoreSoftDeletedTenant,
  type RestoreOutcome,
} from "@/lib/tenant-lifecycle";
import { purgeTenantById } from "@/lib/tenant-purge";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const created: string[] = [];

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A soft-deleted club with a parent, a kid, another member and a class instance. */
async function makeClub(label: string, deletedAt: Date): Promise<string> {
  return withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({
      data: { name: `Lane C ${label}`, slug: `lanec-${label}-${STAMP}`, deletedAt },
    });
    created.push(t.id);
    const parent = await tx.member.create({
      data: { tenantId: t.id, name: "Parent Synthetic", email: `lanec-p-${label}-${STAMP}@test.local` },
    });
    await tx.member.create({
      data: {
        tenantId: t.id,
        name: "Kid Synthetic",
        email: `lanec-k-${label}-${STAMP}@test.local`,
        accountType: "kids",
        parentMemberId: parent.id,
      },
    });
    await tx.member.create({
      data: { tenantId: t.id, name: "Adult Synthetic", email: `lanec-a-${label}-${STAMP}@test.local` },
    });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: "Lane C Class", duration: 60, maxCapacity: 10 } });
    await tx.classInstance.create({
      data: { classId: cls.id, date: new Date("2026-09-01T00:00:00Z"), startTime: "10:00", endTime: "11:00" },
    });
    return t.id;
  });
}

async function memberCount(tenantId: string) {
  return withRlsBypass((tx) => tx.member.count({ where: { tenantId } }));
}
async function tenantRow(tenantId: string) {
  return withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { deletedAt: true, purgeStartedAt: true } }),
  );
}

/**
 * Wait until some backend is blocked on a row lock running a statement that
 * mentions `needle`. Polls with a bounded deadline; it does not stand in for
 * ordering — the first transaction is still holding its lock while we wait.
 */
async function waitForLockWaiter(needle: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${"%" + needle + "%"} AND datname = current_database()`;
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no backend blocked on ${needle} within 15s`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!HAS_DB)("restore vs purge on the authoritative Tenant row", () => {
  beforeAll(async () => {
    // Fail fast if the migration is missing on this branch.
    await withRlsBypass((tx) => tx.tenant.findFirst({ select: { purgeStartedAt: true } }));
  });

  afterAll(async () => {
    // Anything left (restored, boundary, partial) is purged through the same
    // path, after being made due; a leftover row is reported, not hidden.
    const purgeNow = new Date(Date.now() + 365 * DAY_MS);
    for (const id of created) {
      const row = await tenantRow(id);
      if (!row) continue;
      await withRlsBypass((tx) =>
        tx.tenant.updateMany({
          where: { id },
          data: { deletedAt: row.deletedAt ?? new Date(), purgeStartedAt: row.purgeStartedAt },
        }),
      );
      const out = await purgeTenantById(id, purgeNow, () => false);
      if (out.kind !== "purged" && out.kind !== "gone-during-purge") {
        console.error(`[lane C cleanup] ${id}: ${JSON.stringify(out)}`);
      }
    }
    await withRlsBypass((tx) =>
      tx.auditLog.deleteMany({ where: { action: "admin.tenant.hard_deleted", entityId: { in: created } } }),
    );
  });

  it("restore wins: the restore commits first, the blocked purge claim matches nothing, data remains", async () => {
    const restoreNow = new Date();
    const purgeNow = new Date(restoreNow.getTime() + 2 * DAY_MS);
    const id = await makeClub("rw", new Date(restoreNow.getTime() - 29 * DAY_MS));

    const held = deferred();
    const release = deferred();
    const restoreTx = withRlsBypass(async (tx) => {
      const r = await restoreSoftDeletedTenant(tx, id, restoreNow);
      held.resolve();
      await release.promise;
      return r;
    }, { timeout: 30_000 });
    await held.promise;

    const purge = purgeTenantById(id, purgeNow, () => false);
    await waitForLockWaiter("purgeStartedAt");
    release.resolve();

    expect(await restoreTx).toEqual({ kind: "restored" });
    expect(await purge).toEqual({ kind: "skipped", reason: "restored" });
    expect(await tenantRow(id)).toEqual({ deletedAt: null, purgeStartedAt: null });
    expect(await memberCount(id)).toBe(3);
  });

  it("purge wins: the claim commits first, the blocked restore reports the real state, then the data is gone", async () => {
    const purgeNow = new Date();
    const restoreNow = new Date(purgeNow.getTime() - 2 * DAY_MS);
    const id = await makeClub("pw", new Date(purgeNow.getTime() - 31 * DAY_MS));

    const held = deferred();
    const release = deferred();
    const claimTx = withRlsBypass(async (tx) => {
      const c = await claimTenantPurge(tx, id, purgeNow);
      held.resolve();
      await release.promise;
      return c;
    }, { timeout: 30_000 });
    await held.promise;

    const restore = withRlsBypass((tx) => restoreSoftDeletedTenant(tx, id, restoreNow));
    await waitForLockWaiter("deletedAt");
    release.resolve();

    expect(await claimTx).toMatchObject({ kind: "claimed", resumed: false });
    const refused = (await restore) as Exclude<RestoreOutcome, { kind: "restored" }>;
    expect(refused.kind).toBe("purge-in-progress");
    expect(restoreRefusal(refused)).toMatchObject({ status: 409, state: "deletion-in-progress" });

    const done = await purgeTenantById(id, purgeNow, () => false);
    expect(done).toMatchObject({ kind: "purged", resumed: true, membersDeleted: 3 });
    expect(await tenantRow(id)).toBeNull();
    expect(await memberCount(id)).toBe(0);

    const after = await withRlsBypass((tx) => restoreSoftDeletedTenant(tx, id, restoreNow));
    expect(after).toEqual({ kind: "permanently-deleted" });
  });

  it("deadline mid-purge: the claim stands, restore is refused, the next run resumes and finishes", async () => {
    const now = new Date();
    const id = await makeClub("crash", new Date(now.getTime() - 31 * DAY_MS));

    // Stop after the first member batch: the club is part-deleted.
    let calls = 0;
    const partial = await purgeTenantById(id, now, () => ++calls > 2);
    expect(partial.kind).toBe("partial");
    const mid = await tenantRow(id);
    expect(mid?.purgeStartedAt).toBeInstanceOf(Date);
    expect(await withRlsBypass((tx) => restoreSoftDeletedTenant(tx, id, new Date(now.getTime() - 5 * DAY_MS)))).toMatchObject({
      kind: "purge-in-progress",
    });

    const resumed = await purgeTenantById(id, new Date(now.getTime() + DAY_MS), () => false);
    expect(resumed).toMatchObject({ kind: "purged", resumed: true });
    expect(await tenantRow(id)).toBeNull();
  });

  it("duplicate concurrent runs: one purge, one clean no-op, exactly one evidence row, no error", async () => {
    const now = new Date();
    const id = await makeClub("dup", new Date(now.getTime() - 31 * DAY_MS));
    const [a, b] = await Promise.all([
      purgeTenantById(id, now, () => false),
      purgeTenantById(id, now, () => false),
    ]);
    // The loser either met the vanished row mid-walk or (if the winner had
    // already finished) found nothing due at all. Never an error, never two purges.
    const kinds = [a.kind, b.kind];
    expect(kinds.filter((k) => k === "purged")).toHaveLength(1);
    expect(["gone-during-purge", "skipped"]).toContain(kinds.find((k) => k !== "purged"));
    expect(await tenantRow(id)).toBeNull();
    const evidence = await withRlsBypass((tx) =>
      tx.auditLog.count({ where: { action: "admin.tenant.hard_deleted", entityId: id } }),
    );
    expect(evidence).toBe(1);
  });

  it("retention boundary: exactly 30 days is restorable and not claimable; 1 ms past is the reverse", async () => {
    const now = new Date();
    const edge = await makeClub("edge", new Date(now.getTime() - 30 * DAY_MS));
    expect(await withRlsBypass((tx) => claimTenantPurge(tx, edge, now))).toEqual({ kind: "skipped", reason: "not-due" });
    expect((await tenantRow(edge))?.purgeStartedAt).toBeNull();

    const late = await makeClub("late", new Date(now.getTime() - 30 * DAY_MS - 1));
    expect(await withRlsBypass((tx) => restoreSoftDeletedTenant(tx, late, now))).toMatchObject({ kind: "window-expired" });
    expect((await tenantRow(late))?.deletedAt).toBeInstanceOf(Date);

    expect(await withRlsBypass((tx) => restoreSoftDeletedTenant(tx, edge, now))).toEqual({ kind: "restored" });
  });
});
