// Attendance-history import engine (lib/attendance-import.ts) against a REAL
// database — the Neon test branch, never production (tests/setup-test-db.ts
// refuses the production endpoint; run with TEST_DATABASE_URL from .env.test).
//
// The engine is driven exactly as app/api/admin/import/attendance drives it:
// decisions through saveDecisions, the commit prelude (claim the preview
// job's lease, create historical classes, set it running with its mappings),
// then runStep until it reports "complete". Only the file store is replaced:
// each job's fileBlobUrl is "test://…" and readFile serves the CSV from memory.
//
// Every scenario asserts database state, not just return values. The fixture
// clubs are throwaway tenants; afterAll removes everything they hold and
// checks nothing is left.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { createHash } from "node:crypto";

// Fault injection for one batch transaction. runStep opens each batch with
// withTenantContext(…, { timeout: 60_000, maxWait: 15_000 }) — the only call
// with that signature — so a failure armed here is thrown INSIDE that
// transaction, after the batch's writes, and Postgres rolls all of it back.
const inject = vi.hoisted(() => ({ failOnBatchCall: 0, batchCalls: 0 }));
vi.mock("@/lib/prisma-tenant", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/prisma-tenant")>();
  const withTenantContext: typeof mod.withTenantContext = async (tenantId, fn, options) => {
    const isBatch = options?.timeout === 60_000 && options?.maxWait === 15_000;
    if (!isBatch || !inject.failOnBatchCall) return mod.withTenantContext(tenantId, fn, options);
    inject.batchCalls += 1;
    const call = inject.batchCalls;
    return mod.withTenantContext(tenantId, async (tx) => {
      const out = await fn(tx);
      if (call === inject.failOnBatchCall) throw new Error("simulated failure inside a batch transaction");
      return out;
    }, options);
  };
  return { ...mod, withTenantContext };
});

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { teamupPersonKey } from "@/lib/importers/teamup";
import { dayMarkerFor } from "@/lib/importers/attendance";
import { synthesiseKidEmail, synthesiseMemberEmail } from "@/lib/synthesise-kid-email";
import { ensureTodayInstances } from "@/lib/today-sessions";
import {
  buildPlan,
  claimLease,
  createHistoricalClasses,
  emptyProgress,
  JOB_SOURCE,
  LEDGER_SOURCE,
  loadClubInputs,
  MAPPING_VERSION,
  planHashOf,
  previewSummary,
  releaseLease,
  rollbackJob,
  runStep,
  saveDecisions,
  type JobMappings,
  type Outcome,
} from "@/lib/attendance-import";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `aie${Date.now().toString(36)}`;
const VENUE = "Total BJJ Main";
const HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp";

// ── Files ────────────────────────────────────────────────────────────────────

const FILES = new Map<string, string>();
const readFile = async (url: string) => FILES.get(url) ?? null;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = { name: string; email: string; at: string; offering: string; status: string };
const line = (r: Row) => [r.name, r.email, r.at, r.offering, VENUE, "Coach A", "Online", "", "", "Unlimited", "App", r.status, ""].join(",");
const csvOf = (rows: Row[]) => [HEADER, ...rows.map(line)].join("\n");
const E = (who: string) => `${STAMP}-${who}@example.test`;

// ── Fixture ──────────────────────────────────────────────────────────────────

type Club = { label: string; tenantId: string; userId: string; locationId: string; classId: string; m: Record<string, string> };
const clubs: Club[] = [];

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${label}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } });
    const loc = await tx.location.create({ data: { tenantId: t.id, name: VENUE, isDefault: true } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: "Adults Gi", duration: 60, isActive: true } });
    const mk = (name: string, email: string, externalRef: string | null, extra: Record<string, unknown> = {}) =>
      tx.member.create({ data: { tenantId: t.id, name, email, externalRef, ...extra }, select: { id: true } }).then((r) => r.id);
    const m: Record<string, string> = {};
    m.alice = await mk("Alice Adams", E("alice"), teamupPersonKey("Alice Adams", E("alice")));
    m.ben = await mk("Ben Brown", E("ben"), null); // matched on name AND email
    m.pat = await mk("Pat Parker", E("pat"), teamupPersonKey("Pat Parker", E("pat")));
    // A child: synthesised no-login address, externalRef on the PARENT's email (as the members import stores it).
    m.kit = await mk("Kit Parker", synthesiseKidEmail(), teamupPersonKey("Kit Parker", E("pat")), { accountType: "kids", parentMemberId: m.pat });
    // Two adults sharing one address.
    m.sam = await mk("Sam Rice", E("rice"), teamupPersonKey("Sam Rice", E("rice")));
    m.jo = await mk("Jo Rice", synthesiseMemberEmail("adult"), teamupPersonKey("Jo Rice", E("rice")), { unverifiedEmail: E("rice") });
    // No email at all.
    m.nora = await mk("Nora Nomail", synthesiseMemberEmail("adult"), teamupPersonKey("Nora Nomail", ""));
    // Decision target for an unresolved person (different name and email: never auto-matched).
    m.umaMember = await mk("Uma Upton-Lee", E("uma.upton"), null);
    // An externalRef match the owner chooses to keep pending.
    m.penny = await mk("Penny Pending", E("penny"), teamupPersonKey("Penny Pending", E("penny")));
    return { label, tenantId: t.id, userId: u.id, locationId: loc.id, classId: cls.id, m };
  });
  clubs.push(club);
  const err = await withTenantContext(club.tenantId, (tx) =>
    saveDecisions(tx, club.tenantId, club.userId, [
      { kind: "offering", sourceKey: "Adults Gi", action: "class", targetId: club.classId },
      { kind: "offering", sourceKey: "Open Mat", action: "new_class" },
      { kind: "venue", sourceKey: VENUE, action: "location", targetId: club.locationId },
    ]),
  );
  if (err) throw new Error(`fixture decisions refused: ${err}`);
  return club;
}

/** A live (timetable) session and a staff check-in on it — not import-made. */
async function liveCheckIn(club: Club, localDate: string, start: string, memberId: string) {
  return withRlsBypass(async (tx) => {
    const end = `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}${start.slice(2)}`;
    const ci = await tx.classInstance.create({ data: { classId: club.classId, date: dayMarkerFor(localDate), startTime: start, endTime: end } });
    const ar = await tx.attendanceRecord.create({ data: { tenantId: club.tenantId, memberId, classInstanceId: ci.id, checkInTime: new Date(`${localDate}T${start}:05Z`), checkInMethod: "admin" } });
    return { instanceId: ci.id, attendanceId: ar.id };
  });
}

// ── Driving the engine as the route does ─────────────────────────────────────

