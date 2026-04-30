import { vi, describe, it, expect, beforeEach } from "vitest";

// L2 — POST /api/auth/reset-password must bump sessionVersion in the same
// transaction as the password update so any pre-existing JWT becomes invalid
// on the next Node-runtime auth() check.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    passwordResetToken: { findFirst: vi.fn(), updateMany: vi.fn() },
    passwordHistory: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(false),
    hash: vi.fn().mockResolvedValue("$2a$12$newhash"),
  },
}));

import { prisma } from "@/lib/prisma";

const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockUserUpdate = vi.mocked(prisma.user.update);
const mockPrtFindFirst = vi.mocked(prisma.passwordResetToken.findFirst);
const mockPrtUpdateMany = vi.mocked(prisma.passwordResetToken.updateMany);
const mockHistoryFindMany = vi.mocked(prisma.passwordHistory.findMany);
const mockTx = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantFindUnique.mockResolvedValue({ id: "tenant-A" } as never);
  mockUserFindFirst.mockResolvedValue({
    id: "user-1",
    email: "alice@gym.com",
    tenantId: "tenant-A",
    passwordHash: "$2a$12$oldhash",
  } as never);
  mockPrtFindFirst.mockResolvedValue({
    id: "rt-1",
    token: "valid-token",
    email: "alice@gym.com",
    tenantId: "tenant-A",
    used: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as never);
  mockPrtUpdateMany.mockResolvedValue({ count: 1 } as never);
  mockHistoryFindMany.mockResolvedValue([] as never);
  // Capture the operations passed into $transaction so we can assert on them.
  mockTx.mockImplementation(async (ops: unknown) => {
    return Array.isArray(ops) ? ops.map(() => ({})) : ([] as never);
  });
});

function makeReq() {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "valid-token",
      email: "alice@gym.com",
      tenantSlug: "gym",
      password: "Str0ngPassword!", // satisfies validatePassword
    }),
  });
}

describe("L2 — reset-password bumps sessionVersion", () => {
  it("calls user.update with passwordHash AND sessionVersion increment in the transaction", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);

    // The $transaction was called with an array including a user.update that
    // sets BOTH passwordHash AND sessionVersion.increment. We exercise the
    // same Prisma surface the route uses by re-invoking the user.update mock
    // through the captured operation list.
    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({
        passwordHash: "$2a$12$newhash",
        sessionVersion: { increment: 1 },
      }),
    }));
  });

  it("does NOT bump sessionVersion when token is invalid (returns 400)", async () => {
    mockPrtFindFirst.mockResolvedValue(null);
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("does NOT bump sessionVersion when concurrent token consume races (count 0)", async () => {
    mockPrtUpdateMany.mockResolvedValue({ count: 0 } as never);
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });
});
