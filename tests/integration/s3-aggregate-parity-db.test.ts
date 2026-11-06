// S3 parity (6 Nov 2026): every aggregate statement in lib/aggregate-counts.ts returns EXACTLY what the Prisma reads it
// replaced returned, on seeded rows that sit on every edge those reads draw (window starts and ends to the
// millisecond, guardians, tasters, empty and null phones, paused / archived / imported classes, imported check-ins,
// another club's rows at the same instants). The "old" side is the replaced Prisma code, verbatim: the At-Risk gate
// below, and tests/unit/support/aggregate-counts-via-prisma.ts for the rest (the unit tests' stand-in for the SQL).
// Both are built from the same lib fragments (ACTIVE_MEMBER, CAN_TRAIN_MEMBER, liveClassWhere,
// MATFLOW_CHECKIN_WHERE …), so a change to a fragment that the SQL does not follow fails this file.
//
// Also proved on the real database: the timetable's mats read recovers inside the page's one transaction when its
// statement fails (savepoint), and the whole Reports load runs in one transaction with its bars adding up.
//
// Neon TEST branch only; runs as both roles through the matflow-verify-local db-tests.mjs runner (RLS on under
// matflow_app). Synthetic fixture: prefix s3p-, example.test addresses, torn down by tenant id.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// getReportsData lives beside the cached wrapper; the cache is not under test and needs Next's runtime.
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn, revalidateTag: vi.fn() }));

import type { Prisma } from "@prisma/client";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import {
  countAttendanceInWindows,
  readAtRiskGateProbes,
  readAttendanceSummaryCounts,
  readDashboardCounts,
  type AtRiskGateProbes,
  type CountWindow,
} from "@/lib/aggregate-counts";
import * as viaPrisma from "../unit/support/aggregate-counts-via-prisma";
import { AT_RISK_DAYS, MATFLOW_CHECKIN_WHERE, atRiskWindowStart, readAtRiskGate, type AtRiskGate } from "@/lib/dashboard-action-items";
import { readMatsForTimetable } from "@/lib/mats-store";
import { getReportsData, reportsAttendanceScope, reportsBarScope } from "@/lib/reports";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `s3p-${Date.now().toString(36)}`;
const made: string[] = [];
type Tx = Prisma.TransactionClient;

let seq = 0;
const nextId = (k: string) => `${STAMP}-${k}-${++seq}`;

type Visit = { at: string; member: string; cls: string; method?: string };

/** One club: members by key, classes by key, check-ins. Instances are one per check-in (unique by startTime). */
async function mkClub(
  label: string,
  spec: {
    members?: Record<string, Partial<Prisma.MemberUncheckedCreateInput> & { parent?: string }>;
    classes?: Record<string, Partial<Prisma.ClassUncheckedCreateInput> & { imported?: boolean }>;
    tiers?: number;
    visits?: Visit[];
    mats?: string[];
  },
): Promise<{ tenantId: string; member: Record<string, string>; cls: Record<string, string> }> {
  return withRlsBypass(
    async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London" } });
      made.push(t.id);
      const job = await tx.importJob.create({
        data: { tenantId: t.id, createdById: `${STAMP}-${label}`, source: "teamup-attendance", fileName: `${STAMP}.csv`, fileBlobUrl: "none", status: "complete" },
      });
      const member: Record<string, string> = {};
      // A kids account must have a parent (CHECK Member_kids_must_have_parent): `parent` names an earlier member's key.
      for (const [k, { parent, ...m }] of Object.entries(spec.members ?? {}) as [string, Partial<Prisma.MemberUncheckedCreateInput> & { parent?: string }][]) {
        const id = nextId(`m-${k}`);
        member[k] = id;
        await tx.member.create({
          data: { id, tenantId: t.id, name: `${label} ${k}`, email: `${id}@example.test`, ...(parent ? { parentMemberId: member[parent] } : {}), ...m } as Prisma.MemberUncheckedCreateInput,
        });
      }
      const cls: Record<string, string> = {};
      for (const [k, { imported, ...c }] of Object.entries(spec.classes ?? {})) {
        const id = nextId(`c-${k}`);
        cls[k] = id;
        await tx.class.create({ data: { id, tenantId: t.id, name: `${label} ${k}`, duration: 60, ...(imported ? { sourceImportJobId: job.id } : {}), ...c } as Prisma.ClassUncheckedCreateInput });
      }
      for (let i = 0; i < (spec.tiers ?? 0); i += 1) await tx.membershipTier.create({ data: { tenantId: t.id, name: `${label} tier ${i}` } });
      for (const [i, name] of (spec.mats ?? []).entries()) {
        await tx.mat.create({ data: { tenantId: t.id, name, nameKey: name.toLowerCase(), sortOrder: i } });
      }
      const visits = spec.visits ?? [];
      const instances = visits.map((v, i) => {
        const at = new Date(v.at);
        return { id: nextId("i"), classId: cls[v.cls], date: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())), startTime: `r${i}` };
      });
      if (instances.length) await tx.classInstance.createMany({ data: instances });
      if (visits.length) {
        await tx.attendanceRecord.createMany({
          data: visits.map((v, i) => {
            const method = v.method ?? "admin";
            return {
              tenantId: t.id,
              memberId: member[v.member],
              classInstanceId: instances[i].id,
              checkInTime: new Date(v.at),
              checkInMethod: method,
              importJobId: method === "import" ? job.id : null,
            };
          }),
        });
      }
      return { tenantId: t.id, member, cls };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