let fileSeq = 0;
async function mkJob(club: Club, text: string, exportedAt: string) {
  const url = `test://${STAMP}/${++fileSeq}`;
  FILES.set(url, text);
  const job = await withRlsBypass((tx) =>
    tx.importJob.create({
      data: {
        tenantId: club.tenantId, createdById: club.userId, source: JOB_SOURCE, fileName: `attendance-${fileSeq}.csv`, fileBlobUrl: url,
        status: "preview", fileHash: sha256(text), sourceExportedAt: new Date(exportedAt), sourceExportedAtProvenance: "owner_stated", mappingVersion: MAPPING_VERSION,
      },
      select: { id: true },
    }),
  );
  return job.id;
}

/** The route's commit prelude: lease on the preview job, historical classes, running with mappings. */
async function startCommit(club: Club, jobId: string) {
  const t = club.tenantId;
  const job = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId }, select: { fileBlobUrl: true, sourceExportedAt: true } }));
  const text = FILES.get(job.fileBlobUrl)!;
  const inputs = await withTenantContext(t, (tx) => loadClubInputs(tx, t));
  const now = new Date();
  const built = buildPlan(text, inputs, now);
  if (built.errors) throw new Error(built.errors.join(" "));
  const started = await withTenantContext(t, async (tx) => {
    const token = await claimLease(tx, t, jobId, ["preview"]);
    if (!token) return false;
    const mappings: JobMappings = { createdClasses: {}, snapshotAt: job.sourceExportedAt?.toISOString() ?? null };
    await createHistoricalClasses(tx, t, jobId, built.plan, inputs, mappings.createdClasses);
    await ensureTodayInstances(tx, t, inputs.timezone);
    await releaseLease(tx, t, jobId, token, {
      status: "running", startedAt: now, processedRows: 0, importedRows: 0, skippedRows: 0, errorRows: 0,
      totalRows: built.plan.bookings.length,
      mappings: mappings as never,
      manifest: { kind: "attendance", inProgress: true, progress: emptyProgress() } as never,
    });
    return true;
  }, { timeout: 60_000 });
  expect(started, "commit prelude claimed the preview job").toBe(true);
}

type Manifest = {
  reconciles: boolean;
  input: { rows: number; bookings: number; duplicates: number; rejected: number };
  outcomes: Record<Outcome, number>;
  dispositions: Record<string, number>;
  attendance: { createdByThisImport: number; linkedToExisting: number };
  sessions: { created: number };
  classes: { created: number };
};

async function stepUntilComplete(club: Club, jobId: string, maxSteps = 8) {
  for (let i = 1; i <= maxSteps; i++) {
    const r = await runStep(club.tenantId, jobId, readFile);
    if (r.kind === "complete") return { manifest: r.manifest as unknown as Manifest, steps: i };
    if (r.kind !== "progress") throw new Error(`step ${i} returned ${r.kind}${r.kind === "failed" ? `: ${r.error}` : ""}`);
  }
  throw new Error(`job did not complete within ${maxSteps} steps`);
}

async function commitAll(club: Club, jobId: string, maxSteps = 8) {
  await startCommit(club, jobId);
  const out = await stepUntilComplete(club, jobId, maxSteps);
  expect(out.steps).toBeLessThanOrEqual(maxSteps);
  return out;
}

async function importFile(club: Club, rows: Row[] | string, exportedAt: string) {
  const text = typeof rows === "string" ? rows : csvOf(rows);
  const jobId = await mkJob(club, text, exportedAt);
  const { manifest, steps } = await commitAll(club, jobId);
  return { jobId, manifest, steps };
}

async function rollback(club: Club, jobId: string) {
  return withTenantContext(club.tenantId, async (tx) => {
    const token = await claimLease(tx, club.tenantId, jobId, ["complete", "failed"]);
    if (!token) throw new Error("rollback could not claim the lease");
    const report = await rollbackJob(tx, club.tenantId, jobId);
    await releaseLease(tx, club.tenantId, jobId, token, { rolledBackAt: new Date() });
    return report;
  }, { timeout: 120_000, maxWait: 15_000 });
}

// ── Reading the database ─────────────────────────────────────────────────────

async function counts(tenantId: string) {
  return withRlsBypass(async (tx) => ({
    bookings: await tx.importedBooking.count({ where: { tenantId } }),
    attendance: await tx.attendanceRecord.count({ where: { tenantId } }),
    importAttendance: await tx.attendanceRecord.count({ where: { tenantId, checkInMethod: "import" } }),
    instances: await tx.classInstance.count({ where: { class: { tenantId } } }),
    classes: await tx.class.count({ where: { tenantId } }),
  }));
}

const bookingsOf = (tenantId: string) =>
  withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId, source: LEDGER_SOURCE } }));

async function bookingAt(club: Club, personKey: string, startsAt: string, offering = "Adults Gi") {
  return withRlsBypass((tx) => tx.importedBooking.findFirstOrThrow({ where: { tenantId: club.tenantId, sourcePersonKey: personKey, startsAt: new Date(startsAt), offeringLabel: offering } }));
}

async function attendanceAt(club: Club, memberId: string, localDate: string, start: string) {
  return withRlsBypass((tx) => tx.attendanceRecord.findMany({ where: { tenantId: club.tenantId, memberId, classInstance: { date: dayMarkerFor(localDate), startTime: start } } }));
}

// ── Data ─────────────────────────────────────────────────────────────────────
// Instants in GMT (+00:00) so the club's wall clock equals the UTC clock.

