// Imports after a contact-email change (admin hub ledger AH-05, story I4,
// 9 Oct 2026) against a REAL database — the Neon test branch only (the guarded
// runners refuse any other host; tests/setup-test-db.ts refuses production).
//
// A synthetic club is imported through the REAL members-import commit route
// (app/api/admin/import/[id]/commit): externalRef, ImportedMembership ledger
// rows, a kid on a parent's address, a second adult on a shared address and a
// guardian draft all come from the importer itself. Then member addresses are
// corrected through the REAL owner PATCH (app/api/members/[id]) — the operator
// contact-email route arrives later; the invariant is the same: externalRef is
// the person's source identity and nothing rewrites it. Then:
//   - a TeamUp status refresh with the ORIGINAL rows (real commit route,
//     mode "refresh") resolves to the same member ids and never touches the
//     corrected address;
//   - an attendance import (lib/attendance-import, driven as its route drives
//     it) resolves the original row by external_ref and pins every fallback;
//   - refresh and PATCH racing on the same rows, both interleavings forced
//     deterministically (each side holding the row lock while the other
//     waits), end in one consistent state.
// Only the file store, the owner gate, CSRF, audit, mail and the rate limiter
// are stubbed. Every scenario asserts database rows. afterAll removes the
// throwaway clubs and checks nothing is left.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string } }));
vi.mock("@/lib/api-authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-authz")>()),
  requireApiOwner: vi.fn(async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } };
  }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));
