import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipTier: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks are registered
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit-log";
import { GET, POST } from "@/app/api/memberships/route";
import { PATCH } from "@/app/api/memberships/[id]/route";

const mockAuth = vi.mocked(auth);
const mockFindMany = vi.mocked(prisma.membershipTier.findMany);
const mockUpdateMany = vi.mocked(prisma.membershipTier.updateMany);
const mockCreate = vi.mocked(prisma.membershipTier.create);
const mockFindFirst = vi.mocked(prisma.membershipTier.findFirst);
const mockLogAudit = vi.mocked(logAudit);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET — tenant isolation ───────────────────────────────────────────────────

describe("GET /api/memberships — tenant isolation", () => {
  it("only returns tiers for the session tenant", async () => {
    mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "tenant-A", id: "user-1" } } as never);

    const tenantATiers = [
      { id: "tier-1", tenantId: "tenant-A", name: "Monthly", isActive: true },
    ];
    mockFindMany.mockResolvedValue(tenantATiers as never);

    const res = await GET();
    expect(res.status).toBe(200);

    // Prisma was called with tenant-A's tenantId
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-A" }),
      }),
    );

    const data = await res.json();
    expect(data).toEqual(tenantATiers);
  });
});

// ─── POST — tenantId comes from session, not body ─────────────────────────────

describe("POST /api/memberships — tenantId from session", () => {
  it("sets tenantId from session.user.tenantId, ignoring any body tenantId", async () => {
    mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "tenant-A", id: "user-1" } } as never);

    const createdTier = {
      id: "tier-new",
      tenantId: "tenant-A",
      name: "Monthly Adult",
      pricePence: 4000,
      currency: "GBP",
      billingCycle: "monthly",
      maxClassesPerWeek: null,
      isKids: false,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    mockCreate.mockResolvedValue(createdTier as never);

    const req = new Request("http://localhost/api/memberships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Monthly Adult",
        pricePence: 4000,
        currency: "GBP",
        billingCycle: "monthly",
        isKids: false,
        // Attacker tries to inject a different tenantId — must be ignored
        tenantId: "tenant-B",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // tenantId in create call must be from session (tenant-A), not body (tenant-B)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant-A" }),
      }),
    );
  });
});

// ─── PATCH — cross-tenant isolation (B-5) ────────────────────────────────────

describe("PATCH /api/memberships/[id] — cross-tenant isolation", () => {
  it("returns 404 when tier belongs to a different tenant (count === 0)", async () => {
    // Session belongs to tenant-A
    mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "tenant-A", id: "user-1" } } as never);

    // updateMany finds no rows because tenant-B's tier doesn't match tenant-A
    mockUpdateMany.mockResolvedValue({ count: 0 } as never);

    const req = new Request("http://localhost/api/memberships/tier-from-tenant-B", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hacked" }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "tier-from-tenant-B" }) });
    expect(res.status).toBe(404);

    // audit log must NOT have been called for a failed update
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 200 when tier belongs to the session tenant (count === 1)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "tenant-A", id: "user-1" } } as never);
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    mockFindFirst.mockResolvedValue({
      id: "tier-1",
      tenantId: "tenant-A",
      name: "Updated",
      description: null,
      pricePence: 4000,
      currency: "GBP",
      billingCycle: "monthly",
      maxClassesPerWeek: null,
      isKids: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const req = new Request("http://localhost/api/memberships/tier-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "tier-1" }) });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership.tier.update" }),
    );
  });
});
