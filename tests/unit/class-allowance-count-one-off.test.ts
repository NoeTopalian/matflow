/**
 * G4: a coach's one-off is not counted against the allowance. The count
 * (statement C2, lib/class-allowance-count.ts) leaves out attendance rows
 * with a ClassOneOff exactly as it leaves out class-pack redemptions, and the
 * member portal's usage line reads through the same statement. The
 * real-database proof is tests/integration/class-one-off-db.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { readAllowanceSnapshot, memberAllowanceUsage } from "@/lib/class-allowance-count";

const ROW = {
  classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-09-28", maxClassesPerWeek: null,
  billingCycle: "monthly", stripeSubscriptionId: "sub_1", nextDueAt: null, billingPeriodStart: null, billingPeriodEnd: null,
  alreadyIn: false,
};

function fakeTx() {
  const sql: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      sql.push(text);
      return text.includes("json_agg") ? [{ visits: [] }] : [ROW];
    }),
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
  };
  return { tx, sql };
}

const normalise = (s: string) => s.replace(/\s+/g, " ");

describe("the allowance count leaves out a coach's one-off", () => {
  it("the check-in's count excludes attendance rows that have a ClassOneOff", async () => {
    const { tx, sql } = fakeTx();
    await readAllowanceSnapshot(tx as never, {
      tenantId: "t-1", memberId: "m-1", session: 0, currentInstanceId: "ci-1", timeZone: "Europe/London",
    });
    const visits = normalise(sql.find((s) => s.includes("json_agg"))!);
    expect(visits).toContain('AND NOT EXISTS ( SELECT 1 FROM "ClassOneOff" o WHERE o."attendanceRecordId" = a."id" )');
    // ...beside the existing pack-redemption exclusion, not instead of it.
    expect(visits).toContain('AND NOT EXISTS ( SELECT 1 FROM "ClassPackRedemption" r WHERE r."attendanceRecordId" = a."id" )');
  });

  it("the member portal's usage line reads through the same statement", async () => {
    const { tx, sql } = fakeTx();
    const usage = await memberAllowanceUsage(tx as never, { tenantId: "t-1", memberId: "m-1", now: new Date("2026-10-19T12:00:00Z") });
    expect(usage).toMatchObject({ used: 0, limit: 4 });
    const visits = normalise(sql.find((s) => s.includes("json_agg"))!);
    expect(visits).toContain('SELECT 1 FROM "ClassOneOff" o WHERE o."attendanceRecordId" = a."id"');
  });
});
