// Round 3 (10 Nov 2026): the AI monthly report's period is the club's previous
// month (Tenant.timezone), and so is the month before it that the report
// compares against. Both routes used the server process's months (UTC on
// Vercel), so a BST club's month started an hour late.

import { vi, describe, it, expect } from "vitest";

const checkInWindows: { gte?: Date; lte?: Date; lt?: Date }[] = [];

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_tenantId: string, fn: (tx: unknown) => Promise<T>) =>
    fn({
      member: { count: async () => 0, findMany: async () => [] },
      tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
      memberStatusEvent: { findMany: async () => [] },
      importedMembership: { findMany: async () => [] },
      attendanceRecord: {
        count: async ({ where }: { where: { checkInTime: { gte?: Date; lte?: Date; lt?: Date } } }) => {
          checkInWindows.push(where.checkInTime);
          return 0;
        },
      },
      class: { count: async () => 0 },
    }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

import { generateMonthlyReport } from "@/lib/ai-causal-report";
import { previousClubMonthPeriod } from "@/lib/club-month";

const iso = (d: Date | undefined) => d?.toISOString();

describe("previousClubMonthPeriod", () => {
  it("London, 10 November: October, from 23:00 UTC on 30 September (BST) to the last millisecond before 1 November (GMT)", () => {
    const p = previousClubMonthPeriod(new Date("2026-11-10T08:00:00Z"), "Europe/London");
    expect(iso(p.periodStart)).toBe("2026-09-30T23:00:00.000Z");
    expect(iso(p.periodEnd)).toBe("2026-10-31T23:59:59.999Z");
  });

  it("Tokyo: October runs 15:00 UTC on 30 September to 14:59:59.999 UTC on 31 October", () => {
    const p = previousClubMonthPeriod(new Date("2026-11-10T08:00:00Z"), "Asia/Tokyo");
    expect(iso(p.periodStart)).toBe("2026-09-30T15:00:00.000Z");
    expect(iso(p.periodEnd)).toBe("2026-10-31T14:59:59.999Z");
  });

  it("on the club's 1st, just after midnight, the previous month is already the one that just ended", () => {
    // 00:30 on 1 November in Auckland (NZDT) is 11:30 UTC on 31 October.
    const p = previousClubMonthPeriod(new Date("2026-10-31T11:30:00Z"), "Pacific/Auckland");
    expect(iso(p.periodStart)).toBe("2026-09-30T11:00:00.000Z"); // 1 Oct 00:00 NZDT
    expect(iso(p.periodEnd)).toBe("2026-10-31T10:59:59.999Z");
  });

  it("an unusable zone falls back to Europe/London", () => {
    const p = previousClubMonthPeriod(new Date("2026-11-10T08:00:00Z"), "Not/AZone");
    expect(iso(p.periodStart)).toBe("2026-09-30T23:00:00.000Z");
  });
});

describe("the report compares against the club's month before", () => {
  it("London October report, UTC server: September's check-ins are counted from 23:00 UTC on 31 August to October's start", async () => {
    checkInWindows.length = 0;
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const { periodStart, periodEnd } = previousClubMonthPeriod(new Date("2026-11-10T08:00:00Z"), "Europe/London");
      await generateMonthlyReport({ tenantId: "t1", tenantName: "Club", periodStart, periodEnd, timeZone: "Europe/London" });
      expect(checkInWindows).toContainEqual({ gte: periodStart, lte: periodEnd });
      expect(checkInWindows).toContainEqual({ gte: new Date("2026-08-31T23:00:00Z"), lt: periodStart });
    } finally {
      process.env.TZ = originalTz;
    }
  });
});
