// @vitest-environment jsdom
//
// D10 (owner direction, Noe 23 Oct 2026): "no payment recorded" is not the
// same as confirmed non-payment. The self check-in door's ACCESS rule is
// unchanged — the same members are refused — but the refusal now says which
// evidence applies, and the Members Payment badge uses the same three:
//
//   A  on a plan, nothing ever recorded, first payment date 3 Jan passed
//        → "No payment has been recorded for this membership and its first payment date (3 Jan) has passed."
//   B  a charge failed on 5 Jan (Stripe overdue)
//        → "A payment failed on 5 Jan."
//   C  paid before, the payment due on 3 Jan not recorded
//        → "The payment due on 3 Jan is outstanding."

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

const memberFindUniqueMock = vi.fn();
const paymentFindFirstMock = vi.fn();
const recordCreateMock = vi.fn();

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: memberFindUniqueMock },
      payment: { findFirst: paymentFindFirstMock },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
      classInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ci-1", classId: "c-1", isCancelled: false,
          date: new Date("2026-09-25T00:00:00.000Z"), startTime: "10:00", endTime: "11:00",
          class: { id: "c-1", tenantId: "t-1", maxCapacity: null, requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null,
            tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" } },
        }),
      },
      attendanceRecord: { create: recordCreateMock, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue(null) },
      classPackRedemption: { create: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ maxCapacity: null }]),
    }),
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("filter=all"),
  usePathname: () => "/dashboard/members",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { performCheckin } from "@/lib/checkin";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { PAYMENT_EVIDENCE_LABEL, paymentEvidence, paymentEvidenceSentence, shownPaymentStatus } from "@/lib/overdue";
import MembersList, { type MemberRow } from "@/components/dashboard/MembersList";

const SELF = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self" as const,
  enforceRankGate: false, enforceRosterGate: false, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: false, enforceWaiverGate: true, enforceHoldGate: true,
  checkedInByUserId: null,
};
const base = { waiverAccepted: true, holdUntil: null, stripeSubscriptionId: null as string | null, billedBy: "matflow", accountType: "adult", membershipTier: null };
const DUE_3_JAN = new Date("2026-01-03T00:00:00.000Z");
const FAILED_5_JAN = new Date("2026-01-05T12:00:00.000Z");
const FUTURE = new Date(Date.now() + 10 * 86_400_000);

const A = { ...base, paymentStatus: "pending", membershipTierId: "tier-1", nextDueAt: DUE_3_JAN };
const B = { ...base, paymentStatus: "overdue", membershipTierId: "tier-1", nextDueAt: DUE_3_JAN, stripeSubscriptionId: "sub_b" };
const C = { ...base, paymentStatus: "paid", membershipTierId: "tier-1", nextDueAt: DUE_3_JAN };

const SENTENCE_A = "No payment has been recorded for this membership and its first payment date (3 Jan) has passed.";
const SENTENCE_B = "A payment failed on 5 Jan.";
const SENTENCE_C = "The payment due on 3 Jan is outstanding.";

beforeEach(() => {
  vi.clearAllMocks();
  recordCreateMock.mockResolvedValue({ id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: "self" });
});
afterEach(() => cleanup());

async function refuse(member: object, lastSettled: { status: string; createdAt: Date } | null) {
  memberFindUniqueMock.mockResolvedValue(member);
  paymentFindFirstMock.mockResolvedValue(lastSettled);
  const result = await performCheckin(SELF);
  expect(result.kind).toBe("no_coverage");
  expect(recordCreateMock).not.toHaveBeenCalled();
  return { result, refusal: checkinRefusal(result, { paymentRail: "stripe", timeZone: "Europe/London" }) };
}

