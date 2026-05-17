import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(),
}));

import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";

const mockedWithTenantContext = vi.mocked(withTenantContext);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("logAudit — fire-and-forget contract", () => {
  it("resolves before the underlying DB write completes (returns immediately)", async () => {
    let dbResolve: (() => void) | undefined;
    const dbWrite = new Promise<void>((resolve) => { dbResolve = resolve; });
    mockedWithTenantContext.mockReturnValue(dbWrite as never);

    let logAuditResolved = false;
    const auditPromise = logAudit({
      tenantId: "tenant-A",
      userId: "user-1",
      action: "member.update",
      entityType: "member",
      entityId: "member-1",
    }).then(() => { logAuditResolved = true; });

    await auditPromise;

    expect(logAuditResolved).toBe(true);
    expect(dbResolve).toBeDefined();
    // Sanity check: the underlying DB call really was triggered (just not awaited)
    expect(mockedWithTenantContext).toHaveBeenCalledTimes(1);

    dbResolve!();
  });

  it("does not throw when the underlying DB write rejects", async () => {
    mockedWithTenantContext.mockReturnValue(Promise.reject(new Error("DB down")) as never);

    await expect(
      logAudit({
        tenantId: "tenant-A",
        action: "member.delete",
        entityType: "member",
        entityId: "member-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("folds actAsUserId into metadata.actingAs", async () => {
    mockedWithTenantContext.mockImplementation(async (_tenantId, fn) => {
      const fakeTx = {
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      await fn(fakeTx as never);
    });

    await logAudit({
      tenantId: "tenant-A",
      userId: "owner-1",
      actAsUserId: "admin-99",
      action: "member.totp_reset",
      entityType: "member",
      entityId: "member-1",
      metadata: { reason: "lost device" },
    });

    const [tenantId, fn] = mockedWithTenantContext.mock.calls[0];
    expect(tenantId).toBe("tenant-A");

    const fakeTx = {
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await fn(fakeTx as never);

    expect(fakeTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner-1",
        metadata: { reason: "lost device", actingAs: "admin-99" },
      }),
    });
  });
});
