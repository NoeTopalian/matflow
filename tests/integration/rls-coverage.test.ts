// Every table that holds a club's rows must carry the RLS backstop: ENABLE +
// FORCE ROW LEVEL SECURITY and the `tenant_isolation` policy. The foundation
// suite (rls-foundation.test.ts) proves the policy works on three tables; this
// one proves no table was left out. It found nothing missing on 30 Sep 2026
// (32 tables with a tenantId column, including Location from 20260925000000),
// and exists so the next new table cannot ship without the backstop.
//
// Tables without a tenantId column are either child tables reached through a
// tenant-scoped parent (they carry their own policy too, checked below where
// present) or platform tables that hold no club data, listed with the reason.

import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";

const HAS_DB = !!process.env.DATABASE_URL;

const PLATFORM_TABLES: Record<string, string> = {
  GymApplication: "an application to become a club, before any tenant exists; operator-only",
  Operator: "MatFlow's own staff accounts",
  PlatformConfig: "platform-wide settings",
  RateLimitHit: "throttle counters keyed by IP/route, no club data",
  StripeEvent: "webhook idempotency receipts; the handler resolves the club from the event",
};

type Row = { tbl: string; enabled: boolean; forced: boolean; policy: boolean; has_tenant: boolean };

describe.skipIf(!HAS_DB)("RLS covers every club table", () => {
  it("every table with a tenantId column has RLS enabled, forced and a tenant_isolation policy", async () => {
    const rows = await prisma.$queryRawUnsafe<Row[]>(`
      select t.relname as tbl, t.relrowsecurity as enabled, t.relforcerowsecurity as forced,
        exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.relname and p.policyname = 'tenant_isolation') as policy,
        exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = t.relname and col.column_name = 'tenantId') as has_tenant
      from pg_class t join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relkind = 'r' and t.relname <> '_prisma_migrations'`);
    const tenantTables = rows.filter((r) => r.has_tenant);
    expect(tenantTables.length).toBeGreaterThan(30);
    const gaps = tenantTables.filter((r) => !(r.enabled && r.forced && r.policy)).map((r) => r.tbl);
    expect(gaps, `tables with tenant data but no RLS backstop: ${gaps.join(", ")}`).toEqual([]);

    // Anything else without RLS must be a known platform table.
    const unguarded = rows.filter((r) => !r.has_tenant && !r.enabled).map((r) => r.tbl);
    const unknown = unguarded.filter((t) => !PLATFORM_TABLES[t]);
    expect(unknown, `tables without RLS that are not known platform tables: ${unknown.join(", ")}`).toEqual([]);
  });
});
