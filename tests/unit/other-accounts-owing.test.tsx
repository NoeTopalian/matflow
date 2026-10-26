// @vitest-environment jsdom
//
// D9 (owner direction, Noe 23 Oct 2026): inactive members stay out of every
// ACTIVE-member total, but a genuine debt on an inactive or cancelled account
// must stay visible under its own label — "Other accounts owing" — on Reports
// (tile and CSV), the Members payers view and Payments → Outstanding.
//
// Owner instruction of 24 Oct 2026: a failed payment must not automatically be
// treated as an unpaid debt without reconciliation. A failed latest charge on
// an inactive or cancelled account that is NOT marked overdue is "Last charge
// failed — to reconcile": shown apart, in no debt total.
//
// Worked example:
//   Ava   active, adult, cash plan, due five days ago        → Payers overdue
//   Ian   INACTIVE, marked overdue by staff, his last payment succeeded
//                                                            → Other accounts owing (confirmed)
//   Gail  active GUARDIAN on her own plan, due five days ago → Payers overdue (guardian)
//   Cole  CANCELLED by Stripe after his last charge failed, not marked overdue
//                                                            → Last charge failed — to reconcile
//   Ned   inactive, stale due date, last payment succeeded   → nothing (no invented debt)
//   Rita  cancelled, a failed charge LATER paid              → nothing
// So: Payers overdue 2 (1 guardian), Other accounts owing 1, to reconcile 1,
// Active members 1, Current members 3 — the member counts are what they were.

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

import {
  ACTIVE_MEMBER,
  CURRENT_MEMBER,
  FAILED_TO_RECONCILE_COPY,
  OTHER_OWING_COPY,
  failedToReconcileLine,
  otherAccountsOwingLine,
} from "@/lib/member-population";
import { otherOwingEvidence, overduePayerWhere, shownPaymentStatus } from "@/lib/overdue";
import { isConfirmedDebt, loadOtherAccountsOwing, otherOwingTotals, type OtherOwingRow } from "@/lib/other-accounts-owing";
import { countMemberRows, memberListCountWheres } from "@/lib/member-list-counts";
import { clubMonthWindow } from "@/lib/club-month";
import { getReportsData } from "@/lib/reports";
import { reportsCsv } from "@/components/dashboard/ReportsView";
import { buildOutstandingRows, paymentHealthLine } from "@/lib/billing";
import MembersList, { inStatusView, type MemberRow } from "@/components/dashboard/MembersList";
import OutstandingPanel from "@/components/dashboard/OutstandingPanel";

const NOW = new Date();
const DAY = 86_400_000;
const MONTH = clubMonthWindow(NOW, "Europe/London");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

type Pay = { status: string; createdAt: Date; amountPence: number; failureReason: string | null };
const paid = (days: number): Pay => ({ status: "succeeded", createdAt: ago(days), amountPence: 5000, failureReason: null });
const failed = (days: number): Pay => ({ status: "failed", createdAt: ago(days), amountPence: 5000, failureReason: "Your card was declined." });

function member(over: { id: string; name: string } & Record<string, unknown>) {
  return {
    tenantId: "club",
    email: `${over.id}@example.test`,
    status: "active",
    accountType: "adult",
    paymentStatus: "paid",
    membershipTierId: "tier-adult",
    membershipType: "Adult monthly",
    nextDueAt: new Date(NOW.getTime() + 20 * DAY),
    stripeSubscriptionId: null,
    billedBy: "matflow",
    waiverAccepted: true,
    phone: "+447700900123",
    parentMemberId: null,
    joinedAt: new Date("2025-01-10T00:00:00Z"),
    cancelledAt: null,
    attendances: [],
    payments: [] as Pay[],
    ...over,
  } as {
    tenantId: string; id: string; name: string; email: string; status: string; accountType: string; paymentStatus: string;
    membershipTierId: string; membershipType: string; nextDueAt: Date; stripeSubscriptionId: string | null; billedBy: string;
    waiverAccepted: boolean; phone: string; parentMemberId: string | null; joinedAt: Date; cancelledAt: Date | null;
    attendances: unknown[]; payments: Pay[];
  };
}

