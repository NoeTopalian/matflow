// Audit integrity (admin hub lane C, 9 Oct 2026, ledger AH-03 / BRIEF Priority 4).
//
// 1. Actor + correlation COLUMNS (migration 20261009010000_audit_operator_request):
//    AuditLog.operatorId names the operator behind a row (never the shared-secret
//    sentinel; an id with no Operator row is written as null so it cannot abort
//    the caller's transaction), AuditLog.requestId carries the correlation id
//    (the spent step-up grant's id when given, else the platform request id or
//    a UUID on durable rows). metadata.actingAs is still written for readers.
// 2. Audit history is append-only from the application: no route or library
//    updates or deletes AuditLog rows, except the retention cron, which deletes
//    by AGE only (auditLogRetentionWhere). DBA reality: anyone holding the
//    database owner role can still edit history; that is outside the app.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  operators: new Set<string>(["op-real"]),
}));
const tx = {
  user: { findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
  operator: { findUnique: async ({ where }: { where: { id: string } }) => (db.operators.has(where.id) ? { id: where.id } : null) },
  auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { db.created.push(data); return data; } },
};
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: async () => null }));

import { logAudit, auditLogRetentionWhere } from "@/lib/audit-log";

beforeEach(() => {
  db.created = [];
});

const base = { tenantId: "t-1", action: "admin.tenant.suspended", entityType: "Tenant", entityId: "t-1" } as const;

describe("AuditLog actor and correlation columns", () => {
  it("an operator row carries operatorId and the given requestId as columns (and in metadata)", async () => {
    await logAudit({ ...base, tx: tx as never, actAsUserId: "op-real", operatorId: "op-real", requestId: "a".repeat(64) });
    expect(db.created[0]).toMatchObject({ operatorId: "op-real", requestId: "a".repeat(64) });
    expect(db.created[0].metadata).toMatchObject({ actingAs: "op-real", actorType: "operator", requestId: "a".repeat(64) });
  });

  it("operatorId defaults to the explicit real actor (actAsUserId)", async () => {
    await logAudit({ ...base, durable: true, actAsUserId: "op-real" });
    expect(db.created[0].operatorId).toBe("op-real");
  });

  it("the shared-secret sentinel is never written as an operator", async () => {
    await logAudit({ ...base, durable: true, actAsUserId: "__matflow_super_admin__" });
    expect(db.created[0].operatorId).toBeNull();
    expect(db.created[0].metadata).toMatchObject({ actorType: "shared-secret" });
  });

  it("an id with no Operator row is written as null (attribution kept in metadata), never a foreign-key abort", async () => {
    await logAudit({ ...base, tx: tx as never, actAsUserId: "op-deleted" });
    expect(db.created[0].operatorId).toBeNull();
    expect(db.created[0].metadata).toMatchObject({ actingAs: "op-deleted" });
  });

  it("durable rows without a grant get the platform request id as the correlation column", async () => {
    await logAudit({ ...base, durable: true, req: new Request("http://x/", { headers: { "x-vercel-id": "lhr1::abc" } }) });
    expect(db.created[0].requestId).toBe("lhr1::abc");
  });

  it("forbidden keys never reach metadata (scrub list kept)", async () => {
    await logAudit({ ...base, durable: true, metadata: { reason: "r", tempPassword: "x", grant: "g", token: "t" } });
    const meta = db.created[0].metadata as Record<string, unknown>;
    expect(meta.reason).toBe("r");
    expect(meta).not.toHaveProperty("tempPassword");
    expect(meta).not.toHaveProperty("grant");
    expect(meta).not.toHaveProperty("token");
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("audit history is append-only from the application", () => {
  const files = [...walk("app"), ...walk("lib")];
  const RETENTION = join("app", "api", "cron", "retention", "route.ts");

  it("no app/ or lib/ code updates or deletes AuditLog rows through Prisma", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/\bauditLog\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\s*\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("no raw SQL in app/ or lib/ updates or deletes AuditLog", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/(UPDATE\s+"?AuditLog"?\s+SET|DELETE\s+FROM\s+"?AuditLog"?|TRUNCATE\s+(TABLE\s+)?"?AuditLog"?)/i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the only generic handle on the AuditLog delegate is the retention cron, with the age-only predicate", () => {
    const users = files.filter((f) => /tx\.auditLog as unknown as/.test(readFileSync(f, "utf8")));
    expect(users).toEqual([RETENTION]);
    expect(readFileSync(RETENTION, "utf8")).toMatch(/tx\.auditLog as unknown as BatchDeletable,\s*auditLogRetentionWhere\(now\)/);
  });

  it("the retention predicate deletes by AGE only: every branch is bounded by createdAt", () => {
    const where = auditLogRetentionWhere(new Date("2026-10-09T00:00:00Z")) as { OR: Array<Record<string, unknown>> };
    expect(where.OR.length).toBeGreaterThan(0);
    for (const branch of where.OR) expect(branch.createdAt).toMatchObject({ lt: expect.any(Date) });
    expect(JSON.stringify(where)).not.toMatch(/"id"|"requestId"|"operatorId"/);
  });
});
