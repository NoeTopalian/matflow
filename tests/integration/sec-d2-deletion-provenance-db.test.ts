// Security lane D2 (iteration 2, 9 Oct 2026) — deletion provenance (SF-54 / SF-67 / SF-74).
//
// Every path that removes a login address from a club must record the release (a keyed digest the attendance
// import reads) IN THE SAME TRANSACTION as the removal: a crash between the two would leave an address free for a
// same-name record to take over with nothing telling the importer it was released. Paths: staff member DELETE
// (app/api/members/[id]), the family child DELETE (app/api/member/children/[id]), staff DELETE
// (app/api/staff/[id]), DSAR erase (app/api/admin/dsar/erase) and members-import rollback
// (app/api/admin/import/[id]/rollback).
//
// "Crash" = the audit write for that action throws (the real audit module wraps every other call). The cell then
// asserts the address is not left released-but-undigested: the removal rolled back with it. Then, per path, a
// record with a back-dated creation time and NO acquisition row is planted at the released address (the strongest
// re-acquisition: no route, no audit row) and the REAL attendance import must leave the booking pending; a control
// shows the same plant at a never-released address binds, so the release digest is what refuses.
//
// Runs only through the guarded runners (owner role / matflow_app with RLS), TEST branch. Prefix secd2p-; count-checked
// teardown of this file's clubs only.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers(init?.headers) }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const crash = vi.hoisted(() => ({ action: null as string | null, hits: 0 }));
vi.mock("@/lib/audit-log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit-log")>();
  return {
    ...real,
    logAudit: vi.fn(async (args: Parameters<typeof real.logAudit>[0]) => {
      if (crash.action && args.action === crash.action) { crash.hits += 1; throw new Error(`secd2 crash at ${args.action}`); }
      return real.logAudit(args);
    }),
  };
});
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string; memberId?: string } }));
const sessionOf = () => (gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner", ...(gate.current.memberId ? { memberId: gate.current.memberId } : {}) } } : null);
vi.mock("@/auth", () => ({ auth: vi.fn(async () => sessionOf()), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: sessionOf() };
  };
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok), requireApiRole: vi.fn(ok) };
});
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { JOB_SOURCE, LEDGER_SOURCE, MAPPING_VERSION, buildPlan, loadClubInputs, planHashOf, saveDecisions } from "@/lib/attendance-import";
import { POST as attendanceRoute } from "@/app/api/admin/import/attendance/route";
import { DELETE as memberDelete } from "@/app/api/members/[id]/route";
import { DELETE as childDelete } from "@/app/api/member/children/[id]/route";
import { DELETE as staffDelete } from "@/app/api/staff/[id]/route";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";
import { POST as importRollback } from "@/app/api/admin/import/[id]/rollback/route";
import { emailDigest } from "@/lib/login-email";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secd2p-${Date.now().toString(36)}`;
const N = (who: string) => `secD2P ${who}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const VENUE = "secD2P Main";
const OFFERING = "secD2P Adults Gi";
const HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ORIGIN = { origin: "https://test.local", host: "test.local" };

type Club = { tenantId: string; userId: string; classId: string; locationId: string };
const clubs: Club[] = [];
let seq = 0;

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "secD2P Owner", role: "owner", passwordHash: "x" } });
    const loc = await tx.location.create({ data: { tenantId: t.id, name: VENUE, isDefault: true } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: OFFERING, duration: 60, isActive: true } });
    return { tenantId: t.id, userId: u.id, classId: cls.id, locationId: loc.id };
  });
  clubs.push(club);
  expect(await withTenantContext(club.tenantId, (tx) =>
    saveDecisions(tx, club.tenantId, club.userId, [
      { kind: "offering", sourceKey: OFFERING, action: "class", targetId: club.classId },
      { kind: "venue", sourceKey: VENUE, action: "location", targetId: club.locationId },
    ]))).toBeNull();
  return club;
}