// Interleaving hooks. recordStatusEventsBulk runs INSIDE the refresh's write
// transaction, after its member.updateMany (the refresh holds the row locks);
// retireEmailBoundTokens runs INSIDE the PATCH transaction, after its
// member.updateMany (the PATCH holds the row lock). An armed hook runs once.
const hooks = vi.hoisted(() => ({ insideRefresh: null as null | (() => Promise<void>), insidePatch: null as null | (() => Promise<void>) }));
vi.mock("@/lib/member-status", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/member-status")>();
  return {
    ...mod,
    recordStatusEventsBulk: vi.fn(async (...args: Parameters<typeof mod.recordStatusEventsBulk>) => {
      const h = hooks.insideRefresh; hooks.insideRefresh = null;
      if (h) await h();
      return mod.recordStatusEventsBulk(...args);
    }),
  };
});
vi.mock("@/lib/login-email", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/login-email")>();
  return {
    ...mod,
    retireEmailBoundTokens: vi.fn(async (...args: Parameters<typeof mod.retireEmailBoundTokens>) => {
      const h = hooks.insidePatch; hooks.insidePatch = null;
      if (h) await h();
      return mod.retireEmailBoundTokens(...args);
    }),
  };
});

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { teamupPersonKey } from "@/lib/importers/teamup";
import { ensureTodayInstances } from "@/lib/today-sessions";
import { dayMarkerFor } from "@/lib/importers/attendance";
import {
  buildPlan,
  claimLease,
  createHistoricalClasses,
  emptyProgress,
  JOB_SOURCE,
  LEDGER_SOURCE,
  loadClubInputs,
  MAPPING_VERSION,
  releaseLease,
  runStep,
  saveDecisions,
  type JobMappings,
} from "@/lib/attendance-import";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `cei${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Deterministic digest of rows: sorted by id, every column (Dates as ISO). */
const digest = (rows: { id: string }[]) => sha(JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : 1))));

// ── The TeamUp memberships export ────────────────────────────────────────────
const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
type P = { name: string; email: string; plan: string; dob: string; ec?: [string, string] };
const tRow = (p: P, status: string) =>
  [p.name, p.email, "", p.plan, "recurring", status, "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", p.dob, p.ec?.[0] ?? "", p.ec ? "07000000000" : "", p.ec?.[1] ?? ""].join(",");
const ADULT = "Adults Unlimited";
const KIDS = "Kids Unlimited";
const PEOPLE = {
  alex: { name: "Alex Moss", email: E("alex"), plan: ADULT, dob: "1990-04-15" },
  kit: { name: "Kit Moss", email: E("alex"), plan: KIDS, dob: "2017-03-03" },
  sam: { name: "Sam Rice", email: E("rice"), plan: ADULT, dob: "1992-11-10" },
  jo: { name: "Jo Rice", email: E("rice"), plan: ADULT, dob: "1994-02-02" },
  tia: { name: "Tia Vale", email: E("vale"), plan: KIDS, dob: "2016-06-06", ec: ["Robin Vale", "Mother"] as [string, string] },
  casey: { name: "Casey Hart", email: E("casey"), plan: ADULT, dob: "1991-01-01" },
  drew: { name: "Drew Fenn", email: E("drew"), plan: ADULT, dob: "1991-02-02" },
  eli: { name: "Eli Gray", email: E("eli"), plan: ADULT, dob: "1991-03-03" },
  fay: { name: "Fay Ord", email: E("fay"), plan: ADULT, dob: "1991-04-04" },
} satisfies Record<string, P>;
type Who = keyof typeof PEOPLE;
const exportOf = (status: Partial<Record<Who, string>> = {}) =>
  [T_HEADER, ...(Object.keys(PEOPLE) as Who[]).map((k) => tRow(PEOPLE[k], status[k] ?? "active"))].join("\n");

// ── Driving the real routes ──────────────────────────────────────────────────
type Club = { tenantId: string; userId: string };
const clubs: Club[] = [];

async function mkClub(label: string): Promise<Club & { locationId: string; classId: string }> {
  const c = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "Owner", role: "owner", passwordHash: "x" } });
    await tx.membershipTier.create({ data: { tenantId: t.id, name: ADULT, pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } });
    await tx.membershipTier.create({ data: { tenantId: t.id, name: KIDS, pricePence: 6600, currency: "GBP", billingCycle: "monthly", isKids: true, isActive: true } });
    const loc = await tx.location.create({ data: { tenantId: t.id, name: "Main", isDefault: true } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: "Adults Gi", duration: 60, isActive: true } });
    return { tenantId: t.id, userId: u.id, locationId: loc.id, classId: cls.id };
  });
  clubs.push(c);
  return c;
}

let fileSeq = 0;
async function runImport(club: Club, csv: string, mode: "create" | "refresh", exportedAt: string) {
  const url = `https://blob.test.local/${STAMP}/${++fileSeq}.csv`;
  FILES.set(url, csv);
  const job = await withRlsBypass((tx) => tx.importJob.create({
    data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode, fileName: `teamup-${fileSeq}.csv`, fileBlobUrl: url, status: "preview", sourceExportedAt: new Date(exportedAt), sourceExportedAtProvenance: "owner_stated" },
  }));
  gate.current = club;
  const req = new Request(`https://test.local/api/admin/import/${job.id}/commit`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" });
  const res = await commit(req, { params: Promise.resolve({ id: job.id }) });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  const row = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, manifest: true } }));
  expect(row.status).toBe("complete");
  return { jobId: job.id, manifest: row.manifest as { refresh?: { changes?: { memberId: string; after: Record<string, unknown> }[] } } };
}

