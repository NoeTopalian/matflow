// GET /api/coach/today says which session the staff register opens on, from
// the CLUB's clock (25 Nov 2026). The clock is fixed here; the club is in
// Asia/Makassar (UTC+8) so a server or phone running on UTC would get every
// case wrong.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, headers: init?.headers ?? {}, json: async () => body }) },
}));

const { requireApiStaffMock, tenantFindUniqueMock, instanceFindManyMock, classFindManyMock, instanceCreateManyMock } = vi.hoisted(() => ({
  requireApiStaffMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  instanceFindManyMock: vi.fn(),
  classFindManyMock: vi.fn(),
  instanceCreateManyMock: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: requireApiStaffMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: tenantFindUniqueMock },
      class: { findMany: classFindManyMock },
      classInstance: { findMany: instanceFindManyMock, createMany: instanceCreateManyMock },
      sessionCover: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) }, // session cover (no rows)
    }),
}));

import { GET } from "@/app/api/coach/today/route";

const MARKER = new Date("2026-11-25T00:00:00Z"); // Wednesday 25 November, the club's day
type Opt = { mat?: [string, number]; coachUserId?: string; isCancelled?: boolean };
const inst = (id: string, startTime: string, endTime: string, o: Opt = {}) => ({
  id, date: MARKER, startTime, endTime, isCancelled: o.isCancelled ?? false, cancellationReason: null,
  class: {
    id: `class-${id}`, name: id, location: null, coachName: null, instructorId: null, coachUserId: o.coachUserId ?? null, maxCapacity: null, color: null,
    mat: o.mat ? { name: o.mat[0], sortOrder: o.mat[1] } : null, _count: { rosterMembers: 0 },
  },
  _count: { attendances: 0, waitlists: 0 },
});

const DAY = [
  inst("am", "06:30", "07:30"),
  inst("five", "17:00", "18:00", { mat: ["Mat 1", 0] }),
  inst("six-mat2", "18:00", "19:00", { mat: ["Mat 2", 1], coachUserId: "coach-1" }),
  inst("six-mat1", "18:00", "19:00", { mat: ["Mat 1", 0] }),
  inst("late", "19:30", "20:30", { mat: ["Mat 1", 0] }),
];

type Row = { id: string; auto?: string; onNowCount?: number; matName: string | null; matOrder: number | null; isMine: boolean };
/** The route's answer with the club's wall clock at `clubTime` (Makassar is UTC+8, no DST). */
async function at(clubTime: string, opts: { userId?: string; support?: boolean; rows?: unknown[] } = {}): Promise<Row[]> {
  requireApiStaffMock.mockResolvedValue({
    ok: true, tenantId: "t1", userId: opts.userId ?? "someone-else", role: "coach",
    session: { user: { id: opts.userId ?? "someone-else", tenantId: "t1", ...(opts.support ? { impersonatedBy: "operator-1" } : {}) } },
  });
  instanceFindManyMock.mockResolvedValue(opts.rows ?? DAY);
  const [h, m] = clubTime.split(":").map(Number);
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 25, h - 8, m)));
  return (await GET()).json();
}
const chosen = (rows: Row[]) => rows.filter((r) => r.auto).map((r) => `${r.id}:${r.auto}`);

beforeEach(() => {
  vi.useFakeTimers();
  tenantFindUniqueMock.mockResolvedValue({ timezone: "Asia/Makassar" });
  classFindManyMock.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/coach/today — which session the register opens on", () => {
  it("before opening: the first class, up next", async () => {
    expect(chosen(await at("05:00"))).toEqual(["am:up_next"]);
  });

  it("during a class: that class, on now", async () => {
    expect(chosen(await at("17:30"))).toEqual(["five:on_now"]);
  });

  it("the exact boundary between back-to-back classes: the class starting", async () => {
    expect(chosen(await at("17:59"))).toEqual(["five:on_now"]);
    // 18:00: two start together; nobody's own, so the club's mat order decides.
    const rows = await at("18:00");
    expect(chosen(rows)).toEqual(["six-mat1:on_now"]);
    expect(rows.find((r) => r.auto)?.onNowCount).toBe(2);
  });

  it("a gap: the next class, not the one just finished", async () => {
    expect(chosen(await at("08:00"))).toEqual(["five:up_next"]);
    expect(chosen(await at("19:10"))).toEqual(["late:up_next"]);
  });

  it("two on now on two mats: the signed-in coach's own class", async () => {
    expect(chosen(await at("18:20", { userId: "coach-1" }))).toEqual(["six-mat2:on_now"]);
  });

  it("a support session is not that account's coach: mat order decides, though the row is still marked as the account's", async () => {
    const rows = await at("18:20", { userId: "coach-1", support: true });
    expect(chosen(rows)).toEqual(["six-mat1:on_now"]);
    expect(rows.find((r) => r.id === "six-mat2")?.isMine).toBe(true);
  });

  it("after closing: the class that ended most recently, never tomorrow", async () => {
    expect(chosen(await at("22:00"))).toEqual(["late:last_today"]);
  });

  it("never a cancelled class, and none at all when nothing is eligible", async () => {
    const rows = [inst("off", "18:00", "19:00", { isCancelled: true }), inst("next", "20:00", "21:00")];
    expect(chosen(await at("18:20", { rows }))).toEqual(["next:up_next"]);
    expect(chosen(await at("18:20", { rows: [rows[0]] }))).toEqual([]);
    expect(await at("18:20", { rows: [] })).toEqual([]);
  });

  it("each session carries its mat and the mat's place in the club's order", async () => {
    const rows = await at("12:00");
    expect(rows.find((r) => r.id === "six-mat2")).toMatchObject({ matName: "Mat 2", matOrder: 1 });
    expect(rows.find((r) => r.id === "am")).toMatchObject({ matName: null, matOrder: null });
  });

  it("the answer says which club date the list is for, and the server's clock, as headers (the body stays an array)", async () => {
    requireApiStaffMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u", role: "coach", session: { user: { id: "u", tenantId: "t1" } } });
    instanceFindManyMock.mockResolvedValue(DAY);
    // 00:30 on 25 November in Makassar is still 24 November in UTC.
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 24, 16, 30)));
    const res = (await GET()) as unknown as { headers: Record<string, string>; json: () => Promise<unknown> };
    expect(res.headers["X-Club-Date"]).toBe("2026-11-25");
    expect(res.headers["X-Club-Zone"]).toBe("Asia/Makassar");
    expect(Number(res.headers["X-Server-Time"])).toBe(Date.UTC(2026, 10, 24, 16, 30));
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("two rows for one class at one start: the list is read in id order, and the live one is kept, else the lower id", async () => {
    // A legacy duplicate: the same class written twice for the day. The cancelled twin has the lower id.
    const twin = (id: string, isCancelled: boolean) => ({ ...inst(id, "18:00", "19:00", { isCancelled }), class: { ...inst("dup", "18:00", "19:00").class } });
    const rows = await at("18:20", { rows: [twin("x1", true), twin("x2", false)] });
    expect(instanceFindManyMock.mock.calls.at(-1)?.[0].orderBy).toEqual([{ startTime: "asc" }, { id: "asc" }]);
    expect(rows.map((r) => r.id)).toEqual(["x2"]);
    expect(chosen(rows)).toEqual(["x2:on_now"]);
    // Neither cancelled: the lower id, on every request.
    expect((await at("18:20", { rows: [twin("y1", false), twin("y2", false)] })).map((r) => r.id)).toEqual(["y1"]);
  });
});
