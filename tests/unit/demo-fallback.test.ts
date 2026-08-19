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
// Bypass withTenantContext / withRlsBypass when no DATABASE_URL is set so
// the prisma mock below is what route handlers actually call. See
// docs/BACKEND-AUDIT-2026-05-17.md "prisma-tenant shim" pattern.
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
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

// Stage-3 e2e triage (2026-08-17, finding A1): DEMO_RESPONSE used to be served
// with HTTP 200 to REAL members on missing memberId / missing row / DB error —
// a fabricated identity ("Alex Johnson") in place of an honest failure, which
// UI-RULES §7 forbids and the e2e honesty guard exists to catch. Fabrication is
// now confined to the demo tenant; every real-tenant failure surfaces a status.
describe("GET /api/member/me — demo confined to demo-tenant, honest errors elsewhere", () => {
  it("demo-tenant: returns demo shape with session name overlaid", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "demo-tenant", name: "Jane Doe", email: "jane@demo.com" } } as never);
    const res = await GET();
    const body = await res.json();
    expect(isDemoShape(body)).toBe(true);
    expect(body.name).toBe("Jane Doe");
  });

  it("real tenant, no memberId on session: 404, never demo data", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "real-tenant", memberId: undefined, email: "s@t.com" } } as never);
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(isDemoShape(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Alex Johnson");
  });

  it("real tenant, member row missing: 404, never demo data", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "real-tenant", memberId: "m-xyz", email: "s@t.com" } } as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(isDemoShape(body)).toBe(false);
  });

  it("real tenant, DB error: 503 so the client's retry banner can fire", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "real-tenant", memberId: "m-xyz", email: "s@t.com" } } as never);
    vi.mocked(prisma.member.findFirst).mockRejectedValue(new Error("DB error"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(isDemoShape(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Alex Johnson");
    expect(consoleError).toHaveBeenCalled();
  });
});