const AVA = member({ id: "ava", name: "Ava Active", nextDueAt: ago(5) });
const IAN = member({ id: "ian", name: "Ian Inactive", status: "inactive", paymentStatus: "overdue", payments: [failed(60), paid(40)] });
const GAIL = member({ id: "gail", name: "Gail Guardian", accountType: "parent", nextDueAt: ago(5) });
const COLE = member({ id: "cole", name: "Cole Cancelled", status: "cancelled", paymentStatus: "cancelled", cancelledAt: ago(30), payments: [paid(70), failed(35)] });
const NED = member({ id: "ned", name: "Ned Stale", status: "inactive", nextDueAt: ago(60), payments: [paid(90)] });
const RITA = member({ id: "rita", name: "Rita Repaid", status: "cancelled", paymentStatus: "cancelled", cancelledAt: ago(20), payments: [failed(100), paid(80)] });
const CLUB = [AVA, IAN, GAIL, COLE, NED, RITA];

function listRow(r: (typeof CLUB)[number], owing: OtherOwingRow[]): MemberRow {
  const row = owing.find((o) => o.memberId === r.id);
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    membershipType: r.membershipType,
    status: r.status,
    accountType: r.accountType,
    paymentStatus: shownPaymentStatus(r, NOW),
    waiverAccepted: r.waiverAccepted,
    parentMemberId: r.parentMemberId,
    joinedAt: r.joinedAt.toISOString(),
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    lastVisitAt: null,
    ...(row ? (isConfirmedDebt(row) ? { otherOwing: true } : { failedToReconcile: true }) : {}),
  };
}

async function loadOwing(): Promise<OtherOwingRow[]> {
  return loadOtherAccountsOwing(fakeTx(CLUB) as never, "club");
}

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

afterEach(() => {
  cleanup();
  currentSearch = "";
});

