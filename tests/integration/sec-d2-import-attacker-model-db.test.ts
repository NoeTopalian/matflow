// Security lane D2 (iteration 2, 9 Oct 2026) — the attendance import under an explicit attacker model.
//
// Question: with each attacker prerequisite, which writes make a LATER attendance import attach one person's
// history to another member, and which does the system refuse? Attacker model: docs/security/evidence/D2/
// 01-attacker-model.md. Prerequisites:
//   (a) the runtime database password — under the restricted runner this file connects as matflow_app, and every
//       "attacker" write goes through withRlsBypass, i.e. the SF-62 bypass any holder of that password can set;
//   (b) a staff/owner session in one club — only the REAL routes (member PATCH/DELETE, the import decide route,
//       the members import commit);
//   (c) full app-environment compromise — (a) plus the signing key (AUTH_SECRET), so keyed digests can be forged.
//
// Every scenario ends in the REAL attendance route (preview job → commit → steps) and asserts what the COMMIT wrote
// (ImportedBooking.memberId, AttendanceRecord). Source keys (externalRef / TeamUp person keys) are never altered to
// make a cell pass. Cells the system cannot refuse today are marked OPEN and run as `it.fails` (the secure
// assertion fails, so the cell is reported as an expected failure); SEC_D2_STRICT=1 runs them as ordinary tests to
// show them red. A fix that closes one turns its `it.fails` red — the tripwire to move it.
//
// Runs ONLY through the guarded runners (att/run-engine.sh = owner role; q78/run-restricted.sh = matflow_app with
// RLS); both refuse any host but the TEST branch. Fixture prefix secd2- (slugs, addresses) / secD2 (names);
// count-checked teardown of this file's clubs only.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
// The audit log is REAL: address changes and releases must write the rows the importer reads.
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string } }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => (gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } : null)),
  signIn: vi.fn(), signOut: vi.fn(), handlers: {},
}));
vi.mock("@/lib/api-authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-authz")>()),
  requireApiOwner: vi.fn(async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } };
  }),
  requireApiOwnerOrManager: vi.fn(async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } };
  }),
}));
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { teamupPersonKey } from "@/lib/importers/teamup";
import { JOB_SOURCE, LEDGER_SOURCE, MAPPING_VERSION, buildPlan, loadClubInputs, planHashOf, saveDecisions } from "@/lib/attendance-import";
import { POST } from "@/app/api/admin/import/attendance/route";
import { PATCH as patchMember, DELETE as deleteMember } from "@/app/api/members/[id]/route";
import { POST as membersCommit } from "@/app/api/admin/import/[id]/commit/route";
import { hashToken } from "@/lib/token-hash";

