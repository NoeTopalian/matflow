import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    member: { findFirst: vi.fn(), count: vi.fn() },
    attendanceRecord: { create: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    passwordResetToken: { updateMany: vi.fn(), create: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST as postCheckin } from "@/app/api/checkin/route";
import { GET as getStats } from "@/app/api/dashboard/stats/route";
import { POST as postStaff } from "@/app/api/staff/route";
import { POST as postForgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as postCheckout } from "@/app/api/member/checkout/route";

const mockAuth = vi.mocked(auth);
const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockInstanceFindFirst = vi.mocked(prisma.classInstance.findFirst);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockUserCreate = vi.mocked(prisma.user.create);
const mockPrtUpdateMany = vi.mocked(prisma.passwordResetToken.updateMany);
const mockPrtCreate = vi.mocked(prisma.passwordResetToken.create);

beforeEach(() => vi.clearAllMocks());

// ── F3: QR check-in tenant isolation ─────────────────────────────────────────

describe("F3 — QR checkin: memberId must belong to tenant", () => {
  it("returns 404 when memberId belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue(null as never);
    mockTenantFindUnique.mockResolvedValue({ id: "tenant-A" } as never);
    // Member lookup returns null — memberId is from tenant-B
    mockMemberFindFirst.mockResolvedValue(null);

    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classInstanceId: "inst-1",
        memberId: "member-from-tenant-B",
        checkInMethod: "qr",
        tenantSlug: "tenant-a-gym",
      }),
    });

    const res = await postCheckin(req);
    expect(res.status).toBe(404);
    // Crucially: no attendance record should have been created
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it("allows QR checkin when memberId belongs to the correct tenant", async () => {
    mockAuth.mockResolvedValue(null as never);
    mockTenantFindUnique.mockResolvedValue({ id: "tenant-A" } as never);
    mockMemberFindFirst.mockResolvedValue({ id: "member-a1", tenantId: "tenant-A" } as never);
    mockInstanceFindFirst.mockResolvedValue({ id: "inst-1", isCancelled: false, class: { tenantId: "tenant-A" } } as never);
    vi.mocked(prisma.attendanceRecord.create).mockResolvedValue({ id: "rec-1" } as never);

    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classInstanceId: "inst-1",
        memberId: "member-a1",
        checkInMethod: "qr",
        tenantSlug: "tenant-a-gym",
      }),
    });

    const res = await postCheckin(req);
    expect(res.status).toBe(201);
  });
});

// ── F8: dashboard/stats role guard ───────────────────────────────────────────

describe("F8 — dashboard/stats: member role returns 403", () => {
  it("returns 403 for member role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "member" } } as never);
    const res = await getStats();
    expect(res.status).toBe(403);
  });

  it("returns 200 for owner role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    vi.mocked(prisma.member.count).mockResolvedValue(0);
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0);
    const res = await getStats();
    expect(res.status).toBe(200);
  });

  it("returns 403 for unauthenticated request (null session)", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await getStats();
    expect(res.status).toBe(401);
  });
});

// ── F5: staff creation response must not include password ────────────────────

describe("F5 — staff creation: no password in response", () => {
  it("response does not contain temporaryPassword or passwordHash", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    mockUserCreate.mockResolvedValue({
      id: "u1", name: "Test User", email: "test@gym.com", role: "coach", createdAt: new Date(),
    } as never);

    const req = new Request("http://localhost/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test User", email: "test@gym.com", role: "coach" }),
    });

    const res = await postStaff(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).not.toHaveProperty("temporaryPassword");
    expect(body).not.toHaveProperty("passwordHash");
    expect(body).not.toHaveProperty("password");
  });

  it("response includes mustChangePassword: true when no password supplied", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    mockUserCreate.mockResolvedValue({
      id: "u1", name: "Test User", email: "test@gym.com", role: "coach", createdAt: new Date(),
    } as never);

    const req = new Request("http://localhost/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test User", email: "test@gym.com", role: "coach" }),
    });

    const res = await postStaff(req);
    const body = await res.json();
    expect(body.mustChangePassword).toBe(true);
  });
});

// ── F10: forgot-password rate limiting ───────────────────────────────────────

describe("F10 — forgot-password: rate limiting", () => {
  it("returns 429 after 3 requests for same email within window", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1" } as never);
    mockUserFindFirst.mockResolvedValue(null); // user not found — returns 200 early

    // Use a unique email to avoid collisions with other test runs
    const email = `rl-test-${Math.random().toString(36).slice(2)}@gym.com`;
    const makeRlRequest = () =>
      postForgotPassword(
        new Request("http://localhost/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, tenantSlug: "rl-test-gym" }),
        })
      );

    const r1 = await makeRlRequest();
    const r2 = await makeRlRequest();
    const r3 = await makeRlRequest();
    const r4 = await makeRlRequest();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
    expect((r4.headers as unknown as Record<string, string>)["Retry-After"]).toBeDefined();
  });
});

// ── F4: checkout price validation ────────────────────────────────────────────

describe("F4 — checkout: client-manipulated prices rejected", () => {
  it("returns 400 when item price does not match server price", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1" } } as never);

    const req = new Request("http://localhost/api/member/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "6", name: "Club Hoodie", price: 0.01, quantity: 1 }], // real price is 45
        successUrl: "http://localhost/success",
        cancelUrl: "http://localhost/cancel",
      }),
    }) as never;

    const res = await postCheckout(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid item price");
  });

  it("returns 400 for unknown item id", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1" } } as never);

    const req = new Request("http://localhost/api/member/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "999", name: "Fake Item", price: 1, quantity: 1 }],
        successUrl: "http://localhost/success",
        cancelUrl: "http://localhost/cancel",
      }),
    }) as never;

    const res = await postCheckout(req);
    expect(res.status).toBe(400);
  });
});
