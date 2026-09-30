// End-user check of the two decisions ("No payment yet"; kids classes refuse
// adults), 30 Sep 2026. What it found, each pinned here:
//  1. After "Membership resumed" the profile said "Payment Paid" for a member
//     who never paid — the screen wrote "paid" instead of the route's answer.
//  2. Dashboard "Payments due 0" and Reports "All payments are in good
//     standing" while Payments → Outstanding listed members on "No payment yet".
//  4. The adult refusal at a kids class said only "This is a kids class."
//  5. The member Schedule badged a kids class "Next" for an adult.
// (3, the Payments header after Record from an Outstanding row, is in
// payments-page-refresh-after-record.test.tsx.)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findMany: vi.fn(), count: vi.fn() },
    classInstance: { findMany: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    member: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    payment: { count: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { getReportsData } from "@/lib/reports";
import { paymentStatusFromHoldResponse } from "@/lib/member-hold";
import { noPaymentYetWhere, owesMoneyClause, overdueClause } from "@/lib/overdue";
import { paymentHealthLine } from "@/lib/billing";
import { buildActionItems } from "@/lib/dashboard-action-items";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { sessionStates } from "@/lib/schedule-state";

const root = join(__dirname, "..", "..");
const source = (p: string) => readFileSync(join(root, p), "utf8");

describe("1. resume shows the route's payment status", () => {
  it("reads paymentStatus from the resume answer", () => {
    expect(paymentStatusFromHoldResponse({ ok: true, paymentStatus: "pending", holdUntil: null })).toBe("pending");
    expect(paymentStatusFromHoldResponse({ ok: true, paymentStatus: "paid" })).toBe("paid");
    expect(paymentStatusFromHoldResponse({ ok: true, paymentStatus: "paused" })).toBe("paused");
  });

  it("does not guess when the answer does not say", () => {
    expect(paymentStatusFromHoldResponse({ ok: true })).toBeNull();
    expect(paymentStatusFromHoldResponse(null)).toBeNull();
    expect(paymentStatusFromHoldResponse({ paymentStatus: "" })).toBeNull();
  });

  it("the profile no longer hard-codes Paid (or Paused) after resume/hold", () => {
    const profile = source("components/dashboard/MemberProfile.tsx");
    expect(profile).not.toMatch(/paymentStatus:\s*"paid",\s*holdUntil:\s*null/);
    expect(profile).not.toMatch(/paymentStatus:\s*"paused",\s*holdUntil:/);
    expect(profile.match(/paymentStatusFromHoldResponse\(data\)/g)?.length).toBe(2);
  });
});

describe("2. one definition of who owes (the Outstanding list's)", () => {
  it("No payment yet = pending, on a plan, MatFlow-billed", () => {
    expect(noPaymentYetWhere()).toEqual({
      paymentStatus: "pending",
      membershipTierId: { not: null },
      billedBy: { not: "teamup" },
    });
  });

  it("owes = overdue OR No payment yet", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(owesMoneyClause(now)).toEqual([...overdueClause(now), noPaymentYetWhere()]);
  });

  it("the dashboard count and action list, and Outstanding, all use it", () => {
    const dashboard = source("app/dashboard/page.tsx");
    expect(dashboard.match(/OR: owesMoneyClause\(/g)?.length).toBe(2);
    expect(dashboard).not.toMatch(/OR: overdueClause\(/);
    expect(source("app/api/payments/outstanding/route.ts")).toMatch(/\.\.\.noPaymentYetWhere\(\)/);
  });

  it("the dashboard action list names No payment yet as such", () => {
    const items = buildActionItems({
      now: new Date("2026-09-30T12:00:00Z"),
      overdue: [{ id: "m1", name: "Ben Brook", noPaymentYet: true }, { id: "m2", name: "Old Debt" }],
      recentFailed: [],
      missingWaiver: [],
      atRisk: [],
      birthdayCandidates: [],
    });
    expect(items.find((i) => i.memberId === "m1")?.detail).toBe("No payment yet");
    expect(items.find((i) => i.memberId === "m2")?.detail).toBe("Payment overdue");
  });
});

describe("2. Reports never says 'all in good standing' while anyone has No payment yet", () => {
  it("says Overdue now N · No payment yet M", () => {
    expect(paymentHealthLine({ overdueCount: 0, noPaymentYetCount: 2, failedLast30Days: 0 })).toEqual({
      tone: "owed",
      text: "Overdue now 0 · No payment yet 2",
    });
  });

  it("good standing only when nothing is owed at all", () => {
    expect(paymentHealthLine({ overdueCount: 0, noPaymentYetCount: 0, failedLast30Days: 0 })?.tone).toBe("good");
    expect(paymentHealthLine({ overdueCount: 1, noPaymentYetCount: 0, failedLast30Days: 0 })).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.class.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.class.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.classInstance.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.attendanceRecord.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.member.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.payment.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.member.count).mockImplementation(((args: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {};
      if (where.paymentStatus === "pending" && where.billedBy) return Promise.resolve(3 as never);
      return Promise.resolve(0 as never);
    }) as never);
  });

  it("getReportsData counts No payment yet with the shared rule, beside overdue", async () => {
    const data = await getReportsData("tenant-A");
    expect(data.paymentHealth.noPaymentYetCount).toBe(3);
    expect(data.paymentHealth.overdueCount).toBe(0);
    expect(paymentHealthLine(data.paymentHealth)?.text).toBe("Overdue now 0 · No payment yet 3");
  });
});

describe("4. the kids-class refusal says the rule and the next step", () => {
  it("names adults and what to do", () => {
    expect(checkinRefusal({ kind: "kids_class" })?.body.error).toBe(
      "This is a kids class — adults can't check in to it. Choose an adult class.",
    );
  });

  it("the kiosk sends the same sentence", () => {
    const kiosk = source("app/api/kiosk/[token]/checkin/route.ts");
    expect(kiosk).toMatch(/error: KIDS_CLASS_REFUSAL, reason: "kids_class"/);
    expect(kiosk).not.toMatch(/"This is a kids class\."/);
  });
});

describe("5. Schedule never badges a kids class Next for an adult", () => {
  const kids = { startMin: 17 * 60, endMin: 17 * 60 + 45 };
  const adult = { startMin: 18 * 60, endMin: 19 * 60 };
  const now = 16 * 60 + 40;

  it("an adult's Next is the adult class, the kids class stays upcoming", () => {
    expect(sessionStates([{ ...kids, neverNext: true }, adult], now, true)).toEqual(["upcoming", "next"]);
  });

  it("a child's schedule still badges the kids class Next", () => {
    expect(sessionStates([kids, adult], now, true)).toEqual(["next", "upcoming"]);
  });

  it("the Schedule page and the API wire it through", () => {
    expect(source("app/member/schedule/page.tsx")).toMatch(/neverNext: c\.kidsClassForAdult === true/);
    expect(source("app/api/member/schedule/route.ts")).toMatch(/kidsClassForAdult: viewerIsAdult && cls\.isKids === true/);
  });
});
