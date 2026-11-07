// Durable audit writes against REAL Postgres (lane D, 6 Oct 2026; operator
// audit 5 Oct 2026, Q9).
//
// A row written with `logAudit({ tx })` commits or rolls back with the change
// in the same transaction — both directions.
//
// The age-based retention predicate this file also tested is gone: Activity is
// kept permanently (product rule, Noe, 6 Nov 2026). That no row of any age is
// deleted by the nightly sweep is proved on Postgres in
// tests/integration/cron-smoke.test.ts.
//
// Rows carry a unique synthetic tenantId (AuditLog.tenantId has no foreign
// key, so no Tenant row is needed) and are deleted in afterAll. Runs only
// against the Neon TEST branch; skips without a database.

import { describe, it, expect, afterAll } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T = `lane-d-tenant-${STAMP}`;

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
