// Payments lane PC (11 Oct 2026) — the MemberSubscription writer on REAL rows,
// through the same tenant-scoped transaction the create and migration paths use
// (withTenantContext, so RLS applies under the restricted runner). Run with
// BOTH TEST-branch runners; skips without a database.
//
// Pins: the mapping is immutable (a retried create returns the same row and
// changes nothing); a subscription already mapped to another member is refused
// (also when that member is in another club); the pointer is written in the
// same transaction and rolls back with it; another club cannot read the row.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { recordSubscriptionMapping } from "@/lib/stripe/webhook/mapping";

const HAS_DB = !!process.env.DATABASE_URL;
const RLS = process.env.RLS_ENFORCED === "1";
const STAMP = `paypcw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const T = { a: `${STAMP}-ta`, b: `${STAMP}-tb` };
const M = { a1: `${STAMP}-a1`, a2: `${STAMP}-a2`, b1: `${STAMP}-b1` };
const SUB = `sub_${STAMP}_x`;
const SUB_ROLLBACK = `sub_${STAMP}_rb`;

const input = (tenantId: string, memberId: string, sub = SUB) => ({
  tenantId, memberId, stripeAccountId: `acct_${tenantId}`, stripeSubscriptionId: sub,
  source: "app" as const, status: "incomplete", currentPeriodEnd: null,
});

describe.skipIf(!HAS_DB)("pay-pc: the subscription mapping writer", () => {
  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const [k, id] of Object.entries(T)) {
        await tx.tenant.create({ data: { id, name: `${STAMP} ${k}`, slug: id, stripeAccountId: `acct_${id}`, stripeConnected: true } });
      }
      await tx.member.create({ data: { id: M.a1, tenantId: T.a, email: `${STAMP}-a1@example.test`, name: "PC a1" } });
      await tx.member.create({ data: { id: M.a2, tenantId: T.a, email: `${STAMP}-a2@example.test`, name: "PC a2" } });
      await tx.member.create({ data: { id: M.b1, tenantId: T.b, email: `${STAMP}-b1@example.test`, name: "PC b1" } });
    });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.memberSubscription.deleteMany({ where: { tenantId: { in: [T.a, T.b] } } });
      await tx.member.deleteMany({ where: { tenantId: { in: [T.a, T.b] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [T.a, T.b] } } });
    });
  }, 120_000);

  it("writes the row, and a retried create returns the same row unchanged (immutable)", async () => {
    const first = await withTenantContext(T.a, (tx) => recordSubscriptionMapping(tx, input(T.a, M.a1)));
    const again = await withTenantContext(T.a, (tx) => recordSubscriptionMapping(tx, { ...input(T.a, M.a1), status: "active", source: "migration" }));
    expect(again.id).toBe(first.id);
    const row = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: SUB } }));
    expect(row).toMatchObject({ tenantId: T.a, memberId: M.a1, source: "app", status: "incomplete", stripeAccountId: `acct_${T.a}` });
  });

  it("refuses to map the same subscription to another member of the same club", async () => {
    await expect(withTenantContext(T.a, (tx) => recordSubscriptionMapping(tx, input(T.a, M.a2)))).rejects.toThrow();
    const row = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: SUB } }));
    expect(row?.memberId).toBe(M.a1);
  });

  it("refuses to map it to a member of another club", async () => {
    await expect(withTenantContext(T.b, (tx) => recordSubscriptionMapping(tx, input(T.b, M.b1)))).rejects.toThrow();
    const rows = await withRlsBypass((tx) => tx.memberSubscription.findMany({ where: { stripeSubscriptionId: SUB } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(T.a);
  });

  it("the mapping and the pointer commit together: a failure after both rolls both back", async () => {
    class Abort extends Error {}
    await withTenantContext(T.a, async (tx) => {
      await recordSubscriptionMapping(tx, input(T.a, M.a2, SUB_ROLLBACK));
      await tx.member.update({ where: { id: M.a2 }, data: { stripeSubscriptionId: SUB_ROLLBACK, paymentStatus: "pending" } });
      throw new Abort("after both writes");
    }).catch((e) => { if (!(e instanceof Abort)) throw e; });
    const row = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: SUB_ROLLBACK } }));
    const m = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: M.a2 }, select: { stripeSubscriptionId: true, paymentStatus: true } }));
    expect(row).toBeNull();
    expect(m).toMatchObject({ stripeSubscriptionId: null });
  });

  it.skipIf(!RLS)("another club cannot read the row (RLS, restricted role)", async () => {
    const seenByB = await withTenantContext(T.b, (tx) => tx.memberSubscription.findMany({ where: { stripeSubscriptionId: SUB } }));
    const seenByA = await withTenantContext(T.a, (tx) => tx.memberSubscription.findMany({ where: { stripeSubscriptionId: SUB } }));
    expect(seenByB).toEqual([]);
    expect(seenByA).toHaveLength(1);
  });
});