const idCreatedAt = (at: string) =>
  `c${new Date(at).getTime().toString(36).padStart(8, "0")}${Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;
const OLD = "2025-01-15T10:00:00Z";
const mkOld = (club: Club, name: string, email: string, extra: Record<string, unknown> = {}) =>
  withRlsBypass((tx) => tx.member.create({ data: { id: idCreatedAt(OLD), tenantId: club.tenantId, name, email, ...extra }, select: { id: true } })).then((r) => r.id);

/** The strongest re-acquisition: a back-dated record planted at the address by raw SQL, no route, no audit row. */
async function plant(club: Club, name: string, email: string) {
  const id = idCreatedAt("2024-06-01T00:00:00Z");
  await withRlsBypass((tx) => tx.$executeRaw`INSERT INTO "Member"(id, "tenantId", name, email, "updatedAt") VALUES (${id}, ${club.tenantId}, ${name}, ${email}, now())`);
  return id;
}

async function call(club: Club, body: unknown) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const res = (await attendanceRoute(new Request("http://localhost/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

/** The REAL attendance import of one attended booking for (name, email); returns the planted record's attendance. */
async function importOne(club: Club, name: string, email: string) {
  const text = [HEADER, [name, email, "2025-11-03T18:00:00+00:00", OFFERING, VENUE, "Attended"].join(",")].join("\n");
  const url = `test://${STAMP}/${++seq}`;
  FILES.set(url, text);
  const inputs = await withTenantContext(club.tenantId, (tx) => loadClubInputs(tx, club.tenantId));
  const planHash = planHashOf(sha(text), inputs);
  const built = buildPlan(text, inputs, new Date());
  if (built.errors) throw new Error(built.errors.join(" "));
  const job = await withRlsBypass((tx) => tx.importJob.create({
    data: { tenantId: club.tenantId, createdById: club.userId, source: JOB_SOURCE, fileName: `secd2p-${seq}.csv`, fileBlobUrl: url, status: "preview", fileHash: sha(text),
      sourceExportedAt: new Date("2026-10-08T12:00:00Z"), sourceExportedAtProvenance: "owner_stated", mappingVersion: MAPPING_VERSION, totalRows: 1, dryRunSummary: { planHash } as never },
    select: { id: true },
  }));
  const c = await call(club, { action: "commit", jobId: job.id, planHash });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  for (let i = 0; i < 6; i++) {
    const s = await call(club, { action: "step", jobId: job.id });
    if (s.body.done) break;
  }
  return withRlsBypass((tx) => tx.importedBooking.findFirstOrThrow({ where: { tenantId: club.tenantId, source: LEDGER_SOURCE, createdByJobId: job.id }, select: { memberId: true, disposition: true } }));
}

const memberExists = (club: Club, id: string) => withRlsBypass((tx) => tx.member.count({ where: { tenantId: club.tenantId, id } })).then((n) => n === 1);
const userExists = (club: Club, id: string) => withRlsBypass((tx) => tx.user.count({ where: { tenantId: club.tenantId, id } })).then((n) => n === 1);
/** Is this address's keyed release digest recorded anywhere in the club's audit trail? */
const digestRecorded = async (club: Club, email: string) => {
  const d = emailDigest(email);
  const rows = await withRlsBypass((tx) => tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "AuditLog" WHERE "tenantId" = ${club.tenantId}
      AND (metadata->>'releasedEmailSha256' = ${d} OR metadata->'releasedEmailSha256' ? ${d})`);
  return Number(rows[0]?.n ?? 0) > 0;
};

// ── The five release paths, each driven through its REAL route ────────────────────────────────────────────────
type Released = { club: Club; email: string; name: string; status: number; subjectGone: () => Promise<boolean> };
const paths: Record<string, (label: string) => Promise<Released>> = {
  "member DELETE": async (label) => {
    const club = await mkClub(label);
    const name = N("Rel Member"), email = E(`${label}-addr`);
    const id = await mkOld(club, name, email);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await memberDelete(new Request(`https://test.local/api/members/${id}?confirm=1`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id }) })) as unknown as { status: number };
    return { club, email, name, status: res.status, subjectGone: async () => !(await memberExists(club, id)) };
  },
  "child DELETE": async (label) => {
    const club = await mkClub(label);
    const parent = await mkOld(club, N("Rel Parent"), E(`${label}-parent`), { accountType: "parent" });
    const name = N("Rel Child"), email = E(`${label}-addr`);
    const child = await mkOld(club, name, email, { accountType: "junior", parentMemberId: parent, guardianConfirmedAt: new Date("2025-02-01T00:00:00Z") });
    gate.current = { tenantId: club.tenantId, userId: club.userId, memberId: parent };
    const res = (await childDelete(new Request(`https://test.local/api/member/children/${child}`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id: child }) })) as unknown as { status: number };
    return { club, email, name, status: res.status, subjectGone: async () => !(await memberExists(club, child)) };
  },
  "staff DELETE": async (label) => {
    const club = await mkClub(label);
    const name = N("Rel Coach"), email = E(`${label}-addr`);
    const staff = await withRlsBypass((tx) => tx.user.create({ data: { tenantId: club.tenantId, email, name, role: "coach", passwordHash: "x" }, select: { id: true } })).then((r) => r.id);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await staffDelete(new Request(`https://test.local/api/staff/${staff}`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id: staff }) })) as unknown as { status: number };
    return { club, email, name, status: res.status, subjectGone: async () => !(await userExists(club, staff)) };
  },
  "DSAR erase": async (label) => {
    const club = await mkClub(label);
    const name = N("Rel Dsar"), email = E(`${label}-addr`);
    const id = await mkOld(club, name, email);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${id}`, { method: "POST", headers: ORIGIN }))) as unknown as { status: number };
    // The erase keeps a scrubbed row: the address is gone when no member holds it any more.
    return { club, email, name, status: res.status, subjectGone: async () => (await withRlsBypass((tx) => tx.member.count({ where: { tenantId: club.tenantId, email } }))) === 0 };
  },
  "members-import rollback": async (label) => {
    const club = await mkClub(label);
    const name = N("Rel Imported"), email = E(`${label}-addr`);
    const job = await withRlsBypass((tx) => tx.importJob.create({
      data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode: "create", fileName: "secd2p-members.csv", fileBlobUrl: `test://${STAMP}/members-${label}`, status: "complete", completedAt: new Date() },
      select: { id: true },
    }));
    const id = await mkOld(club, name, email, { importJobId: job.id });
    // A real import completes after it writes its members. Stamped here, after the member, so the rollback's
    // "edited after the import" rule (updatedAt more than 1 s past completedAt) never reads the round trips
    // between the two writes as an edit: at ~235 ms per round trip that gap passed 1 s (26 Oct 2026).
    await withRlsBypass((tx) => tx.importJob.update({ where: { id: job.id }, data: { completedAt: new Date() } }));
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await importRollback(new Request(`https://test.local/api/admin/import/${job.id}/rollback`, { method: "POST", headers: ORIGIN, body: "{}" }), { params: Promise.resolve({ id: job.id }) })) as unknown as { status: number };
    return { club, email, name, status: res.status, subjectGone: async () => !(await memberExists(club, id)) };
  },
};
const AUDIT_ACTION: Record<string, string> = {
  "member DELETE": "member.delete", "child DELETE": "member.child.delete", "staff DELETE": "staff.delete",
  "DSAR erase": "member.dsar_erase", "members-import rollback": "import.rollback",
};

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
      await tx.location.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    members: await tx.member.count({ where: { tenantId: { in: ids } } }),
    users: await tx.user.count({ where: { tenantId: { in: ids } } }),
    bookings: await tx.importedBooking.count({ where: { tenantId: { in: ids } } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0, users: 0, bookings: 0, audit: 0 });
  process.stderr.write(`[sec-d2p] teardown: ${ids.length} clubs removed, 0 rows left\n`);
}, 240_000);

