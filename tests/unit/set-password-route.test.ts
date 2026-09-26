/**
 * F-3 (customer simulation, 26 Sep 2026): after an operator reset the owner
 * signs in with a temporary password and is asked to choose their own. These
 * pin the route that clears the flag: signed-in staff only, ten characters,
 * no reuse of the current or recent passwords, flag cleared, audit written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const authMock = vi.fn();
const userUpdate = vi.fn();
const historyCreate = vi.fn();
const auditMock = vi.fn();
const CURRENT_HASH = bcrypt.hashSync("TempPass1234", 4);
const OLD_HASH = bcrypt.hashSync("OldPassword99", 4);

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) } }));
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
    expect(data.sessionVersion).toBeUndefined();
    expect(historyCreate).toHaveBeenCalledWith({ data: { userId: "u1", passwordHash: CURRENT_HASH } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.password.set_own", entityId: "u1" }));
  });
});
