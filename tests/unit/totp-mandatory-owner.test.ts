import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * 2FA-optional spec (2026-05-07) — converted from totp-mandatory-owner.
 *
 * New invariants asserted here:
 *   1. /api/auth/totp/setup POST re-encodes the JWT clearing requireTotpSetup
 *      AND setting totpEnabled=true (so the dashboard banner clears immediately).
 *   2. /api/auth/totp/setup is widened to all User staff roles (owner/manager/
 *      coach/admin); only members are rejected (members use /api/member/totp/setup).
 *   3. /api/auth/totp/disable returns 403 for ANY authenticated role (was: 403
 *      owners, 401 non-owners). Self-disable is impossible for everyone.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { findUniqueMock, updateMock, getTokenMock, encodeMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  getTokenMock: vi.fn(),
  encodeMock: vi.fn().mockResolvedValue("encoded-jwt-string"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}));

// withTenantContext wraps prisma calls in a transaction. For unit tests we
// short-circuit it: hand the callback a fake tx whose user.* delegate to
// the same mocks we mock on `prisma`.
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ user: { findUnique: findUniqueMock, update: updateMock } })),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: getTokenMock,
  encode: encodeMock,
}));

vi.mock("otplib", () => ({
  generateSecret: vi.fn().mockReturnValue("MOCK-SECRET"),
  generateURI: vi.fn().mockReturnValue("otpauth://totp/test"),
  verifySync: vi.fn(({ token }: { token: string }) => ({ valid: token === "123456" })),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,STUB") },
}));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq() {
  return new Request("http://localhost/api/auth/totp/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
}

// ── /api/auth/totp/setup POST — JWT re-encode + role widening ────────────────

describe("POST /api/auth/totp/setup — JWT re-encode after enrolment", () => {
  it("clears requireTotpSetup AND sets totpEnabled=true in re-encoded JWT", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-owner", role: "owner", tenantId: "tenant-A" },
    } as never);
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });
    getTokenMock.mockResolvedValueOnce({
      id: "u-owner",
      role: "owner",
      tenantId: "tenant-A",
      requireTotpSetup: true,
      totpPending: false,
    });

    const { POST } = await import("@/app/api/auth/totp/setup/route");
    const res = await POST(makeReq() as never);

    expect(res.status).toBe(200);
    expect(encodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.objectContaining({
          requireTotpSetup: false,
          totpEnabled: true,
          id: "u-owner",
          role: "owner",
        }),
      }),
    );
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u-owner" },
      data: { totpEnabled: true },
    });
  });

  it("accepts non-owner staff (manager/coach/admin) — widened from owner-only", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-coach", role: "coach", tenantId: "tenant-A" },
    } as never);
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });
    getTokenMock.mockResolvedValueOnce({
      id: "u-coach",
      role: "coach",
      tenantId: "tenant-A",
    });

    const { POST } = await import("@/app/api/auth/totp/setup/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalled();
  });

  it("rejects 401 when role=member (members use /api/member/totp/setup)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "m-1", role: "member", tenantId: "tenant-A" },
    } as never);

    const { POST } = await import("@/app/api/auth/totp/setup/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects 400 when the code doesn't verify", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-owner", role: "owner", tenantId: "tenant-A" },
    } as never);
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });

    const req = new Request("http://localhost/api/auth/totp/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "999999" }),
    });
    const { POST } = await import("@/app/api/auth/totp/setup/route");
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ── /api/auth/totp/disable POST — 403 for ALL authenticated roles ────────────

describe("POST /api/auth/totp/disable — no self-disable for any role", () => {
  it("returns 403 for owner with no-self-disable message", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-owner", role: "owner", tenantId: "tenant-A" },
    } as never);

    const { POST } = await import("@/app/api/auth/totp/disable/route");
    const res = await POST();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/cannot be self-disabled/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 403 for non-owner staff (was 401 before — widened)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-coach", role: "coach", tenantId: "tenant-A" },
    } as never);

    const { POST } = await import("@/app/api/auth/totp/disable/route");
    const res = await POST();
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 403 for member too — widening covers all roles", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "m-1", role: "member", tenantId: "tenant-A" },
    } as never);

    const { POST } = await import("@/app/api/auth/totp/disable/route");
    const res = await POST();
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 401 only when no session at all", async () => {
    mockAuth.mockResolvedValueOnce(null as never);

    const { POST } = await import("@/app/api/auth/totp/disable/route");
    const res = await POST();
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
