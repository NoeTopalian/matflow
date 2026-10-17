// T7: booking (POST /api/member/class-subscriptions/[classId]) refuses a
// member whose plan allowance is used up, with the same sentence the member
// app's check-in gives. A booking is a standing place, so it is judged at the
// class's next session that has not started yet (or now, if none is
// scheduled), after the same Class row lock.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  queryRaw: vi.fn(),
  instanceFindMany: vi.fn(),
  subCreate: vi.fn(),
  cRow: null as unknown,
  cValues: [] as unknown[],
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      $queryRaw: h.queryRaw,
      classMembershipTier: { findMany: vi.fn(async () => []) },
      classRoster: { count: vi.fn(async () => 0), findFirst: vi.fn() },
      member: { findFirst: vi.fn() },
      classSubscription: { create: h.subCreate, count: vi.fn(async () => 0), deleteMany: vi.fn() },
      tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
      classInstance: { findMany: h.instanceFindMany },
    }),
}));

import { POST } from "@/app/api/member/class-subscriptions/[classId]/route";

const DAY = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();
const FOUR_VISITS = [
  { d: DAY("2026-10-05"), s: "18:00" },
  { d: DAY("2026-10-12"), s: "07:00" },
  { d: DAY("2026-10-12"), s: "18:00" },
  { d: DAY("2026-10-14"), s: "18:00" },
];
const book = async () => (await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "c-1" }) }))!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Saturday 17 Oct 2026, 13:00 in London.
  vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
  h.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "m-1" } });
  h.cRow = { classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: null, alreadyIn: false, visits: FOUR_VISITS };
  h.queryRaw.mockImplementation(async (strings: string[], ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes('FROM "Class"')) {
      return [{ id: "c-1", name: "Fundamentals", maxCapacity: null, isActive: true, deletedAt: null, sourceImportJobId: null }];
    }
    h.cValues = values;
    return [h.cRow];
  });
  h.instanceFindMany.mockResolvedValue([
    // Earlier today: already started, so not the one a booking is judged at.
    { id: "ci-past", date: new Date("2026-10-17T00:00:00.000Z"), startTime: "10:00" },
    { id: "ci-next", date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00" },
  ]);
  h.subCreate.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe("booking - plan allowance", () => {
  it("refuses with the count and the date the next class frees up, and books nothing", async () => {
    const res = await book();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "4 of 4 classes used in the last 4 weeks; next free on Monday 2 November from 18:00. Ask staff if you need to train before then.",
      reason: "allowance_reached",
    });
    expect(h.subCreate).not.toHaveBeenCalled();
  });

  it("is judged at the class's next session that has not started (excluded from its own count)", async () => {
    await book();
    expect(h.cValues).toContain("ci-next");
    expect(h.cValues).not.toContain("ci-past");
  });

  it("books while the rolling total is within the allowance", async () => {
    h.cRow = { classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: null, alreadyIn: false, visits: FOUR_VISITS.slice(1) };
    expect((await book()).status).toBe(201);
    expect(h.subCreate).toHaveBeenCalled();
  });

  it("an Unlimited plan books as before", async () => {
    h.cRow = { classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null, alreadyIn: false, visits: FOUR_VISITS };
    expect((await book()).status).toBe(201);
  });

  it("with no session scheduled, it is judged at now", async () => {
    h.instanceFindMany.mockResolvedValue([]);
    // Window ending Sat 17 Oct 13:00 still holds all four visits.
    expect((await book()).status).toBe(403);
    expect(h.cValues).toContain("");
  });
});