const HAS_DB = !!process.env.DATABASE_URL;
const STRICT = process.env.SEC_D2_STRICT === "1";
/** OPEN cells: the secure assertion currently fails. Reported as expected failures unless SEC_D2_STRICT=1. */
const openIt = STRICT ? it : it.fails;
const STAMP = `secd2-${Date.now().toString(36)}`;
const N = (who: string) => `secD2 ${who}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const VENUE = "secD2 Main";
const OFFERING = "secD2 Adults Gi";
const HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status";
const BOOKING_AT = "2025-11-03T18:00:00+00:00";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = { name: string; email: string; at?: string };
const csvOf = (rows: Row[]) =>
  [HEADER, ...rows.map((r) => [r.name, r.email, r.at ?? BOOKING_AT, OFFERING, VENUE, "Attended"].join(","))].join("\n");
/** The provenance digest the importer checks (lib/attendance-import sourceKeyDigest) — computing it needs AUTH_SECRET. */
const provenanceDigest = (kind: string, key: string) => hashToken(`import-source-key:v1:${kind}\u0001${key}`);

type Club = { tenantId: string; userId: string; classId: string; locationId: string };
const clubs: Club[] = [];
let seq = 0;

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "secD2 Owner", role: "owner", passwordHash: "x" } });
    const loc = await tx.location.create({ data: { tenantId: t.id, name: VENUE, isDefault: true } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: OFFERING, duration: 60, isActive: true } });
    return { tenantId: t.id, userId: u.id, classId: cls.id, locationId: loc.id };
  });
  clubs.push(club);
  const err = await withTenantContext(club.tenantId, (tx) =>
    saveDecisions(tx, club.tenantId, club.userId, [
      { kind: "offering", sourceKey: OFFERING, action: "class", targetId: club.classId },
      { kind: "venue", sourceKey: VENUE, action: "location", targetId: club.locationId },
    ]),
  );
  if (err) throw new Error(`fixture decisions refused: ${err}`);
  return club;
}

/** A cuid v1 whose embedded creation time is `at` (the importer reads Member creation time from the id). */
const idCreatedAt = (at: string) =>
  `c${new Date(at).getTime().toString(36).padStart(8, "0")}${Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;
const OLD = "2025-01-15T10:00:00Z";
/** A member that has existed since before the bookings (fixture write, not an attacker step). */
const mkOldMember = (club: Club, name: string, email: string, externalRef: string | null = null) =>
  withRlsBypass((tx) => tx.member.create({ data: { id: idCreatedAt(OLD), tenantId: club.tenantId, name, email, externalRef }, select: { id: true } })).then((r) => r.id);

async function mkPreview(club: Club, text: string) {
  const url = `test://${STAMP}/${++seq}`;
  FILES.set(url, text);
  const inputs = await withTenantContext(club.tenantId, (tx) => loadClubInputs(tx, club.tenantId));
  const fileHash = sha(text);
  const planHash = planHashOf(fileHash, inputs);
  const built = buildPlan(text, inputs, new Date());
  if (built.errors) throw new Error(built.errors.join(" "));
  const job = await withRlsBypass((tx) =>
    tx.importJob.create({
      data: {
        tenantId: club.tenantId, createdById: club.userId, source: JOB_SOURCE, fileName: `secd2-${seq}.csv`, fileBlobUrl: url,
        status: "preview", fileHash, sourceExportedAt: new Date("2026-10-08T12:00:00Z"), sourceExportedAtProvenance: "owner_stated",
        mappingVersion: MAPPING_VERSION, totalRows: built.parsed.rows.length, dryRunSummary: { planHash } as never,
      },
      select: { id: true },
    }),
  );
  return { jobId: job.id, planHash, plan: built.plan };
}

const routeReq = (body: unknown) =>
  new Request("http://localhost/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(club: Club, body: unknown) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const res = (await POST(routeReq(body))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

/** Preview, commit and run every step through the REAL route; the file is the victim's one booking. */
async function importVictim(club: Club, name: string, email: string) {
  const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name, email }]));
  const c = await call(club, { action: "commit", jobId, planHash });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  for (let i = 0; i < 6; i++) {
    const s = await call(club, { action: "step", jobId });
    expect([200, 202], JSON.stringify(s.body)).toContain(s.status);
    if (s.body.done) return plan;
  }
  throw new Error("import did not complete");
}

async function ownerPatch(club: Club, memberId: string, body: Record<string, unknown>) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const r = new Request(`https://test.local/api/members/${memberId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body),
  });
  const res = (await patchMember(r, { params: Promise.resolve({ id: memberId }) })) as unknown as { status: number; json: () => Promise<unknown> };
  expect(res.status, JSON.stringify(await res.json())).toBe(200);
}

async function ownerDelete(club: Club, memberId: string) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const r = new Request(`https://test.local/api/members/${memberId}?confirm=1`, { method: "DELETE", headers: { origin: "https://test.local", host: "test.local" } });
  const res = (await deleteMember(r, { params: Promise.resolve({ id: memberId }) })) as unknown as { status: number; json: () => Promise<unknown> };
  expect(res.status, JSON.stringify(await res.json())).toBe(200);
}

const ledger = (club: Club) =>
  withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: club.tenantId, source: LEDGER_SOURCE }, select: { memberId: true, matchMethod: true, disposition: true } }));
const attendanceOf = (club: Club, memberId: string) => withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: club.tenantId, memberId } }));

