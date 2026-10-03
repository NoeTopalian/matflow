/**
 * F-3 (customer simulation, 26 Sep 2026): after an operator reset the owner
 * signs in with a temporary password and is asked to choose their own. These
 * pin the route that clears the flag: signed-in staff only, ten characters,
 * no reuse of the current or recent passwords, flag cleared, audit written.
 *
 * 3 Oct 2026: choosing the password also bumps `sessionVersion` (any other
 * device still on the temporary password is evicted) and re-issues THIS
 * device's token at the new version without the `mustChangePassword` claim.
 * Red on revert: drop the bump and "bumps the version" fails; drop the
 * re-encode and "re-issues this device's token" fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const authMock = vi.fn();
const userUpdate = vi.fn();
const historyCreate = vi.fn();
const auditMock = vi.fn();
const getTokenMock = vi.fn();
const encodeMock = vi.fn();
const cookieSet = vi.fn();
const CURRENT_HASH = bcrypt.hashSync("TempPass1234", 4);
const OLD_HASH = bcrypt.hashSync("OldPassword99", 4);

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, cookies: { set: cookieSet } }),
  },
}));
vi.mock("next-auth/jwt", () => ({
  getToken: (...a: unknown[]) => getTokenMock(...a),
  encode: (...a: unknown[]) => encodeMock(...a),
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("@/lib/auth-cookie", () => ({ SESSION_COOKIE_NAME: "authjs.session-token", SESSION_COOKIE_SECURE: false }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/authz", () => ({ STAFF_ROLES: ["owner", "manager", "coach", "admin"] }));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: "u1", passwordHash: CURRENT_HASH }),
        update: userUpdate,
      },
      passwordHistory: {
        findMany: vi.fn().mockResolvedValue([{ id: "h1", passwordHash: OLD_HASH }]),
        create: historyCreate,
        deleteMany: vi.fn(),
      },
    }),
  ),
}));

async function post(body: unknown) {
  const { POST } = await import("@/app/api/auth/set-password/route");
  return POST(new Request("http://localhost/api/auth/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

describe("POST /api/auth/set-password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockReturnValue({ user: { id: "u1", tenantId: "t1", role: "owner" } });
    userUpdate.mockResolvedValue({ sessionVersion: 8 });
    getTokenMock.mockResolvedValue({ id: "u1", tenantId: "t1", role: "owner", sessionVersion: 7, mustChangePassword: true, requireTotpSetup: true });
    encodeMock.mockResolvedValue("re-encoded-jwt");
  });

  it("refuses without a session and for a member session", async () => {
    authMock.mockReturnValue(null);
    expect((await post({ password: "BrandNewPassword1" })).status).toBe(401);
    authMock.mockReturnValue({ user: { id: "m1", tenantId: "t1", role: "member" } });
    expect((await post({ password: "BrandNewPassword1" })).status).toBe(403);
  });

  it("names the rule for a short password", async () => {
    const res = await post({ password: "short" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body.details)).toMatch(/at least 10 characters/);
  });

  it("refuses the temporary password itself and a recent one", async () => {
    for (const pw of ["TempPass1234", "OldPassword99"]) {
      const res = await post({ password: pw });
      expect(res.status, pw).toBe(400);
      expect((await res.json()).error).toMatch(/haven't used before/);
    }
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("sets the new hash, clears the flag, keeps history and audits", async () => {
    const res = await post({ password: "BrandNewPassword1" });
    expect(res.status).toBe(200);
    const data = userUpdate.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(false);
    expect(data.passwordHash).not.toBe(CURRENT_HASH);
    expect(bcrypt.compareSync("BrandNewPassword1", data.passwordHash)).toBe(true);
    expect(historyCreate).toHaveBeenCalledWith({ data: { userId: "u1", passwordHash: CURRENT_HASH } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.password.set_own", entityId: "u1" }));
  });

  it("bumps the session version so a device still on the temporary password is evicted", async () => {
    await post({ password: "BrandNewPassword1" });
    const args = userUpdate.mock.calls[0][0];
    expect(args.data.sessionVersion).toEqual({ increment: 1 });
    expect(args.data.mustChangePassword).toBe(false);
  });

  it("re-issues this device's token at the new version without the flag", async () => {
    const res = await post({ password: "BrandNewPassword1" });
    expect(await res.json()).toEqual({ ok: true, signInAgain: false });
    expect(encodeMock).toHaveBeenCalledTimes(1);
    const { token } = encodeMock.mock.calls[0][0] as { token: Record<string, unknown> };
    expect(token.sessionVersion).toBe(8);
    expect(token.mustChangePassword).toBe(false);
    // Only the password claim is cleared — the authenticator gate still holds
    // until enrolment (activation order: password, then TOTP).
    expect(token.requireTotpSetup).toBe(true);
    expect(cookieSet).toHaveBeenCalledWith("authjs.session-token", "re-encoded-jwt", expect.objectContaining({ httpOnly: true, path: "/" }));
  });

  it("when the cookie cannot be decoded, says sign in again (the bump still evicts)", async () => {
    getTokenMock.mockResolvedValue(null);
    const res = await post({ password: "BrandNewPassword1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signInAgain: true });
    expect(userUpdate.mock.calls[0][0].data.sessionVersion).toEqual({ increment: 1 });
    expect(encodeMock).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