const K = {
  alice: () => teamupPersonKey("Alice Adams", E("alice")),
  ben: () => teamupPersonKey("Ben Brown", E("ben")),
  kit: () => teamupPersonKey("Kit Parker", E("pat")),
  pat: () => teamupPersonKey("Pat Parker", E("pat")),
  sam: () => teamupPersonKey("Sam Rice", E("rice")),
  jo: () => teamupPersonKey("Jo Rice", E("rice")),
  nora: () => teamupPersonKey("Nora Nomail", ""),
  uma: () => teamupPersonKey("Uma Unknown", E("uma")),
  penny: () => teamupPersonKey("Penny Pending", E("penny")),
};
const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+00:00`;

const FILE1 = (): Row[] => [
  { name: "Alice Adams", email: E("alice"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
  { name: "Ben Brown", email: E("ben"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
  { name: "Uma Unknown", email: E("uma"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
  { name: "Kit Parker", email: E("pat"), at: at("2025-11-04", "17:00"), offering: "Adults Gi", status: "Attended" },
  { name: "Alice Adams", email: E("alice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "Registered" },
  { name: "Sam Rice", email: E("rice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "No show" },
  { name: "Jo Rice", email: E("rice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "Late Cancelled" },
  { name: "Pat Parker", email: E("pat"), at: at("2025-11-08", "11:00"), offering: "Open Mat", status: "Attended" },
  { name: "Nora Nomail", email: "", at: at("2025-11-08", "11:00"), offering: "Open Mat", status: "Attended" },
  { name: "Alice Adams", email: E("alice"), at: at("2027-02-01", "18:00"), offering: "Adults Gi", status: "Registered" },
  // The same booking twice in one file: a duplicate, never a second booking.
  { name: "Alice Adams", email: E("alice"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
];
const S1 = "2026-01-10T12:00:00Z";

/** > 400 bookings: four members, 120 days, every fifth Registered. */
function bigFile(): string {
  const people = [["Alice Adams", E("alice")], ["Ben Brown", E("ben")], ["Sam Rice", E("rice")], ["Pat Parker", E("pat")]];
  const rows: Row[] = [];
  const base = Date.UTC(2024, 10, 4); // 4 Nov 2024 — all GMT until 30 Mar 2025
  for (let d = 0; d < 120; d++) {
    const day = new Date(base + d * 86_400_000).toISOString().slice(0, 10);
    people.forEach(([name, email], i) => rows.push({ name, email, at: at(day, "18:00"), offering: "Adults Gi", status: (d * 4 + i) % 5 === 0 ? "Registered" : "Attended" }));
  }
  return csvOf(rows);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("attendance-import engine on the test database", () => {
  let main: Club;
  let job1 = "";
  let liveSlot: { instanceId: string; attendanceId: string };
  const replay9: { forecast?: Record<string, number>; manifest?: Manifest; touched?: string[] } = {};
  const memberSnapshot = new Map<string, string>();
  const snap = (m: { status: string; membershipType: string | null; paymentStatus: string; updatedAt: Date }) =>
    JSON.stringify([m.status, m.membershipType, m.paymentStatus, m.updatedAt.getTime()]);

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!url.includes("ep-hidden-salad")) throw new Error("Refusing: DATABASE_URL is not the ep-hidden-salad test branch.");
    main = await mkClub("main");
    for (const label of ["big-clean", "big-resume", "rb-one", "rb-two"]) await mkClub(label);
    // A live session already on the timetable at file 1's first slot (no check-ins on it).
    liveSlot = await withRlsBypass(async (tx) => {
      const ci = await tx.classInstance.create({ data: { classId: main.classId, date: dayMarkerFor("2025-11-03"), startTime: "18:00", endTime: "19:00" } });
      return { instanceId: ci.id, attendanceId: "" };
    });
    const members = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: { in: clubs.map((c) => c.tenantId) } }, select: { id: true, status: true, membershipType: true, paymentStatus: true, updatedAt: true } }));
    for (const m of members) memberSnapshot.set(m.id, snap(m));
  }, 180_000);

  afterAll(async () => {
    const ids = clubs.map((c) => c.tenantId);
    if (!ids.length) return;
    for (const tenantId of ids) {
      await withRlsBypass(async (tx) => {
        await tx.importedBooking.deleteMany({ where: { tenantId } });
        await tx.attendanceRecord.deleteMany({ where: { tenantId } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
        await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
        await tx.importSourceMapping.deleteMany({ where: { tenantId } });
        await tx.class.deleteMany({ where: { tenantId } });
        await tx.importJob.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.location.deleteMany({ where: { tenantId } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 60_000 });
    }
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: ids } } }),
      bookings: await tx.importedBooking.count({ where: { tenantId: { in: ids } } }),
      mappings: await tx.importSourceMapping.count({ where: { tenantId: { in: ids } } }),
      attendance: await tx.attendanceRecord.count({ where: { tenantId: { in: ids } } }),
      instances: await tx.classInstance.count({ where: { class: { tenantId: { in: ids } } } }),
      classes: await tx.class.count({ where: { tenantId: { in: ids } } }),
      jobs: await tx.importJob.count({ where: { tenantId: { in: ids } } }),
      members: await tx.member.count({ where: { tenantId: { in: ids } } }),
      locations: await tx.location.count({ where: { tenantId: { in: ids } } }),
      users: await tx.user.count({ where: { tenantId: { in: ids } } }),
    }));
    expect(left).toEqual({ tenants: 0, bookings: 0, mappings: 0, attendance: 0, instances: 0, classes: 0, jobs: 0, members: 0, locations: 0, users: 0 });
  }, 180_000);

  // 1 ─────────────────────────────────────────────────────────────────────────
  it("first import: attended rows of matched people become imported attendance; every other state stays a booking; every row is accounted for", async () => {
    const before = await counts(main.tenantId);
    const { jobId, manifest } = await importFile(main, FILE1(), S1);
    job1 = jobId;
    const after = await counts(main.tenantId);

    // Ledger: 10 bookings (11 rows, one duplicate), all created by this job.
    expect(manifest.reconciles).toBe(true);
    expect(manifest.input).toEqual({ rows: 11, bookings: 10, duplicates: 1, rejected: 0 });
    expect(manifest.outcomes).toEqual({ created: 10, updated: 0, unchanged: 0, stale: 0, protected: 0 });
    const ledger = await bookingsOf(main.tenantId);
    expect(ledger).toHaveLength(10);
    expect(ledger.every((b) => b.createdByJobId === jobId && b.lastJobId === jobId)).toBe(true);
    expect(manifest.outcomes.created + manifest.input.duplicates + manifest.input.rejected).toBe(manifest.input.rows);

    // Attendance: Alice, Ben, Kit (child via parent's email), Pat, Nora (no email) — and nobody else.
    const recs = await withRlsBypass((tx) => tx.attendanceRecord.findMany({ where: { tenantId: main.tenantId }, include: { classInstance: true } }));
    expect(after.attendance - before.attendance).toBe(5);
    expect(recs.every((r) => r.checkInMethod === "import" && r.importJobId === jobId)).toBe(true);
    expect(new Set(recs.map((r) => r.memberId))).toEqual(new Set([main.m.alice, main.m.ben, main.m.kit, main.m.pat, main.m.nora]));

    // The live session at the same slot is reused, not duplicated.
    const at1103 = recs.filter((r) => r.memberId === main.m.alice || r.memberId === main.m.ben);
    expect(at1103.map((r) => r.classInstanceId)).toEqual([liveSlot.instanceId, liveSlot.instanceId]);
    const slotCopies = await withRlsBypass((tx) => tx.classInstance.count({ where: { classId: main.classId, date: dayMarkerFor("2025-11-03"), startTime: "18:00" } }));
    expect(slotCopies).toBe(1);

    // Sessions created: Adults Gi 4 Nov 17:00 and Open Mat 8 Nov 11:00 — past, no end time, stamped.
    const made = await withRlsBypass((tx) => tx.classInstance.findMany({ where: { class: { tenantId: main.tenantId }, sourceImportJobId: jobId } }));
    expect(made).toHaveLength(2);
    expect(made.every((s) => s.endTime === null && s.date.getTime() < Date.now())).toBe(true);
    expect(after.instances - before.instances).toBe(2);

    // Registered / No show / Late Cancelled: booking_only, no attendance.
    for (const [key, status] of [[K.alice(), "registered"], [K.sam(), "no_show"], [K.jo(), "late_cancelled"]] as const) {
      const b = await bookingAt(main, key, at("2025-11-05", "18:00"));
      expect(b.status).toBe(status);
      expect(b.disposition).toBe("booking_only");
      expect(b.attendanceRecordId).toBeNull();
    }
    expect(await attendanceAt(main, main.m.sam, "2025-11-05", "18:00")).toHaveLength(0);
    expect(await attendanceAt(main, main.m.jo, "2025-11-05", "18:00")).toHaveLength(0);
    expect(await attendanceAt(main, main.m.alice, "2025-11-05", "18:00")).toHaveLength(0);

    // Shared address: each adult resolved to their own member by the source key.
    expect((await bookingAt(main, K.sam(), at("2025-11-05", "18:00"))).memberId).toBe(main.m.sam);
    expect((await bookingAt(main, K.jo(), at("2025-11-05", "18:00"))).memberId).toBe(main.m.jo);
    expect((await bookingAt(main, K.ben(), at("2025-11-03", "18:00"))).matchMethod).toBe("name_and_email");

    // Unresolved person: pending, no attendance.
    const uma = await bookingAt(main, K.uma(), at("2025-11-03", "18:00"));
    expect(uma.disposition).toBe("pending_person");
    expect(uma.memberId).toBeNull();
    expect(uma.attendanceRecordId).toBeNull();

    // Not yet started: held as future, no session.
    const fut = await bookingAt(main, K.alice(), at("2027-02-01", "18:00"));
    expect(fut.disposition).toBe("future");
    expect(fut.classInstanceId).toBeNull();

    // "Open Mat" mapped new_class: ONE inactive historical class, remembered by the decision.
    const hist = await withRlsBypass((tx) => tx.class.findMany({ where: { tenantId: main.tenantId, sourceImportJobId: jobId } }));
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ name: "Open Mat", isActive: false, duration: null, locationId: main.locationId });
    const dec = await withRlsBypass((tx) => tx.importSourceMapping.findFirstOrThrow({ where: { tenantId: main.tenantId, kind: "offering", sourceKey: "Open Mat" } }));
    expect(dec.targetId).toBe(hist[0].id);
    expect(after.classes - before.classes).toBe(1);

    const job = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId } }));
    expect(job.status).toBe("complete");
    expect(job.processedRows).toBe(10);
    expect(job.importedRows).toBe(5);
    expect(job.leaseToken).toBeNull();
  }, 180_000);

  // 2 ─────────────────────────────────────────────────────────────────────────
  it("an identical replay creates nothing: every booking is unchanged", async () => {
    const before = await counts(main.tenantId);
    const text = csvOf(FILE1());
    // The preview forecasts the same thing the commit does.
    const inputs = await withTenantContext(main.tenantId, (tx) => loadClubInputs(tx, main.tenantId));
    const built = buildPlan(text, inputs, new Date());
    if (built.errors) throw new Error(built.errors.join(" "));
    const summary = await withTenantContext(main.tenantId, (tx) => previewSummary(tx, main.tenantId, built, inputs, new Date("2026-01-11T12:00:00Z")));
    expect(summary.forecast).toEqual({ new: 0, unchanged: 10, status_update: 0, resolution_update: 0, stale: 0 });

    const { jobId, manifest } = await importFile(main, text, "2026-01-11T12:00:00Z");
    expect(await counts(main.tenantId)).toEqual(before);
    expect(manifest.outcomes).toEqual({ created: 0, updated: 0, unchanged: 10, stale: 0, protected: 0 });
    expect(manifest.reconciles).toBe(true);
    const touched = await withRlsBypass((tx) => tx.importedBooking.count({ where: { tenantId: main.tenantId, lastJobId: jobId } }));
    expect(touched).toBe(0);
  }, 120_000);

  // 3 ─────────────────────────────────────────────────────────────────────────
  it("a re-ordered file creates nothing: booking identity ignores row order", async () => {
    const before = await counts(main.tenantId);
    const { manifest } = await importFile(main, [...FILE1()].reverse(), "2026-01-12T12:00:00Z");
    expect(await counts(main.tenantId)).toEqual(before);
    expect(manifest.outcomes).toEqual({ created: 0, updated: 0, unchanged: 10, stale: 0, protected: 0 });
  }, 120_000);

  // 4 ─────────────────────────────────────────────────────────────────────────
  it("an overlapping export creates only the new rows", async () => {
    const before = await counts(main.tenantId);
    const fresh: Row[] = [
      { name: "Alice Adams", email: E("alice"), at: at("2025-11-10", "18:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Ben Brown", email: E("ben"), at: at("2025-11-10", "18:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Sam Rice", email: E("rice"), at: at("2025-11-12", "11:00"), offering: "Open Mat", status: "Registered" },
    ];
    const { jobId, manifest } = await importFile(main, [...FILE1().slice(0, 5), ...fresh], "2026-01-13T12:00:00Z");
    const after = await counts(main.tenantId);
    expect(manifest.outcomes).toEqual({ created: 3, updated: 0, unchanged: 5, stale: 0, protected: 0 });
    expect(after.bookings - before.bookings).toBe(3);
    expect(after.attendance - before.attendance).toBe(2);
    expect(after.instances - before.instances).toBe(1);
    expect(after.classes).toBe(before.classes);
    const created = await withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: main.tenantId, createdByJobId: jobId } }));
    expect(created.map((b) => b.startsAt.toISOString().slice(0, 10)).sort()).toEqual(["2025-11-10", "2025-11-10", "2025-11-12"]);
  }, 120_000);

  // 5 ─────────────────────────────────────────────────────────────────────────
  let job5 = "";
  it("a NEWER snapshot turns Registered into Attended on the same booking row, with exactly one new attendance", async () => {
    const prior = await bookingAt(main, K.alice(), at("2025-11-05", "18:00"));
    const before = await counts(main.tenantId);
    const { jobId, manifest } = await importFile(main, [
      { name: "Alice Adams", email: E("alice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "Attended" },
    ], "2026-02-01T12:00:00Z");
    job5 = jobId;
    const after = await counts(main.tenantId);
    const row = await bookingAt(main, K.alice(), at("2025-11-05", "18:00"));
    expect(manifest.outcomes).toEqual({ created: 0, updated: 1, unchanged: 0, stale: 0, protected: 0 });
    expect(row.id).toBe(prior.id);
    expect(row.status).toBe("attended");
    expect(row.disposition).toBe("attendance_created");
    expect(row.lastJobId).toBe(jobId);
    expect(row.createdByJobId).toBe(job1);
    expect(row.sourceSnapshotAt?.toISOString()).toBe("2026-02-01T12:00:00.000Z");
    expect(row.previousState).toMatchObject({ status: "registered", disposition: "booking_only" });
    expect(after.bookings).toBe(before.bookings);
    expect(after.attendance - before.attendance).toBe(1);
    const recs = await attendanceAt(main, main.m.alice, "2025-11-05", "18:00");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ id: row.attendanceRecordId, importJobId: jobId, checkInMethod: "import" });
  }, 120_000);

  // 6 ─────────────────────────────────────────────────────────────────────────
  it("an OLDER snapshot never overwrites a status a newer one set: outcome stale, nothing changes", async () => {
    const prior = await bookingAt(main, K.alice(), at("2025-11-05", "18:00"));
    const before = await counts(main.tenantId);
    const { manifest } = await importFile(main, [
      { name: "Alice Adams", email: E("alice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "No show" },
    ], "2026-01-20T12:00:00Z");
    expect(manifest.outcomes).toEqual({ created: 0, updated: 0, unchanged: 0, stale: 1, protected: 0 });
    const row = await bookingAt(main, K.alice(), at("2025-11-05", "18:00"));
    expect(row).toMatchObject({ status: "attended", disposition: "attendance_created", lastJobId: job5, attendanceRecordId: prior.attendanceRecordId });
    expect(row.updatedAt.getTime()).toBe(prior.updatedAt.getTime());
    expect(await counts(main.tenantId)).toEqual(before);
  }, 120_000);

  // 7 ─────────────────────────────────────────────────────────────────────────
  it("one visit per person per instant: two offerings at once make one attendance; a live check-in at the slot is linked, never duplicated", async () => {
    const live = await liveCheckIn(main, "2025-11-17", "18:00", main.m.sam);
    const before = await counts(main.tenantId);
    const { manifest } = await importFile(main, [
      { name: "Ben Brown", email: E("ben"), at: at("2025-11-15", "10:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Ben Brown", email: E("ben"), at: at("2025-11-15", "10:00"), offering: "Open Mat", status: "Attended" },
      { name: "Sam Rice", email: E("rice"), at: at("2025-11-17", "18:00"), offering: "Adults Gi", status: "Attended" },
    ], "2026-02-02T12:00:00Z");
    const after = await counts(main.tenantId);

    // Ben: one record across both offerings; the second booking links to it.
    const ben = await withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: main.tenantId, sourcePersonKey: K.ben(), startsAt: new Date(at("2025-11-15", "10:00")) } }));
    expect(ben).toHaveLength(2);
    const owner = ben.find((b) => b.disposition === "attendance_created")!;
    const linked = ben.find((b) => b.disposition === "attendance_existing")!;
    expect(owner).toBeDefined();
    expect(linked).toBeDefined();
    expect(owner.attendanceOwned).toBe(true);
    expect(linked.attendanceOwned).toBe(false);
    expect(linked.attendanceRecordId).toBe(owner.attendanceRecordId);
    const benRecs = await withRlsBypass((tx) => tx.attendanceRecord.findMany({ where: { tenantId: main.tenantId, memberId: main.m.ben, checkInTime: new Date(at("2025-11-15", "10:00")) } }));
    expect(benRecs).toHaveLength(1);

    // Sam: the live check-in stands alone; the imported booking points at it.
    const sam = await bookingAt(main, K.sam(), at("2025-11-17", "18:00"));
    expect(sam).toMatchObject({ disposition: "attendance_existing", attendanceOwned: false, attendanceRecordId: live.attendanceId, classInstanceId: live.instanceId });
    const samRecs = await attendanceAt(main, main.m.sam, "2025-11-17", "18:00");
    expect(samRecs).toHaveLength(1);
    expect(samRecs[0]).toMatchObject({ id: live.attendanceId, checkInMethod: "admin" });

    expect(after.attendance - before.attendance).toBe(1);
    expect(manifest.attendance).toEqual({ createdByThisImport: 1, linkedToExisting: 2 });
    expect(manifest.outcomes.created).toBe(3);
  }, 120_000);

  // 8 ─────────────────────────────────────────────────────────────────────────
  it("staff removal is protected: a replay marks the booking staff_removed and does not recreate the attendance", async () => {
    const rows: Row[] = [
      { name: "Kit Parker", email: E("pat"), at: at("2025-11-20", "17:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Pat Parker", email: E("pat"), at: at("2025-11-20", "17:00"), offering: "Adults Gi", status: "Attended" },
    ];
    const first = await importFile(main, rows, "2026-02-03T12:00:00Z");
    const kit = await bookingAt(main, K.kit(), at("2025-11-20", "17:00"));
    expect(kit.disposition).toBe("attendance_created");
    await withRlsBypass((tx) => tx.attendanceRecord.delete({ where: { id: kit.attendanceRecordId! } }));
    const before = await counts(main.tenantId);

    const { jobId, manifest } = await importFile(main, rows, "2026-02-04T12:00:00Z");
    expect(manifest.outcomes).toEqual({ created: 0, updated: 0, unchanged: 1, stale: 0, protected: 1 });
    const row = await bookingAt(main, K.kit(), at("2025-11-20", "17:00"));
    expect(row.disposition).toBe("staff_removed");
    // Marking it is bookkeeping, not a change in the source: the replay does
    // not become the row's last change, so rolling the replay back cannot
    // "restore" the removed visit (acceptance review P1-1, 3 Oct 2026).
    expect(row.lastJobId).toBe(first.jobId);
    expect(jobId).not.toBe(first.jobId);
    expect(await attendanceAt(main, main.m.kit, "2025-11-20", "17:00")).toHaveLength(0);
    expect(await attendanceAt(main, main.m.pat, "2025-11-20", "17:00")).toHaveLength(1);
    expect(await counts(main.tenantId)).toEqual(before);

    // And again: still protected, still no record.
    const again = await importFile(main, rows, "2026-02-04T13:00:00Z");
    expect(again.manifest.outcomes.protected).toBe(1);
    expect(await attendanceAt(main, main.m.kit, "2025-11-20", "17:00")).toHaveLength(0);

    // Rolling back either replay never brings the removed visit back.
    await rollback(main, again.jobId);
    await rollback(main, jobId);
    expect(await attendanceAt(main, main.m.kit, "2025-11-20", "17:00")).toHaveLength(0);
    expect((await bookingAt(main, K.kit(), at("2025-11-20", "17:00"))).disposition).toBe("staff_removed");
  }, 180_000);

  // 8b ────────────────────────────────────────────────────────────────────────
  it("a corrected booking that owned a shared visit hands it to the partner booking; rolling the correction back hands it back", async () => {
    const club = await mkClub("heir");
    const t = at("2025-11-21", "18:00");
    const both = (gi: string, mat: string): Row[] => [
      { name: "Alice Adams", email: E("alice"), at: t, offering: "Adults Gi", status: gi },
      { name: "Alice Adams", email: E("alice"), at: t, offering: "Open Mat", status: mat },
    ];
    await importFile(club, both("Attended", "Attended"), "2026-02-01T12:00:00Z");
    const gi1 = await bookingAt(club, K.alice(), t, "Adults Gi");
    const mat1 = await bookingAt(club, K.alice(), t, "Open Mat");
    const owner = gi1.attendanceOwned ? gi1 : mat1;
    const partner = gi1.attendanceOwned ? mat1 : gi1;
    expect(partner.attendanceRecordId).toBe(owner.attendanceRecordId);
    const visitId = owner.attendanceRecordId!;

    // The newer export says the OWNER booking was a no-show.
    const ownerIsGi = owner.offeringLabel === "Adults Gi";
    const correction = await importFile(club, both(ownerIsGi ? "No show" : "Attended", ownerIsGi ? "Attended" : "No show"), "2026-02-02T12:00:00Z");
    const ownerAfter = await bookingAt(club, K.alice(), t, owner.offeringLabel);
    const partnerAfter = await bookingAt(club, K.alice(), t, partner.offeringLabel);
    expect(ownerAfter.status).toBe("no_show");
    expect(ownerAfter.attendanceRecordId).toBeNull();
    expect(partnerAfter.attendanceOwned).toBe(true);
    expect(partnerAfter.attendanceRecordId).toBe(visitId);
    const visits = await withRlsBypass((tx) => tx.attendanceRecord.findMany({ where: { tenantId: club.tenantId, memberId: club.m.alice } }));
    expect(visits.map((v) => v.id)).toEqual([visitId]); // still one visit, never a dangling link

    await rollback(club, correction.jobId);
    const ownerBack = await bookingAt(club, K.alice(), t, owner.offeringLabel);
    const partnerBack = await bookingAt(club, K.alice(), t, partner.offeringLabel);
    expect(ownerBack).toMatchObject({ status: "attended", attendanceOwned: true, attendanceRecordId: visitId });
    expect(partnerBack).toMatchObject({ attendanceOwned: false, attendanceRecordId: visitId });
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: club.tenantId, memberId: club.m.alice } }))).toBe(1);
  }, 180_000);

  // 8c ────────────────────────────────────────────────────────────────────────
  it("rollback restores more than one layer: registered → attended → no-show, rolled back twice, ends registered with no visit", async () => {
    const club = await mkClub("layers");
    const t = at("2025-11-22", "10:00");
    const row = (status: string): Row[] => [{ name: "Alice Adams", email: E("alice"), at: t, offering: "Adults Gi", status }];
    await importFile(club, row("Registered"), "2026-02-01T12:00:00Z");
    const j2 = await importFile(club, row("Attended"), "2026-02-02T12:00:00Z");
    expect(await attendanceAt(club, club.m.alice, "2025-11-22", "10:00")).toHaveLength(1);
    const j3 = await importFile(club, row("No show"), "2026-02-03T12:00:00Z");
    expect(await attendanceAt(club, club.m.alice, "2025-11-22", "10:00")).toHaveLength(0);

    await rollback(club, j3.jobId); // the visit j3 deleted comes back
    expect((await bookingAt(club, K.alice(), t)).status).toBe("attended");
    expect(await attendanceAt(club, club.m.alice, "2025-11-22", "10:00")).toHaveLength(1);

    await rollback(club, j2.jobId); // and j2's change goes too
    const b = await bookingAt(club, K.alice(), t);
    expect(b.status).toBe("registered");
    expect(b.attendanceRecordId).toBeNull();
    expect(await attendanceAt(club, club.m.alice, "2025-11-22", "10:00")).toHaveLength(0);
  }, 240_000);

  // 9 ─────────────────────────────────────────────────────────────────────────
  it("a person decision maps a pending person on replay (outcome updated, attendance gained)", async () => {
    const inputsBefore = await withTenantContext(main.tenantId, (tx) => loadClubInputs(tx, main.tenantId));
    const hashBefore = planHashOf("f", inputsBefore);
    expect(planHashOf("f", await withTenantContext(main.tenantId, (tx) => loadClubInputs(tx, main.tenantId)))).toBe(hashBefore);
    const err = await withTenantContext(main.tenantId, (tx) =>
      saveDecisions(tx, main.tenantId, main.userId, [{ kind: "person", sourceKey: K.uma(), action: "member", targetId: main.m.umaMember }]),
    );
    expect(err).toBeNull();
    const inputsAfter = await withTenantContext(main.tenantId, (tx) => loadClubInputs(tx, main.tenantId));
    expect(planHashOf("f", inputsAfter)).not.toBe(hashBefore);

    const before = await counts(main.tenantId);
    // What the preview promises for this replay (kept for the next case).
    const built = buildPlan(csvOf(FILE1()), inputsAfter, new Date());
    if (built.errors) throw new Error(built.errors.join(" "));
    replay9.forecast = (await withTenantContext(main.tenantId, (tx) => previewSummary(tx, main.tenantId, built, inputsAfter, new Date(S1)))).forecast;
    const { jobId, manifest } = await importFile(main, FILE1(), S1);
    replay9.manifest = manifest;
    replay9.touched = (await withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: main.tenantId, lastJobId: jobId }, select: { sourcePersonKey: true } }))).map((r) => r.sourcePersonKey);
    // Alice's 5 Nov booking (set Attended by a newer export) is stale against S1.
    expect(manifest.outcomes.stale).toBe(1);
    expect(manifest.outcomes.created).toBe(0);
    expect(manifest.outcomes.updated).toBeGreaterThanOrEqual(1);
    const uma = await bookingAt(main, K.uma(), at("2025-11-03", "18:00"));
    expect(uma).toMatchObject({ memberId: main.m.umaMember, matchMethod: "decision", disposition: "attendance_created", attendanceOwned: true, lastJobId: jobId });
    const recs = await attendanceAt(main, main.m.umaMember, "2025-11-03", "18:00");
    expect(recs).toHaveLength(1);
    expect(recs[0].classInstanceId).toBe(liveSlot.instanceId);
    expect((await counts(main.tenantId)).attendance - before.attendance).toBe(1);
  }, 120_000);

  // A replay rewrites only the bookings whose source or resolution changed —
  // here only Uma's — and the commit does what the preview forecast. Booking-
  // only rows (Sam's no-show, Jo's late cancel on 5 Nov) have no source change;
  // the 5 Nov session that a later import created for Alice must not make them
  // "updated" (that moves lastJobId, so rolling back the first import would
  // then keep them as "changed by a later import").
  it("a replay with no source change rewrites no booking-only row: the commit's outcomes match the preview forecast", () => {
    expect(replay9.manifest, "previous case ran").toBeDefined();
    expect(replay9.touched).toEqual([K.uma()]);
    const f = replay9.forecast!;
    expect(replay9.manifest!.outcomes).toEqual({ created: f.new, updated: f.status_update + f.resolution_update, unchanged: f.unchanged, stale: f.stale, protected: 0 });
  });

  it("a 'keep pending' decision holds an externalRef-matching person pending: no attendance", async () => {
    const err = await withTenantContext(main.tenantId, (tx) =>
      saveDecisions(tx, main.tenantId, main.userId, [{ kind: "person", sourceKey: K.penny(), action: "pending" }]),
    );
    expect(err).toBeNull();
    const rows: Row[] = [{ name: "Penny Pending", email: E("penny"), at: at("2025-12-01", "18:00"), offering: "Adults Gi", status: "Attended" }];
    const inputs = await withTenantContext(main.tenantId, (tx) => loadClubInputs(tx, main.tenantId));
    const built = buildPlan(csvOf(rows), inputs, new Date());
    if (built.errors) throw new Error(built.errors.join(" "));
    expect(built.plan.people[0]).toMatchObject({ memberId: null, decidedPending: true });

    await importFile(main, rows, "2026-02-05T12:00:00Z");
    const b = await bookingAt(main, K.penny(), at("2025-12-01", "18:00"));
    expect(b).toMatchObject({ memberId: null, disposition: "pending_person", attendanceRecordId: null });
    const recs = await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: main.tenantId, memberId: main.m.penny } }));
    expect(recs).toBe(0);
  }, 120_000);

  // 10 ────────────────────────────────────────────────────────────────────────
  it("interruption and resume over > 400 bookings: a failed batch rolls back, the job resumes from its checkpoint, and the end state equals a clean run", async () => {
    const clean = clubs.find((c) => c.label === "big-clean")!;
    const resumed = clubs.find((c) => c.label === "big-resume")!;
    const text = bigFile();

    const t0 = Date.now();
    const cleanRun = await importFile(clean, text, S1);
    const cleanMs = Date.now() - t0;
    expect(cleanRun.manifest.input.bookings).toBe(480);
    expect(cleanRun.manifest.reconciles).toBe(true);

    const jobId = await mkJob(resumed, text, S1);
    await startCommit(resumed, jobId);
    inject.batchCalls = 0;
    inject.failOnBatchCall = 2; // the second batch fails inside its transaction
    const t1 = Date.now();
    let failed: Awaited<ReturnType<typeof runStep>> | null = null;
    try {
      for (let i = 0; i < 4 && !failed; i++) {
        const r = await runStep(resumed.tenantId, jobId, readFile);
        if (r.kind === "failed") failed = r;
        else expect(r.kind).toBe("progress");
      }
    } finally {
      inject.failOnBatchCall = 0;
    }
    expect(failed).toMatchObject({ kind: "failed", processed: 400, total: 480 });
    const mid = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId } }));
    expect(mid.status).toBe("failed");
    expect(mid.processedRows).toBe(400);
    expect(mid.leaseToken).toBeNull();
    expect((await counts(resumed.tenantId)).bookings).toBe(400);

    const { manifest, steps } = await stepUntilComplete(resumed, jobId);
    const resumedMs = Date.now() - t1;
    const timing = `[attendance-import-engine] 480 bookings: clean run ${cleanMs} ms in ${cleanRun.steps} step(s); interrupted+resumed ${resumedMs} ms (${steps} step(s) after the failure)`;
    console.log(timing);
    if (process.env.ATT_TIMING_OUT) (await import("node:fs")).writeFileSync(process.env.ATT_TIMING_OUT, timing + "\n");

    const a = await counts(clean.tenantId);
    const b = await counts(resumed.tenantId);
    expect(b).toEqual(a);
    expect(b.bookings).toBe(480);
    expect(manifest.outcomes).toEqual(cleanRun.manifest.outcomes);
    expect(manifest.dispositions).toEqual(cleanRun.manifest.dispositions);
    expect(manifest.reconciles).toBe(true);
    const keys = await withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: resumed.tenantId }, select: { bookingKey: true } }));
    expect(new Set(keys.map((k) => k.bookingKey)).size).toBe(480);
    const done = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId } }));
    expect(done).toMatchObject({ status: "complete", processedRows: 480 });
  }, 600_000);

  // 11 ────────────────────────────────────────────────────────────────────────
  it("two tabs: while one step holds the lease, a second step is refused as busy and writes nothing", async () => {
    const jobId = await mkJob(main, csvOf([{ name: "Alice Adams", email: E("alice"), at: at("2025-12-08", "18:00"), offering: "Adults Gi", status: "Attended" }]), "2026-02-06T12:00:00Z");
    await startCommit(main, jobId);
    const token = await withTenantContext(main.tenantId, (tx) => claimLease(tx, main.tenantId, jobId, ["running", "failed"]));
    expect(token).toBeTruthy();
    expect(await withTenantContext(main.tenantId, (tx) => claimLease(tx, main.tenantId, jobId, ["running", "failed"]))).toBeNull();
    const before = await counts(main.tenantId);

    const r = await runStep(main.tenantId, jobId, readFile);
    expect(r.kind).toBe("busy");
    expect(await counts(main.tenantId)).toEqual(before);
    const job = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId } }));
    expect(job).toMatchObject({ status: "running", processedRows: 0, leaseToken: token });
    expect(await withRlsBypass((tx) => tx.importedBooking.count({ where: { tenantId: main.tenantId, OR: [{ createdByJobId: jobId }, { lastJobId: jobId }] } }))).toBe(0);

    await withTenantContext(main.tenantId, (tx) => releaseLease(tx, main.tenantId, jobId, token!));
    const { manifest } = await stepUntilComplete(main, jobId);
    expect(manifest.outcomes.created).toBe(1);
  }, 120_000);

  // 12 ────────────────────────────────────────────────────────────────────────
  it("rollback of a first import removes exactly its bookings, attendance, sessions and historical class; live sessions and check-ins stay", async () => {
    const club = clubs.find((c) => c.label === "rb-one")!;
    const live = await liveCheckIn(club, "2025-11-03", "18:00", club.m.sam);
    const before = await counts(club.tenantId);
    const { jobId } = await importFile(club, [
      { name: "Alice Adams", email: E("alice"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Sam Rice", email: E("rice"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Pat Parker", email: E("pat"), at: at("2025-11-08", "11:00"), offering: "Open Mat", status: "Attended" },
      { name: "Ben Brown", email: E("ben"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "Registered" },
    ], S1);
    const mid = await counts(club.tenantId);
    expect(mid.bookings).toBe(4);
    expect(mid.attendance - before.attendance).toBe(2);
    expect(mid.classes - before.classes).toBe(1);

    const report = await rollback(club, jobId);
    expect(report).toMatchObject({ bookingsRemoved: 4, bookingsRestored: 0, bookingsKeptLaterImport: 0, attendanceRemoved: 2, sessionsRemoved: 1, classesRemoved: 1, classesKept: 0 });
    expect(await counts(club.tenantId)).toEqual(before);
    const liveAr = await withRlsBypass((tx) => tx.attendanceRecord.findUnique({ where: { id: live.attendanceId } }));
    expect(liveAr).toMatchObject({ checkInMethod: "admin", classInstanceId: live.instanceId });
    expect(await withRlsBypass((tx) => tx.classInstance.findUnique({ where: { id: live.instanceId } }))).not.toBeNull();
    const dec = await withRlsBypass((tx) => tx.importSourceMapping.findFirstOrThrow({ where: { tenantId: club.tenantId, kind: "offering", sourceKey: "Open Mat" } }));
    expect(dec.targetId).toBeNull();
    const job = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId } }));
    expect(job.rolledBackAt).not.toBeNull();
  }, 180_000);

  it("rollback of a later job restores the previous state and removes only its own attendance; rolling back the earlier job keeps bookings a later import changed", async () => {
    const club = clubs.find((c) => c.label === "rb-two")!;
    const A: Row[] = [
      { name: "Alice Adams", email: E("alice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "Registered" },
      { name: "Ben Brown", email: E("ben"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
    ];
    const B: Row[] = [
      { name: "Alice Adams", email: E("alice"), at: at("2025-11-05", "18:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Ben Brown", email: E("ben"), at: at("2025-11-03", "18:00"), offering: "Adults Gi", status: "Attended" },
      { name: "Kit Parker", email: E("pat"), at: at("2025-11-06", "17:00"), offering: "Adults Gi", status: "Attended" },
    ];
    const a = await importFile(club, A, "2026-01-10T12:00:00Z");
    const afterA = await counts(club.tenantId);
    const aliceA = await bookingAt(club, K.alice(), at("2025-11-05", "18:00"));
    const benA = await bookingAt(club, K.ben(), at("2025-11-03", "18:00"));

    const b = await importFile(club, B, "2026-02-01T12:00:00Z");
    expect(b.manifest.outcomes).toEqual({ created: 1, updated: 1, unchanged: 1, stale: 0, protected: 0 });

    const rb = await rollback(club, b.jobId);
    expect(rb).toMatchObject({ bookingsRemoved: 1, bookingsRestored: 1, bookingsKeptLaterImport: 0, attendanceRemoved: 2, sessionsRemoved: 2 });
    const alice = await bookingAt(club, K.alice(), at("2025-11-05", "18:00"));
    expect(alice).toMatchObject({
      id: aliceA.id, status: "registered", disposition: "booking_only", lastJobId: a.jobId, attendanceRecordId: null, attendanceOwned: false, classInstanceId: aliceA.classInstanceId,
    });
    expect(alice.previousState).toBeNull();
    expect(alice.sourceSnapshotAt?.toISOString()).toBe(aliceA.sourceSnapshotAt?.toISOString());
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: club.tenantId, importJobId: b.jobId } }))).toBe(0);
    expect(await withRlsBypass((tx) => tx.attendanceRecord.findUnique({ where: { id: benA.attendanceRecordId! } }))).not.toBeNull();
    expect(await counts(club.tenantId)).toEqual(afterA);

    // The newer export again, then roll back the FIRST job.
    const b2 = await importFile(club, B, "2026-02-02T12:00:00Z");
    expect(b2.manifest.outcomes).toEqual({ created: 1, updated: 1, unchanged: 1, stale: 0, protected: 0 });
    const ra = await rollback(club, a.jobId);
    expect(ra.bookingsKeptLaterImport).toBeGreaterThan(0);
    expect(ra).toMatchObject({ bookingsRemoved: 1, bookingsKeptLaterImport: 1, attendanceRemoved: 1 });
    const kept = await bookingAt(club, K.alice(), at("2025-11-05", "18:00"));
    expect(kept).toMatchObject({ id: aliceA.id, status: "attended", lastJobId: b2.jobId, createdByJobId: a.jobId });
    expect(await withRlsBypass((tx) => tx.attendanceRecord.findUnique({ where: { id: kept.attendanceRecordId! } }))).not.toBeNull();
    expect(await withRlsBypass((tx) => tx.importedBooking.count({ where: { tenantId: club.tenantId, sourcePersonKey: K.ben() } }))).toBe(0);
    expect(await withRlsBypass((tx) => tx.attendanceRecord.findUnique({ where: { id: benA.attendanceRecordId! } }))).toBeNull();
    expect(await withRlsBypass((tx) => tx.importedBooking.count({ where: { tenantId: club.tenantId, createdByJobId: b2.jobId } }))).toBe(1);
  }, 240_000);

  // 13 ────────────────────────────────────────────────────────────────────────
  it("no side effects in any club: no payments, emails, notifications or class-pack rows, and no member row changed", async () => {
    const ids = clubs.map((c) => c.tenantId);
    const side = await withRlsBypass(async (tx) => ({
      payments: await tx.payment.count({ where: { tenantId: { in: ids } } }),
      emails: await tx.emailLog.count({ where: { tenantId: { in: ids } } }),
      notifications: await tx.notification.count({ where: { tenantId: { in: ids } } }),
      packs: await tx.memberClassPack.count({ where: { tenantId: { in: ids } } }),
      redemptions: await tx.classPackRedemption.count({ where: { memberPack: { tenantId: { in: ids } } } }),
    }));
    expect(side).toEqual({ payments: 0, emails: 0, notifications: 0, packs: 0, redemptions: 0 });
    const members = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: { in: ids } }, select: { id: true, status: true, membershipType: true, paymentStatus: true, updatedAt: true } }));
    // Members of clubs a later test created are not in the snapshot; every snapshotted one must be unchanged.
    const snapshotted = members.filter((m) => memberSnapshot.has(m.id));
    expect(snapshotted).toHaveLength(memberSnapshot.size);
    const changed = snapshotted.filter((m) => memberSnapshot.get(m.id) !== snap(m)).map((m) => m.id);
    expect(changed).toEqual([]);
  }, 60_000);

  // 14 ────────────────────────────────────────────────────────────────────────
  it("tenant isolation: another club's inputs and rollback see none of this club's rows", async () => {
    const other = clubs.find((c) => c.label === "big-clean")!;
    const inputs = await withTenantContext(other.tenantId, (tx) => loadClubInputs(tx, other.tenantId));
    const mainMembers = new Set(Object.values(main.m));
    expect(inputs.members.some((m) => mainMembers.has(m.id))).toBe(false);
    expect(inputs.classes.some((c) => c.id === main.classId)).toBe(false);
    expect(inputs.locations.some((l) => l.id === main.locationId)).toBe(false);
    expect(inputs.decisions.person[K.uma()]).toBeUndefined();
    expect(inputs.decisions.offering["Adults Gi"]).toEqual({ action: "class", targetId: other.classId });
    // The application filter alone (RLS bypassed), with the wrong club's id.
    const asOther = await withRlsBypass((tx) => loadClubInputs(tx, other.tenantId));
    expect(asOther.members.some((m) => mainMembers.has(m.id))).toBe(false);

    const before = await counts(main.tenantId);
    const ledgerBefore = await bookingsOf(main.tenantId);
    const report = await withRlsBypass((tx) => rollbackJob(tx, other.tenantId, job1), { timeout: 60_000 });
    expect(Object.values(report).every((n) => n === 0)).toBe(true);
    expect(await counts(main.tenantId)).toEqual(before);
    const ledgerAfter = await bookingsOf(main.tenantId);
    expect(ledgerAfter.map((r) => [r.id, r.lastJobId, r.updatedAt.getTime()]).sort()).toEqual(ledgerBefore.map((r) => [r.id, r.lastJobId, r.updatedAt.getTime()]).sort());
  }, 120_000);
});
