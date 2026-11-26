// The server refuses a staff-register write whose register day has passed
// (25 Nov 2026, Noe; lib/register-day.ts). Every write Mark attendance makes
// carries `registerDay`, the club date its list was read for. With the
// server's clock past the club's midnight (Asia/Makassar, UTC+8), yesterday's
// key is refused 409 REGISTER_DAY_STALE and nothing is written; today's key
// and an absent field go ahead exactly as before; a malformed value is 400.
// Each write path: mark (POST /api/checkin), un-mark (DELETE /api/checkin),
// card (POST /api/checkin/card), cancel and restore (PATCH the instance).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  requireApiStaff: vi.fn(),
  requireApiOwnerOrManager: vi.fn(),
  performCheckin: vi.fn(),
  restorePackCredits: vi.fn(),
  loadCheckinInstance: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  instanceFindFirst: vi.fn(),
  instanceUpdateMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  recordFindMany: vi.fn(),
  recordDeleteMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/api-authz", () => ({ requireApiStaff: m.requireApiStaff, requireApiOwnerOrManager: m.requireApiOwnerOrManager }));
vi.mock("@/lib/checkin", () => ({ performCheckin: m.performCheckin, restorePackCreditsForAttendance: m.restorePackCredits, loadCheckinInstance: m.loadCheckinInstance }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/card-token", () => ({ verifyCardToken: () => ({ ok: true, memberId: "m1", cardVersion: 1 }) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: m.memberFindFirst, findMany: m.memberFindMany },
      classInstance: { findFirst: m.instanceFindFirst, updateMany: m.instanceUpdateMany },
      sessionCover: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) }, // session cover (no rows)
      tenant: { findUnique: m.tenantFindUnique },
      // Session cover: a cancel locks the session row before closing its cover.
      $queryRaw: async () => [{ id: "inst-1" }],
      attendanceRecord: { findMany: m.recordFindMany, deleteMany: m.recordDeleteMany },
    }),
}));

import { POST as markPOST, DELETE as unmarkDELETE } from "@/app/api/checkin/route";
import { POST as cardPOST } from "@/app/api/checkin/card/route";
import { PATCH as instancePATCH } from "@/app/api/classes/[id]/instances/[instanceId]/route";
import { registerDayRefusal } from "@/lib/register-day";

const YESTERDAY = "2026-11-25";
const TODAY = "2026-11-26";
type Res = { status: number; json: () => Promise<Record<string, unknown>> };

const post = (url: string, body: unknown, method = "POST") =>
  new Request(`http://test${url}`, { method, headers: { "Content-Type": "application/json", Origin: "http://test" }, body: JSON.stringify(body) });
const STAFF = { user: { id: "owner-1", role: "owner", tenantId: "t1", email: "o@example.test" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T16:05:00Z")); // 00:05 on 26 November in Makassar; 25 November in UTC
  m.auth.mockResolvedValue(STAFF);
  m.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "t1", userId: "owner-1", role: "owner", session: STAFF });
  m.requireApiOwnerOrManager.mockResolvedValue({ ok: true, tenantId: "t1", userId: "owner-1", role: "owner", session: STAFF });
  m.tenantFindUnique.mockResolvedValue({ timezone: "Asia/Makassar", memberAppCheckin: true });
  m.memberFindFirst.mockResolvedValue({ id: "m1", name: "Ada Example" });
  m.memberFindMany.mockResolvedValue([{ id: "m1", name: "Ada Example", cardVersion: 1 }]);
  m.instanceFindFirst.mockResolvedValue({ id: "inst-1", isCancelled: false, date: new Date("2026-11-25T00:00:00Z"), startTime: "18:00" });
  m.instanceUpdateMany.mockResolvedValue({ count: 1 });
  m.performCheckin.mockResolvedValue({ kind: "success", record: { id: "rec-1" }, coverage: null });
  m.loadCheckinInstance.mockResolvedValue({ id: "inst-1", isCancelled: false, class: { tenant: { timezone: "Asia/Makassar" } } });
  m.recordFindMany.mockResolvedValue([{ id: "rec-1" }]);
  m.recordDeleteMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

const mark = (registerDay?: string) => markPOST(post("/api/checkin", { classInstanceId: "inst-1", memberId: "m1", checkInMethod: "admin", ...(registerDay !== undefined ? { registerDay } : {}) })) as unknown as Promise<Res>;
const unmark = (registerDay?: string) =>
  unmarkDELETE(new Request(`http://test/api/checkin?classInstanceId=inst-1&memberId=m1${registerDay !== undefined ? `&registerDay=${registerDay}` : ""}`, { method: "DELETE", headers: { Origin: "http://test" } })) as unknown as Promise<Res>;
const card = (registerDay?: string) => cardPOST(post("/api/checkin/card", { classInstanceId: "inst-1", tokens: ["tok"], ...(registerDay !== undefined ? { registerDay } : {}) })) as unknown as Promise<Res>;
const setCancelled = (isCancelled: boolean, registerDay?: string) =>
  instancePATCH(post("/api/classes/c1/instances/inst-1", { isCancelled, ...(isCancelled ? { cancellationReason: "Coach ill" } : {}), ...(registerDay !== undefined ? { registerDay } : {}) }, "PATCH"), { params: Promise.resolve({ id: "c1", instanceId: "inst-1" }) }) as unknown as Promise<Res>;

