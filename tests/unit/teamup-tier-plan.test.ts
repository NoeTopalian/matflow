/**
 * scripts/readiness/teamup-tier-plan.mjs — the plan label → tier plan.
 *
 * The script is plain Node (it must run against the owner's file without the
 * app's build), so it mirrors lib/importers/teamup.ts cycleForPlan instead of
 * importing it; this pins the two together over every label in Total BJJ's
 * catalogue (catalogue names, not personal data). It also pins the
 * dispositions and the "no financial effect" tier fields it prints.
 */
import { describe, it, expect } from "vitest";
import { cycleForPlan } from "@/lib/importers/teamup";
import { advanceDueDate } from "@/lib/overdue";
import { cycleForPlan as scriptCycle, tierPlan, tierFields, PRICE_NOT_SET_MARKER } from "../../scripts/readiness/teamup-tier-plan.mjs";

const CATALOGUE = [
  "Adults Advanced 2026", "Kids Unlimited Membership", "Advanced Unlimited Adult Classes (OLD)", "Kids Once-A-Week 2026",
  "Beginners Course 2026", "Advanced Unlimited Adult Classes", "Kids Once A Week Membership", "Kids Unlimited 2026",
  "Advanced Once Per Week 2026", "Kids Unlimited Membership (OLD)", "Beginners Once Per Week 2026", "Kids Once A Week Membership (OLD)",
  "Advanced Adult + Juniors & Comp Classes Once Per Week (OLD)", "8 Week Beginners Course", "Beginner Course",
  "Adult Advanced + Juniors & Comp (OLD)", "Advanced Once Per Week (OLD)", "Beginners Course Unlimited Classes",
  "Kids & Beginners Course (OLD)", "Kids & Beginners Course 2026",
];

const HEADER = "Customer Name,Customer Email,Membership Name,Status,Start Date,Expiration Date";
const FILE = "﻿" + [
  HEADER,
  "A,a@example.test,Adults Advanced 2026,active,2026-01-01,",
  "B,b@example.test,Adults Advanced 2026,cancelled,2025-01-01,2025-06-01",
  "C,c@example.test,Beginner Course,hold,2026-03-01,",
  "D,d@example.test,8 Week Beginners Course,hold,2025-01-01,2025-03-01",
  "E,e@example.test,Kids & Beginners Course (OLD),cancelled,2024-01-01,2024-06-01",
  "F,f@example.test,Kids & Beginners Course (OLD),completed,2024-01-01,2024-06-01",
].join("\r\n") + "\r\n";

describe("teamup-tier-plan.mjs", () => {
  it("mirrors lib/importers/teamup.ts cycleForPlan over the whole catalogue", () => {
    for (const label of CATALOGUE) expect(scriptCycle(label), label).toBe(cycleForPlan(label));
  });

  it("LIVE_TIER for a label with any active or hold row, HISTORY_ONLY otherwise; counts are per row", () => {
    const plan = tierPlan(FILE, { asOf: "2026-10-02" });
    const by = Object.fromEntries(plan.map((p) => [p.label, p]));
    expect(by["Adults Advanced 2026"]).toMatchObject({ rows: 2, active: 1, hold: 0, liveAtAsOf: 1, disposition: "LIVE_TIER", teamupCycle: "four_weekly" });
    expect(by["Beginner Course"]).toMatchObject({ rows: 1, active: 0, hold: 1, disposition: "LIVE_TIER" });
    expect(by["Kids & Beginners Course (OLD)"]).toMatchObject({ rows: 2, active: 0, hold: 0, disposition: "HISTORY_ONLY" });
    expect(by["Kids & Beginners Course (OLD)"].createTier).toBeUndefined();
    // A hold that expired before the as-of date is flagged: nobody will be on that plan.
    expect(by["8 Week Beginners Course"]).toMatchObject({ disposition: "LIVE_TIER", liveAtAsOf: 0 });
    expect(by["8 Week Beginners Course"].notes.join(" ")).toMatch(/no row is live at 2026-10-02/);
  });

  it("prints the exact (trimmed) label as the tier name and flags labels that differ only in case", () => {
    const plan = tierPlan([HEADER, "A,a@x.test,  Beginner Course ,active,2026-01-01,", "B,b@x.test,BEGINNER COURSE,active,2026-01-01,"].join("\n"));
    expect(plan.map((p) => p.label).sort()).toEqual(["BEGINNER COURSE", "Beginner Course"]);
    expect(plan.find((p) => p.label === "Beginner Course")!.notes.join(" ")).toMatch(/surrounding spaces/);
    for (const p of plan) expect(p.notes.join(" ")).toMatch(/ONE tier serves both/);
  });

  it("the tier fields it recommends carry no price, no due date and no Stripe price", () => {
    const f = tierFields("Kids Unlimited 2026");
    expect(f).toMatchObject({ name: "Kids Unlimited 2026", pricePence: 0, billingCycle: "none", isKids: false, stripePriceId: null });
    expect(f.description.startsWith(PRICE_NOT_SET_MARKER)).toBe(true);
    expect(f.description).toMatch(/every 4 weeks/);
    // "none" seeds no due date (lib/overdue.ts), so nothing can come due or overdue.
    expect(advanceDueDate(null, f.billingCycle, new Date("2026-10-02T00:00:00Z"))).toBeNull();
  });

  it("refuses a file that is not a memberships export", () => {
    expect(() => tierPlan("name,email\nA,a@x.test\n")).toThrow(/Not a TeamUp memberships export/);
  });
});
