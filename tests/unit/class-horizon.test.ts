// The session horizon topped up from the member read side (Round 9, 16 Nov 2026): lib/class-horizon.ts.
// Pins: it generates from the CLUB's day over ROLLING_WINDOW_DAYS with skipDuplicates; one server instance tops a club up
// at most once per HORIZON_TOP_UP_INTERVAL_MS; a failure never throws into the read; the cron's deadline stops between
// batches; and the cron and the member routes call the same function.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  createMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_tenantId: string, fn: (tx: unknown) => Promise<T>) =>
    fn({ class: { findMany: h.findMany }, classInstance: { createMany: h.createMany }, tenant: { findUnique: h.findUnique } }),
}));

import {
  ensureClassHorizon,
  generateClassHorizon,
  HORIZON_INSERT_BATCH,
  HORIZON_RETRY_AFTER_FAILURE_MS,
  HORIZON_TOP_UP_INTERVAL_MS,
  resetClassHorizonMemoForTests,
} from "@/lib/class-horizon";
import { ROLLING_WINDOW_DAYS } from "@/lib/class-instances";

const NOW = new Date("2026-11-16T10:00:00Z");
const oneClass = [{ id: "c1", schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00", startDate: null, endDate: null }] }];

beforeEach(() => {
  vi.clearAllMocks();
  resetClassHorizonMemoForTests();
  h.findUnique.mockResolvedValue({ timezone: "Europe/London", subscriptionStatus: "active", deletedAt: null });
  h.findMany.mockResolvedValue(oneClass);
  h.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
});

describe("generateClassHorizon", () => {
  it("inserts the rolling window's occurrences with skipDuplicates, only for active undeleted classes", async () => {
    const from = new Date("2026-11-16T00:00:00Z");
    const out = await generateClassHorizon("t1", from);
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", isActive: true, deletedAt: null } }));
    const { data, skipDuplicates } = h.createMany.mock.calls[0][0] as { data: { date: Date }[]; skipDuplicates: boolean };
    expect(skipDuplicates).toBe(true);
    expect(data).toHaveLength(Math.ceil(ROLLING_WINDOW_DAYS / 7));
    expect(out).toEqual({ created: data.length });
  });

  it("stops between batches when told to, reporting partial", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, schedules: oneClass[0].schedules }));
    h.findMany.mockResolvedValue(many); // 80 classes × 8 weeks = 640 rows: two batches
    expect(80 * 8).toBeGreaterThan(HORIZON_INSERT_BATCH);
    let calls = 0;
    const out = await generateClassHorizon("t1", new Date("2026-11-16T00:00:00Z"), () => calls++ >= 1);
    expect(h.createMany).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ created: HORIZON_INSERT_BATCH, partial: true });
  });
});

describe("ensureClassHorizon", () => {
  it("tops a club up once per interval per server instance, then again after it", async () => {
    await ensureClassHorizon("t1", NOW);
    await ensureClassHorizon("t1", new Date(NOW.getTime() + HORIZON_TOP_UP_INTERVAL_MS - 1));
    expect(h.createMany).toHaveBeenCalledTimes(1);
    await ensureClassHorizon("t1", new Date(NOW.getTime() + HORIZON_TOP_UP_INTERVAL_MS));
    expect(h.createMany).toHaveBeenCalledTimes(2);
  });

  it("each club separately", async () => {
    await ensureClassHorizon("t1", NOW);
    await ensureClassHorizon("t2", NOW);
    expect(h.createMany).toHaveBeenCalledTimes(2);
  });

  it("starts from the club's calendar day", async () => {
    h.findUnique.mockResolvedValue({ timezone: "Pacific/Auckland", subscriptionStatus: "active", deletedAt: null }); // 16 Nov 12:00Z is 01:00 on 17 Nov there (UTC+13)
    await ensureClassHorizon("t1", new Date("2026-11-16T12:00:00Z"));
    const { data } = h.createMany.mock.calls[0][0] as { data: { date: Date }[] };
    expect(data.every((r) => r.date.getTime() >= Date.UTC(2026, 10, 17))).toBe(true);
  });

  it("never throws; after a failure the next reads wait HORIZON_RETRY_AFTER_FAILURE_MS before trying again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.createMany.mockRejectedValueOnce(new Error("Connection terminated"));
    await expect(ensureClassHorizon("t1", NOW)).resolves.toBeUndefined();
    await ensureClassHorizon("t1", new Date(NOW.getTime() + HORIZON_RETRY_AFTER_FAILURE_MS - 1));
    expect(h.createMany).toHaveBeenCalledTimes(1);
    await ensureClassHorizon("t1", new Date(NOW.getTime() + HORIZON_RETRY_AFTER_FAILURE_MS));
    expect(h.createMany).toHaveBeenCalledTimes(2);
  });

  it("concurrent first reads share one run", async () => {
    await Promise.all([ensureClassHorizon("t1", NOW), ensureClassHorizon("t1", NOW), ensureClassHorizon("t1", NOW)]);
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.createMany).toHaveBeenCalledTimes(1);
  });

  it("a club the doors refuse (suspended, cancelled, deleted) is not topped up", async () => {
    for (const t of [{ subscriptionStatus: "suspended", deletedAt: null }, { subscriptionStatus: "cancelled", deletedAt: null }, { subscriptionStatus: "active", deletedAt: new Date() }]) {
      resetClassHorizonMemoForTests();
      h.findUnique.mockResolvedValue({ timezone: "UTC", ...t });
      await ensureClassHorizon("t1", NOW);
    }
    expect(h.findMany).not.toHaveBeenCalled();
    h.findUnique.mockResolvedValue({ timezone: "UTC", subscriptionStatus: "past_due", deletedAt: null });
    resetClassHorizonMemoForTests();
    await ensureClassHorizon("t1", NOW);
    expect(h.createMany).toHaveBeenCalledTimes(1); // past due still opens the doors, so its members' sessions exist
  });

  it("a club that no longer exists is left alone", async () => {
    h.findUnique.mockResolvedValue(null);
    await ensureClassHorizon("gone", NOW);
    expect(h.findMany).not.toHaveBeenCalled();
  });
});

describe("one generator for the cron and the member reads", () => {
  it("the cron and every member and kiosk read that lists sessions call lib/class-horizon", () => {
    expect(readFileSync("app/api/cron/class-instances/route.ts", "utf8")).toMatch(/generateClassHorizon\(/);
    for (const f of [
      "app/api/member/schedule/route.ts",
      "app/api/member/me/children/route.ts",
      "app/api/member/class-subscriptions/[classId]/route.ts",
      "app/api/member/home/route.ts",
      "app/api/kiosk/[token]/classes/route.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/await ensureClassHorizon\(/);
    }
  });
});
