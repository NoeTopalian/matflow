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
    announcement: { findMany: vi.fn(), create: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    attendanceRecord: { create: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { GET as getAnnouncements } from "@/app/api/announcements/route";
import { POST as postCheckin } from "@/app/api/checkin/route";

const mockAuth = vi.mocked(auth);
const mockAnnFindMany = vi.mocked(prisma.announcement.findMany as (...args: unknown[]) => unknown);
const mockInstanceFindFirst = vi.mocked(prisma.classInstance.findFirst as (...args: unknown[]) => unknown);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst as (...args: unknown[]) => unknown);

beforeEach(() => vi.clearAllMocks());

describe("Tenant isolation — announcements", () => {
  it("GET only returns announcements for the session tenant", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "tenant-A" } } as never);
    mockAnnFindMany.mockImplementation((async (args: { where?: { tenantId?: string } } = {}) => {
      // Simulate DB returning only matching records
      return args.where?.tenantId === "tenant-A"
        ? [{ id: "a1", title: "A", body: "B", pinned: false, createdAt: new Date() }]
        : [];
    }) as never);
    const res = await getAnnouncements();
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("a1");
    // Confirm the query was called with the session's tenantId
    expect((mockAnnFindMany.mock.calls[0] as [{ where: { tenantId: string } }])[0].where.tenantId).toBe("tenant-A");
  });
});

describe("Tenant isolation — check-in", () => {
  it("returns 404 when the class instance belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "tenant-A", email: "m@a.com", role: "member" } } as never);
    mockMemberFindFirst.mockResolvedValue({ id: "member-a1" } as never);
    // Simulate DB finding no instance for this tenant (tenant-B's class)
    mockInstanceFindFirst.mockResolvedValue(null);
    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classInstanceId: "tenant-b-inst", checkInMethod: "self" }),
    });
    const res = await postCheckin(req);
    expect(res.status).toBe(404);
  });
});
