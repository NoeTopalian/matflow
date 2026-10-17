// T7c (Sean note 5): the membership routes accept the class allowance as the
// pair classLimit / classLimitWeeks, refuse half a pair, keep accepting the
// legacy maxClassesPerWeek from a page loaded before this release, write the
// three columns in step, and audit all three for undo.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipTier: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    location: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit-log";
import { POST } from "@/app/api/memberships/route";
import { PATCH } from "@/app/api/memberships/[id]/route";
import { describeApiError } from "@/lib/api-field-errors";

const mockAuth = vi.mocked(auth);
const mockUpdateMany = vi.mocked(prisma.membershipTier.updateMany);
const mockCreate = vi.mocked(prisma.membershipTier.create);
const mockFindFirst = vi.mocked(prisma.membershipTier.findFirst);
const mockLogAudit = vi.mocked(logAudit);

type Cols = { maxClassesPerWeek: number | null; classLimit: number | null; classLimitWeeks: number | null };
const row = (cols: Partial<Cols> = {}) => ({
  id: "tier-1", tenantId: "tenant-A", name: "Plan A", description: null, pricePence: 4500,
  currency: "GBP", billingCycle: "monthly", maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null,
  isKids: false, isActive: true, locationId: null, stripePriceId: null, stripeProductId: null,
  createdAt: new Date(), updatedAt: new Date(), ...cols,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "tenant-A", id: "user-1" } } as never);
});

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/memberships/tier-1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "tier-1" }) },
  );
}

function post(extra: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/memberships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Plan B", pricePence: 4000, currency: "GBP", billingCycle: "monthly", isKids: false, ...extra }),
    }),
  );
}

describe("PATCH /api/memberships/[id] — class allowance", () => {
  it("sets 4 every 4 weeks, nulls the legacy column, and audits the change for undo", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst
      .mockResolvedValueOnce(row({ maxClassesPerWeek: 3 }) as never)
      .mockResolvedValueOnce(row({ classLimit: 4, classLimitWeeks: 4 }) as never);
    const res = await patch({ classLimit: 4, classLimitWeeks: 4 });
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "tier-1", tenantId: "tenant-A" },
      data: { classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: null },
    });
    const meta = mockLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta.before).toEqual({ maxClassesPerWeek: 3, classLimit: null, classLimitWeeks: null });
    expect(meta.after).toEqual({ maxClassesPerWeek: null, classLimit: 4, classLimitWeeks: 4 });
  });

  it("a weekly allowance mirrors N into maxClassesPerWeek", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row() as never);
    await patch({ classLimit: 3, classLimitWeeks: 1 });
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ classLimit: 3, classLimitWeeks: 1, maxClassesPerWeek: 3 });
  });

  it("a null pair clears all three columns (Unlimited)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row() as never);
    const res = await patch({ classLimit: null, classLimitWeeks: null });
    expect(res.status).toBe(200);
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null });
  });

  it("the legacy field from a pre-T7c page is still honoured, as N every 1 week", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row() as never);
    await patch({ maxClassesPerWeek: 5 });
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ classLimit: 5, classLimitWeeks: 1, maxClassesPerWeek: 5 });
  });

  it("an unrelated edit leaves the allowance alone", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row({ classLimit: 4, classLimitWeeks: 4 }) as never);
    await patch({ name: "Plan A2" });
    const data = mockUpdateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toEqual({ name: "Plan A2" });
  });

  it.each([
    [{ classLimit: 4 }],
    [{ classLimitWeeks: 4 }],
    [{ classLimit: 4, classLimitWeeks: null }],
    [{ classLimit: null, classLimitWeeks: 4 }],
    [{ classLimit: 0, classLimitWeeks: 4 }],
    [{ classLimit: 61, classLimitWeeks: 4 }],
    [{ classLimit: 2.5, classLimitWeeks: 4 }],
    [{ classLimit: 4, classLimitWeeks: 9 }],
    [{ classLimit: 4, classLimitWeeks: 0 }],
    [{ classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: 4 }],
  ])("refuses %j with a 400 and writes nothing", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("half a pair reads as one sentence the owner can act on", async () => {
    const res = await patch({ classLimit: 4 });
    expect(describeApiError(await res.json())).toBe(
      "Set both the number of classes and how many weeks, or leave both blank for Unlimited.",
    );
  });

  it("an out-of-range number names the field in plain words", async () => {
    const res = await patch({ classLimit: 61, classLimitWeeks: 4 });
    expect(describeApiError(await res.json())).toBe("Classes allowed must be 60 or less.");
    const res2 = await patch({ classLimit: 4, classLimitWeeks: 9 });
    expect(describeApiError(await res2.json())).toBe("Weeks must be 8 or less.");
  });
});

describe("POST /api/memberships — class allowance", () => {
  beforeEach(() => {
    mockCreate.mockImplementation((async (args: { data: Record<string, unknown> }) => ({ id: "tier-new", ...args.data })) as never);
  });

  it("creates with 4 every 4 weeks", async () => {
    const res = await post({ classLimit: 4, classLimitWeeks: 4 });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ tenantId: "tenant-A", classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: null });
  });

  it("creates Unlimited when the allowance is absent or a null pair", async () => {
    await post({});
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null });
    await post({ classLimit: null, classLimitWeeks: null });
    expect(mockCreate.mock.calls[1][0].data).toMatchObject({ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null });
  });

  it("a legacy weekly limit is stored as N every 1 week", async () => {
    await post({ maxClassesPerWeek: 3 });
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ classLimit: 3, classLimitWeeks: 1, maxClassesPerWeek: 3 });
  });

  it.each([[{ classLimit: 4 }], [{ classLimit: 61, classLimitWeeks: 4 }], [{ classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: 4 }]])(
    "refuses %j",
    async (extra) => {
      const res = await post(extra);
      expect(res.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );
});
