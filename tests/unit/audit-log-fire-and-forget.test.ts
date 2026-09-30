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
        user: { findFirst: vi.fn().mockResolvedValue({ id: "owner-1" }) },
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
      user: { findFirst: vi.fn().mockResolvedValue({ id: "owner-1" }) },
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

// End-user round 2 (30 Sep 2026): member-side routes pass the member's id as
// `userId`, which references a staff User, so every member action's audit row
// failed the foreign key and was silently dropped.
//
// Functional review round 3 (F10): the fix inserted first and retried on the
// P2003, so Prisma logged one foreign-key error per member action. The decision
// is now made before the insert — one insert, no failed first attempt.
describe("logAudit — a member as the actor", () => {
  const STAFF = new Set(["owner-1"]);

  function fakeDb() {
    const attempts: Record<string, unknown>[] = [];
    const created: Record<string, unknown>[] = [];
    const findFirst = vi.fn(async ({ where }: { where: { id: string; tenantId?: string } }) =>
      STAFF.has(where.id) && where.tenantId === "tenant-A" ? { id: where.id } : null,
    );
    mockedWithTenantContext.mockImplementation(async (_tenantId, fn) => {
      const fakeTx = {
        user: { findFirst },
        auditLog: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            attempts.push(data);
            if (data.userId && !STAFF.has(data.userId as string)) {
              throw Object.assign(new Error("Foreign key constraint violated: AuditLog_userId_fkey"), { code: "P2003" });
            }
            created.push(data);
            return {};
          }),
        },
      };
      return fn(fakeTx as never);
    });
    return { attempts, created, findFirst };
  }

  it("a member actor: ONE insert, no userId, the actor in metadata.actorId", async () => {
    const db = fakeDb();
    await logAudit({ tenantId: "tenant-A", userId: "member-7", action: "member.child.create", entityType: "Member", entityId: "kid-1", metadata: { a: 1 } });
    await vi.waitFor(() => expect(db.created).toHaveLength(1));
    expect(db.attempts).toHaveLength(1);
    expect(mockedWithTenantContext).toHaveBeenCalledTimes(1);
    expect(db.findFirst).toHaveBeenCalledWith({ where: { id: "member-7", tenantId: "tenant-A" }, select: { id: true } });
    expect(db.created[0].userId).toBeNull();
    expect(db.created[0].metadata).toEqual({ a: 1, actorId: "member-7" });
  });

  it("a staff actor still writes userId", async () => {
    const db = fakeDb();
    await logAudit({ tenantId: "tenant-A", userId: "owner-1", action: "member.update", entityType: "Member", entityId: "m-1" });
    await vi.waitFor(() => expect(db.created).toHaveLength(1));
    expect(db.attempts).toHaveLength(1);
    expect(db.created[0].userId).toBe("owner-1");
    expect(db.created[0].metadata).toBeUndefined();
  });

  it("no actor: no lookup, one insert", async () => {
    const db = fakeDb();
    await logAudit({ tenantId: "tenant-A", action: "cron.tick", entityType: "Tenant", entityId: "tenant-A" });
    await vi.waitFor(() => expect(db.created).toHaveLength(1));
    expect(db.findFirst).not.toHaveBeenCalled();
  });
});