describe("D9 + 24 Oct: confirmed debts and failed charges to reconcile, apart, beside the payers, never in a member total", () => {
  it("the rule: marked overdue is a confirmed debt; a failed latest charge alone is to reconcile; a stale date or a repaid failure is nothing", async () => {
    expect(otherOwingEvidence(IAN)).toEqual({ kind: "marked_overdue", failed: null });
    // Review H1 (25 Oct): the Stripe webhook writes "overdue" with the failed payment, so an
    // "overdue" whose latest charge failed is that failure, to reconcile, never a confirmed debt.
    expect(otherOwingEvidence({ status: "inactive", paymentStatus: "overdue", payments: [paid(40), failed(3)] })).toMatchObject({
      kind: "failed_charge",
      amountPence: 5000,
      reason: "Your card was declined.",
    });
    expect(otherOwingEvidence(COLE)).toMatchObject({ kind: "failed_charge", amountPence: 5000 });
    expect(otherOwingEvidence(NED)).toBeNull();
    expect(otherOwingEvidence(RITA)).toBeNull();
    // Marked overdue with no failed charge on record is still a confirmed debt; an active account is never either.
    expect(otherOwingEvidence({ status: "inactive", paymentStatus: "overdue", payments: [] })).toEqual({ kind: "marked_overdue", failed: null });
    expect(otherOwingEvidence({ status: "active", paymentStatus: "overdue", payments: [failed(1)] })).toBeNull();
    // A failed latest charge is never turned into a debt, whatever the stored status.
    expect(otherOwingEvidence({ status: "cancelled", paymentStatus: "cancelled", payments: [failed(1)] })?.kind).toBe("failed_charge");

    const rows = await loadOwing();
    // Most recent failure first: the confirmed debt has no failed latest charge, so it sorts after.
    expect(rows.map((r) => [r.memberName, r.evidence])).toEqual([
      ["Cole Cancelled", "failed_charge"],
      ["Ian Inactive", "marked_overdue"],
    ]);
    expect(rows[0]).toMatchObject({ status: "cancelled", amountPence: 5000 });
    expect(rows[1]).toMatchObject({ status: "inactive", amountPence: null, failedAt: null });
    expect(otherOwingTotals(rows)).toEqual({ count: 1, guardians: 0, toReconcile: 1, toReconcileGuardians: 0 });
    expect(otherAccountsOwingLine(1)).toBe("Other accounts owing: 1 (inactive or left, marked overdue, not chased)");
    expect(failedToReconcileLine(1)).toBe("Last charge failed — to reconcile: 1 (inactive or left, check before treating as owed)");
  });

  it("member and payer totals are unchanged: Payers overdue 2 (1 guardian), Active 1, Current 3", () => {
    expect(matchRows(CLUB, { tenantId: "club", ...overduePayerWhere(NOW) }).map((r) => r.id)).toEqual(["ava", "gail"]);
    expect(matchRows(CLUB, { tenantId: "club", ...ACTIVE_MEMBER }).map((r) => r.id)).toEqual(["ava"]);
    expect(matchRows(CLUB, { tenantId: "club", ...CURRENT_MEMBER }).map((r) => r.id)).toEqual(["ava", "ian", "ned"]);
    const server = memberListCountWheres("club", NOW, MONTH);
    expect(matchRows(CLUB, server.overdue).length).toBe(2);
    expect(matchRows(CLUB, server.overdueGuardians).length).toBe(1);
    expect(matchRows(CLUB, server.active).length).toBe(1);
    expect(matchRows(CLUB, server.all).length).toBe(3);
  });

  it("Reports: 1 other account owing and 1 failed charge to reconcile, each its own figure and CSV row", async () => {
    members = CLUB;
    const data = await getReportsData("club");
    expect(data.paymentHealth.overdueCount).toBe(2);
    expect(data.paymentHealth.overdueGuardianCount).toBe(1);
    expect(data.paymentHealth.otherOwingCount).toBe(1);
    expect(data.paymentHealth.otherOwingGuardianCount).toBe(0);
    expect(data.paymentHealth.failedToReconcileCount).toBe(1);
    expect(data.paymentHealth.failedToReconcileGuardianCount).toBe(0);
    expect(data.summary.activeMembers).toBe(1);
    expect(data.summary.currentMembers).toBe(3);
    const csv = reportsCsv(data, ATTRIBUTION as never);
    expect(csv).toContain("Payments,Payers overdue,2,Includes 1 parent or guardian who pays");
    expect(csv).toContain(`Payments,${OTHER_OWING_COPY.label},1,"Inactive or left, marked overdue, not chased"`);
    expect(csv).toContain(`Payments,${FAILED_TO_RECONCILE_COPY.label},1,Inactive or left · check before treating as owed`);
    // Never "all in good standing" while an inactive account owes or a failed charge is unreconciled.
    expect(paymentHealthLine({ overdueCount: 0, failedLast30Days: 0, otherOwingCount: 1 })).toBeNull();
    expect(paymentHealthLine({ overdueCount: 0, failedLast30Days: 0, otherOwingCount: 0, failedToReconcileCount: 1 })).toBeNull();
    expect(paymentHealthLine({ overdueCount: 0, failedLast30Days: 0, otherOwingCount: 0, failedToReconcileCount: 0 })?.tone).toBe("good");
  });

  it("Members: the payers view names both lines; each chip and drill-through lists exactly its accounts", async () => {
    const owing = await loadOwing();
    const rows = CLUB.map((r) => listRow(r, owing));
    expect(countMemberRows(rows, NOW, MONTH).overdue).toBe(2);
    expect(rows.filter((r) => inStatusView(r, "other-owing")).map((r) => r.name)).toEqual(["Ian Inactive"]);
    expect(rows.filter((r) => inStatusView(r, "failed-to-reconcile")).map((r) => r.name)).toEqual(["Cole Cancelled"]);

    const props = { members: rows, primaryColor: "#3b82f6", role: "coach", serverCounts: countMemberRows(rows, NOW, MONTH), otherOwing: otherOwingTotals(owing), monthWindow: { ...MONTH, isCurrent: true } };
    currentSearch = "filter=overdue";
    const { unmount } = render(<MembersList {...props} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("2 payers overdue");
    expect(screen.getByTestId("members-other-owing-line").textContent).toBe("Other accounts owing: 1 (inactive or left, marked overdue, not chased)");
    expect(screen.getByTestId("members-to-reconcile-line").textContent).toBe("Last charge failed — to reconcile: 1 (inactive or left, check before treating as owed)");
    expect(screen.getByRole("button", { name: "Other accounts owing · 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Last charge failed — to reconcile · 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Active · 1" })).toBeTruthy();
    unmount();

    currentSearch = "filter=other-owing";
    const second = render(<MembersList {...props} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("1 other account owing");
    expect(screen.getByTestId("members-headline-scope").textContent).toContain("marked overdue");
    expect(screen.queryAllByText("Ian Inactive").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Cole Cancelled")).toHaveLength(0);
    second.unmount();

    currentSearch = "filter=failed-to-reconcile";
    render(<MembersList {...props} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("1 account whose last charge failed — to reconcile");
    expect(screen.getByTestId("members-headline-scope").textContent).toContain("Not a confirmed debt: check the payment before treating it as owed");
    expect(screen.queryAllByText("Cole Cancelled").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Ian Inactive")).toHaveLength(0);
    expect(screen.queryAllByText("Ava Active")).toHaveLength(0);
    expect(screen.queryAllByText("Ned Stale")).toHaveLength(0);
  });

  it("Payments → Outstanding: the chase list and its total are the payers; the confirmed debt and the failed charge are listed apart with no Chase", async () => {
    const otherOwing = await loadOwing();
    const rows = buildOutstandingRows({
      now: NOW,
      overdueMembers: [
        { id: "ava", name: "Ava Active", membershipType: "Adult monthly", nextDueAt: ago(5), planPricePence: 5000, billedBy: "matflow", accountType: "adult" },
        { id: "gail", name: "Gail Guardian", membershipType: "Adult monthly", nextDueAt: ago(5), planPricePence: 5000, billedBy: "matflow", accountType: "parent" },
      ],
      latestFailed: new Map(),
      noPaymentYetMembers: [],
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ rows, total: 2, totalPence: 10000, otherOwing }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    render(<OutstandingPanel />);
    await screen.findByText("Ava Active");
    expect(screen.getByTestId("outstanding-summary").textContent).toContain("outstanding across 2 payers");
    expect(screen.getByTestId("outstanding-split").textContent).toBe("2 payers overdue · 0 with no payment yet. Includes 1 parent or guardian who pays.");
    expect(screen.getByTestId("outstanding-other-owing").textContent).toBe("Other accounts owing: 1 (inactive or left, marked overdue, not chased) — listed below, not in this total.");
    expect(screen.getByTestId("outstanding-to-reconcile").textContent).toBe("Last charge failed — to reconcile: 1 (inactive or left, check before treating as owed) — listed below, not in this total.");
    expect(screen.getByText("£100.00")).toBeTruthy();

    const owingList = screen.getByTestId("outstanding-other-owing-list");
    expect(within(owingList).getByText("Ian Inactive")).toBeTruthy();
    expect(within(owingList).queryByText("Cole Cancelled")).toBeNull();
    expect(owingList.textContent).toContain("Inactive · Marked overdue");
    expect(owingList.textContent).not.toContain("last charge failed");
    expect(within(owingList).queryByRole("button", { name: /Chase/ })).toBeNull();

    const reconcileList = screen.getByTestId("outstanding-to-reconcile-list");
    expect(within(reconcileList).getByText("Cole Cancelled")).toBeTruthy();
    expect(within(reconcileList).queryByText("Ian Inactive")).toBeNull();
    expect(reconcileList.textContent).toContain(FAILED_TO_RECONCILE_COPY.label);
    expect(reconcileList.textContent).toContain("Cancelled · Last charge failed on");
    expect(reconcileList.textContent).toContain("— check before treating as owed");
    expect(within(reconcileList).queryByRole("button", { name: /Chase/ })).toBeNull();
  });
});