// ── The replaced reads, verbatim ─────────────────────────────────────────────

// The dashboard and attendance-summary reads before S3 are tests/unit/support/aggregate-counts-via-prisma.ts:
// the replaced Prisma calls, verbatim, which the unit tests also use as their stand-in for the SQL. Holding them equal
// here is what lets those unit tests stand for the real statements.
const oldDashboardCounts = (tx: Tx, tenantId: string, monthStart: Date, weekStart: Date) => viaPrisma.readDashboardCounts(tx, tenantId, { monthStart, weekStart });
const oldAttendanceSummary = (tx: Tx, tenantId: string, monthStart: Date, weekStart: Date) => viaPrisma.readAttendanceSummaryCounts(tx, tenantId, { monthStart, weekStart });
/**
 * lib/reports.ts before S3: one count per bar, scoped by the LIVE reportsAttendanceScope (review L1). A change to the
 * report's scope that the SQL's scope (reportsBarScope → countAttendanceInWindows) does not follow fails the bars test.
 */
const oldBucketCounts = (tx: Tx, tenantId: string, windows: CountWindow[], classId: string | undefined, ageGroup: "adult" | "kids" | undefined) =>
  Promise.all(
    windows.map((b) => tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: b.start, lt: b.end }, ...reportsAttendanceScope(classId, ageGroup) } })),
  );
