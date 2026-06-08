import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * 2FA-optional spec (2026-05-07) — member-side self-enrolment.
 *
 * Target: app/api/member/totp/setup/route.ts (GET + POST).
 *
 * Invariants asserted ("all conditions" matrix for the member enrolment gate):
 *   1. Password-bearing member (passwordHash != null) CAN enrol:
 *        GET  → returns secret + qrDataUrl, alreadyEnabled:false, writes secret
 *        POST(123456) → enables TOTP (update { totpEnabled: true }) + re-encodes JWT
 *   2. Magic-link-only / kid member (passwordHash === null) is REJECTED 400 on
 *      both GET and POST; never writes totpEnabled.
 *   3. No session.user.memberId (User/operator/anon) → 401; never touches member.
 *   4. Already-enrolled member → GET returns { alreadyEnabled: true } and never
 *      re-exposes the secret (anti-clone, security audit M7).
 *   5. Bad code (fails verifySync) → POST 400; never enables.
 *   6. Rate-limit exceeded → POST 429.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const { findFirstMock, updateMock, getTokenMock, encodeMock, checkRateLimitMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  getTokenMock: vi.fn(),
  encodeMock: vi.fn().mockResolvedValue("encoded-jwt-string"),
  checkRateLimitMock: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findFirst: findFirstMock, update: updateMock } },
}));

// withTenantContext wraps prisma calls in a transaction. Short-circuit it: hand
// the callback a fake tx whose member.* delegate to the same mocks.
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ member: { findFirst: findFirstMock, update: updateMock } })),
}));

vi.mock("next-auth/jwt", () => ({ getToken: getTokenMock, encode: encodeMock }));

vi.mock("otplib", () => ({
  generateSecret: vi.fn().mockReturnValue("MOCK-MEMBER-SECRET"),
  generateURI: vi.fn().mockReturnValue("otpauth://totp/member-test"),
  verifySync: vi.fn(({ token }: { token: string }) => ({ valid: token === "123456" })),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,MEMBERQR") },
}));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("@/lib/auth-cookie", () => ({
  SESSION_COOKIE_NAME: "authjs.session-token",
  SESSION_COOKIE_SECURE: false,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const MEMBER_SESSION = {
  user: { id: "m-1", memberId: "m-1", role: "member", tenantId: "tenant-A" },
};

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
  encodeMock.mockResolvedValue("encoded-jwt-string");
  checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

function postReq(code: string) {
  return new Request("http://localhost/api/member/totp/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

// ── GET — enrolment initialisation ───────────────────────────────────────────

describe("GET /api/member/totp/setup — password-bearing member can enrol", () => {
  it("returns a fresh secret + QR for an unenrolled member with a password", async () => {
    mockAuth.mockResolvedValueOnce(MEMBER_SESSION as never);
    findFirstMock.mockResolvedValueOnce({
      id: "m-1",
      totpSecret: null,
      totpEnabled: false,
      email: "adult@gym.test",
      passwordHash: "hashed",
    });

    const { GET } = await import("@/app/api/member/totp/setup/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyEnabled).toBe(false);
    expect(body.secret).toBe("MOCK-MEMBER-SECRET");
    expect(body.qrDataUrl).toMatch(/^data:image\/png/);
    // Secret persisted, enrolment not yet flipped on.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { totpSecret: "MOCK-MEMBER-SECRET", totpEnabled: false } }),
    );
  });

  it("does NOT re-expose the secret once already enrolled (anti-clone)", async () => {
    mockAuth.mockResolvedValueOnce(MEMBER_SESSION as never);
    findFirstMock.mockResolvedValueOnce({
      id: "m-1",
      totpSecret: "EXISTING",
      totpEnabled: true,
      email: "adult@gym.test",
      passwordHash: "hashed",
    });

    const { GET } = await import("@/app/api/member/totp/setup/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ alreadyEnabled: true });
    expect(body.secret).toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects 400 a magic-link-only / kid member (passwordHash === null)", async () => {
    mockAuth.mockResolvedValueOnce(MEMBER_SESSION as never);
    findFirstMock.mockResolvedValueOnce({
      id: "m-1",
      totpSecret: null,
      totpEnabled: false,
      email: "kid@gym.test",
      passwordHash: null,
    });

    const { GET } = await import("@/app/api/member/totp/setup/route");
    const res = await GET();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/set a password/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects 401 when there is no member session", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "u-owner", role: "owner", tenantId: "tenant-A" } } as never);

    const { GET } = await import("@/app/api/member/totp/setup/route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});

// ── POST — verify + enable ───────────────────────────────────────────────────

describe("POST /api/member/totp/setup — verify + enable", () => {
  it("enables TOTP and re-encodes the JWT on a valid code", async () => {
    mockAuth.mockResolvedValue(MEMBER_SESSION as never);
    findFirstMock.mockResolvedValueOnce({ totpSecret: "MOCK-MEMBER-SECRET", passwordHash: "hashed" });
    getTokenMock.mockResolvedValueOnce({ id: "m-1", memberId: "m-1", totpEnabled: false });

    const { POST } = await import("@/app/api/member/totp/setup/route");
    const res = await POST(postReq("123456") as never);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-1" }, data: { totpEnabled: true } }),
    );
    // Banner clears immediately: JWT re-encoded with totpEnabled=true.
    expect(encodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.objectContaining({ totpEnabled: true }) }),
    );
  });

  it("rejects 400 on an invalid code and never enables", async () => {
    mockAuth.mockResolvedValue(MEMBER_SESSION as never);
    findFirstMock.mockResolvedValueOnce({ totpSecret: "MOCK-MEMBER-SECRET", passwordHash: "hashed" });

    const { POST } = await import("@/app/api/member/totp/setup/route");
    const res = await POST(postReq("000000") as never);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects 400 a passwordless member even with a verifiable code", async () => {
    mockAuth.mockResolvedValue(MEMBER_SESSION as never);
    findFirstMock.mockResolvedValueOnce({ totpSecret: "MOCK-MEMBER-SECRET", passwordHash: null });

    const { POST } = await import("@/app/api/member/totp/setup/route");
    const res = await POST(postReq("123456") as never);
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects 401 when there is no member session", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "tenant-A" } } as never);

    const { POST } = await import("@/app/api/member/totp/setup/route");
    const res = await POST(postReq("123456") as never);
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-member verify rate limit is exceeded", async () => {
    mockAuth.mockResolvedValue(MEMBER_SESSION as never);
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 300 });

    const { POST } = await import("@/app/api/member/totp/setup/route");
    const res = await POST(postReq("123456") as never);
    expect(res.status).toBe(429);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
