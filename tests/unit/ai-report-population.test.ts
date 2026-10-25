/**
 * T2c acceptance 1 (17 Oct 2026): the AI monthly report's metric snapshot
 * counts training members only. A parent/guardian account (APPROVED in the
 * TeamUp import contract) is in none of total, active, new or cancelled.
 *
 * The fake transaction evaluates each Prisma `where` against an in-memory
 * member list, so the test proves the counts the report records, not just
 * the shape of the query. Under 10 training members the report takes its
 * placeholder path, which returns the snapshot without calling the model.
 */
import { vi, describe, it, expect } from "vitest";

type Row = { id: string; tenantId: string; status: string; accountType: string; joinedAt: Date; cancelledAt?: Date | null };
type Ev = { id: string; memberId: string; fromStatus: string | null; toStatus: string; reason: string; sourceAction: string | null; occurredAt: Date; createdAt: Date };

const { state } = vi.hoisted(() => ({ state: { members: [] as Row[], events: [] as Ev[] } }));

type Cond = string | { not?: string; in?: string[]; gte?: Date; lte?: Date; lt?: Date };

function matches(row: Row, where: Record<string, Cond>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const v = (row as Record<string, unknown>)[field];
    if (typeof cond === "string") return v === cond;
    if (cond.not !== undefined && v === cond.not) return false;
    if (cond.in !== undefined && !cond.in.includes(v as string)) return false;
    const t = v instanceof Date ? v.getTime() : NaN;
    if (cond.gte !== undefined && !(t >= cond.gte.getTime())) return false;
    if (cond.lte !== undefined && !(t <= cond.lte.getTime())) return false;
    if (cond.lt !== undefined && !(t < cond.lt.getTime())) return false;
    return true;
  });
}

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_tenantId: string, fn: (tx: unknown) => Promise<T>) =>
    fn({
      member: {
        count: async ({ where }: { where: Record<string, Cond> }) => state.members.filter((m) => matches(m, where)).length,
        // Joined is read through the movement replay (lib/membership-report loadJoinedInWindows).
        findMany: async ({ where }: { where: Record<string, Cond> }) =>
          state.members.filter((m) => matches(m, where)).map((m) => ({ id: m.id, status: m.status, joinedAt: m.joinedAt, cancelledAt: m.cancelledAt ?? null })),
      },
      tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
      memberStatusEvent: {
        findMany: async () => state.events.filter((e) => state.members.some((m) => m.id === e.memberId && m.tenantId === T && m.accountType !== "parent")),
      },
      importedMembership: { findMany: async () => [] },
      attendanceRecord: { count: async () => 0 },
      class: { count: async () => 2 },
    }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

import { generateMonthlyReport } from "@/lib/ai-causal-report";

const T = "tenant-A";
const periodStart = new Date("2026-09-01T00:00:00Z");
const periodEnd = new Date("2026-09-30T23:59:59Z");
const inPeriod = new Date("2026-09-15T12:00:00Z");
const longAgo = new Date("2025-01-10T12:00:00Z");

let seq = 0;
const member = (over: Partial<Row>): Row => ({ id: `m${++seq}`, tenantId: T, status: "active", accountType: "adult", joinedAt: longAgo, ...over });

describe("AI monthly report — metric snapshot population", () => {
  it("3 active training members and 2 active guardian accounts → 3 active, guardians in no total or new count", async () => {
    state.members = [
      member({ joinedAt: inPeriod }),
      member({ accountType: "child" }),
      member({}),
      member({ accountType: "parent", joinedAt: inPeriod }),
      member({ accountType: "parent", joinedAt: inPeriod }),
    ];
    const report = await generateMonthlyReport({ tenantId: T, tenantName: "Total BJJ", periodStart, periodEnd });
    expect(report.insufficientData).toBe(true);
    expect(report.metricSnapshot.activeMembers).toBe(3);
    expect(report.metricSnapshot.totalMembers).toBe(3);
    expect(report.metricSnapshot.newThisPeriod).toBe(1);
  });

  it("cancelled counts training members who left, never a cancelled guardian; total keeps those who left", async () => {
    state.members = [
      member({}),
      member({ status: "cancelled" }),
      member({ status: "cancelled", accountType: "parent" }),
      member({ status: "inactive" }),
      member({ status: "active", accountType: "parent" }),
      // Another club's member never counts.
      member({ tenantId: "tenant-B", status: "cancelled" }),
    ];
    const report = await generateMonthlyReport({ tenantId: T, tenantName: "Total BJJ", periodStart, periodEnd });
    expect(report.metricSnapshot.cancelledMembers).toBe(1);
    expect(report.metricSnapshot.activeMembers).toBe(1);
    expect(report.metricSnapshot.totalMembers).toBe(3);
  });

  it("new last period excludes guardian drafts made in that month", async () => {
    const lastPeriod = new Date("2026-08-15T12:00:00Z");
    state.members = [
      member({ joinedAt: lastPeriod }),
      member({ joinedAt: lastPeriod, accountType: "parent" }),
      member({ joinedAt: lastPeriod, accountType: "parent" }),
    ];
    const report = await generateMonthlyReport({ tenantId: T, tenantName: "Total BJJ", periodStart, periodEnd });
    expect(report.metricSnapshot.newPrevPeriod).toBe(1);
    expect(report.metricSnapshot.newThisPeriod).toBe(0);
    expect(report.metricSnapshot.newDelta).toBe(-1);
  });
});

describe("AI monthly report — imports are never joins (review 25 Oct)", () => {
  it("a member the import created this period, with the import time as join date, is not a join", async () => {
    const imported = member({ joinedAt: inPeriod });
    state.members = [member({ joinedAt: inPeriod }), imported];
    state.events = [
      { id: "e1", memberId: imported.id, fromStatus: null, toStatus: "active", reason: "import", sourceAction: "import_create", occurredAt: inPeriod, createdAt: inPeriod },
    ];
    const report = await generateMonthlyReport({ tenantId: T, tenantName: "Total BJJ", periodStart, periodEnd });
    expect(report.metricSnapshot.newThisPeriod).toBe(1);
    state.events = [];
  });
});

describe("AI monthly report — previous-period window (review L8)", () => {
  it("1 November run (period 1-31 Oct): previous window is exactly 1-30 September", async () => {
    const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi);
    state.members = [
      member({ joinedAt: at(2026, 7, 31, 23, 59) }), // 31 Aug: before the window
      member({ joinedAt: at(2026, 8, 1, 0, 0) }), // 1 Sep 00:00: first instant of the window
      member({ joinedAt: at(2026, 8, 30, 23, 59) }), // 30 Sep 23:59: last minute of the window
      member({ joinedAt: at(2026, 9, 1, 0, 0) }), // 1 Oct 00:00: current period, NOT previous
      member({ joinedAt: at(2026, 9, 1, 18, 0) }), // 1 Oct evening: current period, NOT previous
    ];
    const report = await generateMonthlyReport({
      tenantId: T,
      tenantName: "Total BJJ",
      periodStart: new Date(2026, 9, 1),
      periodEnd: new Date(2026, 9, 31, 23, 59, 59, 999),
    });
    expect(report.metricSnapshot.newPrevPeriod).toBe(2);
    expect(report.metricSnapshot.newThisPeriod).toBe(2);
  });
});
