// Durable audit writes and audit retention against REAL Postgres (lane D,
// 6 Oct 2026; operator audit 5 Oct 2026, Q9).
//
// 1. A row written with `logAudit({ tx })` commits or rolls back with the
//    change in the same transaction — both directions.
// 2. `auditLogRetentionWhere` keeps operator, erasure and support-session
//    evidence past the 12-month sweep, deletes it after six years, and still
//    deletes ordinary rows (the JSON-path test must not swallow them via NULL).
//
// Rows carry a unique synthetic tenantId (AuditLog.tenantId has no foreign
// key, so no Tenant row is needed) and are deleted in afterAll. Runs only
// against the Neon TEST branch; skips without a database.

import { describe, it, expect, afterAll } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit, auditLogRetentionWhere, AUDIT_LOG_RETENTION_MS, AUDIT_EVIDENCE_RETENTION_MS } from "@/lib/audit-log";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T = `lane-d-tenant-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;

const countRows = (action: string) =>
  withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: T, action } }));

describe.skipIf(!HAS_DB)("durable audit writes on the database", () => {
  afterAll(async () => {
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: T } }));
  });

  it("a strict row written before a failing change rolls back with it", async () => {
    await expect(
      withRlsBypass(async (tx) => {
        await logAudit({ tx, tenantId: T, action: "lane_d.strict.rolled_back", entityType: "Test", entityId: "x", actAsUserId: "op-lane-d" });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(await countRows("lane_d.strict.rolled_back")).toBe(0);
  });

  it("a strict row the database refuses throws, and the change before it rolls back", async () => {
    await expect(
      withRlsBypass(async (tx) => {
        // Stand-in for the change: an ordinary row in the same transaction.
        await tx.auditLog.create({ data: { tenantId: T, action: "lane_d.change", entityType: "Test", entityId: "x" } });
        // jsonb rejects a NUL character: a genuine database-side failure.
        await logAudit({ tx, tenantId: T, action: "lane_d.strict.refused", entityType: "Test", entityId: "x", metadata: { bad: "a\u0000b" } });
      }),
    ).rejects.toThrow();
    expect(await countRows("lane_d.change")).toBe(0);
    expect(await countRows("lane_d.strict.refused")).toBe(0);
  });

  it("a committed strict row carries actor, request id and outcome", async () => {
    await withRlsBypass(async (tx) => {
      await logAudit({
        tx,
        tenantId: T,
        userId: null,
        action: "lane_d.strict.committed",
        entityType: "Tenant",
        entityId: T,
        metadata: { reason: "synthetic" },
        actAsUserId: "op-lane-d",
        req: new Request("http://localhost/x", { headers: { "x-vercel-id": "lhr1::abc-123" } }),
      });
    });
    const row = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: T, action: "lane_d.strict.committed" } }));
    expect(row?.metadata).toMatchObject({ reason: "synthetic", actingAs: "op-lane-d", actor: "op-lane-d", actorType: "operator", requestId: "lhr1::abc-123", outcome: "succeeded" });
  });
});

describe.skipIf(!HAS_DB)("audit retention keeps platform evidence", () => {
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const old = ago(AUDIT_LOG_RETENTION_MS + 30 * DAY);
  const ancient = ago(AUDIT_EVIDENCE_RETENTION_MS + 30 * DAY);
  const fixtures: Array<{ key: string; action: string; createdAt: Date; metadata?: object | null; deleted: boolean }> = [
    { key: "ordinary-old-null-meta", action: "member.update", createdAt: old, metadata: null, deleted: true },
    { key: "ordinary-old-plain-meta", action: "member.update", createdAt: old, metadata: { field: "name" }, deleted: true },
    { key: "ordinary-recent", action: "member.update", createdAt: ago(10 * DAY), metadata: null, deleted: false },
    { key: "admin-old", action: "admin.owner.force_password_reset", createdAt: old, metadata: { reason: "r" }, deleted: false },
    { key: "impersonation-old", action: "admin.impersonate.start", createdAt: old, metadata: { reason: "r" }, deleted: false },
    { key: "erase-old", action: "member.dsar_erase", createdAt: old, metadata: { gdprBasis: "Article 17" }, deleted: false },
    { key: "erase-request-old", action: "member.dsar_erase.requested", createdAt: old, metadata: null, deleted: false },
    { key: "support-session-row-old", action: "member.update", createdAt: old, metadata: { actingAs: "op-x" }, deleted: false },
    { key: "admin-ancient", action: "admin.tenant.hard_deleted", createdAt: ancient, metadata: { reason: "r" }, deleted: true },
    { key: "support-session-row-ancient", action: "member.update", createdAt: ancient, metadata: { actingAs: "op-x" }, deleted: true },
  ];

  afterAll(async () => {
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: T } }));
  });

  it("selects exactly the rows past their window", async () => {
    await withRlsBypass(async (tx) => {
      for (const f of fixtures) {
        await tx.auditLog.create({
          data: {
            tenantId: T,
            action: f.action,
            entityType: "Retention",
            entityId: f.key,
            createdAt: f.createdAt,
            ...(f.metadata ? { metadata: f.metadata } : {}),
          },
        });
      }
    });
    const selected = await withRlsBypass((tx) =>
      tx.auditLog.findMany({
        where: { AND: [auditLogRetentionWhere(now), { tenantId: T, entityType: "Retention" }] },
        select: { entityId: true },
      }),
    );
    const got = selected.map((r) => r.entityId).sort();
    const want = fixtures.filter((f) => f.deleted).map((f) => f.key).sort();
    expect(got).toEqual(want);
  });
});
