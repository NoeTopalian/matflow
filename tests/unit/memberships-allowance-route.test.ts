// T7c (Sean note 5; product decision 20 Oct 2026): the membership routes
// accept the class allowance as classLimit + classLimitBasis (plus
// classLimitWeeks + classLimitAnchor for "weeks"), refuse an inconsistent set,
// keep accepting the legacy maxClassesPerWeek from a page loaded before this
// release, write every allowance column in step, and audit them all for undo.
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

type Cols = { maxClassesPerWeek: number | null; classLimit: number | null; classLimitBasis: string | null; classLimitWeeks: number | null; classLimitAnchor: Date | null };
const NONE: Cols = { maxClassesPerWeek: null, classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null };
const ANCHOR = new Date("2026-10-20T00:00:00.000Z");
const FOUR_IN_FOUR: Cols = { maxClassesPerWeek: null, classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: ANCHOR };
const row = (cols: Partial<Cols> = {}) => ({
  id: "tier-1", tenantId: "tenant-A", name: "Plan A", description: null, pricePence: 4500,
  currency: "GBP", billingCycle: "monthly", ...NONE,
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
  it("sets 4 every 4 weeks from 20 October, nulls the legacy column, and audits every column for undo", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst
      .mockResolvedValueOnce(row({ maxClassesPerWeek: 3 }) as never)
      .mockResolvedValueOnce(row(FOUR_IN_FOUR) as never);
    const res = await patch({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "tier-1", tenantId: "tenant-A" },
      data: FOUR_IN_FOUR,
    });
    // Snapshots are plain JSON: the Date column is stored as its ISO string (lib/audit-snapshot.ts).
    const meta = mockLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta.before).toEqual({ ...NONE, maxClassesPerWeek: 3 });
    expect(meta.after).toEqual({ ...FOUR_IN_FOUR, classLimitAnchor: ANCHOR.toISOString() });
  });

  it("a weekly allowance mirrors N into maxClassesPerWeek; a monthly one nulls it", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row() as never);
    await patch({ classLimit: 3, classLimitBasis: "week" });
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ ...NONE, classLimit: 3, classLimitBasis: "week", maxClassesPerWeek: 3 });
    await patch({ classLimit: 8, classLimitBasis: "month" });
    expect(mockUpdateMany.mock.calls[1][0].data).toEqual({ ...NONE, classLimit: 8, classLimitBasis: "month" });
  });

  it("clearing (nulls) resets every allowance column (Unlimited)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row() as never);
    const res = await patch({ classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null });
    expect(res.status).toBe(200);
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual(NONE);
  });

  it("the legacy field from a pre-T7c page is still honoured, as N each calendar week", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row() as never);
    await patch({ maxClassesPerWeek: 5 });
    expect(mockUpdateMany.mock.calls[0][0].data).toEqual({ ...NONE, classLimit: 5, classLimitBasis: "week", maxClassesPerWeek: 5 });
  });

  it("an unrelated edit leaves the allowance alone", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockFindFirst.mockResolvedValue(row(FOUR_IN_FOUR) as never);
    await patch({ name: "Plan A2" });
    const data = mockUpdateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toEqual({ name: "Plan A2" });
  });

  it.each([
    [{ classLimit: 4 }],
    [{ classLimitBasis: "week" }],
    [{ classLimit: 4, classLimitBasis: null }],
    [{ classLimit: null, classLimitBasis: "week" }],
    [{ classLimit: 0, classLimitBasis: "week" }],
    [{ classLimit: 61, classLimitBasis: "week" }],
    [{ classLimit: 2.5, classLimitBasis: "week" }],
    [{ classLimit: 4, classLimitBasis: "fortnight" }],
    [{ classLimit: 4, classLimitBasis: "week", classLimitWeeks: 4 }],
    [{ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4 }],
    [{ classLimit: 4, classLimitBasis: "weeks", classLimitAnchor: "2026-10-20" }],
    [{ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 1, classLimitAnchor: "2026-10-20" }],
    [{ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 9, classLimitAnchor: "2026-10-20" }],
    [{ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-02-30" }],
    [{ classLimit: 4, classLimitBasis: "week", maxClassesPerWeek: 4 }],
  ])("refuses %j with a 400 and writes nothing", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("an inconsistent set reads as one sentence the owner can act on", async () => {
    const res = await patch({ classLimit: 4 });
    expect(describeApiError(await res.json())).toBe(
      "Set the number of classes together with how often it resets (each week, each month, or every N weeks from a start date), or clear all of them for Unlimited.",
    );
    const res2 = await patch({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4 });
    expect(describeApiError(await res2.json())).toBe("Every N weeks needs the number of weeks (2 to 8) and the date the periods count from.");
  });

  it("an out-of-range number names the field in plain words", async () => {
    const res = await patch({ classLimit: 61, classLimitBasis: "week" });
    expect(describeApiError(await res.json())).toBe("Classes allowed must be 60 or less.");
    const res2 = await patch({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 9, classLimitAnchor: "2026-10-20" });
    expect(describeApiError(await res2.json())).toBe("Every (weeks) must be 8 or less.");
  });
});

describe("POST /api/memberships — class allowance", () => {
  beforeEach(() => {
    mockCreate.mockImplementation((async (args: { data: Record<string, unknown> }) => ({ id: "tier-new", ...args.data })) as never);
  });

  it("creates with 4 every 4 weeks from 20 October", async () => {
    const res = await post({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ tenantId: "tenant-A", ...FOUR_IN_FOUR });
    const meta = mockLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
  });

  it("creates Unlimited when the allowance is absent or cleared", async () => {
    await post({});
    expect(mockCreate.mock.calls[0][0].data).toMatchObject(NONE);
    await post({ classLimit: null, classLimitBasis: null });
    expect(mockCreate.mock.calls[1][0].data).toMatchObject(NONE);
  });

  it("a legacy weekly limit is stored as N each calendar week", async () => {
    await post({ maxClassesPerWeek: 3 });
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ ...NONE, classLimit: 3, classLimitBasis: "week", maxClassesPerWeek: 3 });
  });

  it.each([
    [{ classLimit: 4 }],
    [{ classLimit: 61, classLimitBasis: "week" }],
    [{ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4 }],
    [{ classLimit: 4, classLimitBasis: "week", maxClassesPerWeek: 4 }],
  ])("refuses %j", async (extra) => {
    const res = await post(extra);
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
