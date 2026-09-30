// Verifier lane 4 (money), 30 Sep 2026, on the frozen production build:
// D1 the Members list and profile said "Paid" for a member the dashboard and
//    Outstanding tab said was overdue by due date;
// D2 opening the Payments page spent the CSV export allowance (a prefetching
//    <Link> to the API route) and running out showed raw JSON;
// D3 the CSV "Date" column was the record time, not the paid date;
// D4 date-overdue Outstanding rows carried no amount and no age;
// D5 an unparseable paidAt answered 500.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shownPaymentStatus } from "@/lib/overdue";
import { buildOutstandingRows } from "@/lib/billing";

const NOW = new Date("2026-09-30T12:00:00Z");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("D1 — one overdue rule on every screen", () => {
  it("shows a cash member past their due date as overdue", () => {
    expect(shownPaymentStatus({ paymentStatus: "paid", nextDueAt: new Date("2026-09-27"), stripeSubscriptionId: null }, NOW)).toBe("overdue");
  });
  it("leaves a card-subscribed member to Stripe, and never chases free, paused or cancelled", () => {
    expect(shownPaymentStatus({ paymentStatus: "paid", nextDueAt: new Date("2026-09-01"), stripeSubscriptionId: "sub_1" }, NOW)).toBe("paid");
    for (const s of ["free", "paused", "cancelled"]) {
      expect(shownPaymentStatus({ paymentStatus: s, nextDueAt: new Date("2026-09-01"), stripeSubscriptionId: null }, NOW)).toBe(s);
    }
  });
  it.each([
    "app/api/members/route.ts",
    "app/api/members/[id]/route.ts",
    "app/dashboard/members/page.tsx",
    "app/dashboard/members/[id]/page.tsx",
  ])("%s serves the derived status", (p) => {
    expect(src(p)).toMatch(/shownPaymentStatus\(/);
  });
});

describe("D2 — the export is a click, not a prefetch", () => {
  it.each(["components/dashboard/PaymentsPageClient.tsx", "components/dashboard/PaymentsTable.tsx"])("%s has no link to the export route", (p) => {
    const s = src(p);
    expect(s).not.toMatch(/href="\/api\/payments\/export\.csv"/);
    expect(s).toMatch(/<ExportCsvButton/);
  });
});

describe("D3 — the CSV says when it was paid", () => {
  it("leads with the paid date and keeps the record time as its own column", () => {
    const s = src("app/api/payments/export.csv/route.ts");
    expect(s).toMatch(/"Paid on"/);
    expect(s).toMatch(/\(r\.paidAt \?\? r\.createdAt\)/);
    expect(s).toMatch(/"Recorded at"/);
  });
});

describe("D4 — date-overdue rows carry an amount and an age", () => {
  it("uses the plan price and the days since the missed due date", () => {
    const [row] = buildOutstandingRows({
      now: NOW,
      overdueMembers: [{ id: "m1", name: "Fran", membershipType: "Four-weekly", nextDueAt: new Date("2026-09-25T12:00:00Z"), planPricePence: 3800 }],
      latestFailed: new Map(),
    });
    expect(row).toMatchObject({ amountPence: 3800, amountSource: "plan_price", daysOverdue: 5 });
  });
  it("prefers a failed charge when there is one", () => {
    const [row] = buildOutstandingRows({
      now: NOW,
      overdueMembers: [{ id: "m1", name: "Card", membershipType: null, nextDueAt: new Date("2026-09-01"), planPricePence: 3800 }],
      latestFailed: new Map([["m1", { amountPence: 4500, createdAt: new Date("2026-09-28T12:00:00Z"), failureReason: "card_declined" }]]),
    });
    expect(row).toMatchObject({ amountPence: 4500, amountSource: "failed_charge", daysOverdue: 2 });
  });
});

describe("D5 — a bad paid date is a 400, not a 500", () => {
  it("validates paidAt in the schema", () => {
    const s = src("app/api/payments/manual/route.ts");
    expect(s).toMatch(/Date paid is not a valid date/);
    expect(s).toMatch(/Date paid can't be in the future/);
  });
});