/** lib/dashboard-action-items.ts readAtRiskGate before S3: findFirst probes. Returns the gate and the probes it ran. */
async function oldAtRiskGate(tx: Tx, tenantId: string, now: Date): Promise<{ gate: AtRiskGate; probes: Partial<AtRiskGateProbes> }> {
  const probes: Partial<AtRiskGateProbes> = {};
  const since = atRiskWindowStart(now);
  const probe = async (checkInTime: { gte?: Date; lt?: Date }, order: "asc" | "desc") =>
    (await tx.attendanceRecord.findFirst({ where: { tenantId, ...MATFLOW_CHECKIN_WHERE, checkInTime }, orderBy: { checkInTime: order }, select: { checkInTime: true } }))
      ?.checkInTime ?? null;
  const weekBefore = new Date(since);
  weekBefore.setDate(since.getDate() - Math.floor(AT_RISK_DAYS / 2));
  const before = (probes.before = await probe({ gte: weekBefore, lt: since }, "desc"));
  if (!before) {
    const first = (probes.first = await probe({ gte: since }, "asc"));
    if (!first) {
      const earlier = (probes.earlier = await probe({ lt: weekBefore }, "desc"));
      return { gate: earlier ? { open: false, reason: "paused" } : { open: false, reason: "none" }, probes };
    }
    const startsAt = new Date(first);
    startsAt.setDate(startsAt.getDate() + AT_RISK_DAYS);
    return { gate: { open: false, reason: "warming_up", startsAt }, probes };
  }
  const mid = new Date(since);
  mid.setDate(since.getDate() + Math.floor(AT_RISK_DAYS / 2));
  probes.firstHalf = await probe({ gte: since, lt: mid }, "asc");
  probes.secondHalf = await probe({ gte: mid }, "asc");
  if (!probes.firstHalf || !probes.secondHalf) return { gate: { open: false, reason: "paused" }, probes };
  return { gate: { open: true }, probes };
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-24T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString();

// Two window sets: week inside the month, and week starting before the month (2 Nov 2026 is a Monday after 1 Nov).
const WINDOW_SETS = [
  { name: "week inside month", monthStart: new Date("2026-10-01T00:00:00.000Z"), weekStart: new Date("2026-10-19T00:00:00.000Z") },
  { name: "week before month", monthStart: new Date("2026-11-01T00:00:00.000Z"), weekStart: new Date("2026-10-26T00:00:00.000Z") },
  { name: "BST month start", monthStart: new Date("2026-09-30T23:00:00.000Z"), weekStart: new Date("2026-10-18T23:00:00.000Z") },
];

// Edge instants for the main club: on each start (counted), a millisecond before it (not), mid-window, and later.
const EDGE_TIMES = [
  "2026-09-30T22:59:59.999Z",
  "2026-09-30T23:00:00.000Z",
  "2026-09-30T23:59:59.999Z",
  "2026-10-01T00:00:00.000Z",
  "2026-10-05T18:30:00.000Z",
  "2026-10-12T09:00:00.000Z",
  "2026-10-18T22:59:59.999Z",
  "2026-10-18T23:00:00.000Z",
  "2026-10-18T23:59:59.999Z",
  "2026-10-19T00:00:00.000Z",
  "2026-10-22T19:00:00.000Z",
  "2026-10-25T23:59:59.999Z",
  "2026-10-26T00:00:00.000Z",
  "2026-10-31T23:59:59.999Z",
  "2026-11-01T00:00:00.000Z",
  "2026-11-03T07:00:00.000Z",
];

describe.skipIf(!HAS_DB)("S3 aggregate statements return exactly what the replaced Prisma reads returned", () => {
  let A: Awaited<ReturnType<typeof mkClub>>;
  let B: Awaited<ReturnType<typeof mkClub>>;
  const gateClubs: Record<string, string> = {};

  beforeAll(async () => {
    const members = {
      adultActive: { status: "active", accountType: "adult", phone: "07700 900001", waiverAccepted: true, joinedAt: new Date("2025-01-01T00:00:00.000Z") },
      adultActiveNew: { status: "active", accountType: "adult", phone: null, waiverAccepted: false, joinedAt: new Date("2026-10-01T00:00:00.000Z") },
      joinedMsBefore: { status: "active", accountType: "adult", phone: "07700 900002", waiverAccepted: true, joinedAt: new Date("2026-09-30T23:59:59.999Z") },
      taster: { status: "taster", accountType: "adult", phone: "", waiverAccepted: false, joinedAt: new Date("2026-10-20T10:00:00.000Z") },
      inactive: { status: "inactive", accountType: "adult", phone: null, waiverAccepted: false, joinedAt: new Date("2026-11-01T00:00:00.000Z") },
      cancelled: { status: "cancelled", accountType: "adult", phone: null, waiverAccepted: false, joinedAt: new Date("2026-10-10T00:00:00.000Z") },
      guardian: { status: "active", accountType: "parent", phone: null, waiverAccepted: false, joinedAt: new Date("2026-10-05T00:00:00.000Z") },
      guardianTaster: { status: "taster", accountType: "parent", phone: "", waiverAccepted: false, joinedAt: new Date("2026-11-02T00:00:00.000Z") },
      kid: { status: "active", accountType: "kids", phone: "x", waiverAccepted: false, joinedAt: new Date("2026-10-15T00:00:00.000Z"), parent: "guardian" },
      junior: { status: "taster", accountType: "junior", phone: null, waiverAccepted: true, joinedAt: new Date("2026-09-01T00:00:00.000Z") },
    };
    const classes = {
      live: {},
      kids: {},
      paused: { isActive: false },
      archived: { isActive: false, deletedAt: new Date("2026-10-01T00:00:00.000Z") },
      archivedButActive: { deletedAt: new Date("2026-10-02T00:00:00.000Z") },
      imported: { imported: true },
    };
    const who = Object.keys(members);
    const which = ["live", "kids", "paused", "archived", "imported"];
    // Every edge instant, by a rotating member and class, plus repeats so one member has several check-ins.
    const visits: Visit[] = EDGE_TIMES.flatMap((at, i) => [
      { at, member: who[i % who.length], cls: which[i % which.length], method: i % 4 === 3 ? "import" : i % 4 === 2 ? "kiosk" : "admin" },
      { at: new Date(new Date(at).getTime() + 1).toISOString(), member: who[(i + 3) % who.length], cls: which[(i + 1) % which.length] },
    ]);
    A = await mkClub("a", { members, classes, tiers: 2, visits, mats: ["Mat 1", "Mat 2"] });
    // Another club with rows at the very same instants: none of them may leak into A's numbers.
    B = await mkClub("b", { members, classes, tiers: 3, visits });

    // At-Risk gate scenarios (one club each; the gate is club-wide). B's MatFlow rows exist at every instant.
    const gateMembers = { m1: { status: "active" }, m2: { status: "active" } };
    const scen: Record<string, Visit[]> = {
      empty: [],
      importsOnly: [{ at: ago(3), member: "m1", cls: "live", method: "import" }, { at: ago(40), member: "m2", cls: "live", method: "import" }],
      warming: [{ at: ago(30), member: "m1", cls: "live", method: "import" }, { at: ago(10), member: "m1", cls: "live" }, { at: ago(2), member: "m2", cls: "live" }],
      strayThenRestart: [{ at: ago(60), member: "m1", cls: "live" }, ...[0, 2, 4, 6, 8].map((d) => ({ at: ago(d), member: "m2", cls: "live" }))],
      stopped: [{ at: ago(40), member: "m1", cls: "live" }, { at: ago(30), member: "m2", cls: "live" }],
      closure: [{ at: ago(30), member: "m1", cls: "live" }, { at: ago(20), member: "m1", cls: "live" }, { at: ago(3), member: "m2", cls: "live" }],
      open: [29, 22, 16, 12, 9, 5, 2].map((d) => ({ at: ago(d), member: "m1", cls: "live" })).concat([{ at: ago(6), member: "m2", cls: "live" }]),
      // Only an imported row in each half: imports never open the gate.
      importedHalves: [{ at: ago(17), member: "m1", cls: "live" }, { at: ago(10), member: "m1", cls: "live", method: "import" }, { at: ago(3), member: "m2", cls: "live", method: "import" }],
      // Exactly on the edges: on `since` and on `mid` (each counted in the half it starts).
      edges: [] as Visit[],
    };
    const since = atRiskWindowStart(NOW);
    const mid = new Date(since);
    mid.setDate(since.getDate() + 7);
    const weekBefore = new Date(since);
    weekBefore.setDate(since.getDate() - 7);
    scen.edges = [
      { at: weekBefore.toISOString(), member: "m1", cls: "live" },
      { at: since.toISOString(), member: "m1", cls: "live" },
      { at: mid.toISOString(), member: "m2", cls: "live" },
    ];
    scen.edgesJustOutside = [
      { at: new Date(since.getTime() - 1).toISOString(), member: "m1", cls: "live" },
      { at: new Date(mid.getTime() - 1).toISOString(), member: "m2", cls: "live" },
    ];
    for (const [k, visitsK] of Object.entries(scen)) {
      gateClubs[k] = (await mkClub(`g-${k.toLowerCase()}`, { members: gateMembers, classes: { live: {} }, visits: visitsK })).tenantId;
    }
  }, 300_000);

  afterAll(async () => {
    if (made.length === 0) return;
    await withRlsBypass(
      async (tx) => {
        await tx.attendanceRecord.deleteMany({ where: { tenantId: { in: made } } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: made } } } });
        await tx.class.deleteMany({ where: { tenantId: { in: made } } });
        await tx.importJob.deleteMany({ where: { tenantId: { in: made } } });
        await tx.mat.deleteMany({ where: { tenantId: { in: made } } });
        await tx.membershipTier.deleteMany({ where: { tenantId: { in: made } } });
        await tx.member.deleteMany({ where: { tenantId: { in: made } } });
        await tx.tenant.deleteMany({ where: { id: { in: made } } });
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { id: { in: made } } }));
    expect(left).toBe(0);
  }, 120_000);

  it.each(WINDOW_SETS)("dashboard counts, $name", async ({ monthStart, weekStart }) => {
    for (const club of [A, B]) {
      const { now, old } = await withTenantContext(club.tenantId, async (tx) => ({
        now: await readDashboardCounts(tx, club.tenantId, { monthStart, weekStart }),
        old: await oldDashboardCounts(tx, club.tenantId, monthStart, weekStart),
      }));
      expect(now).toEqual(old);
    }
    // The fixture exercises every figure (a zero everywhere would prove nothing).
    const a = await withTenantContext(A.tenantId, (tx) => readDashboardCounts(tx, A.tenantId, { monthStart, weekStart }));
    for (const [k, v] of Object.entries(a)) expect([k, v > 0]).toEqual([k, true]);
  });

  it.each(WINDOW_SETS)("attendance summary, $name", async ({ monthStart, weekStart }) => {
    for (const club of [A, B]) {
      const { now, old } = await withTenantContext(club.tenantId, async (tx) => ({
        now: await readAttendanceSummaryCounts(tx, club.tenantId, { monthStart, weekStart }),
        old: await oldAttendanceSummary(tx, club.tenantId, monthStart, weekStart),
      }));
      expect(now).toEqual(old);
      expect(now.totalThisMonth).toBeGreaterThan(0);
      expect(now.uniqueMembersThisMonth).toBeGreaterThan(1);
    }
  });

  it("chart bars, every scope Reports applies", async () => {
    // Weekly bars (server-midnight Mondays and BST-shifted ones), clipped edges, and club months.
    const windows: CountWindow[] = [
      { start: new Date("2026-09-28T00:00:00.000Z"), end: new Date("2026-10-01T00:00:00.000Z") },
      { start: new Date("2026-09-30T23:00:00.000Z"), end: new Date("2026-10-05T00:00:00.000Z") },
      { start: new Date("2026-10-05T00:00:00.000Z"), end: new Date("2026-10-12T00:00:00.000Z") },
      { start: new Date("2026-10-12T00:00:00.000Z"), end: new Date("2026-10-19T00:00:00.000Z") },
      { start: new Date("2026-10-18T23:00:00.000Z"), end: new Date("2026-10-25T23:00:00.000Z") },
      { start: new Date("2026-10-19T00:00:00.000Z"), end: new Date("2026-10-26T00:00:00.000Z") },
      { start: new Date("2026-10-26T00:00:00.000Z"), end: new Date("2026-11-02T00:00:00.000Z") },
      { start: new Date("2026-11-01T00:00:00.000Z"), end: new Date("2026-12-01T00:00:00.000Z") },
      { start: new Date("2026-09-30T23:00:00.000Z"), end: new Date("2026-11-01T00:00:00.000Z") },
      // A window with nothing in it, and a zero-width one.
      { start: new Date("2025-01-01T00:00:00.000Z"), end: new Date("2025-01-08T00:00:00.000Z") },
      { start: new Date("2026-10-19T00:00:00.000Z"), end: new Date("2026-10-19T00:00:00.000Z") },
    ];
    const scopes: { classId?: string; ageGroup?: "adult" | "kids" }[] = [
      {},
      { classId: A.cls.live },
      { classId: A.cls.kids },
      { ageGroup: "adult" },
      { ageGroup: "kids" },
      { classId: A.cls.live, ageGroup: "adult" },
      { classId: A.cls.kids, ageGroup: "kids" },
      // A class of another club: Reports never passes one (it validates the id first), but the count must still be 0.
      { classId: B.cls.live },
    ];
    for (const scope of scopes) {
      const { now, twin, old } = await withTenantContext(A.tenantId, async (tx) => ({
        now: await countAttendanceInWindows(tx, A.tenantId, windows, reportsBarScope(scope.classId, scope.ageGroup)),
        twin: await viaPrisma.countAttendanceInWindows(tx, A.tenantId, windows, reportsBarScope(scope.classId, scope.ageGroup)),
        old: await oldBucketCounts(tx, A.tenantId, windows, scope.classId, scope.ageGroup),
      }));
      expect([scope, now]).toEqual([scope, old]);
      // The unit tests' stand-in counts the same.
      expect([scope, twin]).toEqual([scope, old]);
    }
    const all = await withTenantContext(A.tenantId, (tx) => countAttendanceInWindows(tx, A.tenantId, windows));
    expect(all.filter((n) => n > 0).length).toBeGreaterThan(5);
  });

  it("the At-Risk gate: same answer and same probe values as the findFirst probes, in every state", async () => {
    const seen = new Set<string>();
    for (const [name, tenantId] of Object.entries(gateClubs)) {
      const { now, probes, twin, old } = await withTenantContext(tenantId, async (tx) => {
        const { since, mid, weekBefore } = (await import("@/lib/dashboard-action-items")).atRiskGateWindows(NOW);
        return {
          now: await readAtRiskGate(tx, tenantId, NOW),
          probes: await readAtRiskGateProbes(tx, tenantId, { since, mid, weekBefore }),
          twin: await viaPrisma.readAtRiskGateProbes(tx, tenantId, { since, mid, weekBefore }),
          old: await oldAtRiskGate(tx, tenantId, NOW),
        };
      });
      expect([name, now]).toEqual([name, old.gate]);
      // The unit tests' stand-in reads the same five probes as the statement.
      expect([name, twin]).toEqual([name, probes]);
      // Every probe the old gate ran reads the same instant.
      for (const [k, v] of Object.entries(old.probes)) {
        expect([name, k, probes[k as keyof AtRiskGateProbes]?.toISOString() ?? null]).toEqual([name, k, v?.toISOString() ?? null]);
      }
      seen.add(now.open ? "open" : now.reason);
    }
    // The scenarios reach every state of the rule.
    expect([...seen].sort()).toEqual(["none", "open", "paused", "warming_up"]);
  });

  it("the timetable's mats read recovers inside the page's one transaction when its statement fails", async () => {
    const out = await withTenantContext(A.tenantId, async (tx) => {
      const before = await tx.class.count({ where: { tenantId: A.tenantId } });
      // A real failing statement on the real connection: it aborts the transaction, as a missing Mat table would.
      const broken = new Proxy(tx, {
        get: (t, k) => (k === "mat" ? { findMany: () => t.$queryRaw`SELECT * FROM "S3NoSuchTable"` } : Reflect.get(t, k)),
      }) as Tx;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const failed = await readMatsForTimetable(broken, A.tenantId);
      logged.mockRestore();
      // The transaction goes on: a later read answers, and the reads before the savepoint stand.
      const after = await tx.class.count({ where: { tenantId: A.tenantId } });
      const ok = await readMatsForTimetable(tx, A.tenantId);
      return { before, failed, after, ok };
    });
    expect(out.failed).toEqual({ mats: [], storedLayout: null, failed: true });
    expect(out.after).toBe(out.before);
    expect(out.ok.failed).toBe(false);
    expect(out.ok.mats.map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
  });

  it("after a failed mats read the transaction still COMMITS a write made after it, and leaves no savepoint open (review L3)", async () => {
    const marker = `${STAMP}-commit-marker`;
    const stillOpen = await withTenantContext(A.tenantId, async (tx) => {
      const broken = new Proxy(tx, {
        get: (t, k) => (k === "mat" ? { findMany: () => t.$queryRaw`SELECT * FROM "S3NoSuchTable"` } : Reflect.get(t, k)),
      }) as Tx;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const failed = await readMatsForTimetable(broken, A.tenantId);
      logged.mockRestore();
      expect(failed.failed).toBe(true);
      // No savepoint left: releasing it again must be refused ("savepoint does not exist"). Asked under a probe
      // savepoint so the refusal does not abort the transaction.
      await tx.$executeRaw`SAVEPOINT s3_probe`;
      let open: boolean;
      try {
        await tx.$executeRaw`RELEASE SAVEPOINT timetable_mats`;
        open = true;
      } catch {
        open = false;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT s3_probe`;
        await tx.$executeRaw`RELEASE SAVEPOINT s3_probe`;
      }
      // A write after the failed read, in the same transaction.
      await tx.membershipTier.create({ data: { id: marker, tenantId: A.tenantId, name: "S3 commit marker" } });
      return open;
    });
    expect(stillOpen).toBe(false);
    // Committed: another transaction sees the write.
    const committed = await withTenantContext(A.tenantId, (tx) => tx.membershipTier.count({ where: { tenantId: A.tenantId, id: marker } }));
    expect(committed).toBe(1);
    await withTenantContext(A.tenantId, (tx) => tx.membershipTier.deleteMany({ where: { tenantId: A.tenantId, id: marker } }));
  });

  it("Reports loads in one transaction, and the period's bars add up to its check-ins, with and without filters", async () => {
    for (const options of [{}, { classId: A.cls.live }, { ageGroup: "kids" as const }, { ageGroup: "adult" as const, classId: A.cls.kids }]) {
      for (const period of [{ period: "custom", from: "2026-10", to: "2026-10" }, { period: "custom", from: "2026-09", to: "2026-11" }]) {
        const d = await getReportsData(A.tenantId, { ...options, period });
        const inPeriod = d.weeklyAttendance.filter((w) => w.inPeriod).reduce((s, w) => s + w.count, 0);
        expect([options, period, inPeriod]).toEqual([options, period, d.summary.totalCheckIns]);
      }
    }
  });
});
