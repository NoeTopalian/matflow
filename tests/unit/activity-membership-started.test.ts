// "Started a membership — awaiting first payment" (lib/activity-events.ts
// logMembershipStarted): written once per Stripe subscription, behind the
// Member row lock, and never in the way of the payment form. That two requests
// really do take turns is proved against the database
// (tests/integration/activity-events-db.test.ts); here, the order of the steps
// and what happens when any of them fails.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Found = { id: string } | null;
const h = vi.hoisted(() => {
  const steps: string[] = [];
  return {
    steps,
    logAudit: vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => {
      steps.push("write");
    }),
    memberLock: vi.fn<(...args: unknown[]) => Promise<Found>>(async () => {
      steps.push("lock");
      return { id: "m1" };
    }),
    earlier: vi.fn<(args: unknown) => Promise<Found>>(async () => {
      steps.push("look for an earlier row");
      return null;
    }),
    tier: vi.fn<(args: unknown) => Promise<Found>>(async () => {
      steps.push("look up the plan");
      return { id: "tier_on_sale" };
    }),
    withTenantContext: vi.fn(),
  };
});
const TX = { auditLog: { findFirst: h.earlier }, membershipTier: { findFirst: h.tier } };

vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/checkin", () => ({ memberLock: h.memberLock }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: h.withTenantContext }));

import { logMembershipStarted } from "@/lib/activity-events";

const ARGS = { tenantId: "t1", memberId: "m1", stripePriceId: "price_1", stripeSubscriptionId: "sub_1QabcDEF234", userId: "m1", memberEmail: "melody@example.test" };

beforeEach(() => {
  vi.clearAllMocks();
  h.steps.length = 0;
  h.withTenantContext.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(TX));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("logMembershipStarted", () => {
  it("locks the member, looks for an earlier row, then writes — all in one transaction", async () => {
    expect(await logMembershipStarted(ARGS)).toBe(true);
    expect(h.steps).toEqual(["lock", "look for an earlier row", "look up the plan", "write"]);
    expect(h.withTenantContext).toHaveBeenCalledTimes(1);
    expect(h.memberLock).toHaveBeenCalledWith(TX, "t1", "m1");
    expect(h.earlier).toHaveBeenCalledWith({ where: { tenantId: "t1", requestId: "sub-purchased:sub_1QabcDEF234" }, select: { id: true } });
    const written = h.logAudit.mock.calls[0][0];
    // The write is in the same transaction as the check: not a write of its own afterwards.
    expect(written.tx).toBe(TX);
    expect(written.durable).toBeUndefined();
    expect(written).toMatchObject({
      tenantId: "t1",
      userId: "m1",
      action: "member.subscription.purchased",
      entityType: "Member",
      entityId: "m1",
      requestId: "sub-purchased:sub_1QabcDEF234",
      metadata: { memberId: "m1", tierId: "tier_on_sale", stripeSubscriptionId: "sub_1QabcDEF234" },
    });
  });

  it("a second request for the same subscription finds the first one's row and writes nothing", async () => {
    h.earlier.mockResolvedValueOnce({ id: "audit_1" });
    expect(await logMembershipStarted(ARGS)).toBe(false);
    expect(h.logAudit).not.toHaveBeenCalled();
    expect(h.tier).not.toHaveBeenCalled();
  });

  it("uses the plan the caller already resolved, without looking it up by price", async () => {
    expect(await logMembershipStarted({ ...ARGS, tierId: "tier_resolved" })).toBe(true);
    expect(h.tier).not.toHaveBeenCalled();
    expect(h.logAudit.mock.calls[0][0].metadata).toMatchObject({ tierId: "tier_resolved" });
  });

  it("looked up by price, a plan on sale beats an archived one on the same price, and the newest edit beats the rest", async () => {
    await logMembershipStarted(ARGS);
    expect(h.tier).toHaveBeenCalledWith({
      where: { tenantId: "t1", stripePriceId: "price_1" },
      orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
      select: { id: true },
    });
  });

  it("a price that maps to no plan is still recorded, with no plan", async () => {
    h.tier.mockResolvedValueOnce(null);
    expect(await logMembershipStarted(ARGS)).toBe(true);
    expect(h.logAudit.mock.calls[0][0].metadata).toMatchObject({ tierId: null });
  });

  it("an erased member gets no row, decided before anything is read", async () => {
    expect(await logMembershipStarted({ ...ARGS, memberEmail: "deleted-cm1@deleted.invalid" })).toBe(false);
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a member who is no longer in the club gets no row", async () => {
    h.memberLock.mockResolvedValueOnce(null);
    expect(await logMembershipStarted(ARGS)).toBe(false);
    expect(h.steps).toEqual([]);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  describe("never throws: the member is owed their payment form", () => {
    it("the transaction cannot be opened", async () => {
      const said = vi.spyOn(console, "error").mockImplementation(() => {});
      h.withTenantContext.mockRejectedValueOnce(new Error("connection refused"));
      await expect(logMembershipStarted(ARGS)).resolves.toBe(false);
      expect(String(said.mock.calls[0][0])).toContain("member.subscription.purchased was not recorded");
      expect(JSON.stringify(said.mock.calls)).not.toContain("melody@example.test");
    });

    it("the lock cannot be taken", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      h.memberLock.mockRejectedValueOnce(new Error("lock timeout"));
      await expect(logMembershipStarted(ARGS)).resolves.toBe(false);
      expect(h.logAudit).not.toHaveBeenCalled();
    });

    it("the write fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      h.logAudit.mockRejectedValueOnce(new Error("insert failed"));
      await expect(logMembershipStarted(ARGS)).resolves.toBe(false);
    });

    it("the subscription id is not one (the shape refuses it, here by throwing)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(logMembershipStarted({ ...ARGS, stripeSubscriptionId: "sub_test_self_456" })).resolves.toBe(false);
      expect(h.logAudit).not.toHaveBeenCalled();
    });
  });
});
