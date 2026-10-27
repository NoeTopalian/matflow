// G5 (owner decision, 27 Oct 2026): the club's "Members can check themselves
// in from the app" switch is saved through PATCH /api/settings. Owner-only,
// like every club setting; validated as a boolean; audited with before/after
// so the owner's Activity page can put it back.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { update, findUnique, logAuditMock, authMock } = vi.hoisted(() => ({
  update: vi.fn(),
  findUnique: vi.fn(),
  logAuditMock: vi.fn(async () => {}),
  authMock: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { update, findUnique } }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { update, findUnique } } }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

import { PATCH } from "@/app/api/settings/route";
import { settingSpec } from "@/lib/settings-registry";
import { applyUndo, type AuditRowLike, type TxLike } from "@/lib/undo-registry";

const OWNER = { user: { id: "u-1", tenantId: "t-A", role: "owner" } };

function patchWith(body: unknown) {
  return PATCH(
    new Request("http://localhost:3847/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3847" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(OWNER);
  findUnique.mockResolvedValue({ id: "t-A", memberAppCheckin: true });
  update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "t-A", memberAppCheckin: true, ...data }));
});

describe("PATCH /api/settings — memberAppCheckin", () => {
  it("saves false and audits the change with before and after", async () => {
    const res = await patchWith({ memberAppCheckin: false });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t-A" }, data: { memberAppCheckin: false } }));
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = (logAuditMock.mock.calls[0] as unknown[])[0] as { action: string; entityType: string; entityId: string; metadata: unknown };
    expect(audit.action).toBe("tenant.settings.update");
    expect(audit.entityType).toBe("Tenant");
    expect(audit.entityId).toBe("t-A");
    const meta = JSON.stringify(audit.metadata);
    expect(meta).toContain("memberAppCheckin");
    // before true, after false — both recorded so Activity can undo it.
    expect(audit.metadata).toMatchObject({ before: { memberAppCheckin: true }, after: { memberAppCheckin: false } });
  });

  it("saves true", async () => {
    findUnique.mockResolvedValue({ id: "t-A", memberAppCheckin: false });
    const res = await patchWith({ memberAppCheckin: true });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { memberAppCheckin: true } }));
  });

  it.each([["off"], [0], [null], ["true"]])("refuses a non-boolean (%j) and saves nothing", async (value) => {
    const res = await patchWith({ memberAppCheckin: value });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it.each(["manager", "coach", "admin", "member"])("refuses a %s (owner-only, like every club setting)", async (role) => {
    authMock.mockResolvedValue({ user: { id: "u-2", tenantId: "t-A", role } });
    const res = await patchWith({ memberAppCheckin: false });
    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("is described in the settings registry", () => {
    expect(settingSpec("memberAppCheckin")).toMatchObject({ group: "operations", kind: "boolean", editRole: "owner" });
  });

  it("the owner's Activity undo puts it back", async () => {
    const fake = {
      tenant: {
        findFirst: vi.fn().mockResolvedValue({ id: "t-A", memberAppCheckin: false }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const row: AuditRowLike = {
      id: "a1", tenantId: "t-A", userId: "u-1", action: "tenant.settings.update",
      entityType: "Tenant", entityId: "t-A",
      metadata: { fields: ["memberAppCheckin"], before: { memberAppCheckin: true }, after: { memberAppCheckin: false } },
      createdAt: new Date("2026-10-27T10:00:00Z"),
    } as AuditRowLike;
    await applyUndo(fake as unknown as TxLike, row);
    expect(fake.tenant.update).toHaveBeenCalledWith({ where: { id: "t-A" }, data: { memberAppCheckin: true } });
  });
});
