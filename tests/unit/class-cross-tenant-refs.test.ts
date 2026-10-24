/**
 * Findings E-1, E-2 and E-3 (cross-tenant matrix, 6 Oct 2026), pinned at the
 * unit level so the ordering and the predicates cannot drift back:
 *
 *   E-1  PATCH /api/classes/[id] proves ownership BEFORE any subscription read,
 *        and both subscription reads are scoped through `member: { tenantId }`.
 *   E-2  rank, coach and location ids in a class body must be the caller's
 *        (lib/class-refs.ts), refused with 400 before anything is written, in
 *        both PATCH and POST. Roster ids are filtered to the caller's members.
 *   E-3  DELETE /api/ranks/[id] proves ownership before counting, and the
 *        belt-holder count is scoped through the member.
 *
 * The DB-backed proof is tests/integration/cross-tenant-authorisation-matrix.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  class: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  // count: a rank gate clears the roster, so the PATCH asks whether one existed (T6d).
  classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
  classInstance: { createMany: vi.fn() },
  // findMany: D2 resolves rank orders (lib/booking-eligibility-db readRankOrders), tenant-scoped.
  rankSystem: { findFirst: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  attendanceRecord: { groupBy: vi.fn().mockResolvedValue([]) },
  memberRank: { count: vi.fn() },
  member: { findMany: vi.fn() },
  user: { findFirst: vi.fn() },
  location: { findFirst: vi.fn() },
  tenant: { findUnique: vi.fn(), findFirst: vi.fn() },
  // T6a: the PATCH write transaction opens with a Class row lock.
  $queryRaw: vi.fn().mockResolvedValue([{ id: "c1" }]),
  classMembershipTier: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
  membershipTier: { findMany: vi.fn().mockResolvedValue([]) },
}));
const mockAuth = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(db)),
}));

import { classRefError, CLASS_REF_ERRORS } from "@/lib/class-refs";
import { PATCH } from "@/app/api/classes/[id]/route";
import { POST } from "@/app/api/classes/route";
import { DELETE as deleteRank } from "@/app/api/ranks/[id]/route";

const T = "tenant_a";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, qs = "") =>
  PATCH(new Request(`http://test/api/classes/c1${qs}`, { method: "PATCH", body: JSON.stringify(body) }), params("c1"));
const post = (body: unknown) =>
  POST(new Request("http://test/api/classes", { method: "POST", body: JSON.stringify(body) }));

/** A lookup that only finds ids in `ours`, and only when asked within tenant T. */
const tenantLookup = (ours: string[]) =>
  async ({ where }: { where: { id: string; tenantId: string } }) =>
    where.tenantId === T && ours.includes(where.id) ? { id: where.id } : null;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "owner", tenantId: T } });
  db.class.findFirst.mockResolvedValue({ id: "c1", tenantId: T });
  db.class.updateMany.mockResolvedValue({ count: 1 });
  db.classRoster.deleteMany.mockResolvedValue({ count: 0 });
  db.classRoster.createMany.mockResolvedValue({ count: 0 });
  db.classSubscription.findMany.mockResolvedValue([]);
  db.classSubscription.deleteMany.mockResolvedValue({ count: 0 });
  db.rankSystem.findFirst.mockImplementation(tenantLookup(["rank_a"]));
  db.rankSystem.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] }; tenantId: string } }) =>
    where.tenantId === T ? where.id.in.filter((id) => id === "rank_a").map((id) => ({ id, order: 1 })) : [],
  );
  db.member.findMany.mockResolvedValue([]);
  db.user.findFirst.mockImplementation(tenantLookup(["coach_a"]));
  db.location.findFirst.mockImplementation(tenantLookup(["loc_a"]));
  db.member.findMany.mockResolvedValue([]);
});

describe("classRefError (lib/class-refs.ts)", () => {
  const tx = db as never;

  it("accepts the club's own ids and skips null / undefined", async () => {
    expect(await classRefError(tx, T, { requiredRankId: "rank_a", maxRankId: null, coachUserId: "coach_a", locationId: "loc_a" })).toBeNull();
    expect(await classRefError(tx, T, {})).toBeNull();
  });

  it("refuses each foreign id with its own message", async () => {
    expect(await classRefError(tx, T, { requiredRankId: "rank_b" })).toBe(CLASS_REF_ERRORS.rank);
    expect(await classRefError(tx, T, { maxRankId: "rank_b" })).toBe(CLASS_REF_ERRORS.rank);
    expect(await classRefError(tx, T, { coachUserId: "coach_b" })).toBe(CLASS_REF_ERRORS.coach);
    expect(await classRefError(tx, T, { locationId: "loc_b" })).toBe(CLASS_REF_ERRORS.location);
  });

  it("puts the caller's tenantId on every lookup", async () => {
    await classRefError(tx, T, { requiredRankId: "rank_a", maxRankId: "rank_a", coachUserId: "coach_a", locationId: "loc_a" });
    for (const fn of [db.rankSystem.findFirst, db.user.findFirst, db.location.findFirst]) {
      for (const [args] of fn.mock.calls) expect(args.where.tenantId).toBe(T);
    }
  });
});

