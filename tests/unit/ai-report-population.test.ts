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

type Row = { tenantId: string; status: string; accountType: string; joinedAt: Date };

const { state } = vi.hoisted(() => ({ state: { members: [] as Row[] } }));

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
      },
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

const member = (over: Partial<Row>): Row => ({ tenantId: T, status: "active", accountType: "adult", joinedAt: longAgo, ...over });

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
