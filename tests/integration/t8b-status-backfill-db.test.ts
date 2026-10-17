// T8b (17 Oct 2026) — the status-history back-fill on a REAL database.
//
//   1. Apply writes source-dated history before the import-day event; replay
//      reads active 1 Mar, cancelled 15 Jul, active 1 Oct 2025; the import-day
//      event is unchanged (acceptance 1).
//   2. A second apply writes 0 rows and reports already applied (acceptance 2).
//   3. Rollback removes only the back-filled rows (acceptance 3).
//   4. The other club's events never change (acceptance 5).
//   5. Erased and undated members get no events and are exceptions
//      (acceptances 4 and 6).
//   6. The writer refuses a date not earlier than the first event, and the
//      club's transaction rolls back (acceptance 7).
//   7. The latest-event invariant holds for every member before and after.
//   8. The widened CHECK admits import_backfill and still refuses an unknown action.
//
// Needs migrations 20261017022302_status_event_source_provenance and
// 20261017024714_status_event_backfill_source_action applied. Runs only through
// the guarded runners (a Neon child branch, never production). Skips when
// DATABASE_URL is unset. Prefix t8b-; count-checked teardown of this file's
// clubs only.
import { describe, it, expect, afterAll } from "vitest";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { applyTenantBackfill, detectBackfill, monthTotals, planTenantBackfill, rollbackTenantBackfill } from "@/lib/status-backfill";
import { recordStatusEventsBulk, StatusEventPlacementRefused } from "@/lib/member-status";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `t8b-${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const IMPORT_DAY = new Date("2026-10-03T11:39:57.000Z");
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

type Club = { tenantId: string; userId: string; jobId: string };
const clubs: Club[] = [];

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "T8b Owner", role: "owner", passwordHash: "x" } });
    const j = await tx.importJob.create({
      data: { tenantId: t.id, createdById: u.id, source: "teamup", mode: "create", fileName: "m.csv", fileBlobUrl: `local-import://${STAMP}-${label}`, status: "complete", fileHash: `${STAMP}-${label}`, mappingVersion: "teamup@t8b" },
      select: { id: true },
    });
    return { tenantId: t.id, userId: u.id, jobId: j.id };
  });
  clubs.push(club);
  return club;
}

let rowNo = 1;
async function mkImported(
  club: Club,
  who: string,
  status: string,
  ledger: Array<{ status: string; entitlement: string; type?: string; startDate?: Date | null; expiryDate?: Date; cancelledDate?: Date; completedAt?: Date }>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return withRlsBypass(async (tx) => {
    const m = await tx.member.create({ data: { tenantId: club.tenantId, name: `T8b ${who}`, email: E(who), status, importJobId: club.jobId, ...extra }, select: { id: true } });
    for (const l of ledger) {
      rowNo += 1;
      await tx.importedMembership.create({
        data: {
          tenantId: club.tenantId,
          importJobId: club.jobId,
          memberId: m.id,
          sourceRow: rowNo,
          sourceFingerprint: `${STAMP}-${rowNo}`,
          planLabel: "Adults",
          type: l.type ?? "recurring",
          status: l.status,
          entitlement: l.entitlement,
          disposition: "member_history",
          startDate: l.startDate === undefined ? null : l.startDate,
          expiryDate: l.expiryDate ?? null,
          cancelledDate: l.cancelledDate ?? null,
          completedAt: l.completedAt ?? null,
        },
      });
    }
    await tx.memberStatusEvent.create({
      data: { tenantId: club.tenantId, memberId: m.id, fromStatus: null, toStatus: status, reason: "import", occurredAt: IMPORT_DAY, sourceJobId: club.jobId, sourceAction: "import_create" },
    });
    return m.id;
  });
}

const eventsOf = (club: Club, memberId?: string) =>
  withRlsBypass((tx) =>
    tx.memberStatusEvent.findMany({
      where: { tenantId: club.tenantId, ...(memberId ? { memberId } : {}) },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, memberId: true, fromStatus: true, toStatus: true, reason: true, occurredAt: true, changedById: true, sourceJobId: true, sourceAction: true },
    }),
  );