/** The victim's history must not reach `wrong`; the booking stays pending. */
async function expectNotBound(club: Club, wrong: string, why: string) {
  expect(await attendanceOf(club, wrong), why).toBe(0);
  const rows = await ledger(club);
  expect(rows).toHaveLength(1);
  expect(rows[0].memberId, why).toBeNull();
  expect(rows[0].disposition).toBe("pending_person");
}

/**
 * The address-takeover family. The VICTIM (an old member) held VIC's address since before the bookings; the file is
 * the victim's history. `attack` removes the victim and makes the attacker's old record look like the holder; the
 * cell then imports the file and asserts the attacker received nothing.
 */
const VIC = "Vic Lane";

afterAll(async () => {
  if (!HAS_DB) return;
  const ids = clubs.map((c) => c.tenantId);
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      await tx.importedBooking.deleteMany({ where: { tenantId } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.importSourceMapping.deleteMany({ where: { tenantId } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.importedMembership.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.location.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    members: await tx.member.count({ where: { tenantId: { in: ids } } }),
    bookings: await tx.importedBooking.count({ where: { tenantId: { in: ids } } }),
    mappings: await tx.importSourceMapping.count({ where: { tenantId: { in: ids } } }),
    attendance: await tx.attendanceRecord.count({ where: { tenantId: { in: ids } } }),
    jobs: await tx.importJob.count({ where: { tenantId: { in: ids } } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0, bookings: 0, mappings: 0, attendance: 0, jobs: 0, audit: 0 });
  process.stderr.write(`[sec-d2] teardown: ${ids.length} clubs removed, 0 rows left\n`);
}, 240_000);

describe.skipIf(!HAS_DB)("SF-74 / SEC-053 — attendance import under an explicit attacker model (REAL route, TEST DB)", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    if (process.env.RLS_ENFORCED === "1") expect(who[0]?.current_user).toBe("matflow_app");
    else expect(who[0]?.current_user).not.toBe("matflow_app");
    process.stderr.write(`[sec-d2] role ${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "0"} STRICT=${STRICT ? 1 : 0}\n`);
  });

  // ── Positive controls ────────────────────────────────────────────────────────
  it("CONTROL: the true holder (old member, address held since before the bookings) is bound by name_and_email", async () => {
    const club = await mkClub("ctl");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    await importVictim(club, N(VIC), E("vic"));
    expect((await ledger(club))[0]).toMatchObject({ memberId: vic, matchMethod: "name_and_email" });
    expect(await attendanceOf(club, vic)).toBe(1);
  });

  it("CONTROL: an owner decision saved through saveDecisions binds as decided", async () => {
    const club = await mkClub("ctl-dec");
    const target = await mkOldMember(club, N("Dee Target"), E("dee-target"));
    const err = await withTenantContext(club.tenantId, (tx) =>
      saveDecisions(tx, club.tenantId, club.userId, [{ kind: "person", sourceKey: teamupPersonKey(N(VIC), E("vic")), action: "member", targetId: target }]));
    expect(err).toBeNull();
    await importVictim(club, N(VIC), E("vic"));
    expect((await ledger(club))[0]).toMatchObject({ memberId: target, matchMethod: "decision" });
  });

  // ── (a) runtime database password: every write below is raw SQL / Prisma through the SF-62 bypass ───────────
  it("(a) FORGED RELEASE ROW: an unkeyed release forged for the victim's address only makes the booking pending — never a binding", async () => {
    const club = await mkClub("a-rel");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    await withRlsBypass((tx) => tx.auditLog.create({ data: { tenantId: club.tenantId, action: "member.delete", entityType: "Member", entityId: "secd2-forged",
      metadata: { releasedEmailSha256: sha(E("vic").toLowerCase()) } } }));
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, vic, "a forged release row bound history");
  });

  openIt("OPEN (a) RAW TAKEOVER: victim removed and an old record renamed + re-addressed by raw SQL (no audit rows) → bound to the attacker [closed by SF-62 P2; under (c) needs off-database provenance]", async () => {
    const club = await mkClub("a-raw");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    await withRlsBypass(async (tx) => {
      await tx.$executeRaw`DELETE FROM "Member" WHERE id = ${vic} AND "tenantId" = ${club.tenantId}`;
      await tx.$executeRaw`UPDATE "Member" SET name = ${N(VIC)}, email = ${E("vic")} WHERE id = ${mal} AND "tenantId" = ${club.tenantId}`;
    });
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "raw-SQL takeover bound the victim's history to the attacker");
  });

  openIt("OPEN (a) ACQUISITION ROW BACK-DATED: release row deleted and the attacker's own address-change row back-dated 400 days → bound [closed by SF-57 v2: UPDATE/DELETE refused]", async () => {
    const club = await mkClub("a-back");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    await ownerDelete(club, vic); // audited release (releasedEmailSha256), as the app writes it
    await ownerPatch(club, mal, { name: N(VIC), email: E("vic") }); // audited acquisition (own address change)
    const tampered = await withRlsBypass(async (tx) => ({
      deleted: await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "tenantId" = ${club.tenantId} AND action = 'member.delete' AND "entityId" = ${vic}`,
      backdated: await tx.$executeRaw`UPDATE "AuditLog" SET "createdAt" = "createdAt" - interval '400 days' WHERE "tenantId" = ${club.tenantId} AND "entityId" = ${mal}`,
    }));
    expect(tampered.deleted).toBe(1);
    expect(tampered.backdated).toBeGreaterThan(0);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "a back-dated acquisition bound the victim's history to the attacker");
  });

  openIt("OPEN (a) ACQUISITION ROW DELETED: release and acquisition rows both deleted → bound [closed by SF-57 v2]", async () => {
    const club = await mkClub("a-del");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    await ownerDelete(club, vic);
    await ownerPatch(club, mal, { name: N(VIC), email: E("vic") });
    const n = await withRlsBypass((tx) => tx.$executeRaw`DELETE FROM "AuditLog" WHERE "tenantId" = ${club.tenantId} AND "entityId" IN (${vic}, ${mal})`);
    expect(n).toBeGreaterThanOrEqual(2);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "deleted provenance rows bound the victim's history to the attacker");
  });

  openIt("OPEN (a) FORGED CREATION TIME: victim removed by raw SQL; a record inserted with a back-dated cuid at the address → bound [a Member.createdAt column would be writable too; closed by SF-62 P2]", async () => {
    const club = await mkClub("a-cuid");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    await withRlsBypass((tx) => tx.$executeRaw`DELETE FROM "Member" WHERE id = ${vic} AND "tenantId" = ${club.tenantId}`);
    const forged = idCreatedAt("2024-06-01T00:00:00Z");
    await withRlsBypass((tx) => tx.$executeRaw`INSERT INTO "Member"(id, "tenantId", name, email, "updatedAt") VALUES (${forged}, ${club.tenantId}, ${N(VIC)}, ${E("vic")}, now())`);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, forged, "a forged creation time bound the victim's history");
  });

  it("(a) RE-POINTED DECISION: an owner's saved decision re-pointed by raw UPDATE (no provenance) is not trusted → pending", async () => {
    const club = await mkClub("a-repoint");
    const vic = await mkOldMember(club, N("Vee Right"), E("vee-right"));
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const err = await withTenantContext(club.tenantId, (tx) => saveDecisions(tx, club.tenantId, club.userId, [{ kind: "person", sourceKey: key, action: "member", targetId: vic }]));
    expect(err).toBeNull();
    const n = await withRlsBypass((tx) => tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE "tenantId" = ${club.tenantId} AND kind = 'person' AND "sourceKey" = ${key}`);
    expect(n).toBe(1);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "a re-pointed decision bound the victim's history to the attacker");
  });

  it("(a) CROSS-CLUB RE-POINT: club B's runtime connection with the bypass re-points club A's decision → club A's import does not trust it", async () => {
    const a = await mkClub("a-xa");
    const b = await mkClub("a-xb");
    const right = await mkOldMember(a, N("Vee Right"), E("xa-right"));
    const mal = await mkOldMember(a, N("Mal Lory"), E("xa-mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await withTenantContext(a.tenantId, (tx) => saveDecisions(tx, a.tenantId, a.userId, [{ kind: "person", sourceKey: key, action: "member", targetId: right }]))).toBeNull();
    // From club B's context, the SF-62 bypass reaches club A's row.
    const n = await withTenantContext(b.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE "tenantId" = ${a.tenantId} AND kind = 'person' AND "sourceKey" = ${key}`;
    });
    expect(n, "SF-62: the bypass reached another club's row").toBe(1);
    await importVictim(a, N(VIC), E("vic"));
    await expectNotBound(a, mal, "a cross-club re-point bound history");
  });

  it("(a) FORGED DECISION: a person mapping inserted by raw SQL with no provenance is not trusted → pending", async () => {
    const club = await mkClub("a-forge");
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    await withRlsBypass((tx) => tx.importSourceMapping.create({ data: { tenantId: club.tenantId, source: LEDGER_SOURCE, kind: "person", sourceKey: key, action: "member", targetId: mal, decidedById: club.userId } }));
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "a forged decision bound the victim's history");
  });

  openIt("OPEN (c) FORGED DECISION + FORGED PROVENANCE: with the signing key the provenance row can be forged → bound [needs append-only provenance outside the runtime's reach]", async () => {
    const club = await mkClub("c-forge");
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    await withRlsBypass(async (tx) => {
      const m = await tx.importSourceMapping.create({ data: { tenantId: club.tenantId, source: LEDGER_SOURCE, kind: "person", sourceKey: key, action: "member", targetId: mal, decidedById: club.userId } });
      await tx.auditLog.create({ data: { tenantId: club.tenantId, userId: club.userId, action: "import.mapping.changed", entityType: "ImportSourceMapping", entityId: m.id,
        metadata: { kind: "person", source: LEDGER_SOURCE, sourceKeyDigest: provenanceDigest("person", key), before: null, after: { action: "member", targetId: mal }, via: "decide" } } });
    });
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "forged provenance bound the victim's history");
  });

  openIt("OPEN (a) externalRef SET: an attacker-chosen member's externalRef set to the victim's source key → bound by external_ref [closed by SF-62 P2; (c) needs keyed attestation]", async () => {
    const club = await mkClub("a-ext");
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "Member" SET "externalRef" = ${key} WHERE id = ${mal} AND "tenantId" = ${club.tenantId}`);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "a planted externalRef bound the victim's history");
  });

  it("(a) externalRef CASE COLLISION: a second record whose externalRef differs only in case → both match → pending, neither bound", async () => {
    const club = await mkClub("a-case");
    const key = teamupPersonKey(N(VIC), E("vic"));
    const vic = await mkOldMember(club, N(VIC), E("vic"), key);
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "Member" SET "externalRef" = ${key.toUpperCase()} WHERE id = ${mal} AND "tenantId" = ${club.tenantId}`);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "a case-collided externalRef bound history");
    expect(await attendanceOf(club, vic)).toBe(0);
  });

  it("(a) externalRef EXACT COLLISION: the database refuses a second record with the victim's exact externalRef", async () => {
    const club = await mkClub("a-exact");
    const key = teamupPersonKey(N(VIC), E("vic"));
    await mkOldMember(club, N(VIC), E("vic"), key);
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    await expect(withRlsBypass((tx) => tx.$executeRaw`UPDATE "Member" SET "externalRef" = ${key} WHERE id = ${mal} AND "tenantId" = ${club.tenantId}`)).rejects.toThrow(/unique|duplicate|23505/i);
  });

  // ── (b) a staff/owner session: only the real routes ─────────────────────────────────────────────────────────────
  it("(b) RELEASE + ACQUISITION through the routes: victim deleted (real DELETE), an old record renamed and re-addressed (real PATCH) → pending", async () => {
    const club = await mkClub("b-acq");
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    const mal = await mkOldMember(club, N("Mal Lory"), E("mal"));
    await ownerDelete(club, vic);
    await ownerPatch(club, mal, { name: N(VIC), email: E("vic") });
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "the routes let an acquirer receive the released holder's history");
  });

  it("(b) DECISION RE-POINTED through the real decide route: binds as decided AND the prior target is recoverable from a provenance row written with it", async () => {
    const club = await mkClub("b-decide");
    const first = await mkOldMember(club, N("Fay First"), E("fay"));
    const second = await mkOldMember(club, N("Sid Second"), E("sid"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    for (const targetId of [first, second]) {
      const r = await call(club, { action: "decide", decisions: [{ kind: "person", sourceKey: key, action: "member", targetId }] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    await importVictim(club, N(VIC), E("vic"));
    expect((await ledger(club))[0]).toMatchObject({ memberId: second, matchMethod: "decision" });
    const mapping = await withRlsBypass((tx) => tx.importSourceMapping.findFirstOrThrow({ where: { tenantId: club.tenantId, kind: "person", sourceKey: key }, select: { id: true } }));
    const rows = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: club.tenantId, action: "import.mapping.changed", entityId: mapping.id }, orderBy: { createdAt: "asc" }, select: { userId: true, metadata: true } }));
    expect(rows, "one provenance row per decision").toHaveLength(2);
    const md = rows.map((r) => r.metadata as Record<string, unknown>);
    expect(md[0]).toMatchObject({ kind: "person", before: null, after: { action: "member", targetId: first } });
    expect(md[1]).toMatchObject({ kind: "person", before: { action: "member", targetId: first }, after: { action: "member", targetId: second } });
    expect(md[1].sourceKeyDigest).toBe(provenanceDigest("person", key));
    expect(JSON.stringify(md)).not.toContain(E("vic")); // no address in the audit trail, only the keyed digest
    expect(rows.every((r) => r.userId === club.userId)).toBe(true);
  });

  it("(b) PROVENANCE IS ATOMIC: if the provenance row cannot be written, the decision is not stored either", async () => {
    const club = await mkClub("b-atomic");
    const target = await mkOldMember(club, N("Ann Atomic"), E("ann"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    await expect(withTenantContext(club.tenantId, (tx) => {
      const failing = new Proxy(tx, {
        get(t, p, r) {
          if (p === "auditLog") return { ...t.auditLog, create: async () => { throw new Error("secd2: audit write failed"); } };
          return Reflect.get(t, p, r);
        },
      });
      return saveDecisions(failing, club.tenantId, club.userId, [{ kind: "person", sourceKey: key, action: "member", targetId: target }]);
    })).rejects.toThrow(/secd2: audit write failed/);
    expect(await withRlsBypass((tx) => tx.importSourceMapping.count({ where: { tenantId: club.tenantId, kind: "person" } }))).toBe(0);
  });

  it("(b) externalRef COLLISION through the members import: a TeamUp row for an address a hand-added member holds creates no second identity; the history binds to the holder", async () => {
    const club = await mkClub("b-ext");
    await withRlsBypass((tx) => tx.membershipTier.create({ data: { tenantId: club.tenantId, name: "secD2 Adults", pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } }));
    const vic = await mkOldMember(club, N(VIC), E("vic"));
    const T_HEADER = "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
    const row = [N(VIC), E("vic"), "", "secD2 Adults", "recurring", "active", "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", "1990-04-15", "", "", ""].join(",");
    const url = `https://blob.test.local/${STAMP}/members-${++seq}.csv`;
    FILES.set(url, [T_HEADER, row].join("\n"));
    const job = await withRlsBypass((tx) => tx.importJob.create({
      data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode: "create", fileName: "secd2-members.csv", fileBlobUrl: url, status: "preview", sourceExportedAt: new Date("2026-10-01T08:00:00Z"), sourceExportedAtProvenance: "owner_stated" },
    }));
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = await membersCommit(new Request(`https://test.local/api/admin/import/${job.id}/commit`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" }), { params: Promise.resolve({ id: job.id }) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    const holders = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: club.tenantId, OR: [{ email: E("vic") }, { externalRef: teamupPersonKey(N(VIC), E("vic")) }] }, select: { id: true, externalRef: true } }));
    expect(holders.map((h) => h.id)).toEqual([vic]);
    await importVictim(club, N(VIC), E("vic"));
    expect((await ledger(club))[0]).toMatchObject({ memberId: vic, matchMethod: "name_and_email" });
  });
});
