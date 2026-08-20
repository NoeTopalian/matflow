// RLS foundation integration test.
//
// Asserts that `withTenantContext` scopes reads to one tenant, `withRlsBypass`
// sees all, and the default (no context) returns zero rows.
//
// Two run modes (2026-08-17 verification campaign):
//  - BYPASSRLS connection (e.g. neondb_owner): enforcement assertions SKIP —
//    the connected role bypasses policies, so they can prove nothing. Only the
//    bypass-path tests run.
//  - Restricted role (the real proof): connect with
//    `&options=-c%20role%3Dmatflow_app` after scripts/create-restricted-role.ts
//    and `GRANT matflow_app TO neondb_owner`. All 9 assertions run.
//
// RLS enable/disable is only performed on tables that were NOT already
// enforced, and afterAll restores only what this run enabled — a crashed run
// can no longer strip migration-enforced RLS from the branch (which a blanket
// afterAll DISABLE did on 2026-08-16, silently disarming Member/Payment).
//
// Skips entirely when DATABASE_URL is not set so unit-only runs are unaffected.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const TABLES = ["Member", "Payment", "Order"] as const;
const enabledByThisRun: string[] = [];

// True when the CONNECTED role bypasses RLS (e.g. neondb_owner). Enforcement
// assertions cannot prove anything on such a connection — they skip visibly
// instead of failing. To run them for real, connect as (or SET ROLE to) the
// restricted role, e.g. append `&options=-c%20role%3Dmatflow_app` to
// TEST_DATABASE_URL after scripts/create-restricted-role.ts +
// `GRANT matflow_app TO neondb_owner`.
let connectionBypassesRls = false;