describe("PATCH /api/classes/[id] — E-1 ownership first", () => {
  it("dry run of another club's class is 404 and reads no subscriptions", async () => {
    db.class.findFirst.mockResolvedValue(null);
    const res = await patch({ roster: [] }, "?dryRun=1");
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty("affectedMemberIds");
    expect(db.classSubscription.findMany).not.toHaveBeenCalled();
  });

  it("a real edit of another club's class is 404 and writes nothing", async () => {
    db.class.findFirst.mockResolvedValue(null);
    const res = await patch({ name: "x", roster: [] });
    expect(res.status).toBe(404);
    expect(db.classSubscription.findMany).not.toHaveBeenCalled();
    expect(db.classRoster.deleteMany).not.toHaveBeenCalled();
    expect(db.class.updateMany).not.toHaveBeenCalled();
  });

  it("the ownership check carries the caller's tenantId", async () => {
    await patch({ name: "x" });
    expect(db.class.findFirst.mock.calls[0][0].where).toMatchObject({ id: "c1", tenantId: T });
  });

  it("both subscription lookups are scoped through the member's tenant", async () => {
    db.rankSystem.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) =>
      where.tenantId === T && where.id === "rank_a" ? { id: "rank_a", order: 1, discipline: "BJJ" } : null,
    );
    await patch({ requiredRankId: "rank_a" }, "?dryRun=1");
    await patch({ roster: [] }, "?dryRun=1");
    expect(db.classSubscription.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of db.classSubscription.findMany.mock.calls) {
      expect(args.where).toMatchObject({ classId: "c1", member: { tenantId: T } });
    }
    // D2: the preview's population read and rank lookups are the caller's club only.
    for (const [args] of db.member.findMany.mock.calls) expect(args.where).toMatchObject({ tenantId: T });
    for (const [args] of db.rankSystem.findMany.mock.calls) expect(args.where).toMatchObject({ tenantId: T });
  });
});

describe("PATCH /api/classes/[id] — E-2 foreign ids", () => {
  it.each([
    ["requiredRankId", "rank_b", CLASS_REF_ERRORS.rank],
    ["maxRankId", "rank_b", CLASS_REF_ERRORS.rank],
    ["coachUserId", "coach_b", CLASS_REF_ERRORS.coach],
    ["locationId", "loc_b", CLASS_REF_ERRORS.location],
  ])("refuses another club's %s with 400 before any write", async (field, value, message) => {
    const res = await patch({ [field]: value });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
    expect(db.classRoster.deleteMany).not.toHaveBeenCalled();
    expect(db.classSubscription.deleteMany).not.toHaveBeenCalled();
    expect(db.class.updateMany).not.toHaveBeenCalled();
  });

  it("a foreign rank gate on a dry run is refused too (no subscriber list)", async () => {
    const res = await patch({ requiredRankId: "rank_b" }, "?dryRun=1");
    expect(res.status).toBe(400);
    expect(db.classSubscription.findMany).not.toHaveBeenCalled();
  });

  it("writes the club's own coach and belt", async () => {
    const res = await patch({ requiredRankId: "rank_a", coachUserId: "coach_a" });
    expect(res.status).toBe(200);
    expect(db.class.updateMany.mock.calls[0][0].data).toMatchObject({ requiredRankId: "rank_a", coachUserId: "coach_a" });
  });

  it("a roster keeps only the caller's members", async () => {
    db.member.findMany.mockResolvedValue([{ id: "mem_a" }]);
    const res = await patch({ roster: [{ memberId: "mem_a" }, { memberId: "mem_b" }] });
    expect(res.status).toBe(200);
    expect(db.member.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: T });
    expect(db.classRoster.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: T, classId: "c1", memberId: "mem_a", addedByUserId: "u1" }],
      skipDuplicates: true,
    });
  });
});

describe("POST /api/classes — E-2 foreign ids", () => {
  const base = { name: "Fundamentals", duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] };

  it.each([
    ["requiredRankId", "rank_b", CLASS_REF_ERRORS.rank],
    ["maxRankId", "rank_b", CLASS_REF_ERRORS.rank],
    ["coachUserId", "coach_b", CLASS_REF_ERRORS.coach],
    ["locationId", "loc_b", CLASS_REF_ERRORS.location],
  ])("refuses another club's %s with 400 and creates nothing", async (field, value, message) => {
    const res = await post({ ...base, [field]: value });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
    expect(db.class.create).not.toHaveBeenCalled();
  });

  it("opens no lookup transaction when the body names no foreign id", async () => {
    db.tenant.findUnique.mockResolvedValue({ timezone: "Europe/London" });
    db.class.create.mockResolvedValue({ id: "c-new", name: "Fundamentals", schedules: [] });
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(db.rankSystem.findFirst).not.toHaveBeenCalled();
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/ranks/[id] — E-3", () => {
  const del = (id: string) => deleteRank(new Request(`http://test/api/ranks/${id}`, { method: "DELETE" }), params(id));

  it("another club's belt is 404 and nothing is counted", async () => {
    const res = await del("rank_b");
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty("memberRankCount");
    expect(db.class.count).not.toHaveBeenCalled();
    expect(db.memberRank.count).not.toHaveBeenCalled();
    expect(db.rankSystem.updateMany).not.toHaveBeenCalled();
  });

  it("the belt-holder count on the club's own belt is scoped through the member", async () => {
    db.class.count.mockResolvedValue(1);
    db.memberRank.count.mockResolvedValue(3);
    const res = await del("rank_a");
    expect(res.status).toBe(409);
    expect(db.memberRank.count.mock.calls[0][0].where).toEqual({ rankSystemId: "rank_a", member: { tenantId: T } });
  });
});
