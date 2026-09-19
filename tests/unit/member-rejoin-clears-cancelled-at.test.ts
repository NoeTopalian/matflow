import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Lane L-C round 1, defect 4.
 *
 * `Member.cancelledAt` had exactly one writer — the transition TO "cancelled"
 * in PATCH /api/members/[id] — and no reader ever cleared it. A member who
 * cancelled in January and rejoined in March stayed `status: "active"` with a
 * January `cancelledAt` for ever.
 *
 * That is a money number, not untidiness. The schema comment says so:
 *
 *   D1: set when status flips to "cancelled". Churn/net-new analytics filter
 *   on this (not updatedAt, which any edit bumps).
 *
 * So every churn and net-new figure counted the rejoiner as lost in January
 * and never recovered, and a club with ordinary rejoin traffic read its own
 * retention as permanently worse than it was.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { findFirstMock, updateManyMock, tenantFindMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  tenantFindMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: findFirstMock, updateMany: updateManyMock },
    tenant: { findUnique: tenantFindMock },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/totp-immutable", () => ({ stripTotpFields: (b: unknown) => b }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: true, cancelAt: null })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn().mockReturnValue("203.0.113.9"),
}));

import { PATCH } from "@/app/api/members/[id]/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);
const params = Promise.resolve({ id: "mem-1" });

function patchReq(body: object) {
  return new Request("http://localhost/api/members/mem-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The data object the route handed `member.updateMany`. */
function writtenData(): Record<string, unknown> {
  expect(updateManyMock, "the route reached the write").toHaveBeenCalled();
  return updateManyMock.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "owner", tenantId: "t-A" },
  } as unknown as Awaited<ReturnType<typeof auth>>);
  tenantFindMock.mockResolvedValue({ stripeAccountId: null });
  updateManyMock.mockResolvedValue({ count: 1 });
  // The post-update re-fetch and the before-values read both go through
  // findFirst; a permissive default keeps the handler on its happy path.
  findFirstMock.mockResolvedValue({
    id: "mem-1", email: "a@b.c", status: "cancelled", stripeSubscriptionId: null,
    name: "Alex", phone: null, membershipType: null, paymentStatus: "paid",
    emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
    dateOfBirth: null, nextDueAt: null, updatedAt: new Date(),
  });
});

describe("PATCH /api/members/[id] — cancelledAt across the churn cycle", () => {
  it("clears cancelledAt when a cancelled member moves back to active", async () => {
    await PATCH(patchReq({ status: "active" }), { params });
    expect(writtenData().cancelledAt, "a rejoiner is not still churned").toBeNull();
  });

  it("clears it for every active-side status, not only 'active'", async () => {
    for (const status of ["active", "taster"]) {
      vi.clearAllMocks();
      tenantFindMock.mockResolvedValue({ stripeAccountId: null });
      updateManyMock.mockResolvedValue({ count: 1 });
      findFirstMock.mockResolvedValue({
        id: "mem-1", email: "a@b.c", status: "cancelled", stripeSubscriptionId: null,
        name: "Alex", phone: null, membershipType: null, paymentStatus: "paid",
        emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
        dateOfBirth: null, nextDueAt: null, updatedAt: new Date(),
      });
      await PATCH(patchReq({ status }), { params });
      expect(writtenData().cancelledAt, `status → ${status}`).toBeNull();
    }
  });

  it("still stamps cancelledAt on the way out", async () => {
    findFirstMock.mockResolvedValue({
      id: "mem-1", email: "a@b.c", status: "active", stripeSubscriptionId: null,
      name: "Alex", phone: null, membershipType: null, paymentStatus: "paid",
      emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
      dateOfBirth: null, nextDueAt: null, updatedAt: new Date(),
    });
    await PATCH(patchReq({ status: "cancelled" }), { params });
    expect(writtenData().cancelledAt, "D1 still dates the churn").toBeInstanceOf(Date);
  });

  it("leaves cancelledAt alone when a PATCH does not touch status at all", async () => {
    await PATCH(patchReq({ phone: "+447700900111" }), { params });
    expect("cancelledAt" in writtenData(), "an unrelated edit must not resurrect or erase a churn date").toBe(false);
  });

  it("leaves it alone when an already-active member is PATCHed active again", async () => {
    findFirstMock.mockResolvedValue({
      id: "mem-1", email: "a@b.c", status: "active", stripeSubscriptionId: null,
      name: "Alex", phone: null, membershipType: null, paymentStatus: "paid",
      emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
      dateOfBirth: null, nextDueAt: null, updatedAt: new Date(),
    });
    await PATCH(patchReq({ status: "active" }), { params });
    expect("cancelledAt" in writtenData(), "no transition, no write").toBe(false);
  });
});
