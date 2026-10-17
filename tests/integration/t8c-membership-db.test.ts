// T8c (17 Oct 2026) — movement and headcount reporting on a REAL database.
//
//   1. The event query plus the series over a seeded club equals the pure
//      function over the same rows (lib/membership-movement.ts buildMembership).
//   2. Today's headcount equals the ACTIVE_MEMBER count (the "Active members"
//      tile), and a guardian account is never counted.
//   3. History from the TeamUp ledger planned in memory equals the history
//      after the T8b back-fill is applied: the same months, the same figures.
//   4. Cross-tenant isolation: one club's events never reach another's series,
//      and a read for another club under this club's context returns nothing.
//
// Needs migration 20261017022302_status_event_source_provenance applied (its
// CHECK admits import_backfill). Runs only through
// the guarded runners (a Neon child branch, never production). Skips when
// DATABASE_URL is unset. Prefix t8c-; count-checked teardown of this file's
// clubs only.
import { describe, it, expect, afterAll } from "vitest";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { ACTIVE_MEMBER, TRAINING_MEMBER } from "@/lib/member-population";
import { buildMembership, type MovementEvent } from "@/lib/membership-movement";
import { loadMembershipReport } from "@/lib/membership-report";
import { applyTenantBackfill } from "@/lib/status-backfill";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `t8c-${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const IMPORT_DAY = new Date("2026-10-03T11:39:57.000Z");
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
// Wide enough to hold every seeded date whenever the suite runs.
const MONTHS = 36;

type Club = { tenantId: string; userId: string; jobId: string };
const clubs: Club[] = [];

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "T8c Owner", role: "owner", passwordHash: "x" } });
    const j = await tx.importJob.create({
      data: { tenantId: t.id, createdById: u.id, source: "teamup", mode: "create", fileName: "m.csv", fileBlobUrl: `local-import://${STAMP}-${label}`, status: "complete", fileHash: `${STAMP}-${label}`, mappingVersion: "teamup@t8c" },
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
  joinedAt: Date,
  ledger: Array<{ status: string; entitlement: string; type?: string; startDate: Date; expiryDate?: Date; cancelledDate?: Date; completedAt?: Date }>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return withRlsBypass(async (tx) => {
    const m = await tx.member.create({
      data: { tenantId: club.tenantId, name: `T8c ${who}`, email: E(who), status, joinedAt, importJobId: club.jobId, ...extra },
      select: { id: true },
    });
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
          startDate: l.startDate,
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

async function mkStaffMember(club: Club, who: string, joinedAt: Date, extra: Record<string, unknown> = {}): Promise<string> {
  return withRlsBypass(async (tx) => {
    const m = await tx.member.create({ data: { tenantId: club.tenantId, name: `T8c ${who}`, email: E(who), status: "active", joinedAt, ...extra }, select: { id: true } });
    await tx.memberStatusEvent.create({
      data: { tenantId: club.tenantId, memberId: m.id, fromStatus: null, toStatus: "active", reason: "staff_edit", changedById: club.userId, occurredAt: joinedAt },
    });
    return m.id;
  });
}

/** The same rows the loader reads, fetched directly, replayed by the pure function. */
async function pureSeries(club: Club, now: Date) {
  const { members, events } = await withRlsBypass(async (tx) => ({
    members: await tx.member.findMany({ where: { tenantId: club.tenantId, ...TRAINING_MEMBER }, select: { id: true, status: true } }),
    events: await tx.memberStatusEvent.findMany({
      where: { tenantId: club.tenantId, member: { tenantId: club.tenantId, ...TRAINING_MEMBER } },
      select: { id: true, memberId: true, fromStatus: true, toStatus: true, reason: true, sourceAction: true, occurredAt: true, createdAt: true },
    }),
  }));
  const mapped: MovementEvent[] = events.map((e) => (e.sourceAction === "import_backfill" ? { ...e, estimated: true } : e));
  const recorded = events.filter((e) => e.sourceAction !== "import_backfill").map((e) => e.occurredAt.getTime());
  const boundary = recorded.length ? new Date(Math.min(...recorded)) : null;
  return buildMembership({ events: mapped, live: members, now, timeZone: "Europe/London", months: MONTHS, boundary });
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

describe.skipIf(!HAS_DB)("T8c: movement and headcount on a real database", () => {
  it("replays a seeded club, matches the pure series and the tile, and the ledger in memory equals the applied back-fill", async () => {
    const a = await mkClub("a");
    const b = await mkClub("b");

    // ada: left Jun 2025, back Sep 2025, active at the import.
    await mkImported(a, "ada", "active", D("2025-01-10"), [
      { status: "cancelled", entitlement: "history", startDate: D("2025-01-10"), cancelledDate: D("2025-06-30") },
      { status: "active", entitlement: "current", startDate: D("2025-09-01") },
    ]);
    // elvis: a prepaid course completed in Jul 2025 ("Completed course", B-2).
    await mkImported(a, "elvis", "inactive", D("2025-01-16"), [
      { status: "completed", entitlement: "history", type: "prepaid", startDate: D("2025-01-16"), expiryDate: D("2025-07-24"), completedAt: new Date("2025-07-25T00:01:35.000Z") },
    ]);
    // cara: cancelled in Jun 2026, before the import.
    await mkImported(a, "cara", "cancelled", D("2024-11-01"), [
      { status: "cancelled", entitlement: "history", startDate: D("2024-11-01"), cancelledDate: D("2026-06-15") },
    ]);
    // dan: joined in MatFlow after the import.
    await mkStaffMember(a, "dan", new Date("2026-10-09T09:00:00.000Z"));
    // A guardian account with an active event: never a member count.
    await mkStaffMember(a, "guardian", new Date("2025-02-01T09:00:00.000Z"), { accountType: "parent" });
    // Club B: one active member who must never reach club A's series.
    await mkStaffMember(b, "bea", new Date("2025-03-01T09:00:00.000Z"));

    const now = new Date();
    const ledgerReport = await withTenantContext(a.tenantId, (tx) => loadMembershipReport(tx, a.tenantId, { now, months: MONTHS }));
    expect(ledgerReport.historySource).toBe("ledger");
    expect(ledgerReport.boundary).toBe(IMPORT_DAY.toISOString());

    // 2. Today's headcount equals the tile; the guardian is not in it.
    const activeTile = await withTenantContext(a.tenantId, (tx) => tx.member.count({ where: { tenantId: a.tenantId, ...ACTIVE_MEMBER } }));
    expect(activeTile).toBe(2); // ada, dan
    expect(ledgerReport.headcountByMonth.at(-1)!.headcount).toBe(activeTile);
    expect(ledgerReport.reconciled).toBe(0);

    const by = (k: string) => ledgerReport.movementsByMonth.find((r) => r.month === k);
    expect(by("2025-06")).toMatchObject({ lostCancelled: 1 });
    expect(by("2025-07")).toMatchObject({ lostCompleted: 1 });
    expect(by("2025-09")).toMatchObject({ rejoined: 1 });
    expect(by("2026-06")).toMatchObject({ lostCancelled: 1 });
    expect(by("2026-10")).toMatchObject({ new: 1, imported: 0 });
    // The earliest event is cara's start on 1 Nov 2024. Months that end before
    // it have no data ("none", never a fabricated zero); every later month
    // before the import boundary is estimated from the ledger.
    const beforeImport = ledgerReport.movementsByMonth.filter((m) => m.month < "2026-10");
    for (const r of beforeImport.filter((m) => m.month < "2024-11")) expect(r.basis).toBe("none");
    for (const r of beforeImport.filter((m) => m.month >= "2024-11")) expect(r.basis).toBe("estimated");
    expect(beforeImport.some((m) => m.basis === "estimated")).toBe(true);

    // 3. Apply the back-fill on this test club, then read again: the same figures.
    const applied = await withTenantContext(a.tenantId, (tx) => applyTenantBackfill(tx, a.tenantId, { runId: `${STAMP}-run` }), { timeout: 60_000 });
    expect(applied.status).toBe("applied");
    const backfillReport = await withTenantContext(a.tenantId, (tx) => loadMembershipReport(tx, a.tenantId, { now, months: MONTHS }));
    expect(backfillReport.historySource).toBe("backfill");
    expect(backfillReport.headcountByMonth).toEqual(ledgerReport.headcountByMonth);
    expect(backfillReport.movementsByMonth).toEqual(ledgerReport.movementsByMonth);
    expect(backfillReport.boundary).toBe(ledgerReport.boundary);

    // 1. The loader equals the pure function over the rows it reads.
    const pure = await pureSeries(a, now);
    expect(backfillReport.headcountByMonth).toEqual(pure.headcountByMonth);
    expect(backfillReport.movementsByMonth).toEqual(pure.movementsByMonth);
    expect(backfillReport.totals).toEqual(pure.totals);

    // 4. Isolation: club B sees only bea; club A's context cannot read club B.
    const bReport = await withTenantContext(b.tenantId, (tx) => loadMembershipReport(tx, b.tenantId, { now, months: MONTHS }));
    expect(bReport.headcountByMonth.at(-1)!.headcount).toBe(1);
    expect(bReport.totals.new).toBe(1);
    const crossed = await withTenantContext(a.tenantId, (tx) => loadMembershipReport(tx, b.tenantId, { now, months: MONTHS }));
    // Nothing readable: every month has no data (never a fabricated zero).
    expect(crossed.headcountByMonth.every((h) => h.basis === "none" && h.headcount === null)).toBe(true);
    expect(crossed.totals.new).toBe(0);
  });
});
