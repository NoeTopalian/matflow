// @vitest-environment jsdom
//
// Review L2 (23 Oct 2026): money totals count PAYERS, member totals count
// MEMBERS. A guardian row can hold a real payment obligation (a member who
// switched themselves to a parent account keeps their plan and due date;
// staff can put a parent account on a plan), so "overdue" must count it and
// say so — never drop the debt — while "active members" must not count the
// guardian as a member.
//
// The fixture is one family: a parent account on its own plan, a due date
// passed, and their child on a kids' plan, paid up. Reports, the Members page
// (server where and browser twin) and Payments → Outstanding must all say
// "1 payer overdue", name the guardian in the detail, and count 1 active
// member (the child).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";
import { fakeTx, matchRows } from "./support/prisma-where-eval";

let members: Record<string, unknown>[] = [];
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeTx(members, { timezone: "Europe/London" })),
}));
let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ACTIVE_MEMBER, PAYER_COPY, payerGuardianNote, payersOverdueLabel } from "@/lib/member-population";
import { overduePayerWhere, noPaymentYetPayerWhere, shownPaymentStatus } from "@/lib/overdue";
import { countMemberRows, memberListCountWheres } from "@/lib/member-list-counts";
import { clubMonthWindow } from "@/lib/club-month";
import { getReportsData } from "@/lib/reports";
import { reportsCsv } from "@/components/dashboard/ReportsView";
import { buildOutstandingRows, outstandingPayerSummary, paymentHealthLine } from "@/lib/billing";
import MembersList, { inStatusView, type MemberRow } from "@/components/dashboard/MembersList";
import OutstandingPanel from "@/components/dashboard/OutstandingPanel";

const NOW = new Date();
const DAY = 86_400_000;
const MONTH = clubMonthWindow(NOW, "Europe/London");

type FamilyRow = {
  tenantId: string;
  id: string;
  name: string;
  email: string;
  status: string;
  accountType: string;
  paymentStatus: string;
  membershipTierId: string | null;
  nextDueAt: Date | null;
  stripeSubscriptionId: string | null;
  billedBy: string;
  waiverAccepted: boolean;
  phone: string | null;
  parentMemberId: string | null;
  joinedAt: Date;
  cancelledAt: Date | null;
  attendances: { checkInTime: Date }[];
};

const PARENT: FamilyRow = {
  tenantId: "club",
  id: "p1",
  name: "Pat Parent",
  email: "pat@example.test",
  status: "active",
  accountType: "parent",
  paymentStatus: "paid",
  membershipTierId: "tier-adult",
  nextDueAt: new Date(NOW.getTime() - 5 * DAY), // due five days ago, nothing recorded
  stripeSubscriptionId: null,
  billedBy: "matflow",
  waiverAccepted: false,
  phone: "+447700900123",
  parentMemberId: null,
  joinedAt: new Date("2025-01-10T00:00:00Z"),
  cancelledAt: null,
  attendances: [],
};
const KID: FamilyRow = {
  ...PARENT,
  id: "k1",
  name: "Kit Kid",
  email: "kit@example.test",
  accountType: "kids",
  membershipTierId: "tier-kids",
  nextDueAt: new Date(NOW.getTime() + 20 * DAY), // paid up
  waiverAccepted: true,
  parentMemberId: "p1",
};
const FAMILY = [PARENT, KID];

function listRow(r: FamilyRow): MemberRow {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    membershipType: "Plan",
    status: r.status,
    accountType: r.accountType,
    paymentStatus: shownPaymentStatus(r, NOW),
    waiverAccepted: r.waiverAccepted,
    parentMemberId: r.parentMemberId,
    joinedAt: r.joinedAt.toISOString(),
    cancelledAt: null,
    lastVisitAt: null,
  };
}

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

afterEach(() => cleanup());

