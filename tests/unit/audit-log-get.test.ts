import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-008 (audit M12): GET /api/audit-log is owner-only and tenant-scoped.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { findMany } },
}));

const requireOwnerMock = vi.fn();
vi.mock("@/lib/authz", () => ({
  requireOwner: () => requireOwnerMock(),
}));

import { GET } from "@/app/api/audit-log/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/audit-log", () => {
  it("returns tenant-scoped entries (where.tenantId is the caller's tenant)", async () => {
    requireOwnerMock.mockResolvedValueOnce({ tenantId: "t-A", userId: "u-1", role: "owner" });
    findMany.mockResolvedValueOnce([
      { id: "log-1", action: "member.create", entityType: "Member", entityId: "m-1", createdAt: new Date() },
    ]);

    const res = await GET(new Request("http://localhost/api/audit-log"));
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t-A" },
    }));
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("returns nextCursor when results fill the requested page", async () => {
    requireOwnerMock.mockResolvedValueOnce({ tenantId: "t-A", userId: "u-1", role: "owner" });
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `log-${i}`, action: "member.create", entityType: "Member", entityId: `m-${i}`, createdAt: new Date(),
    }));
    findMany.mockResolvedValueOnce(entries);

    const res = await GET(new Request("http://localhost/api/audit-log?take=10"));
    const body = await res.json();
    expect(body.entries).toHaveLength(10);
    expect(body.nextCursor).toBe("log-9");
  });

  it("clamps take to 100 max even when caller asks for 1000", async () => {
    requireOwnerMock.mockResolvedValueOnce({ tenantId: "t-A", userId: "u-1", role: "owner" });
    findMany.mockResolvedValueOnce([]);

    await GET(new Request("http://localhost/api/audit-log?take=1000"));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it("propagates the requireOwner gate (non-owners never reach the handler body)", async () => {
    // requireOwner redirects internally; here we simulate by throwing so the
    // caller (Next.js) handles the redirect/forbid response.
    requireOwnerMock.mockRejectedValueOnce(new Error("redirect to /dashboard"));
    await expect(GET(new Request("http://localhost/api/audit-log"))).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});
