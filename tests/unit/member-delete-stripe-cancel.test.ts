import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Audit P1-8 — DELETE /api/members/[id] must cancel Stripe, fail-closed.
 *
 * Before this fix the hard-delete handler went straight to the cascade: the
 * Member row vanished while Stripe carried on charging the card, and the
 * resulting Payment rows landed with memberId = null (that FK is SET NULL) so
 * nobody could tell who was still being billed. The contract now matches the
 * DSAR erase route and the PATCH-to-cancelled path — if Stripe refuses, the
 * delete is refused and the row survives for the operator to retry.
 *
 * lib/member-delete is mocked here on purpose: this file is about the Stripe
 * gate in front of the cascade, not the cascade walk itself (covered by
 * tests/integration/member-cascade-delete.test.ts).
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

const { memberFindFirstMock, tenantFindUniqueMock, cancelSubMock, deleteHelperMock } = vi.hoisted(() => ({
  memberFindFirstMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  cancelSubMock: vi.fn(),
  deleteHelperMock: vi.fn(),
}));

const fakeTx = {
  member: { findFirst: memberFindFirstMock },
  tenant: { findUnique: tenantFindUniqueMock },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakeTx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
}));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: cancelSubMock }));
vi.mock("@/lib/member-delete", () => ({ deleteParentMemberWithKidsResolution: deleteHelperMock }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const TENANT = "tenant-A";
const ACCOUNT = "acct_gym_123";

function deleteReq(id: string, query = "confirm=1") {
  return new Request(`https://test.local/api/members/${id}?${query}`, {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

async function callDelete(id: string, query?: string) {
  const { DELETE } = await import("@/app/api/members/[id]/route");
  return DELETE(deleteReq(id, query) as never, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u-owner", role: "owner", tenantId: TENANT, email: "owner@gym.test" },
  } as never);
  tenantFindUniqueMock.mockResolvedValue({ stripeAccountId: ACCOUNT });
  deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Sam Fighter", kidsAffected: 0 });
});

describe("DELETE /api/members/[id] — Stripe cancellation gate (P1-8)", () => {
  it("refuses the delete when the Stripe cancel fails", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: "sub_live_1",
      children: [],
    });
    cancelSubMock.mockResolvedValue({ ok: false, status: 500, error: "card_declined" });

    const res = await callDelete("m-1");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Cannot delete");
    expect(body.error).toContain("Sam Fighter");
    expect(body.error).toContain("card_declined");
    // Fail-closed: the cascade must never have run.
    expect(deleteHelperMock).not.toHaveBeenCalled();
  });

  it("refuses the delete when the gym has no connected Stripe account", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: "sub_live_1",
      children: [],
    });
    tenantFindUniqueMock.mockResolvedValue({ stripeAccountId: null });

    const res = await callDelete("m-1");

    expect(res.status).toBe(422);
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(deleteHelperMock).not.toHaveBeenCalled();
  });

  it("cancels the subscription and then deletes when Stripe succeeds", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: "sub_live_1",
      children: [],
    });
    cancelSubMock.mockResolvedValue({ ok: true, cancelAt: 1770000000 });

    const res = await callDelete("m-1");

    expect(res.status).toBe(200);
    expect(cancelSubMock).toHaveBeenCalledWith({
      tenant: { stripeAccountId: ACCOUNT },
      stripeSubscriptionId: "sub_live_1",
    });
    expect(deleteHelperMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { stripeSubscriptionsCancelled: number };
    expect(body.stripeSubscriptionsCancelled).toBe(1);
  });

  it("skips Stripe entirely for a member with no subscription", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-2",
      name: "Free Trialist",
      stripeSubscriptionId: null,
      children: [],
    });

    const res = await callDelete("m-2");

    expect(res.status).toBe(200);
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(deleteHelperMock).toHaveBeenCalledTimes(1);
  });

  it("cascade strategy also cancels each kid's subscription", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: "sub_parent",
      children: [
        { id: "k-1", name: "Kid One", stripeSubscriptionId: "sub_kid_1" },
        { id: "k-2", name: "Kid Two", stripeSubscriptionId: null },
      ],
    });
    cancelSubMock.mockResolvedValue({ ok: true, cancelAt: null });
    deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Parent Payer", kidsAffected: 2 });

    const res = await callDelete("p-1", "strategy=cascade");

    expect(res.status).toBe(200);
    expect(cancelSubMock).toHaveBeenCalledTimes(2);
    const cancelledIds = cancelSubMock.mock.calls.map((c) => c[0].stripeSubscriptionId).sort();
    expect(cancelledIds).toEqual(["sub_kid_1", "sub_parent"]);
  });

  it("orphan strategy leaves the surviving kids' subscriptions alone", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: null,
      children: [{ id: "k-1", name: "Kid One", stripeSubscriptionId: "sub_kid_1" }],
    });
    deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Parent Payer", kidsAffected: 1 });

    const res = await callDelete("p-1", "strategy=orphan");

    expect(res.status).toBe(200);
    // The kid stays in the tenant, so their subscription must stay live.
    expect(cancelSubMock).not.toHaveBeenCalled();
  });

  it("does not cancel anything on the kids-present picker response", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: "sub_parent",
      children: [{ id: "k-1", name: "Kid One", stripeSubscriptionId: null }],
    });
    deleteHelperMock.mockResolvedValue({
      kind: "kids-present",
      kids: [{ id: "k-1", name: "Kid One" }],
    });

    const res = await callDelete("p-1");

    expect(res.status).toBe(409);
    // Nothing was deleted, so nothing may have been cancelled.
    expect(cancelSubMock).not.toHaveBeenCalled();
  });

  it("404s without touching Stripe when the member is not in this tenant", async () => {
    memberFindFirstMock.mockResolvedValue(null);

    const res = await callDelete("m-nope");

    expect(res.status).toBe(404);
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(deleteHelperMock).not.toHaveBeenCalled();
  });
});