async function patchEmail(club: Club, memberId: string, email: string) {
  mockAuth.mockResolvedValue({ user: { id: club.userId, tenantId: club.tenantId, role: "owner" } } as never);
  const req = new Request(`https://test.local/api/members/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify({ email }),
  });
  const res = await patchMember(req, { params: Promise.resolve({ id: memberId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── Attendance import, driven as app/api/admin/import/attendance drives it ───
const A_HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp";
const aRow = (name: string, email: string, at: string) => [name, email, at, "Adults Gi", "Main", "Coach A", "Online", "", "", "Unlimited", "App", "Attended", ""].join(",");
const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+00:00`;

async function importAttendance(club: Club, text: string) {
  const url = `test://${STAMP}/${++fileSeq}`;
  FILES.set(url, text);
  const t = club.tenantId;
  const job = await withRlsBypass((tx) => tx.importJob.create({
    data: { tenantId: t, createdById: club.userId, source: JOB_SOURCE, fileName: `attendance-${fileSeq}.csv`, fileBlobUrl: url, status: "preview", fileHash: sha(text), sourceExportedAt: new Date("2026-10-01T08:00:00Z"), sourceExportedAtProvenance: "owner_stated", mappingVersion: MAPPING_VERSION },
    select: { id: true },
  }));
  const inputs = await withTenantContext(t, (tx) => loadClubInputs(tx, t));
  const now = new Date();
  const built = buildPlan(text, inputs, now);
  if (built.errors) throw new Error(built.errors.join(" "));
  const started = await withTenantContext(t, async (tx) => {
    const token = await claimLease(tx, t, job.id, ["preview"]);
    if (!token) return false;
    const mappings: JobMappings = { createdClasses: {}, snapshotAt: "2026-10-01T08:00:00.000Z" };
    await createHistoricalClasses(tx, t, job.id, built.plan, inputs, mappings.createdClasses);
    await ensureTodayInstances(tx, t, inputs.timezone);
    await releaseLease(tx, t, job.id, token, {
      status: "running", startedAt: now, processedRows: 0, importedRows: 0, skippedRows: 0, errorRows: 0,
      totalRows: built.plan.bookings.length, mappings: mappings as never,
      manifest: { kind: "attendance", inProgress: true, progress: emptyProgress() } as never,
    });
    return true;
  }, { timeout: 60_000 });
  expect(started).toBe(true);
  for (let i = 0; i < 8; i++) {
    const r = await runStep(t, job.id, async (u) => FILES.get(u) ?? null);
    if (r.kind === "complete") return { jobId: job.id, plan: built.plan };
    if (r.kind !== "progress") throw new Error(`attendance step returned ${r.kind}`);
  }
  throw new Error("attendance import did not complete");
}

// ── Reading rows ─────────────────────────────────────────────────────────────
const memberRow = (id: string) => withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id } }));
const ledgerOf = (tenantId: string, memberId: string) =>
  withRlsBypass((tx) => tx.importedMembership.findMany({ where: { tenantId, memberId } }));
