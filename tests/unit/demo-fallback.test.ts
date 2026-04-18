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
vi.mock("@/lib/streak", () => ({
  getWeekKey: vi.fn(),
  calculateStreak: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: vi.fn() },
    attendanceRecord: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/me/route";

const mockAuth = vi.mocked(auth);

beforeEach(() => vi.clearAllMocks());

function isDemoShape(body: unknown): boolean {
  const b = body as Record<string, unknown>;
  return (
    typeof b.belt === "object" &&
    b.belt !== null &&
    typeof b.stats === "object" &&
    b.stats !== null
  );
}

describe("GET /api/member/me — demo fallback branches", () => {
  it("branch 1: returns demo shape for demo-tenant with session name overlaid", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "demo-tenant", name: "Jane Doe", email: "jane@demo.com" } } as never);
    const res = await GET();
    const body = await res.json();
    expect(isDemoShape(body)).toBe(true);
    expect(body.name).toBe("Jane Doe");
  });

  it("branch 2: returns demo shape when session has no memberId", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "real-tenant", memberId: undefined, email: "s@t.com" } } as never);
    const res = await GET();
    const body = await res.json();
    expect(isDemoShape(body)).toBe(true);
  });

  it("branch 3: returns demo shape when member not found in DB", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "real-tenant", memberId: "m-xyz", email: "s@t.com" } } as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(isDemoShape(body)).toBe(true);
  });

  it("branch 4: returns demo shape when prisma throws", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "real-tenant", memberId: "m-xyz", email: "s@t.com" } } as never);
    vi.mocked(prisma.member.findFirst).mockRejectedValue(new Error("DB error"));
    const res = await GET();
    const body = await res.json();
    expect(isDemoShape(body)).toBe(true);
  });
});
