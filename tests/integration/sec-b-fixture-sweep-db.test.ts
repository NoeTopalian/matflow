// Security lane B fixture sweep (9 Oct 2026). Removes ONLY synthetic clubs and
// operators whose slug / id carries the lane-B prefix `secb-` / `secB-`, left
// behind when a lane-B test's teardown failed. Count-checked: it reports what
// it found, deletes children before parents, and asserts zero remain. It never
// matches another lane's prefix or an unprefixed row.
//
// Runs only via the guarded runners (TEST branch only). Skips without a DB and
// unless SEC_B_SWEEP=1, so a normal `npm test` never deletes anything.

import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";

const RUN = !!process.env.DATABASE_URL && process.env.SEC_B_SWEEP === "1";

describe.skipIf(!RUN)("lane B fixture sweep (prefix secb- only)", () => {
  it("deletes abandoned secb- clubs and secB- operators, count-checked", async () => {
    const tenants = await withRlsBypass((tx) => tx.tenant.findMany({ where: { slug: { startsWith: "secb-" } }, select: { id: true, slug: true } }));
    for (const t of tenants) expect(t.slug.startsWith("secb-")).toBe(true);
    console.log(JSON.stringify({ sweep: "found", tenants: tenants.length }));
    for (const { id: tenantId } of tenants) {
      await withRlsBypass(async (tx) => {
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.importedMembership.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.importJob.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 120_000 });
    }
    const ops = await prisma.operator.findMany({ where: { id: { startsWith: "secB-" } }, select: { id: true } });
    for (const o of ops) {
      await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: o.id } }));
    }
    await prisma.operator.deleteMany({ where: { id: { startsWith: "secB-" } } });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { slug: { startsWith: "secb-" } } }),
      operators: await tx.operator.count({ where: { id: { startsWith: "secB-" } } }),
    }));
    console.log(JSON.stringify({ sweep: "removed", tenants: tenants.length, operators: ops.length, left }));
    expect(left).toEqual({ tenants: 0, operators: 0 });
  }, 600_000);
});