function statusOn(events: Array<{ toStatus: string; occurredAt: Date }>, at: Date): string | null {
  let s: string | null = null;
  for (const e of events) if (e.occurredAt <= at) s = e.toStatus;
  return s;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const ids = clubs.map((c) => c.tenantId);
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.importedMembership.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    members: await tx.member.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0 });
});

describe.skipIf(!HAS_DB)("T8b: back-fill apply, re-apply, rollback on a real database", () => {
  it("runs the whole cycle for one club and leaves the other untouched", async () => {
    const a = await mkClub("a");
    const b = await mkClub("b");
    const ada = await mkImported(a, "ada", "active", [
      { status: "cancelled", entitlement: "history", startDate: D("2025-01-10"), cancelledDate: D("2025-06-30") },
      { status: "active", entitlement: "current", startDate: D("2025-09-01") },
    ]);
    const elvis = await mkImported(a, "elvis", "inactive", [
      { status: "completed", entitlement: "history", type: "prepaid", startDate: D("2025-01-16"), expiryDate: D("2025-07-24"), completedAt: new Date("2025-07-25T00:01:35.000Z") },
    ]);
    const undated = await mkImported(a, "undated", "cancelled", [{ status: "cancelled", entitlement: "history", startDate: D("2025-03-01") }]);
    const gone = await mkImported(a, "gone", "cancelled", [
      { status: "cancelled", entitlement: "history", startDate: D("2024-12-01"), cancelledDate: D("2025-08-22") },
    ]);
    await withRlsBypass((tx) => tx.member.update({ where: { id: gone }, data: { email: `deleted-${gone}@deleted.invalid` } }));
    // A staff change after the import: must survive everything.
    await withRlsBypass((tx) =>
      tx.memberStatusEvent.create({ data: { tenantId: a.tenantId, memberId: ada, fromStatus: "active", toStatus: "active", reason: "staff_edit", changedById: a.userId, occurredAt: new Date("2026-10-10T09:00:00Z") } }),
    );
    const bea = await mkImported(b, "bea", "active", [{ status: "active", entitlement: "current", startDate: D("2024-04-01") }]);

    const originalA = (await eventsOf(a)).map((e) => e.id).sort();
    const originalB = JSON.stringify(await eventsOf(b));
    const before = await withTenantContext(a.tenantId, (tx) => detectBackfill(tx, a.tenantId, "Europe/London"));
    expect(before.latestEventMismatches).toBe(0);

    // Preview: reads only.
    const plan = await withTenantContext(a.tenantId, (tx) => planTenantBackfill(tx, a.tenantId));
    expect(plan.inputs).toHaveLength(5); // ada 3, elvis 2
    expect(plan.exceptionCounts).toMatchObject({ erased_member: 1, undated_end: 1 });
    expect((await eventsOf(a)).length).toBe(originalA.length);

    // Apply.
    const first = await withTenantContext(a.tenantId, (tx) => applyTenantBackfill(tx, a.tenantId, { runId: `${STAMP}-1` }), { timeout: 60_000 });
    expect(first).toMatchObject({ status: "applied", written: 5 });
    const adaEvents = await eventsOf(a, ada);
    expect(statusOn(adaEvents, new Date("2025-03-01T12:00:00Z"))).toBe("active");
    expect(statusOn(adaEvents, new Date("2025-07-15T12:00:00Z"))).toBe("cancelled");
    expect(statusOn(adaEvents, new Date("2025-10-01T12:00:00Z"))).toBe("active");
    expect(adaEvents.find((e) => e.sourceAction === "import_create")?.occurredAt.toISOString()).toBe(IMPORT_DAY.toISOString());
    for (const e of adaEvents.filter((x) => x.sourceAction === "import_backfill")) {
      expect(e).toMatchObject({ reason: "import", changedById: null, sourceJobId: a.jobId });
      expect(e.occurredAt.getTime()).toBeLessThan(IMPORT_DAY.getTime());
    }
    const elvisEvents = await eventsOf(a, elvis);
    expect(elvisEvents.map((e) => e.toStatus)).toEqual(["active", "inactive", "inactive"]);
    expect((await eventsOf(a, undated)).map((e) => e.sourceAction)).toEqual(["import_create"]);
    expect((await eventsOf(a, gone)).map((e) => e.sourceAction)).toEqual(["import_create"]);

    const after = await withTenantContext(a.tenantId, (tx) => detectBackfill(tx, a.tenantId, "Europe/London"));
    expect(after.byMonth).toEqual(monthTotals(plan.byMonth));
    expect(after.duplicates).toBe(0);
    expect(after.latestEventMismatches).toBe(before.latestEventMismatches);
    const audit = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: a.tenantId }, select: { action: true, metadata: true } }));
    expect(audit.map((x) => x.action)).toEqual(["member.status_history.backfill"]);

    // Re-apply: nothing.
    const second = await withTenantContext(a.tenantId, (tx) => applyTenantBackfill(tx, a.tenantId, { runId: `${STAMP}-2` }), { timeout: 60_000 });
    expect(second).toMatchObject({ status: "already_applied", written: 0 });
    expect((await eventsOf(a)).length).toBe(originalA.length + 5);

    // Rollback: only the back-filled rows go.
    const rb = await withTenantContext(a.tenantId, (tx) => rollbackTenantBackfill(tx, a.tenantId, { runId: `${STAMP}-1` }));
    expect(rb.removed).toBe(5);
    expect((await eventsOf(a)).map((e) => e.id).sort()).toEqual(originalA);

    // The other club never moved.
    expect(JSON.stringify(await eventsOf(b))).toBe(originalB);
    expect((await eventsOf(b, bea)).every((e) => e.sourceAction !== "import_backfill")).toBe(true);
  });

  it("the writer refuses a date not earlier than the first event and the club rolls back", async () => {
    const c = await mkClub("c");
    const m = await mkImported(c, "cara", "active", [{ status: "active", entitlement: "current", startDate: D("2025-05-01") }]);
    const base = { tenantId: c.tenantId, memberId: m, reason: "import" as const, changedById: null, sourceJobId: c.jobId, sourceAction: "import_backfill" as const };
    await expect(
      withTenantContext(c.tenantId, (tx) =>
        recordStatusEventsBulk(
          tx,
          [
            { ...base, fromStatus: null, toStatus: "active", occurredAt: new Date("2025-05-01T00:00:00Z") },
            { ...base, fromStatus: "active", toStatus: "cancelled", occurredAt: new Date(IMPORT_DAY) },
          ],
          { placement: "before-first" },
        ),
      ),
    ).rejects.toBeInstanceOf(StatusEventPlacementRefused);
    expect((await eventsOf(c, m)).map((e) => e.sourceAction)).toEqual(["import_create"]);
  });

  it("the widened CHECK admits import_backfill and still refuses an unknown action", async () => {
    const c = clubs[0] ?? (await mkClub("d"));
    const m = await withRlsBypass((tx) => tx.member.create({ data: { tenantId: c.tenantId, name: "T8b Check", email: E("check"), status: "active" }, select: { id: true } })).then((r) => r.id);
    await withRlsBypass((tx) =>
      tx.memberStatusEvent.create({ data: { tenantId: c.tenantId, memberId: m, fromStatus: null, toStatus: "active", reason: "import", occurredAt: D("2025-01-01"), sourceJobId: c.jobId, sourceAction: "import_backfill" } }),
    );
    await expect(
      withRlsBypass((tx) =>
        tx.memberStatusEvent.create({ data: { tenantId: c.tenantId, memberId: m, fromStatus: "active", toStatus: "cancelled", reason: "import", sourceJobId: c.jobId, sourceAction: "import_bogus" } }),
      ),
    ).rejects.toThrow();
  });
});
