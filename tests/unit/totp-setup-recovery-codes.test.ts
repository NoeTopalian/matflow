import { vi, describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * A fresh TOTP enrolment discards old recovery codes (3 Oct 2026).
 *
 * Recovery codes belong to an authenticator. /api/auth/totp/recover accepts a
 * code to strip TOTP and does not ask whether the codes predate the current
 * enrolment, so codes left over from an earlier enrolment — or minted before
 * an account was handed to its owner — could remove the authenticator the
 * owner has just set up. The enabling write must null them in the same update.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));

const { findUniqueMock, updateMock, auditCreateMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  auditCreateMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        user: { findUnique: findUniqueMock, update: updateMock, updateMany: async () => ({ count: 1 }), findFirst: async () => ({ id: "staff" }) },
        // Lane D (6 Oct 2026): enrolment writes its audit row in this transaction.
        auditLog: { create: auditCreateMock },
      }),
    ),
}));
vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn().mockResolvedValue(null),
  encode: vi.fn().mockResolvedValue("encoded"),
}));
vi.mock("otplib", () => ({
  generateSecret: vi.fn().mockReturnValue("MOCK-SECRET"),
  generateURI: vi.fn().mockReturnValue("otpauth://totp/test"),
  // timeStep: the routes now SPEND the code via consumeUserTotp (single use, 7 Oct 2026).
  verifySync: vi.fn(({ token }: { token: string }) => ({ valid: token === "123456", timeStep: 1 })),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,STUB") },
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));

import { auth } from "@/auth";
import { POST } from "@/app/api/auth/totp/setup/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({
    user: { id: "u-owner", role: "owner", tenantId: "tenant-A" },
  } as never);
});

function enrol(code: string) {
  return POST(
    new Request("http://localhost/api/auth/totp/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }) as never,
  );
}

describe("POST /api/auth/totp/setup — fresh enrolment", () => {
  it("sets totpRecoveryCodes to JsonNull in the same write that turns TOTP on", async () => {
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });

    const res = await enrol("123456");

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const data = updateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.totpEnabled).toBe(true);
    expect(data.totpRecoveryCodes).toBe(Prisma.JsonNull);
  });

  // Operator audit 5 Oct 2026 (Q4-b / Q9): enrolment wrote no audit row at all.
  it("writes an enrolment audit row in the same transaction, with no secret, code or recovery material", async () => {
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });
    const res = await enrol("123456");
    expect(res.status).toBe(200);
    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    const row = auditCreateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(row).toMatchObject({ action: "auth.totp.enrolled", entityType: "User", entityId: "u-owner", userId: "u-owner", tenantId: "tenant-A" });
    expect(row.metadata).toMatchObject({ outcome: "succeeded", actorType: "user", actor: "u-owner" });
    const text = JSON.stringify(row);
    expect(text).not.toContain("MOCK-SECRET");
    expect(text).not.toContain("123456");
    expect(text).not.toMatch(/recovery/i);
  });

  it("an audit insert failure fails the enrolment (the row and the factor commit together)", async () => {
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });
    auditCreateMock.mockRejectedValueOnce(new Error("db down"));
    await expect(enrol("123456")).rejects.toThrow("db down");
  });

  it("touches nothing when the code is wrong", async () => {
    findUniqueMock.mockResolvedValueOnce({ totpSecret: "MOCK-SECRET" });

    const res = await enrol("000000");

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
