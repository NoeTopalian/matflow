// Existing audit rows gained the id the Activity timeline's filters need
// (5 Nov 2026): the plan on a cancellation or a hold, the member on a refund,
// the class on a check-in, the name on a deletion. And the attribution row is
// now written only for a real change.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { addLoginClaimSql } from "./login-claim-fake";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, headers: init?.headers ?? {}, json: async () => body }),
  },
}));

const { findFirstMock, updateManyMock, tenantFindMock, logAuditMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  tenantFindMock: vi.fn(),
  logAuditMock: vi.fn<(row: Record<string, unknown>) => Promise<void>>(async () => {}),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: findFirstMock, updateMany: updateManyMock },
    tenant: { findUnique: tenantFindMock },
    passwordResetToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    magicLinkToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(addLoginClaimSql(prisma));
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/totp-immutable", () => ({ stripTotpFields: (b: unknown) => b }));
vi.mock("@/lib/member-status", () => ({ recordStatusEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: true, cancelAt: null })) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })), getClientIp: vi.fn().mockReturnValue("203.0.113.9") }));

import { PATCH } from "@/app/api/members/[id]/route";
import { auth } from "@/auth";

const params = Promise.resolve({ id: "mem-1" });
const patch = (body: object) => PATCH(new Request("http://localhost/api/members/mem-1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params });
const rowsOf = (action: string) => logAuditMock.mock.calls.map(([row]) => row).filter((row) => row.action === action) as { metadata: Record<string, unknown> }[];

let row: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "owner", tenantId: "t-A" } } as never);
  tenantFindMock.mockResolvedValue({ stripeAccountId: null });
  row = {
    id: "mem-1", email: "alex@example.com", status: "active", stripeSubscriptionId: null, name: "Alex", phone: null, membershipType: null, paymentStatus: "paid",
    emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null, dateOfBirth: null, nextDueAt: null, updatedAt: new Date(), passwordHash: null,
    membershipTierId: "tier-adult", billedBy: null, accountType: "adult", preferredPaymentMethod: null, leaderboardOptOut: false, holdUntil: null,
    trialRunById: null, creditedToUserId: null, creditedToMemberId: null, creditedToLabel: "Open day",
  };
  // The before-read and the read-back both go through findFirst, so the fake carries the write across.
  findFirstMock.mockImplementation(async (args: { where: Record<string, unknown> }) => ("email" in args.where ? null : { ...row }));
  updateManyMock.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    for (const [k, v] of Object.entries(args.data)) if (typeof v === "string" || v === null) row[k] = v;
    return { count: 1 };
  });
});

describe("a staff cancellation names the plan that was held", () => {
  it("the member.update row carries tierId, so the plan's own history finds the cancellation", async () => {
    expect((await patch({ status: "cancelled" })).status).toBe(200);
    const [update] = rowsOf("member.update");
    expect(update.metadata.changes).toMatchObject({ status: { from: "active", to: "cancelled" } });
    expect(update.metadata.tierId).toBe("tier-adult");
  });

  it("an edit that is not a cancellation does not", async () => {
    expect((await patch({ name: "Alexandra" })).status).toBe(200);
    expect("tierId" in rowsOf("member.update")[0].metadata).toBe(false);
  });

  it("a member on no plan is cancelled without one", async () => {
    row.membershipTierId = null;
    expect((await patch({ status: "cancelled" })).status).toBe(200);
    expect("tierId" in rowsOf("member.update")[0].metadata).toBe(false);
  });
});

describe("the attribution row is written for a change, not for every save", () => {
  it("the member form sends the same values back: no row", async () => {
    expect((await patch({ name: "Alexandra", creditedToLabel: "Open day", trialRunById: null, creditedToUserId: null, creditedToMemberId: null })).status).toBe(200);
    expect(rowsOf("member.update")).toHaveLength(1);
    expect(rowsOf("member.attribution.update")).toHaveLength(0);
  });

  it("a changed value: one row, naming only the field that changed", async () => {
    expect((await patch({ creditedToLabel: "Friend referral", trialRunById: null, creditedToUserId: null, creditedToMemberId: null })).status).toBe(200);
    const rows = rowsOf("member.attribution.update");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ fields: ["creditedToLabel"], values: { creditedToLabel: "Friend referral" } });
  });

  it("clearing a value is a change", async () => {
    expect((await patch({ creditedToLabel: null })).status).toBe(200);
    expect(rowsOf("member.attribution.update")[0].metadata).toEqual({ fields: ["creditedToLabel"], values: { creditedToLabel: null } });
  });
});

// The remaining additions are one conditional key each, in routes whose behaviour is otherwise unchanged and tested
// elsewhere. Each is pinned where it is written, so a later edit cannot drop it without this test saying which.
describe("each writer names what the timeline filters on", () => {
  const src = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
  const WRITERS: [string, string, RegExp][] = [
    ["a member's own cancellation names their plan", "app/api/member/subscriptions/cancel/route.ts", /action: "member\.subscription\.cancel",.*?tierId: member\.membershipTierId/],
    ["a parent's cancellation for a child names the child's plan", "app/api/member/subscriptions/cancel-for-kid/route.ts", /action: "member\.subscription\.cancel\.kid",.*?tierId: kid\.membershipTierId/],
    ["a parent starting a child's membership names the plan", "app/api/member/subscriptions/start-for-kid/route.ts", /action: "member\.subscription\.create\.kid",.*?tierId: tier\.id/],
    ["a membership ended by Stripe names the plan", "app/api/stripe/webhook/route.ts", /action: "member\.subscription\.cancelled_by_stripe",.*?tierId: cancelledMember\.membershipTierId/],
    ["a hold names the plan", "app/api/members/[id]/hold/route.ts", /action: "member\.hold\.start",.*?tierId: member\.membershipTierId/],
    ["the end of a hold names the plan", "app/api/members/[id]/resume/route.ts", /action: "member\.hold\.end",.*?tierId: member\.membershipTierId/],
    ["a refund names the member whose payment it was", "app/api/payments/[id]/refund/route.ts", /action: "payment\.refund",.*?memberId: payment\.memberId/],
    ["an order marked paid at the desk names its member", "app/api/orders/[id]/mark-paid/route.ts", /action: "order\.mark_paid",.*?memberId: updated\.memberId/],
    ["a staff check-in names the class", "app/api/checkin/route.ts", /action: "attendance\.mark",.*?classId: result\.classId/],
    ["a member's own check-in names the class", "app/api/checkin/route.ts", /action: "attendance\.self_checkin",.*?classId: result\.classId/],
    ["a kiosk check-in names the class", "app/api/kiosk/[token]/checkin/route.ts", /action: "attendance\.kiosk_checkin",.*?classId: result\.classId/],
    ["a card-scan batch names the class", "app/api/checkin/card/route.ts", /action: "attendance\.card_scan",.*?classId: instance\.classId/],
    ["a deleted member's name is kept on the deletion row", "app/api/members/[id]/route.ts", /action: "member\.delete",.*?name: deletedName/],
  ];
  it.each(WRITERS)("%s", (_what, path, pattern) => {
    expect(pattern.test(src(path)), `${path} no longer matches ${pattern}`).toBe(true);
  });

  it("every successful check-in result carries its class", () => {
    const checkin = src("lib/checkin.ts");
    const successes = checkin.split('kind: "success",').length - 1;
    expect(successes).toBeGreaterThanOrEqual(4);
    expect(checkin.split("classId: instance.classId,").length - 1).toBe(successes);
  });
});
