import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

// Wizard v2 Step 2 / Fix 4 follow-up: TOTP recovery codes.
// Tests cover the lib helpers + both endpoints (generate + recover).

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-do-not-use-in-prod";
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("recovery-codes lib (pure helpers)", () => {
  it("generateRecoveryCodes returns 8 unique pairs by default", async () => {
    const { generateRecoveryCodes } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    const displays = new Set(codes.map((c) => c.display));
    const hashes = new Set(codes.map((c) => c.hash));
    expect(displays.size).toBe(8);
    expect(hashes.size).toBe(8);
  });

  it("display format is XXXX-XXXX-XX with lowercase hex", async () => {
    const { generateRecoveryCodes } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(3);
    for (const c of codes) {
      expect(c.display).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{2}$/);
    }
  });

  it("hash is a 64-char hex string (HMAC-SHA256 output)", async () => {
    const { generateRecoveryCodes } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(2);
    for (const c of codes) {
      expect(c.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("normaliseUserCode strips dashes + whitespace + uppercase", async () => {
    const { normaliseUserCode } = await import("@/lib/recovery-codes");
    expect(normaliseUserCode("ABCD-1234-EF")).toBe("abcd1234ef");
    expect(normaliseUserCode("  abcd-1234-ef  ")).toBe("abcd1234ef");
    expect(normaliseUserCode("ABCD1234EF")).toBe("abcd1234ef");
    expect(normaliseUserCode("abcd1234ef")).toBe("abcd1234ef");
  });

  it("consumeRecoveryCode accepts a valid display code and removes its hash", async () => {
    const { generateRecoveryCodes, consumeRecoveryCode } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(3);
    const stored = codes.map((c) => c.hash);

    const result = consumeRecoveryCode(codes[1].display, stored);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remaining).toHaveLength(2);
      expect(result.remaining).not.toContain(codes[1].hash);
      expect(result.remaining).toContain(codes[0].hash);
      expect(result.remaining).toContain(codes[2].hash);
    }
  });

  it("consumeRecoveryCode rejects a wrong code", async () => {
    const { generateRecoveryCodes, consumeRecoveryCode } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(2);
    const stored = codes.map((c) => c.hash);
    const result = consumeRecoveryCode("0000-0000-00", stored);
    expect(result.ok).toBe(false);
  });

  it("consumeRecoveryCode rejects a malformed code (wrong length)", async () => {
    const { consumeRecoveryCode } = await import("@/lib/recovery-codes");
    const result = consumeRecoveryCode("abc", ["fakehash"]);
    expect(result.ok).toBe(false);
  });

  it("consumeRecoveryCode is single-use — same code can't be consumed twice", async () => {
    const { generateRecoveryCodes, consumeRecoveryCode } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(2);
    const stored = codes.map((c) => c.hash);
    const first = consumeRecoveryCode(codes[0].display, stored);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = consumeRecoveryCode(codes[0].display, first.remaining);
    expect(second.ok).toBe(false);
  });
});

// ── POST /api/auth/totp/recovery-codes ────────────────────────────────────────

vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { findFirstMock, updateMock, logAuditMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findFirst: findFirstMock,
      update: updateMock,
    },
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: logAuditMock,
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq() {
  return new Request("http://localhost/api/auth/totp/recovery-codes", { method: "POST" });
}

describe("POST /api/auth/totp/recovery-codes", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/auth/totp/recovery-codes/route");
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 400 when user has TOTP disabled", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({ id: "u1", totpEnabled: false });
    const { POST } = await import("@/app/api/auth/totp/recovery-codes/route");
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("generates 8 codes, persists hashes, returns display strings", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({ id: "u1", totpEnabled: true });
    const { POST } = await import("@/app/api/auth/totp/recovery-codes/route");
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.codes).toHaveLength(8);
    for (const code of body.codes) {
      expect(code).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{2}$/);
    }
    // Persisted hashes must be 64-char hex (HMAC-SHA256), NOT the display strings.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const stored = updateMock.mock.calls[0][0].data.totpRecoveryCodes;
    expect(stored).toHaveLength(8);
    for (const hash of stored) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(body.codes).not.toContain(hash); // hash MUST NOT appear in response
    }
  });
});

// ── POST /api/auth/totp/recover ──────────────────────────────────────────────

describe("POST /api/auth/totp/recover", () => {
  it("returns ok:true even when tenant doesn't exist (no enumeration)", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/auth/totp/recover/route");
    const res = await POST(
      new Request("http://localhost/api/auth/totp/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@example.com", tenantSlug: "nonexistent", recoveryCode: "abcd-1234-ef" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recovered).toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("clears TOTP + bumps sessionVersion on valid code", async () => {
    const { generateRecoveryCodes } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(3);
    const stored = codes.map((c) => c.hash);

    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({ id: "tenant-A" } as never);
    findFirstMock.mockResolvedValueOnce({
      id: "u1",
      totpRecoveryCodes: stored,
      totpEnabled: true,
    });

    const { POST } = await import("@/app/api/auth/totp/recover/route");
    const res = await POST(
      new Request("http://localhost/api/auth/totp/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", tenantSlug: "gym", recoveryCode: codes[1].display }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recovered).toBe(true);

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        totpEnabled: false,
        totpSecret: null,
        sessionVersion: { increment: 1 },
        totpRecoveryCodes: expect.any(Array),
      }),
    });
    // The consumed code's hash should be removed.
    const newStored = updateMock.mock.calls[0][0].data.totpRecoveryCodes;
    expect(newStored).toHaveLength(2);
    expect(newStored).not.toContain(codes[1].hash);
  });

  it("returns ok:true on wrong code (no enumeration), audits the failure", async () => {
    const { generateRecoveryCodes } = await import("@/lib/recovery-codes");
    const codes = generateRecoveryCodes(2);
    const stored = codes.map((c) => c.hash);

    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({ id: "tenant-A" } as never);
    findFirstMock.mockResolvedValueOnce({
      id: "u1",
      totpRecoveryCodes: stored,
      totpEnabled: true,
    });

    const { POST } = await import("@/app/api/auth/totp/recover/route");
    const res = await POST(
      new Request("http://localhost/api/auth/totp/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", tenantSlug: "gym", recoveryCode: "0000-0000-00" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recovered).toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.totp.recovery.failed",
      }),
    );
  });
});
