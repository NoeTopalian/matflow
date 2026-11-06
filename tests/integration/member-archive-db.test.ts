// PR 3 (6 Nov 2026; Noe: "Save all past user data") — removing a member
// archives them, removing a staff account deactivates it, and data requests
// (export and erasure) are owner-only. Runs against a REAL database: the Neon
// TEST branch only (helpers/db-target; tests/setup-test-db.ts refuses
// production). Skipped, visibly, on any other target.
//
// What it proves, through the real routes and helpers:
// - Remove keeps every record (attendance, status events, photos, roster
//   places, bookings) and the member leaves lists, counts and doors;
// - Reports history for a past period is identical before and after;
// - Restore brings the member, and kids archived with them, back;
// - an archived member can still be erased, and a manager is refused;
// - a deactivated staff account's session is refused and its Activity rows
//   keep their author; reactivation restores it.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", async (orig) => {
  const real = await orig<typeof import("next/server")>();
  return {
    ...real,
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers(init?.headers) }),
    },
  };
});
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { DELETE as memberDELETE } from "@/app/api/members/[id]/route";
import { GET as membersGET, POST as membersPOST } from "@/app/api/members/route";
import { parseTeamUp } from "@/lib/importers/teamup";
import { planRefresh, planRefreshRollback, REFRESH_MEMBER_SELECT } from "@/lib/importers/teamup-refresh";
import { POST as restorePOST } from "@/app/api/members/[id]/restore/route";
import { DELETE as staffDELETE } from "@/app/api/staff/[id]/route";
import { POST as reactivatePOST } from "@/app/api/staff/[id]/reactivate/route";
import { GET as subjectsGET } from "@/app/api/admin/dsar/subjects/route";
import { POST as erasePOST } from "@/app/api/admin/dsar/erase/route";
import { getMemberListCounts } from "@/lib/member-list-counts-server";
import { clubMonthWindow } from "@/lib/club-month";
import { getReportsData } from "@/lib/reports";
import { performCheckin } from "@/lib/checkin";
import { checkSessionVersion } from "@/lib/session-revocation";
import { ACTIVE_MEMBER, TRAINING_MEMBER_EVER } from "@/lib/member-population";
import { classifyDbTarget, assertTestBranch, skipReason } from "./helpers/db-target";

const TARGET = classifyDbTarget(process.env.DATABASE_URL);
const HAS_DB = TARGET === "run" || TARGET === "refuse";
const SKIP_NOTE = skipReason(TARGET) ? ` [skipped: ${skipReason(TARGET)}]` : "";
const STAMP = `pr3arch${Date.now().toString(36)}`;

