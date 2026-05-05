import { vi, describe, it, expect, beforeEach } from "vitest";

// Fix 4 — mandatory TOTP for owner role.
// Tests the post-enrolment JWT re-encode (clears requireTotpSetup) on
// /api/auth/totp/setup POST and the 403 from /api/auth/totp/disable.

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

// ── /api/auth/totp/setup POST — re-encodes JWT clearing requireTotpSetup ─────

describe("POST /api/auth/totp/setup — JWT re-encode after enrolment (Fix 4 T-4)", () => {
  it("clears requireTotpSetup in the re-encoded JWT after successful enrolment", async () => {
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

    // The JWT should be re-encoded with requireTotpSetup explicitly false.
    expect(encodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.objectContaining({
          requireTotpSetup: false,
          id: "u-owner",
          role: "owner",
        }),
      }),
    );

    // User row should have totpEnabled flipped to true.
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u-owner" },
      data: { totpEnabled: true },
    });
  });

  it("rejects 401 when not an owner", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-coach", role: "coach", tenantId: "tenant-A" },
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

// ── /api/auth/totp/disable POST — 403 for owners ─────────────────────────────

describe("POST /api/auth/totp/disable — owners cannot disable (Fix 4)", () => {
  it("returns 403 with mandatory-TOTP message when owner tries to disable", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-owner", role: "owner", tenantId: "tenant-A" },
    } as never);

    const { POST } = await import("@/app/api/auth/totp/disable/route");
    const req = new Request("http://localhost/api/auth/totp/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    void req;
    const res = await POST();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/required for owner/i);

    // No DB writes should occur.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects 401 when non-owner tries to disable (existing behaviour)", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-coach", role: "coach", tenantId: "tenant-A" },
    } as never);

    const { POST } = await import("@/app/api/auth/totp/disable/route");
    const req = new Request("http://localhost/api/auth/totp/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    void req;
    const res = await POST();
    expect(res.status).toBe(401);
  });
});
