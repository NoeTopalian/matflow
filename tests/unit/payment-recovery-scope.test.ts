// @vitest-environment jsdom
//
// Round-3 review L3 (23 Oct 2026): "Payment recovery" was relabelled
// "Payers with a failed payment…", but the metric is not a payer total: its
// base is every account with a failed payment in the last 90 days, whatever
// its status (cancelled included) and account type, and "recovered" is the
// stored payment status "paid" (lib/reports.ts recovery). The words now say
// exactly that, on the tile and in the CSV. The numbers are unchanged.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { reportsCsv, RECOVERY_SCOPE } from "@/components/dashboard/ReportsView";
import { createEmptyReportsData } from "@/lib/reports";

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

describe("Payment recovery says what it counts", () => {
  it("the scope names accounts, any status, guardians included, and 'marked paid'", () => {
    expect(RECOVERY_SCOPE).toBe("Accounts with a failed payment in the last 90 days now marked paid (any status, parents and guardians included)");
  });

  it("the CSV row carries the same words beside the unchanged ratio", () => {
    const base = createEmptyReportsData();
    const data = {
      ...base,
      paymentHealth: { ...base.paymentHealth, recoveryRate: 50, recovery: { ratePct: 50, recovered: 1, failedMembers: 2 } },
    };
    const row = reportsCsv(data, ATTRIBUTION as never).split("\r\n").find((l) => l.startsWith("Health,Payment recovery,"));
    // The scope holds commas, so csvCell quotes it.
    expect(row).toBe(`Health,Payment recovery,50% (1 of 2),"${RECOVERY_SCOPE}"`);
  });

  it("the metric itself is unchanged: base = every member with a failed payment in 90 days, recovered = stored paid", () => {
    const src = readFileSync("lib/reports.ts", "utf8");
    expect(src).toContain('where: { tenantId, status: "failed", createdAt: { gte: new Date(Date.now() - 90 * 86400000) } }');
    expect(src).toContain('tx.member.count({ where: { id: { in: failedMemberIds }, tenantId, paymentStatus: "paid" } })');
  });
});
