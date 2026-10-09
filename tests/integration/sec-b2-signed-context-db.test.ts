// Security campaign iteration 2, lane B (SF-62 design P2) — the application's MAC (lib/prisma-tenant.ts) and the
// database's recomputation (the ctx_tenant() body proposed in docs/security/evidence/B2/proposed-sf62-phase1.sql)
// agree on a real Postgres, inside one transaction, using only built-in functions (sha256, convert_to, encode).
// No DDL, no fixtures, no session state; TEST branch only; both runners.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { tenantContextMac } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("signed tenant context: app MAC == SQL recomputation", () => {
  it("matches for the same transaction and differs for another transaction, tenant or key", async () => {
    const key = randomBytes(64);
    const ipad = Buffer.from(key.map((b) => b ^ 0x36));
    const opad = Buffer.from(key.map((b) => b ^ 0x5c));
    const tenant = "secB2-tenant-x";
    const sqlMac = (tx: typeof prisma, t: string) => tx.$queryRaw<Array<{ mac: string; pid: string; ts: string }>>`
      SELECT encode(sha256(${opad}::bytea || sha256(${ipad}::bytea || convert_to(${t} || '|' || pg_backend_pid()::text || '|'
               || floor(extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text, 'UTF8'))), 'hex') AS mac,
             pg_backend_pid()::text AS pid,
             floor(extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text AS ts`;

    const first = await prisma.$transaction(async (tx) => (await sqlMac(tx as unknown as typeof prisma, tenant))[0]);
    expect(tenantContextMac(key, tenant, first.pid, first.ts)).toBe(first.mac);

    const second = await prisma.$transaction(async (tx) => (await sqlMac(tx as unknown as typeof prisma, tenant))[0]);
    expect(second.ts).not.toBe(first.ts); // a new transaction has a new start time ...
    expect(second.mac).not.toBe(first.mac); // ... so the earlier MAC cannot be replayed
    expect(tenantContextMac(key, "secB2-other", second.pid, second.ts)).not.toBe(second.mac);
    expect(tenantContextMac(randomBytes(64), tenant, second.pid, second.ts)).not.toBe(second.mac);
  });
});
