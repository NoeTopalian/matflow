/**
 * Headline member counts exclude parent/guardian accounts (2 Oct 2026,
 * independent acceptance of the TeamUp import, finding P1: 219 no-login
 * guardian drafts read as "active members" and "new this month"). Pinned as a
 * scan: every Member population query in lib/reports.ts and the dashboard
 * home carries TRAINING_MEMBER.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TRAINING_MEMBER } from "@/lib/member-population";

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

  it("every Member population query in lib/reports.ts carries TRAINING_MEMBER (money queries and the age-bucketed denominator, which names its buckets, are the exceptions)", () => {
    const src = readFileSync("lib/reports.ts", "utf8");
    const qs = memberQueries(src);
    expect(qs.length).toBeGreaterThan(8);
    const unguarded = qs.filter((q) => !q.includes("TRAINING_MEMBER") && !q.includes("paymentStatus") && !q.includes("noPaymentYetWhere") && !q.includes("ADULT_ACCOUNT_TYPES"));
    expect(unguarded, unguarded.join("\n---\n")).toEqual([]);
  });

  it("the dashboard home's active, new-this-month and missing-waiver counts carry TRAINING_MEMBER", () => {
    const src = readFileSync("app/dashboard/page.tsx", "utf8");
    // Guardian accounts never sign a training waiver (acceptance follow-up, 2 Oct 2026): the count and the list.
    expect((src.match(/waiverAccepted: false, \.\.\.TRAINING_MEMBER/g) ?? []).length).toBe(2);
    expect(src).toMatch(/status: "active", \.\.\.TRAINING_MEMBER/);
    expect(src).toMatch(/joinedAt: \{ gte: startOfMonth \}, \.\.\.TRAINING_MEMBER/);
  });
});
