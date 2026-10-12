// Security campaign iteration 2, lane B (SF-62) — the both-role acceptance test for the PROPOSED migration
// (docs/security/evidence/B2/proposed-sf62-phase1.sql + phase2.sql) on the real public schema.
//
// It only runs when SEC_B2_BOUNDARY_APPLIED=1, i.e. after the lead has applied both phases to the TEST branch and
// provisioned matflow_sec.context_key with the key that RLS_CONTEXT_SIGNING_KEY carries for this run. Until then it
// is NOT RUN — that is a coverage gap for SF-62, not a pass. Run with SEC_B2_BOUNDARY_APPLIED=1 against the current
// TEST branch it fails (red): the deployed policies still trust app.bypass_rls.
// Runners: q78/run-restricted.sh (matflow_app) and att/run-engine.sh (owner: RLS cells record "not in force").
// Fixtures (prefix secB2-) are created and removed through SIGNED tenant contexts only — no bypass exists after phase 2.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";

const RUN = process.env.SEC_B2_BOUNDARY_APPLIED === "1" && !!process.env.DATABASE_URL;
const STAMP = `secB2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = STAMP.toLowerCase();
const T = { a: `${SLUG}-a`, b: `${SLUG}-b` };

describe.skipIf(!RUN)("SF-62 proposal applied: the runtime role cannot cross tenants by setting a GUC", () => {
  let enforced = false;

  beforeAll(async () => {
    expect(process.env.RLS_CONTEXT_SIGNING_KEY, "RLS_CONTEXT_SIGNING_KEY must hold the provisioned key").toMatch(/^[0-9a-fA-F]{128}$/);
    const r = await prisma.$queryRaw<Array<{ bypass: boolean; superuser: boolean }>>`
      SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    enforced = !r[0].bypass && !r[0].superuser;
    for (const id of [T.a, T.b]) {
      await withTenantContext(id, async (tx) => {
        await tx.tenant.create({ data: { id, name: `${STAMP} ${id}`, slug: id } });
        await tx.member.create({ data: { tenantId: id, email: `${id}@example.test`, name: "M" } });
      });
    }
  }, 120_000);

  afterAll(async () => {
    for (const id of [T.a, T.b]) {
      await withTenantContext(id, async (tx) => {
        await tx.member.deleteMany({ where: { tenantId: id } });
        await tx.tenant.deleteMany({ where: { id } });
      }).catch(() => {});
    }
    const left = await Promise.all([T.a, T.b].map((id) => withTenantContext(id, (tx) => tx.tenant.count({ where: { id } }))));
    expect(left).toEqual([0, 0]);
  }, 120_000);

  it("catalogue: no policy trusts a plain app.* setting; every RLS table has the role-keyed system policy", async () => {
    const bad = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE s.nspname = 'public' AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'app\\.(bypass_rls|current_tenant_id)'
        OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'app\\.(bypass_rls|current_tenant_id)')`;
    expect(bad[0].n).toBe(0);
    const missing = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'system_access')`;
    expect(missing[0].n).toBe(0);
  });

  it("catalogue: definer functions owned by matflow_system, pinned search_path, no PUBLIC execute; runtime not a member; no ledger rights", async () => {
    const fns = await prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'matflow_system' AND coalesce(p.proconfig::text, '') LIKE '%search_path=pg_catalog, pg_temp%'
              AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)) AS ok
      FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'matflow_sec'`;
    expect(fns.length).toBeGreaterThanOrEqual(7);
    expect(fns.every((f) => f.ok)).toBe(true);
    const r = await prisma.$queryRaw<Array<{ member: boolean; ledger: boolean }>>`
      SELECT pg_has_role('matflow_app', 'matflow_system', 'MEMBER') AS member,
             has_table_privilege('matflow_app', 'public._prisma_migrations', 'INSERT,UPDATE,DELETE') AS ledger`;
    expect(r[0]).toEqual({ member: false, ledger: false });
  });

  it("positive control: a signed context sees its own club", async () => {
    expect(await withTenantContext(T.a, (tx) => tx.member.count({ where: { tenantId: T.a } }))).toBe(1);
  });

  it("app.bypass_rls = 'on' and a forged app.current_tenant_id grant nothing", async () => {
    const r = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const bypass = await tx.member.count({ where: { tenantId: { in: [T.a, T.b] } } });
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${T.b}, true)`;
      const forged = await tx.member.count({ where: { tenantId: T.b } });
      return { bypass, forged };
    });
    if (!enforced) return; // owner role: BYPASSRLS, RLS not in force
    expect(r).toEqual({ bypass: 0, forged: 0 });
  });

  it("in A's signed context, B's rows are invisible and cannot be planted", async () => {
    const seen = await withTenantContext(T.a, (tx) => tx.member.count({ where: { tenantId: T.b } }));
    if (!enforced) return;
    expect(seen).toBe(0);
    await expect(withTenantContext(T.a, (tx) => tx.member.create({ data: { tenantId: T.b, email: `${T.b}-planted@example.test`, name: "P" } })))
      .rejects.toThrow(/row-level security|policy/i);
  });

  it("the runtime role cannot assume the system role", async () => {
    const r = await prisma.$transaction(async (tx) => tx.$executeRawUnsafe("SET LOCAL ROLE matflow_system").then(() => "ALLOWED", (e: Error) => e.message));
    if (!enforced) return;
    expect(r).toMatch(/permission denied/);
  });
});