/** Backends of this database currently blocked on a row lock in an UPDATE of Member — proof the race really interleaved. */
async function blockedMemberUpdates(): Promise<number> {
  const rows = await withRlsBypass((tx) => tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%update%"Member"%'`);
  return Number(rows[0]?.n ?? 0);
}
const STANDING = ["status", "paymentStatus", "cancelledAt", "membershipType", "membershipTierId", "billingStatusAsOf", "billingStatusSource"] as const;
function expectStandingIs(m: Record<string, unknown>, after: Record<string, unknown>) {
  for (const k of STANDING) {
    const have = m[k] instanceof Date ? (m[k] as Date).toISOString() : (m[k] ?? null);
    expect(have, k).toEqual(after[k] ?? null);
  }
}

describe.skipIf(!HAS_DB)("contact-email change → imports keep the person (AH-05)", () => {
  let A: Awaited<ReturnType<typeof mkClub>>;
  let B: Awaited<ReturnType<typeof mkClub>>;
  const id: Record<string, string> = {};
  const before: Record<string, { ref: Buffer; ledger: string; ledgerIds: string[] }> = {};
  let liveAttendanceId = "";
  let joDigest = "", guardianDigest = "", kidDigest = "", clubBDigest = "";

  beforeAll(async () => {
    A = await mkClub("a");
    B = await mkClub("b");
    await runImport(A, exportOf(), "create", "2026-09-01T08:00:00Z");
    const members = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: A.tenantId } }));
    for (const k of Object.keys(PEOPLE) as Who[]) {
      const m = members.find((x) => x.name === PEOPLE[k].name);
      if (!m) throw new Error(`import did not create ${k}`);
      id[k] = m.id;
    }
    const guardian = members.find((m) => m.externalRef === `teamup-payer:${E("vale")}`);
    if (!guardian) throw new Error("import did not create the guardian draft");
    id.guardian = guardian.id;
    // Hand-added members (no externalRef) for the fallback cases.
    await withRlsBypass(async (tx) => {
      id.bea = (await tx.member.create({ data: { tenantId: A.tenantId, name: "Bea Lane", email: E("bea-old") } })).id;
      id.dee = (await tx.member.create({ data: { tenantId: A.tenantId, name: "Dee Holt", email: E("dee-old") } })).id;
      // The owner confirms Kit's suggested guardian link on the Family card.
      await tx.member.update({ where: { id: id.kit }, data: { guardianConfirmedAt: new Date("2026-09-02T10:00:00Z") } });
      // A live check-in for Alex before any change.
      const ci = await tx.classInstance.create({ data: { classId: A.classId, date: dayMarkerFor("2025-10-01"), startTime: "18:00", endTime: "19:00" } });
      liveAttendanceId = (await tx.attendanceRecord.create({ data: { tenantId: A.tenantId, memberId: id.alex, classInstanceId: ci.id, checkInTime: new Date("2025-10-01T18:00:05Z"), checkInMethod: "admin" } })).id;
      // Club B: a member carrying a byte-identical externalRef (unique is per club).
      id.clubB = (await tx.member.create({ data: { tenantId: B.tenantId, name: "Alex Moss", email: E("alex"), externalRef: teamupPersonKey("Alex Moss", E("alex")) } })).id;
    }, { timeout: 30_000 });
    // A saved decision made BEFORE the change: an alias row → Alex.
    const err = await withTenantContext(A.tenantId, (tx) => saveDecisions(tx, A.tenantId, A.userId, [
      { kind: "offering", sourceKey: "Adults Gi", action: "class", targetId: A.classId },
      { kind: "venue", sourceKey: "Main", action: "location", targetId: A.locationId },
      { kind: "person", sourceKey: teamupPersonKey("A. Moss", E("alias")), action: "member", targetId: id.alex },
    ]));
    if (err) throw new Error(`decisions refused: ${err}`);

    for (const k of ["alex", "kit", "sam", "casey", "drew", "eli", "fay"] as const) {
      const m = await memberRow(id[k]);
      const ledger = await ledgerOf(A.tenantId, id[k]);
      before[k] = { ref: Buffer.from(m.externalRef ?? "", "utf8"), ledger: digest(ledger), ledgerIds: ledger.map((r) => r.id).sort() };
    }
    joDigest = digest([await memberRow(id.jo)]);
    guardianDigest = digest([await memberRow(id.guardian)]);
    clubBDigest = digest([await memberRow(id.clubB)]);
  }, 180_000);

  afterAll(async () => {
    const ids = clubs.map((c) => c.tenantId);
    for (const tenantId of ids) {
      await withRlsBypass(async (tx) => {
        await tx.importedBooking.deleteMany({ where: { tenantId } });
        await tx.attendanceRecord.deleteMany({ where: { tenantId } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
        await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
        await tx.importSourceMapping.deleteMany({ where: { tenantId } });
        await tx.class.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId } });
        await tx.importedMembership.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.importJob.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
        await tx.location.deleteMany({ where: { tenantId } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 60_000 });
    }
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: ids } } }),
      members: await tx.member.count({ where: { tenantId: { in: ids } } }),
      jobs: await tx.importJob.count({ where: { tenantId: { in: ids } } }),
    }));
    expect(left).toEqual({ tenants: 0, members: 0, jobs: 0 });
  }, 120_000);

  it("fixture: the real import stored the TeamUp key, ledger rows, the kid link, the shared address and the guardian draft", async () => {
    const alex = await memberRow(id.alex);
    expect(alex.externalRef).toBe(teamupPersonKey("Alex Moss", E("alex")));
    expect(alex.email).toBe(E("alex"));
    expect(before.alex.ledgerIds.length).toBeGreaterThan(0);
    const kit = await memberRow(id.kit);
    expect(kit.parentMemberId).toBe(id.alex);
    expect(kit.externalRef).toBe(teamupPersonKey("Kit Moss", E("alex")));
    kidDigest = digest([kit]);
    const jo = await memberRow(id.jo);
    expect(jo.unverifiedEmail).toBe(E("rice"));
    expect(jo.email).not.toBe(E("rice"));
    const g = await memberRow(id.guardian);
    expect(g.unverifiedEmail).toBe(E("vale"));
  });

  it("the owner corrects addresses: externalRef byte-identical, id, ledger rows, attendance, guardian link and shared-address rows untouched", async () => {
    for (const [k, to] of [["alex", E("alex-new")], ["sam", E("sam-new")], ["bea", E("bea-new")], ["dee", E("dee-new")]] as const) {
      const r = await patchEmail(A, id[k], to);
      expect(r.status, `${k}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.id).toBe(id[k]);
    }
    const alex = await memberRow(id.alex);
    expect(alex.email).toBe(E("alex-new"));
    expect(Buffer.compare(Buffer.from(alex.externalRef ?? "", "utf8"), before.alex.ref)).toBe(0);
    const sam = await memberRow(id.sam);
    expect(Buffer.compare(Buffer.from(sam.externalRef ?? "", "utf8"), before.sam.ref)).toBe(0);
    for (const k of ["alex", "sam"] as const) {
      const ledger = await ledgerOf(A.tenantId, id[k]);
      expect(ledger.map((r) => r.id).sort()).toEqual(before[k].ledgerIds);
      expect(digest(ledger)).toBe(before[k].ledger);
    }
    const live = await withRlsBypass((tx) => tx.attendanceRecord.findUniqueOrThrow({ where: { id: liveAttendanceId } }));
    expect(live.memberId).toBe(id.alex);
    // Kit (parent link + confirmation), Jo (shared address kept as
    // unverifiedEmail), the guardian draft and club B: every column unchanged.
    expect(digest([await memberRow(id.kit)])).toBe(kidDigest);
    expect(digest([await memberRow(id.jo)])).toBe(joDigest);
    expect(digest([await memberRow(id.guardian)])).toBe(guardianDigest);
    expect(digest([await memberRow(id.clubB)])).toBe(clubBDigest);
    // Address reuse: Bea's released address is free for another member now.
    const cat = await withRlsBypass((tx) => tx.member.create({ data: { tenantId: A.tenantId, name: "Cat Reed", email: E("bea-old") } }));
    id.cat = cat.id;
  });

  it("two members of one club cannot share an address (unique(tenantId,email) after the lowercase trigger) — the fallback can never see two exact holders", async () => {
    const dup = withRlsBypass((tx) => tx.member.create({ data: { tenantId: A.tenantId, name: "Alex Moss", email: E("alex-new").toUpperCase() } }));
    await expect(dup).rejects.toMatchObject({ code: "P2002" });
  });

  it("a TeamUp refresh with the ORIGINAL rows resolves to the same member ids and does NOT overwrite the corrected address", async () => {
    const { jobId, manifest } = await runImport(A, exportOf({ alex: "hold" }), "refresh", "2026-09-20T08:00:00Z");
    const changes = manifest.refresh?.changes ?? [];
    const alexChange = changes.find((c) => c.memberId === id.alex);
    expect(alexChange, "Alex matched by externalRef").toBeDefined();
    expect(changes.find((c) => c.memberId === id.sam), "Sam matched by externalRef").toBeDefined();
    const alex = await memberRow(id.alex);
    expect(alex.email).toBe(E("alex-new"));
    expect(Buffer.compare(Buffer.from(alex.externalRef ?? "", "utf8"), before.alex.ref)).toBe(0);
    expect(alex.billingStatusSource).toBe(jobId);
    expectStandingIs(alex as unknown as Record<string, unknown>, alexChange!.after);
    expect((await memberRow(id.sam)).email).toBe(E("sam-new"));
    // Payer records are never refreshed; the shared-address adult keeps every column but standing.
    expect(digest([await memberRow(id.guardian)])).toBe(guardianDigest);
    const jo = await memberRow(id.jo);
    expect(jo.unverifiedEmail).toBe(E("rice"));
    expect(digest(await ledgerOf(A.tenantId, id.alex))).toBe(before.alex.ledger);
    expect(digest([await memberRow(id.clubB)])).toBe(clubBDigest);
  });

  it("an attendance import resolves the original row by external_ref and pins every fallback", async () => {
    // Dee: the owner keeps her corrected-address row pending.
    const err = await withTenantContext(A.tenantId, (tx) => saveDecisions(tx, A.tenantId, A.userId, [
      { kind: "person", sourceKey: teamupPersonKey("Dee Holt", E("dee-new")), action: "pending" },
    ]));
    expect(err).toBeNull();
    const text = [
      A_HEADER,
      aRow("Alex Moss", E("alex"), at("2025-11-03", "18:00")), // original row
      aRow("Alex Moss", E("alex-new"), at("2025-11-04", "18:00")), // corrected address, no ref
      aRow("Bea Lane", E("bea-old"), at("2025-11-03", "18:00")), // no ref, OLD address (now Cat's)
      aRow("Bea Lane", E("bea-new"), at("2025-11-04", "18:00")), // no ref, NEW address
      aRow("A. Moss", E("alias"), at("2025-11-05", "18:00")), // saved decision
      aRow("Dee Holt", E("dee-new"), at("2025-11-05", "18:00")), // keep pending
      aRow("Kit Moss", E("alex"), at("2025-11-06", "17:00")), // kid key on the parent's ORIGINAL address
    ].join("\n");
    await importAttendance(A, text);
    const bookings = await withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: A.tenantId, source: LEDGER_SOURCE } }));
    const by = (name: string, email: string) => {
      const b = bookings.filter((x) => x.sourceName === name && x.sourceEmail === email);
      expect(b, `${name} <${email}>`).toHaveLength(1);
      return b[0];
    };
    expect(by("Alex Moss", E("alex"))).toMatchObject({ memberId: id.alex, matchMethod: "external_ref", disposition: "attendance_created", sourcePersonKey: teamupPersonKey("Alex Moss", E("alex")) });
    // SF-54 (inverted rule): Alex's record was created after these bookings, so the corrected address alone does not bind.
    expect(by("Alex Moss", E("alex-new"))).toMatchObject({ memberId: null, disposition: "pending_person" });
    expect(by("Bea Lane", E("bea-old"))).toMatchObject({ memberId: null, disposition: "pending_person" });
    expect(by("Bea Lane", E("bea-new"))).toMatchObject({ memberId: null, disposition: "pending_person" });
    expect(by("A. Moss", E("alias"))).toMatchObject({ memberId: id.alex, matchMethod: "decision" });
    expect(by("Dee Holt", E("dee-new"))).toMatchObject({ memberId: null, disposition: "pending_person" });
    expect(by("Kit Moss", E("alex"))).toMatchObject({ memberId: id.kit, matchMethod: "external_ref" });
    // Cat (who now holds Bea's old address) gained nothing; club B's identical key gained nothing.
    const stray = await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId: { in: [id.cat, id.clubB] } } }));
    expect(stray).toBe(0);
    // History preserved: the live check-in is still Alex's, alongside the imported ones.
    const alexAttendance = await withRlsBypass((tx) => tx.attendanceRecord.findMany({ where: { tenantId: A.tenantId, memberId: id.alex }, select: { id: true } }));
    expect(alexAttendance.map((r) => r.id)).toContain(liveAttendanceId);
    expect(alexAttendance.length).toBe(3); // live + original row + alias decision (the corrected-address row is pending, SF-54)
    const alex = await memberRow(id.alex);
    expect(alex.email).toBe(E("alex-new"));
    expect(Buffer.compare(Buffer.from(alex.externalRef ?? "", "utf8"), before.alex.ref)).toBe(0);
  });

  it("refresh holds the row locks while three PATCHes wait: one consistent outcome, no address reverted, no standing half-written", async () => {
    const pending: Promise<{ status: number }>[] = [];
    let settledWhileLocked = 0;
    let blocked = -1;
    hooks.insideRefresh = async () => {
      for (const [k, to] of [["casey", E("casey-new")], ["drew", E("drew-new")], ["eli", E("eli-new")]] as const) {
        pending.push(patchEmail(A, id[k], to).finally(() => { if (blocked === -1) settledWhileLocked += 1; }));
      }
      // The PATCHes reach member.updateMany and block on the refresh's row locks.
      for (let i = 0; i < 20 && (await blockedMemberUpdates()) < 3; i++) await sleep(250);
      blocked = await blockedMemberUpdates();
    };
    const { jobId, manifest } = await runImport(A, exportOf({ alex: "hold", casey: "hold", drew: "hold", eli: "hold" }), "refresh", "2026-09-25T08:00:00Z");
    const results = await Promise.all(pending);
    expect(blocked, "three PATCHes were waiting on the refresh's row locks").toBeGreaterThanOrEqual(3);
    expect(settledWhileLocked, "no PATCH finished while the refresh held the rows").toBe(0);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const changes = manifest.refresh?.changes ?? [];
    for (const k of ["casey", "drew", "eli"] as const) {
      const m = await memberRow(id[k]);
      expect(m.email, k).toBe(E(`${k}-new`));
      expect(Buffer.compare(Buffer.from(m.externalRef ?? "", "utf8"), before[k].ref), k).toBe(0);
      expect(m.billingStatusSource, k).toBe(jobId);
      const c = changes.filter((x) => x.memberId === id[k]);
      expect(c, `${k} recorded once`).toHaveLength(1);
      expectStandingIs(m as unknown as Record<string, unknown>, c[0].after);
      expect(digest(await ledgerOf(A.tenantId, id[k]))).toBe(before[k].ledger);
    }
  }, 60_000);

  it("a PATCH holds the row lock while the refresh waits: the refresh lands after it and the corrected address stands", async () => {
    let refresh: Promise<Awaited<ReturnType<typeof runImport>>> | null = null;
    let refreshSettled = false;
    let blocked = -1;
    hooks.insidePatch = async () => {
      refresh = runImport(A, exportOf({ alex: "hold", casey: "hold", drew: "hold", eli: "hold", fay: "hold" }), "refresh", "2026-09-28T08:00:00Z");
      void refresh.finally(() => { refreshSettled = true; }).catch(() => {});
      // The refresh reaches member.updateMany for Fay and blocks on this transaction's row lock.
      for (let i = 0; i < 40 && (await blockedMemberUpdates()) < 1; i++) await sleep(250);
      blocked = await blockedMemberUpdates();
      expect(refreshSettled, "the refresh could not finish while the PATCH held Fay's row").toBe(false);
    };
    const r = await patchEmail(A, id.fay, E("fay-new"));
    expect(r.status).toBe(200);
    expect(blocked, "the refresh was waiting on the PATCH's row lock").toBeGreaterThanOrEqual(1);
    expect(refresh).not.toBeNull();
    const { jobId, manifest } = await refresh!;
    const fay = await memberRow(id.fay);
    expect(fay.email).toBe(E("fay-new"));
    expect(Buffer.compare(Buffer.from(fay.externalRef ?? "", "utf8"), before.fay.ref)).toBe(0);
    expect(fay.billingStatusSource).toBe(jobId);
    const c = (manifest.refresh?.changes ?? []).filter((x) => x.memberId === id.fay);
    expect(c).toHaveLength(1);
    expectStandingIs(fay as unknown as Record<string, unknown>, c[0].after);
    expect(c[0].after.paymentStatus).not.toBe("paid"); // the hold really was applied
  }, 60_000);
});
