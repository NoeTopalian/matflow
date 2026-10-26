/**
 * Headline member counts exclude parent/guardian accounts (2 Oct 2026,
 * independent acceptance of the TeamUp import, finding P1: an import's no-login
 * guardian drafts read as "active members" and "new this month"). Pinned as a
 * scan: every Member population query in lib/reports.ts and the dashboard
 * home carries a named population from lib/member-population.ts.
 *
 * T1 (17 Oct 2026) extends the scan to every surface that was switched to the
 * shared predicates: Settings, Analysis, the Revenue summary, the dashboard
 * stats route, Memberships and the bulk card print. Each query also keeps an
 * explicit tenantId beside the population (the fragments carry none).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACTIVE_MEMBER,
  CAN_TRAIN_MEMBER,
  CURRENT_MEMBER,
  GUARDIAN_ACCOUNT,
  LEFT_MEMBER,
  ON_HOLD,
  TRAINING_MEMBER,
} from "@/lib/member-population";

const POPULATIONS = /\.\.\.(TRAINING_MEMBER|ACTIVE_MEMBER|CURRENT_MEMBER|CAN_TRAIN_MEMBER|LEFT_MEMBER|GUARDIAN_ACCOUNT)\b/;

const memberQueries = (src: string) => {
  const out: string[] = [];
  const re = /tx\.member\.(count|findMany|groupBy)\(\{[\s\S]*?\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[0]);
  return out;
};

describe("member population counts", () => {
  it("TRAINING_MEMBER excludes parent accounts and nothing else", () => {
    expect(TRAINING_MEMBER).toEqual({ accountType: { not: "parent" } });
  });

  it("the named populations are TRAINING_MEMBER plus one status rule each; holds and guardians are their own axes", () => {
    expect(ACTIVE_MEMBER).toEqual({ accountType: { not: "parent" }, status: "active" });
    expect(CURRENT_MEMBER).toEqual({ accountType: { not: "parent" }, status: { not: "cancelled" } });
    expect(CAN_TRAIN_MEMBER).toEqual({ accountType: { not: "parent" }, status: { in: ["active", "taster"] } });
    expect(LEFT_MEMBER).toEqual({ accountType: { not: "parent" }, status: "cancelled" });
    expect(GUARDIAN_ACCOUNT).toEqual({ accountType: "parent" });
    expect(ON_HOLD).toEqual({ paymentStatus: "paused" });
    // No fragment carries a tenant: every caller spreads it beside its own.
    for (const f of [TRAINING_MEMBER, ACTIVE_MEMBER, CURRENT_MEMBER, CAN_TRAIN_MEMBER, LEFT_MEMBER, GUARDIAN_ACCOUNT, ON_HOLD]) {
      expect(f).not.toHaveProperty("tenantId");
    }
  });

  it("lib/member-population.ts has no runtime import, so client components can use it", () => {
    const src = readFileSync("lib/member-population.ts", "utf8");
    const imports = src.split(/\r?\n/).filter((l) => /^import\s/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((l) => l.startsWith("import type "))).toBe(true);
  });

  it("every Member population query in lib/reports.ts carries a named population (money queries and the age-bucketed denominator, which names its buckets, are the exceptions)", () => {
    const src = readFileSync("lib/reports.ts", "utf8");
    const qs = memberQueries(src);
    expect(qs.length).toBeGreaterThan(8);
    // Money totals count PAYERS, a named population of their own (review L2:
    // lib/overdue overduePayerWhere / noPaymentYetPayerWhere, guardians who
    // pay included on purpose), so they are exempt from the member rule.
    const unguarded = qs.filter((q) => !POPULATIONS.test(q) && !q.includes("paymentStatus") && !/\.\.\.(overduePayerWhere|noPaymentYetPayerWhere)\(/.test(q) && !q.includes("ADULT_ACCOUNT_TYPES"));
    expect(unguarded, unguarded.join("\n---\n")).toEqual([]);
  });

  it("Reports' member counts carry a named population; churn comes from the movement replay, not a date column", () => {
    const src = readFileSync("lib/reports.ts", "utf8");
    expect(src).toContain("tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER, ...ON_HOLD } })");
    // D4 (Noe, 26 Oct 2026): left in the period ÷ active at its start, both from
    // the training members' status history (lib/membership-report.ts).
    expect(src).toContain("loadMembershipForPeriod(tx, tenantId, {");
    expect(src).not.toMatch(/LEFT_MEMBER, cancelledAt: thisMonth/);
    expect(src).not.toMatch(/status: "active", \.\.\.TRAINING_MEMBER/);
  });

  it("the dashboard home's active, new-this-month, missing-waiver and missing-phone counts carry a named population", () => {
    const src = readFileSync("app/dashboard/page.tsx", "utf8");
    // Guardian accounts never sign a training waiver (acceptance follow-up, 2 Oct 2026): the count and the list.
    expect((src.match(/\.\.\.CAN_TRAIN_MEMBER, waiverAccepted: false/g) ?? []).length).toBe(2);
    expect(src).toMatch(/tx\.member\.count\(\{ where: \{ tenantId, \.\.\.ACTIVE_MEMBER \} \}\)/);
    expect(src).toMatch(/joinedAt: \{ gte: startOfMonth \}, \.\.\.TRAINING_MEMBER/);
    expect(src).toMatch(/\.\.\.CAN_TRAIN_MEMBER,\s*OR: \[\{ phone: null \}, \{ phone: "" \}\]/);
  });

  // Each switched server file: every tx.member query names a population and
  // keeps its tenantId.
  const SWITCHED: { file: string; minQueries: number }[] = [
    { file: "app/dashboard/settings/page.tsx", minQueries: 3 },
    // Review 25 Oct: Analysis and the AI report read Joined from the movement
    // replay (loadJoinedInWindows, TRAINING_MEMBER inside), not two joinedAt counts.
    { file: "app/dashboard/analysis/page.tsx", minQueries: 2 },
    { file: "app/api/revenue/summary/route.ts", minQueries: 2 },
    { file: "app/api/dashboard/stats/route.ts", minQueries: 3 },
    // T2c: the AI monthly report's three people counts (total, active, cancelled).
    { file: "lib/ai-causal-report.ts", minQueries: 3 },
  ];
  for (const { file, minQueries } of SWITCHED) {
    it(`${file}: every Member query carries a named population and an explicit tenantId`, () => {
      const src = readFileSync(file, "utf8");
      const qs = memberQueries(src);
      expect(qs.length).toBeGreaterThanOrEqual(minQueries);
      const unguarded = qs.filter((q) => !POPULATIONS.test(q));
      expect(unguarded, unguarded.join("\n---\n")).toEqual([]);
      const untenanted = qs.filter((q) => !/\{ tenantId[,\s]/.test(q));
      expect(untenanted, untenanted.join("\n---\n")).toEqual([]);
      expect(src).toContain("withTenantContext(");
    });
  }

  it("Settings keeps holds off the status rows: on hold is read from paymentStatus, guardians counted apart", () => {
    const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
    expect(src).toMatch(/by: \["status"\],\s*where: \{ tenantId, \.\.\.TRAINING_MEMBER \}/);
    expect(src).toContain("{ tenantId, ...CURRENT_MEMBER, ...ON_HOLD }");
    expect(src).toContain('{ tenantId, ...GUARDIAN_ACCOUNT, status: { not: "cancelled" } }');
    const ui = readFileSync("components/dashboard/SettingsPage.tsx", "utf8");
    expect(ui).not.toMatch(/key: "paused"/);
  });

  it("Analysis measures engagement over active training members: the attendee numerator is filtered to ACTIVE_MEMBER", () => {
    const src = readFileSync("app/dashboard/analysis/page.tsx", "utf8");
    expect(src).toMatch(/by: \["memberId"\],[\s\S]*?member: \{ \.\.\.ACTIVE_MEMBER \}/);
  });

  it("the AI monthly report counts active as ACTIVE_MEMBER and cancelled as LEFT_MEMBER, never a bare status", () => {
    const src = readFileSync("lib/ai-causal-report.ts", "utf8");
    expect(src).toContain("tx.member.count({ where: { tenantId, ...TRAINING_MEMBER } })");
    expect(src).toContain("tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER } })");
    expect(src).toContain("tx.member.count({ where: { tenantId, ...LEFT_MEMBER } })");
    expect(src).not.toMatch(/joinedAt:/);
    expect(src).toContain("loadJoinedInWindows(");
    expect(src).not.toMatch(/status: "(active|cancelled)"/);
  });

  it("Analysis compares half-open windows (the period and the equal run before it), never lte a midnight", () => {
    const src = readFileSync("app/dashboard/analysis/page.tsx", "utf8");
    expect(src).not.toContain("endOfLastMonth");
    expect(src).not.toMatch(/lte:/);
    // Check-ins in the run before the period: [previous.start, previous.end) (lib/report-period, 26 Oct 2026).
    expect(src).toContain("const inPrevious = { gte: new Date(range.previous.start), lt: new Date(range.previous.end) };");
    expect(src).toContain("checkInTime: inPrevious");
    // Joined in that run ends at its last instant (previous.at = end − 1 ms).
    expect(src).toContain("{ start: new Date(range.previous.start), at: new Date(range.previous.at) }");
  });

  it("Memberships counts each tier's active training members", () => {
    const src = readFileSync("app/dashboard/memberships/page.tsx", "utf8");
    expect(src).toContain("members: { some: { ...ACTIVE_MEMBER } }");
    expect(src).toContain("members: { where: { ...ACTIVE_MEMBER } }");
    expect(src).not.toMatch(/status: "active"/);
  });

  it("the bulk card print is active training members (Q9 A-6 default: no guardian cards); a single card by id is unchanged", () => {
    const src = readFileSync("app/print/member-cards/page.tsx", "utf8");
    expect(src).toContain("...(memberId ? { id: memberId } : { ...ACTIVE_MEMBER })");
    expect(src).toMatch(/tenantId: ctx\.tenantId,/);
  });

  it("GET /api/members pages in a total order (joinedAt, then id), so tied joinedAt values cannot repeat or skip rows", () => {
    const src = readFileSync("app/api/members/route.ts", "utf8");
    expect(src).toContain('orderBy: [{ joinedAt: "desc" }, { id: "desc" }]');
  });
});
