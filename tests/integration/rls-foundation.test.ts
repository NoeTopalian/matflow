// RLS foundation integration test.
//
// Temporarily enables RLS on Member, Payment, and Order, then asserts that
// `withTenantContext` scopes reads to one tenant, `withRlsBypass` sees all,
// and the default (no context) returns zero rows. RLS is disabled again in
// afterAll. If the test crashes mid-run, manually restore with:
//
//   ALTER TABLE "Member"  DISABLE ROW LEVEL SECURITY; ALTER TABLE "Member"  NO FORCE ROW LEVEL SECURITY;
//   ALTER TABLE "Payment" DISABLE ROW LEVEL SECURITY; ALTER TABLE "Payment" NO FORCE ROW LEVEL SECURITY;
//   ALTER TABLE "Order"   DISABLE ROW LEVEL SECURITY; ALTER TABLE "Order"   NO FORCE ROW LEVEL SECURITY;
//
// Skips when DATABASE_URL is not set so unit-only test runs are unaffected.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const TABLES = ["Member", "Payment", "Order"] as const;

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
    const tA = await prisma.tenant.create({
      data: { name: "RLS Test A", slug: `rls-test-a-${STAMP}` },
    });
    const tB = await prisma.tenant.create({
      data: { name: "RLS Test B", slug: `rls-test-b-${STAMP}` },
    });
    tenantAId = tA.id;
    tenantBId = tB.id;

    const mA = await prisma.member.create({
      data: {
        tenantId: tA.id,
        name: "Member A",
        email: `mem-a-${STAMP}@rls-test.local`,
      },
    });
    const mB = await prisma.member.create({
      data: {
        tenantId: tB.id,
        name: "Member B",
        email: `mem-b-${STAMP}@rls-test.local`,
      },
    });
    memberAId = mA.id;
    memberBId = mB.id;

    const pA = await prisma.payment.create({
      data: {
        tenantId: tA.id,
        memberId: mA.id,
        amountPence: 1000,
        currency: "GBP",
        status: "succeeded",
        description: "RLS test payment A",
      },
    });
    const pB = await prisma.payment.create({
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

    const oA = await prisma.order.create({
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
    const oB = await prisma.order.create({
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

    for (const t of TABLES) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    }
  });

  afterAll(async () => {
    for (const t of TABLES) {
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
    it("withTenantContext scopes findMany to one tenant", async () => {
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

    it("returns zero rows without context (default deny)", async () => {
      const r = await prisma.member.findMany({
        where: { id: { in: [memberAId, memberBId] } },
        select: { id: true },
      });
      expect(r).toEqual([]);
    });
  });

  describe("Payment", () => {
    it("withTenantContext scopes findMany to one tenant", async () => {
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

    it("returns zero rows without context (default deny)", async () => {
      const r = await prisma.payment.findMany({
        where: { id: { in: [paymentAId, paymentBId] } },
        select: { id: true },
      });
      expect(r).toEqual([]);
    });

    it("rejects cross-tenant write attempt", async () => {
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
    it("withTenantContext scopes findMany to one tenant", async () => {
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