describe.skipIf(!HAS_DB)("SF-54 / SF-74 — every release path records the release in the same transaction (REAL routes, TEST DB)", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    if (process.env.RLS_ENFORCED === "1") expect(who[0]?.current_user).toBe("matflow_app");
    else expect(who[0]?.current_user).not.toBe("matflow_app");
    process.stderr.write(`[sec-d2p] role ${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "0"}\n`);
  });

  it("CONTROL: a record planted at a NEVER-released address does bind (so the release digest is what refuses below)", async () => {
    const club = await mkClub("ctl");
    const planted = await plant(club, N("Rel Never"), E("ctl-addr"));
    const b = await importOne(club, N("Rel Never"), E("ctl-addr"));
    expect(b.memberId).toBe(planted);
  });

  for (const [path, run] of Object.entries(paths)) {
    const slug = path.replace(/[^a-z]+/gi, "").toLowerCase();

    it(`${path}: succeeds and records the keyed release digest`, async () => {
      crash.action = null;
      const r = await run(`${slug}-ok`);
      expect(r.status).toBe(200);
      expect(await r.subjectGone(), "the address was not removed").toBe(true);
      expect(await digestRecorded(r.club, r.email), "no release digest for the removed address").toBe(true);
    });

    it(`${path}: a crash at the release record leaves the address NOT released-but-undigested (removal rolls back with it)`, async () => {
      crash.action = AUDIT_ACTION[path];
      crash.hits = 0;
      try {
        const r = await run(`${slug}-crash`);
        expect(crash.hits, "the crash was injected").toBe(1);
        const gone = await r.subjectGone();
        const digested = await digestRecorded(r.club, r.email);
        expect(gone && !digested, `${path}: address released with no digest (status ${r.status})`).toBe(false);
        expect(gone, "the removal must roll back with the failed release record").toBe(false);
        expect(r.status).toBeGreaterThanOrEqual(500);
      } finally {
        crash.action = null;
      }
    });

    it(`${path}: a later import cannot re-acquire the released address without an acquisition row (planted back-dated record → pending)`, async () => {
      crash.action = null;
      const r = await run(`${slug}-reacq`);
      expect(r.status).toBe(200);
      const planted = await plant(r.club, r.name, r.email);
      const b = await importOne(r.club, r.name, r.email);
      expect(b.memberId, `${path}: the planted record received the released holder's history`).toBeNull();
      expect(b.disposition).toBe("pending_person");
      expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: r.club.tenantId, memberId: planted } }))).toBe(0);
    });
  }
});