const mockAuth = vi.mocked(auth);
const ids = { tenant: "", owner: "", manager: "", coach: "", cls: "", past: "", future: "", sam: "", pat: "", kid: "", other: "" };
const as = (userId: string, role: string) => mockAuth.mockResolvedValue({ user: { id: userId, role, tenantId: ids.tenant, email: `${role}@example.test` } } as never);
const req = (url: string, method: string) => new Request(`https://test.local${url}`, { method, headers: { origin: "https://test.local", host: "test.local" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Everything a removal must keep for one member, counted. */
async function kept(memberId: string) {
  return withRlsBypass(async (tx) => ({
    member: await tx.member.count({ where: { id: memberId } }),
    attendance: await tx.attendanceRecord.count({ where: { memberId } }),
    statusEvents: await tx.memberStatusEvent.count({ where: { memberId } }),
    photos: await tx.memberPhoto.count({ where: { memberId } }),
    roster: await tx.classRoster.count({ where: { memberId } }),
    bookings: await tx.classSubscription.count({ where: { memberId } }),
  }));
}

/** The history half of the Reports page for a past period. */
async function history() {
  const r = await getReportsData(ids.tenant, { period: { period: "custom", from: "2026-08", to: "2026-09" } });
  return {
    weeklyAttendance: r.weeklyAttendance,
    checkInMethods: r.checkInMethods,
    topClasses: r.topClasses,
    netNewByMonth: r.netNewByMonth,
    monthlySignups: r.monthlySignups,
    membership: r.membership,
    periodMovement: r.periodMovement,
    churn: r.churn,
  };
}

async function activeCount() {
  return withTenantContext(ids.tenant, (tx) => tx.member.count({ where: { tenantId: ids.tenant, ...ACTIVE_MEMBER } }));
}

async function listedIds(): Promise<string[]> {
  as(ids.owner, "owner");
  const res = (await membersGET(new Request("https://test.local/api/members?take=100"))) as unknown as { json: () => Promise<unknown> };
  const body = (await res.json()) as { members?: Array<{ id: string }> } | Array<{ id: string }>;
  const rows = Array.isArray(body) ? body : body.members ?? [];
  return rows.map((m) => m.id);
}

describe.skipIf(!HAS_DB)(`PR 3 member archive and data requests on TEST${SKIP_NOTE}`, () => {
  beforeAll(async () => {
    assertTestBranch(process.env.DATABASE_URL);
    await withRlsBypass(async (tx) => {
      ids.tenant = (await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`, onboardingCompleted: true } })).id;
      const user = async (role: string) =>
        (await tx.user.create({ data: { tenantId: ids.tenant, email: `${STAMP}-${role}@example.test`, name: `PR3 ${role}`, role, passwordHash: "synthetic-not-a-hash" } })).id;
      ids.owner = await user("owner");
      ids.manager = await user("manager");
      ids.coach = await user("coach");
      ids.cls = (await tx.class.create({ data: { tenantId: ids.tenant, name: `${STAMP} Gi`, duration: 60 } })).id;
      ids.past = (await tx.classInstance.create({ data: { classId: ids.cls, date: new Date("2026-09-10T00:00:00.000Z"), startTime: "18:00", endTime: "19:00" } })).id;
      ids.future = (await tx.classInstance.create({ data: { classId: ids.cls, date: new Date("2031-03-03T00:00:00.000Z"), startTime: "18:00", endTime: "19:00" } })).id;
      const member = async (key: string, data: Record<string, unknown> = {}) =>
        (await tx.member.create({
          data: { tenantId: ids.tenant, name: `PR3 ${key}`, email: `${STAMP}-${key}@example.test`, status: "active", waiverAccepted: true, joinedAt: new Date("2026-08-01T10:00:00.000Z"), ...data },
        })).id;
      ids.sam = await member("sam");
      ids.other = await member("other");
      ids.pat = await member("pat", { accountType: "parent" });
      ids.kid = await member("kid", { accountType: "kids", parentMemberId: ids.pat, guardianConfirmedAt: new Date() });
      // Sam's history: a visit, a status change, a photo, a roster place, a booking.
      await tx.attendanceRecord.create({ data: { tenantId: ids.tenant, memberId: ids.sam, classInstanceId: ids.past, checkInTime: new Date("2026-09-10T18:05:00.000Z"), checkInMethod: "admin", checkedInById: ids.coach } });
      await tx.attendanceRecord.create({ data: { tenantId: ids.tenant, memberId: ids.other, classInstanceId: ids.past, checkInTime: new Date("2026-09-10T18:06:00.000Z"), checkInMethod: "kiosk" } });
      await tx.memberStatusEvent.create({ data: { tenantId: ids.tenant, memberId: ids.sam, fromStatus: "taster", toStatus: "active", reason: "staff_edit", changedById: ids.coach, occurredAt: new Date("2026-09-01T10:00:00.000Z") } });
      await tx.memberPhoto.create({ data: { tenantId: ids.tenant, memberId: ids.sam, url: "data:image/webp;base64,UklGRhoAAABXRUJQ", kind: "evidence" } });
      await tx.classRoster.create({ data: { tenantId: ids.tenant, classId: ids.cls, memberId: ids.sam } });
      await tx.classSubscription.create({ data: { classId: ids.cls, memberId: ids.sam } });
      // An Activity row the coach wrote.
      await tx.auditLog.create({ data: { tenantId: ids.tenant, userId: ids.coach, action: "attendance.mark", entityType: "AttendanceRecord", entityId: "x", metadata: { memberId: ids.sam } } });
    }, { timeout: 60_000 });
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await withRlsBypass(async (tx) => {
      const t = ids.tenant;
      await tx.auditLog.deleteMany({ where: { tenantId: t } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId: t } });
      await tx.classSubscription.deleteMany({ where: { class: { tenantId: t } } });
      await tx.classRoster.deleteMany({ where: { tenantId: t } });
      await tx.classWaitlist.deleteMany({ where: { classInstance: { class: { tenantId: t } } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: t } } });
      await tx.class.deleteMany({ where: { tenantId: t } });
      await tx.memberPhoto.deleteMany({ where: { tenantId: t } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: t } });
      await tx.loginEvent.deleteMany({ where: { tenantId: t } });
      await tx.member.updateMany({ where: { tenantId: t }, data: { parentMemberId: null, accountType: "adult" } });
      await tx.member.deleteMany({ where: { tenantId: t } });
      await tx.user.deleteMany({ where: { tenantId: t } });
      await tx.tenant.deleteMany({ where: { id: t, slug: { startsWith: STAMP } } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { id: ids.tenant } }));
    expect(left).toBe(0);
  }, 120_000);

  it("Remove archives: every record stays, the member leaves lists, counts and doors, and Reports history is identical", async () => {
    const before = { kept: await kept(ids.sam), history: await history(), active: await activeCount(), listed: await listedIds() };
    expect(before.kept).toEqual({ member: 1, attendance: 1, statusEvents: 1, photos: 1, roster: 1, bookings: 1 });
    expect(before.listed).toContain(ids.sam);
    const month = clubMonthWindow(new Date(), "Europe/London");
    const countsBefore = await getMemberListCounts(ids.tenant, new Date(), month);

    as(ids.owner, "owner");
    const res = (await memberDELETE(req(`/api/members/${ids.sam}?confirm=1`, "DELETE"), params(ids.sam))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, archived: true });

    // Nothing deleted.
    expect(await kept(ids.sam)).toEqual(before.kept);
    const row = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: ids.sam }, select: { archivedAt: true, archivedById: true, status: true } }));
    expect(row?.archivedAt).toBeInstanceOf(Date);
    expect(row?.archivedById).toBe(ids.owner);
    expect(row?.status).toBe("active");

    // Out of lists and counts.
    expect(await listedIds()).not.toContain(ids.sam);
    expect(await activeCount()).toBe(before.active - 1);
    const countsAfter = await getMemberListCounts(ids.tenant, new Date(), month);
    expect(countsAfter.all).toBe(countsBefore.all - 1);
    expect(countsAfter.active).toBe(countsBefore.active - 1);

    // History for a past period is identical, and still counts Sam's visit.
    const after = await history();
    expect(after).toEqual(before.history);
    expect(after.checkInMethods.reduce((n, m) => n + m.count, 0)).toBe(2);
    // The current month's headcount leaves Sam out from the moment of removal, so it equals the Active tile.
    const current = await getReportsData(ids.tenant);
    expect(current.membership.headcountByMonth.find((m) => m.isCurrentMonth)?.headcount).toBe(await activeCount());
    expect(current.membership.totals.lostCancelled).toBe(0); // removal is not a cancellation (no churn)
    const everCount = await withTenantContext(ids.tenant, (tx) => tx.member.count({ where: { tenantId: ids.tenant, ...TRAINING_MEMBER_EVER } }));
    expect(everCount).toBeGreaterThanOrEqual(3);

    // The door refuses them (same engine as kiosk, QR, card and the member app).
    const checkin = await performCheckin({
      tenantId: ids.tenant, memberId: ids.sam, classInstanceId: ids.future, method: "kiosk",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true,
    });
    expect(checkin.kind).toBe("member_not_found");

    // An archived member's session is refused.
    expect(await checkSessionVersion({ memberId: ids.sam, tokenVersion: 0, tenantId: ids.tenant })).toBe("revoked");

    // Audited.
    const audit = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: ids.tenant, action: "member.archive", entityId: ids.sam } }));
    expect(audit?.userId).toBe(ids.owner);
  }, 120_000);

  it("Restore brings the member back with everything, owner and manager only", async () => {
    as(ids.coach, "coach");
    const refused = (await restorePOST(req(`/api/members/${ids.sam}/restore`, "POST"), params(ids.sam))) as unknown as { status: number };
    expect(refused.status).toBe(403);

    as(ids.manager, "manager");
    const res = (await restorePOST(req(`/api/members/${ids.sam}/restore`, "POST"), params(ids.sam))) as unknown as { status: number };
    expect(res.status).toBe(200);
    expect(await listedIds()).toContain(ids.sam);
    expect(await kept(ids.sam)).toEqual({ member: 1, attendance: 1, statusEvents: 1, photos: 1, roster: 1, bookings: 1 });
    const row = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: ids.sam }, select: { archivedAt: true, archivedById: true } }));
    expect(row).toEqual({ archivedAt: null, archivedById: null });
    const audit = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: ids.tenant, action: "member.restore", entityId: ids.sam } }));
    expect(audit?.userId).toBe(ids.manager);
    const checkin = await performCheckin({
      tenantId: ids.tenant, memberId: ids.sam, classInstanceId: ids.future, method: "kiosk",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true,
    });
    expect(checkin.kind).not.toBe("member_not_found");
  }, 120_000);

  it("a parent with a child needs a choice; cascade archives both and Restore brings both back", async () => {
    as(ids.owner, "owner");
    const probe = (await memberDELETE(req(`/api/members/${ids.pat}?confirm=1`, "DELETE"), params(ids.pat))) as unknown as { status: number };
    expect(probe.status).toBe(409);
    expect((await withRlsBypass((tx) => tx.member.findUnique({ where: { id: ids.pat }, select: { archivedAt: true } })))?.archivedAt).toBeNull();

    const res = (await memberDELETE(req(`/api/members/${ids.pat}?strategy=cascade`, "DELETE"), params(ids.pat))) as unknown as { status: number };
    expect(res.status).toBe(200);
    const both = await withRlsBypass((tx) => tx.member.findMany({ where: { id: { in: [ids.pat, ids.kid] } }, select: { id: true, archivedAt: true, parentMemberId: true } }));
    expect(both.every((m) => m.archivedAt !== null)).toBe(true);
    expect(both.find((m) => m.id === ids.kid)?.parentMemberId).toBe(ids.pat);

    as(ids.owner, "owner");
    const back = (await restorePOST(req(`/api/members/${ids.pat}/restore`, "POST"), params(ids.pat))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ restoredKids: 1 });
    const again = await withRlsBypass((tx) => tx.member.findMany({ where: { id: { in: [ids.pat, ids.kid] } }, select: { archivedAt: true } }));
    expect(again.every((m) => m.archivedAt === null)).toBe(true);
  }, 120_000);

  it("Data requests: owner finds an archived member and erases them; a manager is refused", async () => {
    as(ids.owner, "owner");
    await memberDELETE(req(`/api/members/${ids.other}?confirm=1`, "DELETE"), params(ids.other));

    as(ids.manager, "manager");
    const mgrSearch = (await subjectsGET(new Request(`https://test.local/api/admin/dsar/subjects?q=PR3`))) as unknown as { status: number };
    expect(mgrSearch.status).toBe(403);
    const mgrErase = (await erasePOST(req(`/api/admin/dsar/erase?memberId=${ids.other}`, "POST"))) as unknown as { status: number };
    expect(mgrErase.status).toBe(403);

    as(ids.owner, "owner");
    const search = (await subjectsGET(new Request(`https://test.local/api/admin/dsar/subjects?q=PR3 other`))) as unknown as { status: number; json: () => Promise<Array<{ id: string; archivedAt: string | null }>> };
    expect(search.status).toBe(200);
    const found = await search.json();
    expect(found.map((r) => r.id)).toEqual([ids.other]);
    expect(found[0].archivedAt).not.toBeNull();

    const erase = (await erasePOST(req(`/api/admin/dsar/erase?memberId=${ids.other}`, "POST"))) as unknown as { status: number };
    expect(erase.status).toBe(200);
    const row = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: ids.other }, select: { name: true, email: true } }));
    expect(row?.name).toBe("Deleted member");
    expect(row?.email).toMatch(/^deleted-/);
    // Anonymous history and the record of erasure stay.
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId: ids.other } }))).toBe(1);
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.tenant, action: { contains: "dsar" }, entityId: ids.other } }))).toBeGreaterThan(0);
  }, 120_000);

  it("Add member with the same email AND name as an archived member restores them: one row, history kept, audited", async () => {
    const janeId = await withRlsBypass(async (tx) => {
      const id = (await tx.member.create({ data: { tenantId: ids.tenant, name: "Jane Back", email: `${STAMP}-jane@example.test`, status: "active", dateOfBirth: new Date("1990-04-15T00:00:00Z") } })).id;
      await tx.attendanceRecord.create({ data: { tenantId: ids.tenant, memberId: id, classInstanceId: ids.past, checkInTime: new Date("2026-09-10T18:07:00.000Z"), checkInMethod: "admin" } });
      return id;
    });
    as(ids.owner, "owner");
    await memberDELETE(req(`/api/members/${janeId}?confirm=1`, "DELETE"), params(janeId));
    const add = async (name: string, dateOfBirth?: string, extra: Record<string, unknown> = {}, who = "jane") => {
      as(ids.owner, "owner");
      const r = new Request("https://test.local/api/members", {
        method: "POST",
        headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
        body: JSON.stringify({ name, email: `${STAMP}-${who}@example.test`, phone: "07000 000111", ...(dateOfBirth ? { dateOfBirth } : {}), ...extra }),
      });
      return (await membersPOST(r)) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    };
    const rows = () => withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: ids.tenant, email: { equals: `${STAMP}-jane@example.test`, mode: "insensitive" } }, select: { id: true, archivedAt: true, phone: true } }));

    // An admin cannot restore (the restore route is owner and manager): Add member answers 409 and nothing changes.
    const adminId = await withRlsBypass(async (tx) => (await tx.user.create({ data: { tenantId: ids.tenant, email: `${STAMP}-admin@example.test`, name: "PR3 admin", role: "admin", passwordHash: "synthetic-not-a-hash" } })).id);
    mockAuth.mockResolvedValue({ user: { id: adminId, role: "admin", tenantId: ids.tenant, email: "admin@example.test" } } as never);
    const asAdmin = (await membersPOST(new Request("https://test.local/api/members", {
      method: "POST",
      headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
      body: JSON.stringify({ name: "Jane Back", email: `${STAMP}-jane@example.test` }),
    }))) as unknown as { status: number };
    expect(asAdmin.status).toBe(409);
    expect((await rows()).map((r) => r.archivedAt !== null)).toEqual([true]);

    // A different name at the same address is a different person: no restore, the uniqueness rule answers.
    expect((await add("John Back")).status).toBe(409);
    // A conflicting date of birth is not the same individual either.
    expect((await add("Jane Back", "1991-01-01")).status).toBe(409);
    expect((await rows()).map((r) => r.archivedAt !== null)).toEqual([true]);

    // Email and name match but the form has no date of birth: not certain, so staff are asked (security review L1).
    const ask = await add("  jane   BACK ");
    expect(ask.status).toBe(409);
    expect((await ask.json()).archivedMatch).toMatchObject({ id: janeId, name: "Jane Back" });
    expect((await rows()).map((r) => r.archivedAt !== null)).toEqual([true]);

    // Email, name AND the same date of birth: certain, so the record is restored without asking.
    const res = await add("  jane   BACK ", "1990-04-15");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: janeId, restored: true });
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: janeId, archivedAt: null, phone: "+447000000111" }); // the phone the form typed, stored in its normal form
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId: janeId } }))).toBe(1);
    const audit = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: ids.tenant, action: "member.restore", entityId: janeId } }));
    expect(audit?.userId).toBe(ids.owner);
    expect((audit?.metadata as Record<string, unknown>)?.via).toBe("add_member");
  }, 120_000);

  it("Add member with a matching email and name but no date of birth asks; confirming restores, and nothing is duplicated", async () => {
    const kimId = await withRlsBypass(async (tx) => (await tx.member.create({ data: { tenantId: ids.tenant, name: "Kim Back", email: `${STAMP}-kim@example.test`, status: "active" } })).id);
    as(ids.owner, "owner");
    await memberDELETE(req(`/api/members/${kimId}?confirm=1`, "DELETE"), params(kimId));
    const post = async (extra: Record<string, unknown> = {}) => {
      as(ids.owner, "owner");
      const r = new Request("https://test.local/api/members", {
        method: "POST",
        headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
        body: JSON.stringify({ name: "Kim Back", email: `${STAMP}-kim@example.test`, dateOfBirth: "1985-02-02", ...extra }),
      });
      return (await membersPOST(r)) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    };
    const first = await post();
    expect(first.status).toBe(409);
    expect((await first.json()).archivedMatch).toMatchObject({ id: kimId });
    // A confirm naming another record restores nothing.
    expect((await post({ confirmRestoreId: "not-this-one" })).status).toBe(409);
    const confirmed = await post({ confirmRestoreId: kimId });
    expect(confirmed.status).toBe(200);
    const kims = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: ids.tenant, email: `${STAMP}-kim@example.test` }, select: { id: true, archivedAt: true, dateOfBirth: true } }));
    expect(kims).toHaveLength(1);
    expect(kims[0]).toMatchObject({ id: kimId, archivedAt: null });
    expect(kims[0].dateOfBirth?.toISOString().slice(0, 10)).toBe("1985-02-02");
  }, 120_000);

  it("a TeamUp refresh plan read from the database leaves an archived member alone and lists them when TeamUp shows them active", async () => {
    const csv = [
      "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship",
      `Tara Teamup,${STAMP}-tara@example.test,,Adults,recurring,active,Stripe,2026-01-14,2026-01-14,,,Yes,,,,,,,GB,,,,,,,`,
    ].join(String.fromCharCode(10));
    const parsed = parseTeamUp(csv);
    const key = parsed.drafts[0]?.sourceKey;
    expect(key).toBeTruthy();
    const taraId = await withRlsBypass(async (tx) =>
      (await tx.member.create({ data: { tenantId: ids.tenant, name: "Tara Teamup", email: `${STAMP}-tara@example.test`, externalRef: key!, billedBy: "teamup", status: "inactive", paymentStatus: "paid", archivedAt: new Date() } })).id,
    );
    const members = await withTenantContext(ids.tenant, (tx) => tx.member.findMany({ where: { tenantId: ids.tenant, OR: [{ externalRef: { in: [key!] } }, { billedBy: "teamup" }] }, select: REFRESH_MEMBER_SELECT }));
    const plan = planRefresh({ drafts: parsed.drafts, errors: parsed.errors, members, tiers: [], job: { id: "job-x", sourceExportedAt: new Date() } });
    expect(plan.matched.map((c) => c.memberId)).not.toContain(taraId);
    expect(plan.exceptions.archivedInMatFlow).toEqual([{ memberId: taraId, name: "Tara Teamup", teamUpSays: "active" }]);
    // And the rollback of an earlier refresh that touched her keeps her standing.
    const standing = { status: "inactive", paymentStatus: "paid", cancelledAt: null, membershipType: null, membershipTierId: null, billingStatusAsOf: null, billingStatusSource: null };
    const rb = planRefreshRollback([{ memberId: taraId, name: "Tara Teamup", sourceKey: key!, fields: ["status"], before: { ...standing, status: "active" }, after: standing }], members);
    expect(rb.restore).toEqual([]);
    expect(rb.kept[0]?.reasons.join(" ")).toMatch(/archived/);
    const row = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: taraId }, select: { status: true, archivedAt: true } }));
    expect(row?.status).toBe("inactive");
    expect(row?.archivedAt).toBeInstanceOf(Date);
  }, 120_000);

  it("Removing a staff account deactivates it: sessions refused, Activity keeps the author, reactivation restores it", async () => {
    as(ids.owner, "owner");
    const res = (await staffDELETE(req(`/api/staff/${ids.coach}`, "DELETE"), params(ids.coach))) as unknown as { status: number };
    expect(res.status).toBe(200);
    const row = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: ids.coach }, select: { deactivatedAt: true, sessionVersion: true } }));
    expect(row?.deactivatedAt).toBeInstanceOf(Date);
    expect(await checkSessionVersion({ userId: ids.coach, tokenVersion: row!.sessionVersion, tenantId: ids.tenant })).toBe("revoked");
    // Their rows keep their author.
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.tenant, userId: ids.coach } }))).toBeGreaterThan(0);
    expect((await withRlsBypass((tx) => tx.attendanceRecord.findFirst({ where: { memberId: ids.sam }, select: { checkedInById: true } })))?.checkedInById).toBe(ids.coach);

    as(ids.manager, "manager");
    const refused = (await reactivatePOST(req(`/api/staff/${ids.coach}/reactivate`, "POST"), params(ids.coach))) as unknown as { status: number };
    expect(refused.status).toBe(403);

    as(ids.owner, "owner");
    const back = (await reactivatePOST(req(`/api/staff/${ids.coach}/reactivate`, "POST"), params(ids.coach))) as unknown as { status: number };
    expect(back.status).toBe(200);
    const again = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: ids.coach }, select: { deactivatedAt: true, sessionVersion: true } }));
    expect(again?.deactivatedAt).toBeNull();
    expect(await checkSessionVersion({ userId: ids.coach, tokenVersion: again!.sessionVersion, tenantId: ids.tenant })).toBe("ok");
  }, 120_000);
});