describe("D10: the self check-in refusal names its evidence; who is refused is unchanged", () => {
  it("A — never paid, first payment date passed: 'No payment has been recorded…'", async () => {
    const { result, refusal } = await refuse(A, null);
    expect(result.kind === "no_coverage" && result.payment?.kind).toBe("no_payment_recorded");
    expect(refusal?.status).toBe(402);
    expect(refusal?.body).toEqual({ error: `${SENTENCE_A} Ask the desk to record your payment.`, reason: "no_coverage" });
  });

  it("B — a charge failed: 'A payment failed on 5 Jan.'", async () => {
    const { result, refusal } = await refuse(B, { status: "failed", createdAt: FAILED_5_JAN });
    expect(result.kind === "no_coverage" && result.payment?.kind).toBe("payment_failed");
    expect(refusal?.body.error).toBe(`${SENTENCE_B} Speak to the desk to settle it.`);
  });

  it("C — paid before, a due date passed: 'The payment due on 3 Jan is outstanding.'", async () => {
    const { result, refusal } = await refuse(C, { status: "succeeded", createdAt: new Date("2025-12-03T09:00:00.000Z") });
    expect(result.kind === "no_coverage" && result.payment?.kind).toBe("payment_outstanding");
    expect(refusal?.body.error).toBe(`${SENTENCE_C} Speak to the desk to settle it.`);
  });

  it("a declined FIRST charge is a failed payment, not 'no payment recorded'", async () => {
    const { result } = await refuse(A, { status: "failed", createdAt: FAILED_5_JAN });
    expect(result.kind === "no_coverage" && result.payment?.kind).toBe("payment_failed");
  });

  it("a failed read of the latest payment still refuses, with the evidence the member row gives", async () => {
    memberFindUniqueMock.mockResolvedValue(C);
    paymentFindFirstMock.mockRejectedValue(new Error("connection reset"));
    const result = await performCheckin(SELF);
    expect(result.kind === "no_coverage" && result.payment?.kind).toBe("payment_outstanding");
  });

  it("access is unchanged: paid with a future due date is admitted; no plan keeps the no-plan sentence", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...C, nextDueAt: FUTURE });
    expect((await performCheckin(SELF)).kind).toBe("success");
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "paid", membershipTierId: null, nextDueAt: null });
    const r = await performCheckin(SELF);
    expect(r.kind === "no_coverage" && r.payment).toBeNull();
    expect(checkinRefusal(r, { paymentRail: "pay_at_desk" })?.body.error).toBe("No plan yet — ask the desk to add one.");
    expect(paymentFindFirstMock).not.toHaveBeenCalled();
  });
});

describe("D10: the Members Payment badge uses the same three distinctions", () => {
  const NOW = new Date();
  function row(id: string, name: string, m: typeof A, lastSettled: { status: string; createdAt: Date } | null): MemberRow {
    const e = paymentEvidence(m, NOW, lastSettled);
    return {
      id,
      name,
      email: `${id}@example.test`,
      membershipType: "Adult monthly",
      status: "active",
      accountType: "adult",
      paymentStatus: shownPaymentStatus(m, NOW),
      paymentEvidence: e ? { kind: e.kind, label: PAYMENT_EVIDENCE_LABEL[e.kind], sentence: paymentEvidenceSentence(e, "Europe/London") } : null,
      waiverAccepted: true,
      joinedAt: "2025-01-10T00:00:00.000Z",
    };
  }

  it("A, B and C read 'No payment recorded', 'Payment failed', 'Payment outstanding', each titled with the door's sentence", () => {
    const rows = [
      row("a", "Ann Neverpaid", A, null),
      row("b", "Bob Declined", B, { status: "failed", createdAt: FAILED_5_JAN }),
      row("c", "Cat Lapsed", C, { status: "succeeded", createdAt: new Date("2025-12-03T09:00:00.000Z") }),
      row("d", "Dee New", { ...A, nextDueAt: FUTURE }, null),
    ];
    // The counts are untouched: A stays "pending" (No payment yet), B and C "overdue".
    expect(rows.map((r) => r.paymentStatus)).toEqual(["pending", "overdue", "overdue", "pending"]);
    render(<MembersList members={rows} primaryColor="#3b82f6" role="owner" />);
    const badges = screen.getAllByTestId("member-payment-badge");
    const byText = (t: string) => badges.find((b) => b.textContent === t);
    expect(byText("No payment recorded")?.getAttribute("title")).toBe(SENTENCE_A);
    expect(byText("Payment failed")?.getAttribute("title")).toBe(SENTENCE_B);
    expect(byText("Payment outstanding")?.getAttribute("title")).toBe(SENTENCE_C);
    // Not behind yet: the plain "No payment yet" badge, no evidence.
    expect(byText("No payment yet")?.getAttribute("title")).toBeNull();
  });
});
