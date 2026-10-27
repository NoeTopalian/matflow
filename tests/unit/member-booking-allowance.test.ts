// T7 (owner decision, 20 Oct 2026): booking (POST /api/member/class-subscriptions/
// [classId]) is NEVER refused for the plan allowance. A booking consumes
// nothing and guarantees nothing — only confirmed attendance counts — so the
// booking stands, and when the period of the class's next session is already
// used up the 201 body carries `allowanceNotice`: what the door will say. The
// notice is judged at the class's next session that has not started yet (or
// now, if none is scheduled), after the same Class row lock.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  queryRaw: vi.fn(),
  instanceFindMany: vi.fn(),
  subCreate: vi.fn(),
  subFindFirst: vi.fn(),
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
      classSubscription: { create: h.subCreate, count: vi.fn(async () => 0), deleteMany: vi.fn(), findFirst: h.subFindFirst },
      tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
      classInstance: { findMany: h.instanceFindMany },
    }),
}));

import { POST } from "@/app/api/member/class-subscriptions/[classId]/route";

const DAY = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();
/** 4 every 4 weeks from Monday 28 September: the next session (Mon 19 Oct) is in 28 Sep – 26 Oct. */
const FOUR_IN_FOUR = { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-09-28", maxClassesPerWeek: null };
const FOUR_VISITS = [
  { d: DAY("2026-10-05"), s: "18:00" },
  { d: DAY("2026-10-12"), s: "07:00" },
  { d: DAY("2026-10-12"), s: "18:00" },
  { d: DAY("2026-10-14"), s: "18:00" },
];
const NOTICE =
  "4 of 4 classes used this 4-week period. Booking doesn't use a class, but checking in before Monday 26 October will need a class-pack credit. For further information, please speak to a coach.";
const book = async () => (await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "c-1" }) }))!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Saturday 17 Oct 2026, 13:00 in London.
  vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
  h.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "m-1" } });
  h.cRow = { ...FOUR_IN_FOUR, alreadyIn: false, visits: FOUR_VISITS };
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
  h.subFindFirst.mockResolvedValue(null);
  h.cValues = [];
});
afterEach(() => vi.useRealTimers());

describe("booking - plan allowance (never a refusal)", () => {
  it("books even when the period is used up, and says what the door will say", async () => {
    const res = await book();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, classId: "c-1", allowanceNotice: NOTICE });
    expect(h.subCreate).toHaveBeenCalledTimes(1);
  });

  it("the notice is judged at the class's next session that has not started (excluded from its own count)", async () => {
    await book();
    expect(h.cValues).toContain("ci-next");
    expect(h.cValues).not.toContain("ci-past");
  });

  it("within the allowance: booked, no notice", async () => {
    h.cRow = { ...FOUR_IN_FOUR, alreadyIn: false, visits: FOUR_VISITS.slice(1) };
    const res = await book();
    expect(res.status).toBe(201);
    expect((await res.json()).allowanceNotice).toBeNull();
    expect(h.subCreate).toHaveBeenCalled();
  });

  it("an Unlimited plan books as before, no notice", async () => {
    h.cRow = { classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null, alreadyIn: false, visits: FOUR_VISITS };
    const res = await book();
    expect(res.status).toBe(201);
    expect((await res.json()).allowanceNotice).toBeNull();
  });

  it("a member who already holds the booking keeps the idempotent success (a re-tap is not re-judged)", async () => {
    h.subFindFirst.mockResolvedValue({ id: "sub-1" });
    const res = await book();
    expect(res.status).toBe(201);
    expect(h.subCreate).not.toHaveBeenCalled();
    expect(h.cValues).toEqual([]);
  });

  it("past the allowance (a lowered limit) the notice never reads 6 of 4", async () => {
    h.cRow = {
      ...FOUR_IN_FOUR, alreadyIn: false,
      visits: [...FOUR_VISITS, { d: DAY("2026-10-15"), s: "18:00" }, { d: DAY("2026-10-16"), s: "18:00" }],
    };
    const body = (await (await book()).json()) as { allowanceNotice: string };
    expect(body.allowanceNotice).toMatch(/^4 of 4 classes used this 4-week period \(6 recorded\)\. Booking doesn't use a class/);
  });

  it("with no session scheduled, the notice is judged at now", async () => {
    h.instanceFindMany.mockResolvedValue([]);
    // Sat 17 Oct is in the same period as the four visits.
    const res = await book();
    expect(res.status).toBe(201);
    expect((await res.json()).allowanceNotice).toBe(NOTICE);
    expect(h.cValues).toContain("");
  });

  it("a fault computing the notice never fails the booking", async () => {
    h.instanceFindMany.mockRejectedValue(new Error("boom"));
    const res = await book();
    expect(res.status).toBe(201);
    expect((await res.json()).allowanceNotice).toBeNull();
    expect(h.subCreate).toHaveBeenCalledTimes(1);
  });

  it("the route has no allowance refusal at all (static guard)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/member/class-subscriptions/[classId]/route.ts"), "utf8");
    expect(src).not.toMatch(/reason:\s*"allowance_reached"/);
    expect(src).not.toMatch(/allowanceRefusalSentence|allowanceBookingSentence/);
  });
});
