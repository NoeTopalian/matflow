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
    tenant: { findUnique: vi.fn() },
    member: { findFirst: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    attendanceRecord: { create: vi.fn() },
  },
}));

import { checkinSchema } from "@/app/api/checkin/route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/checkin/route";

const mockAuth = vi.mocked(auth);

beforeEach(() => vi.clearAllMocks());

// ── Schema validation ──────────────────────────────────────────────────────────

describe("checkinSchema", () => {
  it("accepts a minimal valid body (classInstanceId only)", () => {
    const result = checkinSchema.safeParse({ classInstanceId: "inst-1" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.checkInMethod).toBe("admin");
  });

  it("rejects a body missing classInstanceId", () => {
    const result = checkinSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts all valid checkInMethod values", () => {
    for (const m of ["qr", "admin", "self", "auto"]) {
      expect(checkinSchema.safeParse({ classInstanceId: "x", checkInMethod: m }).success).toBe(true);
    }
  });

  it("rejects an invalid checkInMethod", () => {
    expect(checkinSchema.safeParse({ classInstanceId: "x", checkInMethod: "tap" }).success).toBe(false);
  });
});

// ── Role guard ─────────────────────────────────────────────────────────────────

describe("POST /api/checkin — role guard", () => {
  it("returns 403 when a non-staff member provides memberId (attempting to check in someone else)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "member", tenantId: "t1", email: "m@t.com" } } as never);
    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classInstanceId: "inst-1", memberId: "other-member", checkInMethod: "self" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classInstanceId: "inst-1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