async function expectStale(res: Res) {
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("REGISTER_DAY_STALE");
  expect(body.clubDate).toBe(TODAY);
  expect(body.error).toBe("This register is for Wednesday 25 November. It is now Thursday 26 November at the club. Reload to see today's classes.");
}

describe("mark (POST /api/checkin)", () => {
  it("yesterday's register day after the club's midnight: 409, nothing written", async () => {
    await expectStale(await mark(YESTERDAY));
    expect(m.performCheckin).not.toHaveBeenCalled();
  });
  it("today's register day is accepted; no register day is accepted as before", async () => {
    expect((await mark(TODAY)).status).toBe(201);
    expect((await mark()).status).toBe(201);
    expect(m.performCheckin).toHaveBeenCalledTimes(2);
  });
  it("a malformed register day is a 400, not a pass", async () => {
    for (const bad of ["26/11/2026", "2026-13-40", "2026-02-30", ""]) {
      const res = await mark(bad);
      expect(res.status, bad).toBe(400);
    }
    expect(m.performCheckin).not.toHaveBeenCalled();
  });
  it("authorisation comes first: a member's own check-in with a register day is not a staff write", async () => {
    // Not staff: the staff-only memberId path is refused before the day is looked at.
    m.auth.mockResolvedValue({ user: { id: "u", role: "member", tenantId: "t1", memberId: "m9", email: "m@example.test" } });
    expect((await mark(YESTERDAY)).status).toBe(403);
    expect(m.performCheckin).not.toHaveBeenCalled();
  });
});

describe("un-mark (DELETE /api/checkin)", () => {
  it("yesterday's register day after the club's midnight: 409, nothing read or deleted", async () => {
    await expectStale(await unmark(YESTERDAY));
    expect(m.recordFindMany).not.toHaveBeenCalled();
    expect(m.recordDeleteMany).not.toHaveBeenCalled();
  });
  it("today's register day and no register day are accepted", async () => {
    expect((await unmark(TODAY)).status).toBe(200);
    expect((await unmark()).status).toBe(200);
    expect(m.recordDeleteMany).toHaveBeenCalledTimes(2);
  });
  it("a malformed register day is a 400", async () => {
    expect((await unmark("yesterday")).status).toBe(400);
    expect(m.recordDeleteMany).not.toHaveBeenCalled();
  });
});

describe("card (POST /api/checkin/card)", () => {
  it("yesterday's register day after the club's midnight: 409, no card recorded", async () => {
    await expectStale(await card(YESTERDAY));
    expect(m.performCheckin).not.toHaveBeenCalled();
  });
  it("today's register day and no register day are accepted", async () => {
    expect((await card(TODAY)).status).toBe(200);
    expect((await card()).status).toBe(200);
    expect(m.performCheckin).toHaveBeenCalledTimes(2);
  });
  it("a malformed register day is a 400", async () => {
    expect((await card("2026-1-5")).status).toBe(400);
    expect(m.performCheckin).not.toHaveBeenCalled();
  });
});

describe("cancel and restore (PATCH /api/classes/[id]/instances/[instanceId])", () => {
  it("cancel with yesterday's register day after the club's midnight: 409, nothing updated", async () => {
    await expectStale(await setCancelled(true, YESTERDAY));
    expect(m.instanceUpdateMany).not.toHaveBeenCalled();
  });
  it("restore with yesterday's register day after the club's midnight: 409, nothing updated", async () => {
    m.instanceFindFirst.mockResolvedValue({ id: "inst-1", isCancelled: true, date: new Date("2026-11-25T00:00:00Z"), startTime: "18:00" });
    await expectStale(await setCancelled(false, YESTERDAY));
    expect(m.instanceUpdateMany).not.toHaveBeenCalled();
  });
  it("today's register day and no register day (the timetable) are accepted", async () => {
    expect((await setCancelled(true, TODAY)).status).toBe(200);
    expect((await setCancelled(true)).status).toBe(200);
    expect(m.instanceUpdateMany).toHaveBeenCalledTimes(2);
  });
  it("ownership comes first: another club's session is a bare 404 whatever the register day", async () => {
    m.instanceFindFirst.mockResolvedValue(null);
    expect((await setCancelled(true, YESTERDAY)).status).toBe(404);
    expect(m.tenantFindUnique).not.toHaveBeenCalled();
  });
  it("a malformed register day is a 400", async () => {
    expect((await setCancelled(true, "tomorrow")).status).toBe(400);
    expect(m.instanceUpdateMany).not.toHaveBeenCalled();
  });
});

describe("registerDayRefusal", () => {
  it("the club's date is the server's clock in the club's zone, not UTC", () => {
    // 2026-11-25T16:05Z: still the 25th in UTC, already the 26th in Makassar.
    expect(registerDayRefusal("2026-11-26", "Asia/Makassar")).toBeNull();
    expect(registerDayRefusal("2026-11-25", "Asia/Makassar")?.status).toBe(409);
    expect(registerDayRefusal("2026-11-25", "Europe/London")).toBeNull();
    expect(registerDayRefusal(undefined, "Asia/Makassar")).toBeNull();
  });
});
