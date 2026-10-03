/**
 * POST /api/auth/logout-all on a sign-in that still owes its authenticator
 * code (review re-check, 3 Oct 2026). The route bumps sessionVersion, which
 * signs the account out on every device; a session that has not entered its
 * code is not yet that person and must not hold that lever. Red on revert:
 * remove the check and the first case bumps the version.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
const userUpdate = vi.fn();
const auditMock = vi.fn();

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) } }));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn({ user: { update: userUpdate }, member: { update: vi.fn() } })),
}));

async function post() {
  const { POST } = await import("@/app/api/auth/logout-all/route");
  return POST(new Request("http://localhost/api/auth/logout-all", { method: "POST" }));
}

describe("POST /api/auth/logout-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userUpdate.mockResolvedValue({});
  });

  it("refuses a session that still owes its authenticator code, bumping nothing", async () => {
    authMock.mockReturnValue({ user: { id: "u1", tenantId: "t1", role: "owner", totpPending: true } });
    const res = await post();
    expect(res.status).toBe(403);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("signs out everywhere for a fully signed-in staff user", async () => {
    authMock.mockReturnValue({ user: { id: "u1", tenantId: "t1", role: "owner", totpPending: false } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" }, data: { sessionVersion: { increment: 1 } } }));
  });
});
