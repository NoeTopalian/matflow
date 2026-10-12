// /api/auth/set-password and the temporary-password deadline (lane A,
// 6 Oct 2026). A session opened with the temporary password before it expired
// is setup-only (proxy.ts); after the deadline it cannot be used to choose a
// password either, so the owner must get a new temporary password from
// support. Choosing one's own password in time clears the deadline.
// Red on revert: delete the expiry refusal in the route and the first case
// fails; drop `tempPasswordExpiresAt: null` and the last fails.

import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { LEGACY_TEMP_PASSWORD_DEADLINE } from "@/lib/temp-password";

const authMock = vi.fn();
const userFindFirst = vi.fn();
const userUpdate = vi.fn();
const CURRENT_HASH = bcrypt.hashSync("TempPass1234", 4);

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, cookies: { set: vi.fn() } }),
  },
}));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => ({ id: "u1" })), encode: vi.fn(async () => "jwt") }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("@/lib/auth-cookie", () => ({ SESSION_COOKIE_NAME: "authjs.session-token", SESSION_COOKIE_SECURE: false }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/authz", () => ({ STAFF_ROLES: ["owner", "manager", "coach", "admin"] }));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: { findFirst: userFindFirst, update: userUpdate },
      passwordHistory: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), deleteMany: vi.fn() },
    }),
  ),
}));

async function post(body: unknown) {
  const { POST } = await import("@/app/api/auth/set-password/route");
  return POST(new Request("http://localhost/api/auth/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ user: { id: "u1", tenantId: "t1", role: "owner" } });
  userUpdate.mockResolvedValue({ sessionVersion: 8 });
});

describe("set-password and the temporary-password deadline", () => {
  it("refuses after the deadline and changes nothing", async () => {
    userFindFirst.mockResolvedValue({ id: "u1", passwordHash: CURRENT_HASH, mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() - 1000) });
    const res = await post({ password: "BrandNewPassword1" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/expired/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("before the deadline: the change succeeds and clears the deadline", async () => {
    userFindFirst.mockResolvedValue({ id: "u1", passwordHash: CURRENT_HASH, mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + 60_000) });
    const res = await post({ password: "BrandNewPassword1" });
    expect(res.status).toBe(200);
    const data = (userUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ mustChangePassword: false, tempPasswordExpiresAt: null });
  });

  // Was: "no deadline recorded (null) behaves as before". Review finding D2
  // (6 Oct 2026): legacy rows now expire at LEGACY_TEMP_PASSWORD_DEADLINE.
  it("D2: no deadline recorded (null) works BEFORE the legacy deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(LEGACY_TEMP_PASSWORD_DEADLINE.getTime() - 60_000));
      userFindFirst.mockResolvedValue({ id: "u1", passwordHash: CURRENT_HASH, mustChangePassword: true, tempPasswordExpiresAt: null });
      expect((await post({ password: "BrandNewPassword1" })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("D2: no deadline recorded (null) is refused AFTER the legacy deadline and changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(LEGACY_TEMP_PASSWORD_DEADLINE.getTime() + 1000));
      userFindFirst.mockResolvedValue({ id: "u1", passwordHash: CURRENT_HASH, mustChangePassword: true, tempPasswordExpiresAt: null });
      const res = await post({ password: "BrandNewPassword1" });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/expired/i);
      expect(userUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
