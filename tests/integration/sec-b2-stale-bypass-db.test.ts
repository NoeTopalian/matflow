// Security campaign iteration 2, lane B (SF-62) — stale / leaked session context on a reused connection.
//
// TEST branch only. Run under BOTH runners: q78/run-restricted.sh (matflow_app, RLS in force) and att/run-engine.sh
// (owner, BYPASSRLS — RLS cells record "not in force"). The test swaps the runner's pooled URL for the DIRECT host of
// the same TEST endpoint (scripts/readiness/rls-test-target.mjs: positive allowlist, PG* env refused), because it
// deliberately leaves a SESSION-level setting on its connection and that must never happen through the shared
// PgBouncer, where it would reach other clients.
//
// Red first: before the fix, withTenantContext set only app.current_tenant_id, so a session-level
// app.bypass_rls = 'on' left on the pooled connection made the "tenant-scoped" transaction see every club.
// Fixture prefix secB2-; count-checked teardown.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { directTestUrl } from "../../scripts/readiness/rls-test-target.mjs";

const RAW = process.env.DATABASE_URL;
const HAS_DB = !!RAW && RAW.toLowerCase().includes("ep-hidden-salad");
if (HAS_DB) {
  // Must run before the lazy client is created (first property access), and no client may be cached yet.
  if ((globalThis as { prisma?: unknown }).prisma) throw new Error("a Prisma client already exists in this worker; run this file on its own");
  process.env.DATABASE_URL = directTestUrl(RAW!);
}

const STAMP = `secB2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = STAMP.toLowerCase();

type Pid = Array<{ pid: number }>;
const pidOf = async (q: { $queryRaw: typeof prisma.$queryRaw }) => Number((await q.$queryRaw<Pid>`SELECT pg_backend_pid() AS pid`)[0].pid);

describe.skipIf(!HAS_DB)("SF-62: stale or leaked session context on a reused connection", () => {
  const ids = { a: "", b: "", memberA: "", memberB: "" };
  let enforced = false;
  let who = "";

  beforeAll(async () => {
    const r = await prisma.$queryRaw<Array<{ u: string; bypass: boolean; superuser: boolean }>>`
      SELECT current_user AS u, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    who = r[0].u;
    enforced = !r[0].bypass && !r[0].superuser;
    if (process.env.RLS_ENFORCED === "1") expect(enforced, `RLS_ENFORCED=1 but ${who} bypasses RLS`).toBe(true);
    await withRlsBypass(async (tx) => {
      ids.a = (await tx.tenant.create({ data: { name: `${STAMP} A`, slug: `${SLUG}-a` } })).id;
      ids.b = (await tx.tenant.create({ data: { name: `${STAMP} B`, slug: `${SLUG}-b` } })).id;
      ids.memberA = (await tx.member.create({ data: { tenantId: ids.a, email: `${SLUG}-a@example.test`, name: "A member" } })).id;
      ids.memberB = (await tx.member.create({ data: { tenantId: ids.b, email: `${SLUG}-b@example.test`, name: "B member" } })).id;
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.$executeRaw`SELECT set_config('app.bypass_rls', '', false), set_config('app.current_tenant_id', '', false)`;
    for (const tenantId of [ids.a, ids.b].filter(Boolean)) {
      await withRlsBypass(async (tx) => {
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      });
    }
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { slug: { startsWith: SLUG } } }));
    expect(left).toBe(0);
    await prisma.$disconnect();
  }, 120_000);

  const seen = (tenantId: string) =>
    withTenantContext(tenantId, async (tx) => ({
      pid: await pidOf(tx),
      a: await tx.member.count({ where: { id: ids.memberA } }),
      b: await tx.member.count({ where: { id: ids.memberB } }),
    }));

  it("records the connected role and that the connection is direct (not the shared pooler)", async () => {
    const host = new URL(process.env.DATABASE_URL!).hostname;
    console.log(JSON.stringify({ lane: "B2", currentUser: who, rlsInForce: enforced, pooler: host.includes("-pooler") }));
    expect(host.includes("-pooler")).toBe(false);
  });

  it("positive control: on a clean connection, club A's context sees A's member and not B's", async () => {
    const r = await seen(ids.a);
    expect(r.a).toBe(1);
    if (!enforced) return;
    expect(r.b).toBe(0);
  });

  it("a SESSION-level app.bypass_rls = 'on' left on the connection does not widen the next tenant-scoped transaction", async () => {
    const leakPid = Number((await prisma.$queryRaw<Pid>`SELECT pg_backend_pid() AS pid, set_config('app.bypass_rls', 'on', false) AS v`)[0].pid);
    try {
      const r = await seen(ids.a);
      // The cell is only meaningful if the transaction really reused the poisoned connection.
      expect(r.pid, "withTenantContext did not reuse the connection that carries the session setting").toBe(leakPid);
      expect(r.a).toBe(1);
      if (!enforced) return;
      expect(r.b).toBe(0);
    } finally {
      await prisma.$executeRaw`SELECT set_config('app.bypass_rls', '', false)`;
    }
  });

  it("a SESSION-level tenant B left on the connection is overridden inside club A's transaction", async () => {
    const leakPid = Number((await prisma.$queryRaw<Pid>`SELECT pg_backend_pid() AS pid, set_config('app.current_tenant_id', ${ids.b}, false) AS v`)[0].pid);
    try {
      const r = await seen(ids.a);
      expect(r.pid).toBe(leakPid);
      expect(r.a).toBe(1);
      // Residual under the DEPLOYED policies, recorded not asserted: a plain query OUTSIDE any transaction on this
      // connection runs with the leaked tenant. Only the signed, transaction-bound context (design P2) removes it.
      const plain = await prisma.member.count({ where: { id: ids.memberB } });
      console.log(JSON.stringify({ lane: "B2", residual: "session-level tenant visible to a plain query outside a transaction", visible: plain }));
      if (!enforced) return;
      expect(r.b).toBe(0);
    } finally {
      await prisma.$executeRaw`SELECT set_config('app.current_tenant_id', '', false)`;
    }
  });

  it("a failed tenant transaction leaves no context behind on the connection", async () => {
    const before = await pidOf(prisma);
    await expect(withTenantContext(ids.b, async (tx) => {
      await tx.member.count();
      throw new Error("planned failure");
    })).rejects.toThrow("planned failure");
    const after = await prisma.$queryRaw<Array<{ pid: number; t: string; b: string }>>`
      SELECT pg_backend_pid() AS pid, coalesce(current_setting('app.current_tenant_id', true), '') AS t, coalesce(current_setting('app.bypass_rls', true), '') AS b`;
    expect(Number(after[0].pid)).toBe(before);
    expect({ t: after[0].t, b: after[0].b }).toEqual({ t: "", b: "" });
  });

  it("positive control: withRlsBypass still crosses clubs after the fix (the escape hatch is unchanged)", async () => {
    const r = await withRlsBypass(async (tx) => tx.member.count({ where: { id: { in: [ids.memberA, ids.memberB] } } }));
    expect(r).toBe(2);
  });
});