describe("a guardian who owes is a payer overdue; their child is the member", () => {
  it("the shared definitions: 1 payer overdue (the guardian), 1 active member (the child)", () => {
    expect(matchRows(FAMILY, { tenantId: "club", ...overduePayerWhere(NOW) }).map((r) => r.id)).toEqual(["p1"]);
    expect(matchRows(FAMILY, { tenantId: "club", ...ACTIVE_MEMBER }).map((r) => r.id)).toEqual(["k1"]);
    expect(payersOverdueLabel(1)).toBe("1 payer overdue");
    expect(payersOverdueLabel(3)).toBe("3 payers overdue");
    expect(payerGuardianNote(1)).toBe("Includes 1 parent or guardian who pays");
    expect(payerGuardianNote(2)).toBe("Includes 2 parents or guardians who pay");
    expect(payerGuardianNote(0)).toBe("Includes parents and guardians who pay");
  });

  it("Members page, server and browser: Payers overdue 1 (1 guardian), Active 1", () => {
    const server = memberListCountWheres("club", NOW, MONTH);
    expect(matchRows(FAMILY, server.overdue).length).toBe(1);
    expect(matchRows(FAMILY, server.overdueGuardians).length).toBe(1);
    expect(matchRows(FAMILY, server.active).length).toBe(1);
    const browser = countMemberRows(FAMILY.map(listRow), NOW, MONTH);
    expect(browser.overdue).toBe(1);
    expect(browser.overdueGuardians).toBe(1);
    expect(browser.active).toBe(1);
    expect(inStatusView(listRow(PARENT), "overdue")).toBe(true);
    expect(inStatusView(listRow(KID), "overdue")).toBe(false);
  });

  it("Members page, rendered: the tile, chip, header and rows say payers and name the guardian", () => {
    currentSearch = "filter=overdue";
    const rows = FAMILY.map(listRow);
    render(<MembersList members={rows} primaryColor="#3b82f6" role="owner" serverCounts={countMemberRows(rows, NOW, MONTH)} monthWindow={{ ...MONTH, isCurrent: true }} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("1 payer overdue");
    expect(screen.getByTestId("members-headline-scope").textContent).toContain("including parents and guardians who pay");
    const tile = screen.getByTestId("members-tile-overdue");
    expect(tile.querySelector("p")!.textContent).toBe("1");
    expect(within(tile).getByText(PAYER_COPY.label)).toBeTruthy();
    expect(tile.textContent).toContain("Includes 1 parent or guardian who pays");
    expect(screen.getByRole("button", { name: "Payers overdue · 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Active · 1" })).toBeTruthy();
    // The guardian's row is listed under the chip; the child's is not.
    expect(screen.queryAllByText("Pat Parent").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Kit Kid")).toHaveLength(0);
  });

  it("Reports: 1 payer overdue with the guardian counted and named, 1 active member, the same in the CSV", async () => {
    members = FAMILY;
    const data = await getReportsData("club");
    expect(data.paymentHealth.overdueCount).toBe(1);
    expect(data.paymentHealth.overdueGuardianCount).toBe(1);
    expect(data.summary.activeMembers).toBe(1);
    const csv = reportsCsv(data, ATTRIBUTION as never);
    expect(csv).toContain("Payments,Payers overdue,1,Includes 1 parent or guardian who pays");
  });

  it("Payments → Outstanding: 1 payer, overdue, flagged as a guardian, in the same words", () => {
    const rows = buildOutstandingRows({
      now: NOW,
      overdueMembers: [{ id: "p1", name: "Pat Parent", membershipType: "Plan", nextDueAt: PARENT.nextDueAt, planPricePence: 5000, billedBy: "matflow", accountType: "parent" }],
      latestFailed: new Map(),
      noPaymentYetMembers: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].payerIsGuardian).toBe(true);
    expect(outstandingPayerSummary(rows)).toMatchObject({
      payers: 1,
      overdue: 1,
      noPaymentYet: 0,
      guardians: 1,
      headline: "1 payer",
      split: "1 payer overdue · 0 with no payment yet",
      guardianNote: "Includes 1 parent or guardian who pays",
    });
  });

  it("Payments → Outstanding, rendered: the summary says payers and names the guardian", async () => {
    const rows = buildOutstandingRows({
      now: NOW,
      overdueMembers: [{ id: "p1", name: "Pat Parent", membershipType: "Plan", nextDueAt: PARENT.nextDueAt, planPricePence: 5000, billedBy: "matflow", accountType: "parent" }],
      latestFailed: new Map(),
      noPaymentYetMembers: [],
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ rows, total: 1, totalPence: 5000 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    render(<OutstandingPanel />);
    await screen.findByText("Pat Parent");
    expect(screen.getByTestId("outstanding-summary").textContent).toContain("outstanding across 1 payer");
    expect(screen.getByTestId("outstanding-split").textContent).toBe("1 payer overdue · 0 with no payment yet. Includes 1 parent or guardian who pays.");
  });
});

describe("overdue and No payment yet partition the payers, as Outstanding lists them", () => {
  // A plan nobody has paid for, whose seeded due date has passed: Outstanding
  // has always called this "No payment yet", never overdue.
  const NEW: FamilyRow = { ...PARENT, id: "n1", name: "Nell New", accountType: "adult", paymentStatus: "pending", membershipTierId: "tier-adult" };
  const ROWS = [PARENT, KID, NEW];

  it("server: 1 overdue + 1 no payment yet = the 2 Outstanding rows; the row shows No payment yet", () => {
    expect(matchRows(ROWS, { tenantId: "club", ...overduePayerWhere(NOW) }).map((r) => r.id)).toEqual(["p1"]);
    expect(matchRows(ROWS, { tenantId: "club", ...noPaymentYetPayerWhere() }).map((r) => r.id)).toEqual(["n1"]);
    expect(shownPaymentStatus(NEW, NOW)).toBe("pending");
    expect(countMemberRows(ROWS.map(listRow), NOW, MONTH).overdue).toBe(1);
    const outstanding = buildOutstandingRows({
      now: NOW,
      overdueMembers: [PARENT, NEW].map((m) => ({ id: m.id, name: m.name, membershipType: "Plan", nextDueAt: m.nextDueAt, billedBy: m.billedBy, accountType: m.accountType })),
      latestFailed: new Map(),
      noPaymentYetMembers: [{ id: NEW.id, name: NEW.name, membershipType: "Plan", billedBy: NEW.billedBy, accountType: NEW.accountType }],
    });
    expect(outstandingPayerSummary(outstanding)).toMatchObject({ payers: 2, overdue: 1, noPaymentYet: 1, guardians: 1 });
    expect(paymentHealthLine({ overdueCount: 1, noPaymentYetCount: 1, failedLast30Days: 0 })?.text).toBe("1 payer overdue · No payment yet 1");
  });
});