describe.skipIf(!HAS_DB)("RLS foundation", () => {
  let tenantAId: string;
  let tenantBId: string;
  let memberAId: string;
  let memberBId: string;
  let paymentAId: string;
  let paymentBId: string;
  let orderAId: string;
  let orderBId: string;

  beforeAll(async () => {
    const [{ bypass }] = await prisma.$queryRawUnsafe<{ bypass: boolean }[]>(
      `SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    connectionBypassesRls = bypass;

    // Fixtures build through withRlsBypass (the policies' sanctioned
    // `app.bypass_rls` arm) rather than the bare client: when this file runs
    // as the restricted `matflow_app` role — the configuration that actually
    // proves enforcement — un-contexted INSERTs are themselves denied by the
    // very policies under test. The assertions below still exercise the
    // scoped / bypass / no-context paths independently.
    await withRlsBypass(async (tx) => {
      const tA = await tx.tenant.create({
        data: { name: "RLS Test A", slug: `rls-test-a-${STAMP}` },
      });
      const tB = await tx.tenant.create({
        data: { name: "RLS Test B", slug: `rls-test-b-${STAMP}` },
      });
      tenantAId = tA.id;
      tenantBId = tB.id;

      const mA = await tx.member.create({
        data: {
          tenantId: tA.id,
          name: "Member A",
          email: `mem-a-${STAMP}@rls-test.local`,
        },
      });
      const mB = await tx.member.create({
        data: {
          tenantId: tB.id,
          name: "Member B",
          email: `mem-b-${STAMP}@rls-test.local`,
        },
      });
      memberAId = mA.id;
      memberBId = mB.id;

      const pA = await tx.payment.create({
        data: {
          tenantId: tA.id,
          memberId: mA.id,
          amountPence: 1000,
          currency: "GBP",
          status: "succeeded",
          description: "RLS test payment A",
        },
      });
      const pB = await tx.payment.create({
        data: {
          tenantId: tB.id,
          memberId: mB.id,
          amountPence: 2000,
          currency: "GBP",
          status: "succeeded",
          description: "RLS test payment B",
        },
      });
      paymentAId = pA.id;
      paymentBId = pB.id;

      const oA = await tx.order.create({
        data: {
          tenantId: tA.id,
          memberId: mA.id,
          orderRef: `ORD-RLS-A-${STAMP}`,
          items: [{ id: "x", name: "Test", price: 10, quantity: 1 }],
          totalPence: 1000,
          status: "pending",
          paymentMethod: "pay_at_desk",
        },
      });
      const oB = await tx.order.create({
        data: {
          tenantId: tB.id,
          memberId: mB.id,
          orderRef: `ORD-RLS-B-${STAMP}`,
          items: [{ id: "x", name: "Test", price: 20, quantity: 1 }],
          totalPence: 2000,
          status: "pending",
          paymentMethod: "pay_at_desk",
        },
      });
      orderAId = oA.id;
      orderBId = oB.id;
    });

    // Record which tables THIS run enables, so afterAll only restores those.
    // On a branch where migration 20260503200000 enforces RLS permanently,
    // blanket-disabling in afterAll would strip live enforcement — exactly
    // what a crashed earlier run did to Member/Payment on the test branch.
    // Under the restricted role the ALTERs fail (not owner) and are skipped:
    // RLS is already enforced there, which is the point.
    for (const t of TABLES) {
      try {
        const [{ on }] = await prisma.$queryRawUnsafe<{ on: boolean }[]>(
          `SELECT relrowsecurity AS on FROM pg_class WHERE oid = '"${t}"'::regclass`,
        );
        if (!on) {
          await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
          await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
          enabledByThisRun.push(t);
        }
      } catch {
        /* not owner — RLS already enforced branch-wide */
      }
    }
  });

  afterAll(async () => {
    // Only unwind tables this run itself enabled — never strip enforcement
    // that a migration (or an operator) put there before us.
    for (const t of enabledByThisRun) {
      try { await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`); } catch {}
      try { await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`); } catch {}
    }
    try {
      await withRlsBypass(async (tx) => {
        await tx.order.deleteMany({ where: { id: { in: [orderAId, orderBId] } } });
        await tx.payment.deleteMany({ where: { id: { in: [paymentAId, paymentBId] } } });
        await tx.member.deleteMany({ where: { id: { in: [memberAId, memberBId] } } });
        await tx.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
      });
    } catch {}
  });

  describe("Member", () => {
    it("withTenantContext scopes findMany to one tenant", async (ctx) => {
      if (connectionBypassesRls) ctx.skip();
      const a = await withTenantContext(tenantAId, (tx) =>
        tx.member.findMany({ where: { id: { in: [memberAId, memberBId] } }, select: { id: true } }),
      );
      expect(a.map((m) => m.id)).toContain(memberAId);
      expect(a.map((m) => m.id)).not.toContain(memberBId);

      const b = await withTenantContext(tenantBId, (tx) =>
        tx.member.findMany({ where: { id: { in: [memberAId, memberBId] } }, select: { id: true } }),
      );
      expect(b.map((m) => m.id)).toContain(memberBId);
      expect(b.map((m) => m.id)).not.toContain(memberAId);
    });

    it("withRlsBypass sees all rows", async () => {
      const all = await withRlsBypass((tx) =>
        tx.member.findMany({ where: { id: { in: [memberAId, memberBId] } }, select: { id: true } }),
      );
      expect(all.map((m) => m.id).sort()).toEqual([memberAId, memberBId].sort());
    });

    it("returns zero rows without context (default deny)", async (ctx) => {
      if (connectionBypassesRls) ctx.skip();
      const r = await prisma.member.findMany({
        where: { id: { in: [memberAId, memberBId] } },
        select: { id: true },
      });
      expect(r).toEqual([]);
    });
  });

  describe("Payment", () => {
    it("withTenantContext scopes findMany to one tenant", async (ctx) => {
      if (connectionBypassesRls) ctx.skip();
      const a = await withTenantContext(tenantAId, (tx) =>
        tx.payment.findMany({ where: { id: { in: [paymentAId, paymentBId] } }, select: { id: true } }),
      );
      expect(a.map((p) => p.id)).toContain(paymentAId);
      expect(a.map((p) => p.id)).not.toContain(paymentBId);
    });

    it("withRlsBypass sees all rows", async () => {
      const all = await withRlsBypass((tx) =>
        tx.payment.findMany({ where: { id: { in: [paymentAId, paymentBId] } }, select: { id: true } }),
      );
      expect(all.map((p) => p.id).sort()).toEqual([paymentAId, paymentBId].sort());
    });

    it("returns zero rows without context (default deny)", async (ctx) => {
      if (connectionBypassesRls) ctx.skip();
      const r = await prisma.payment.findMany({
        where: { id: { in: [paymentAId, paymentBId] } },
        select: { id: true },
      });
      expect(r).toEqual([]);
    });

    it("rejects cross-tenant write attempt", async (ctx) => {
      if (connectionBypassesRls) ctx.skip();
      // Trying to write a Payment for tenantB while in tenantA's context
      // must be denied by the policy (WITH CHECK is implicit in PERMISSIVE FOR ALL).
      await expect(
        withTenantContext(tenantAId, (tx) =>
          tx.payment.update({
            where: { id: paymentBId },
            data: { description: "should not write" },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("Order", () => {
    it("withTenantContext scopes findMany to one tenant", async (ctx) => {
      if (connectionBypassesRls) ctx.skip();
      const a = await withTenantContext(tenantAId, (tx) =>
        tx.order.findMany({ where: { id: { in: [orderAId, orderBId] } }, select: { id: true } }),
      );
      expect(a.map((o) => o.id)).toContain(orderAId);
      expect(a.map((o) => o.id)).not.toContain(orderBId);
    });

    it("withRlsBypass sees all rows", async () => {
      const all = await withRlsBypass((tx) =>
        tx.order.findMany({ where: { id: { in: [orderAId, orderBId] } }, select: { id: true } }),
      );
      expect(all.map((o) => o.id).sort()).toEqual([orderAId, orderBId].sort());
    });
  });
});
