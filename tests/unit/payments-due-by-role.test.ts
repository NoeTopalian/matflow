// Round-3 review L5 (23 Oct 2026): a coach's dashboard "Payments due" tile
// links to the Members "Payers overdue" chip (coaches cannot open Payments →
// Outstanding), so its figure and label must be that chip's. Before, the tile
// counted overdue plus "No payment yet" for every role: a never-paid member
// past their first due date made the coach's tile read 1 and the chip it
// opened read 0.
//
// Fixture (the reviewer's): active, paymentStatus pending, on a plan, due two
// days ago, billed by MatFlow.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { matchRows } from "./support/prisma-where-eval";
import { paymentsDueCopy, paymentsDueWhere, seesOutstanding } from "@/lib/payments-due";
import { countMemberRows, memberListCountWheres } from "@/lib/member-list-counts";
import { clubMonthWindow } from "@/lib/club-month";
import { shownPaymentStatus } from "@/lib/overdue";

const NOW = new Date("2026-10-23T10:00:00Z");
const MONTH = clubMonthWindow(NOW, "Europe/London");
const NEVER_PAID = {
  tenantId: "club",
  id: "m1",
  status: "active",
  accountType: "adult",
  paymentStatus: "pending",
  membershipTierId: "tier-adult",
  nextDueAt: new Date(NOW.getTime() - 2 * 86_400_000),
  stripeSubscriptionId: null,
  billedBy: "matflow",
};
const OTHER_CLUB = { ...NEVER_PAID, id: "x1", tenantId: "other" };
const ROWS = [NEVER_PAID, OTHER_CLUB];
const memberChip = () => {
  const row = { status: NEVER_PAID.status, accountType: NEVER_PAID.accountType, paymentStatus: shownPaymentStatus(NEVER_PAID, NOW) };
  return {
    server: matchRows(ROWS, memberListCountWheres("club", NOW, MONTH).overdue).length,
    browser: countMemberRows([row], NOW, MONTH).overdue,
  };
};

describe("dashboard Payments due, by role", () => {
  for (const role of ["coach", "admin"]) {
    it(`${role}: the tile counts and names the Members "Payers overdue" chip it links to (0 = 0)`, () => {
      expect(seesOutstanding(role)).toBe(false);
      const tile = matchRows(ROWS, paymentsDueWhere("club", role, NOW)).length;
      expect(tile).toBe(0);
      expect(memberChip()).toEqual({ server: tile, browser: tile });
      expect(paymentsDueCopy(role)).toMatchObject({ label: "Payers overdue", todoLabel: "Payers overdue", href: "/dashboard/members?filter=overdue" });
    });
  }

  for (const role of ["owner", "manager"]) {
    it(`${role}: the tile is Outstanding's count (overdue plus No payment yet) and links to Payments`, () => {
      expect(seesOutstanding(role)).toBe(true);
      expect(matchRows(ROWS, paymentsDueWhere("club", role, NOW)).map((r) => r.id)).toEqual(["m1"]);
      expect(paymentsDueCopy(role)).toMatchObject({ label: "Payments Due", detail: "Overdue or no payment yet", href: "/dashboard/payments" });
    });
  }

  it("the dashboard page and tile use the shared helper for the count, the label and the link", () => {
    const page = readFileSync("app/dashboard/page.tsx", "utf8");
    expect(page).toContain("tx.member.count({ where: paymentsDueWhere(tenantId, role, now) })");
    // #36 adds the single At-Risk read as the last argument (release integration, 26 Oct 2026).
    expect(page).toContain("getStats(tx, session!.user.tenantId, session!.user.role, atRisk)");
    const tile = readFileSync("components/dashboard/DashboardStats.tsx", "utf8");
    expect(tile).toContain("const paymentsDue = paymentsDueCopy(currentUserRole);");
    expect(tile).toContain("label={paymentsDue.label} value={stats.paymentsDue} detail={paymentsDue.detail}");
  });
});
