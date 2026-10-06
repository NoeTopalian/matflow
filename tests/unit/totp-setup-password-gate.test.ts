import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Review finding D4 (6 Oct 2026): /api/auth/totp/setup ignored the temporary
 * password. /api/auth/* is outside the proxy matcher, so a session opened on a
 * temporary password (mustChangePassword) — including an EXPIRED one — could
 * enrol an authenticator before choosing its own password: whoever saw the
 * temporary password on its way to the owner could pin their own device to the
 * account. GET and POST now refuse with 403 "Choose your own password to
 * continue." — the same message the proxy's activation gate uses.
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
        user: { findUnique: findUniqueMock, update: updateMock, findFirst: async () => ({ id: "staff" }) },
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
  verifySync: vi.fn(({ token }: { token: string }) => ({ valid: token === "123456" })),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,STUB") },
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));

import { auth } from "@/auth";
import { GET, POST } from "@/app/api/auth/totp/setup/route";

const MSG = "Choose your own password to continue.";
const HOUR = 3_600_000;

function session(extra: Record<string, unknown> = {}) {
  vi.mocked(auth).mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "tenant-A", ...extra } } as never);
}

function enrol(code = "123456") {
  return POST(
    new Request("http://localhost/api/auth/totp/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  session();
});

describe("D4: TOTP setup refuses a session that must still choose its own password", () => {
  it("GET: row still on a temporary password → 403, no secret minted", async () => {
    findUniqueMock.mockResolvedValue({
      totpSecret: null, totpEnabled: false, email: "o@example.test",
      mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + HOUR),
    });
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(MSG);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("GET: an EXPIRED temporary password → 403", async () => {
    findUniqueMock.mockResolvedValue({
      totpSecret: null, totpEnabled: false, email: "o@example.test",
      mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("GET: the session's own mustChangePassword claim is refused before the database", async () => {
    session({ mustChangePassword: true });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("POST: row still on a temporary password → 403, nothing enabled, no audit row", async () => {
    findUniqueMock.mockResolvedValue({ totpSecret: "MOCK-SECRET", mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + HOUR) });
    const res = await enrol();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(MSG);
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("POST: the session claim alone is refused", async () => {
    session({ mustChangePassword: true });
    const res = await enrol();
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("control: a chosen password enrols as before", async () => {
    findUniqueMock.mockResolvedValue({ totpSecret: "MOCK-SECRET", mustChangePassword: false, tempPasswordExpiresAt: null });
    const res = await enrol();
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("control: GET on a chosen password mints a secret as before", async () => {
    findUniqueMock.mockResolvedValue({ totpSecret: null, totpEnabled: false, email: "o@example.test", mustChangePassword: false, tempPasswordExpiresAt: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).secret).toBe("MOCK-SECRET");
  });
});
