// Lane L1 (11 Oct 2026): inventory — and, with L1_CLEANUP=1, count-checked removal — of fixtures that L1's own runs
// of sec-a4-lockout-burst-db / sec-c3-rate-limit-atomic-db / sec-l1-* could have left on the TEST branch when a
// teardown itself failed on a dropped connection. Scope is exactly: synthetic clubs whose slug starts "seca4-" created
// inside L1's run window, their members / login events / audit rows, the c3 and l1 buckets ("secc3-rl-", "secl1"),
// and lockout counter rows ("authfail:") stamped inside L1's run window (no other lane ran in it: D-8 kept L2 unlaunched).
// TEST branch only through the guarded runners.
import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const FROM = new Date(process.env.L1_WINDOW_FROM ?? "2026-10-11T05:45:00Z");
const TO = new Date(process.env.L1_WINDOW_TO ?? new Date().toISOString());
const CLEAN = process.env.L1_CLEANUP === "1";
const OUT = process.env.L1_EVIDENCE_OUT;

describe.skipIf(!ON_TEST)("L1 leftovers on TEST", () => {
  it(CLEAN ? "removes L1's leftovers, count-checked" : "lists L1's leftovers", async () => {
    const tenants = await withRlsBypass((tx) =>
      tx.tenant.findMany({ where: { slug: { startsWith: "seca4-" }, createdAt: { gte: FROM, lte: TO } }, select: { id: true } }),
    );
    const ids = tenants.map((t) => t.id);
    const before = await withRlsBypass(async (tx) => ({
      tenants: ids.length,
      members: await tx.member.count({ where: { tenantId: { in: ids } } }),
      loginEvents: await tx.loginEvent.count({ where: { tenantId: { in: ids } } }),
      auditLogs: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
    }));
    const hitWhere = {
      OR: [
        { bucket: { startsWith: "secc3-rl-" }, hitAt: { gte: FROM, lte: TO } },
        { bucket: { startsWith: "secl1" } },
        { bucket: { startsWith: "authfail:" }, hitAt: { gte: FROM, lte: TO } },
      ],
    };
    const hitsBefore = await prisma.rateLimitHit.count({ where: hitWhere });
    let removed: Record<string, number> | null = null;
    if (CLEAN) {
      const hits = await prisma.rateLimitHit.deleteMany({ where: hitWhere });
      removed = await withRlsBypass(async (tx) => ({
        auditLogs: (await tx.auditLog.deleteMany({ where: { tenantId: { in: ids } } })).count,
        loginEvents: (await tx.loginEvent.deleteMany({ where: { tenantId: { in: ids } } })).count,
        members: (await tx.member.deleteMany({ where: { tenantId: { in: ids } } })).count,
        tenants: (await tx.tenant.deleteMany({ where: { id: { in: ids } } })).count,
        hits: hits.count,
      }), { timeout: 60_000 });
    }
    const hitsAfter = await prisma.rateLimitHit.count({ where: hitWhere });
    const tenantsAfter = await withRlsBypass((tx) => tx.tenant.count({ where: { id: { in: ids } } }));
    const line = `L1-LEFTOVERS ${JSON.stringify({ window: [FROM.toISOString(), TO.toISOString()], before: { ...before, hits: hitsBefore }, removed, after: { tenants: tenantsAfter, hits: hitsAfter } })}`;
    console.log(line);
    if (OUT) appendFileSync(OUT, line + "\n");
    if (CLEAN) {
      expect(removed!.tenants).toBe(before.tenants);
      expect(removed!.members).toBe(before.members);
      expect(removed!.hits).toBe(hitsBefore);
      expect({ tenantsAfter, hitsAfter }).toEqual({ tenantsAfter: 0, hitsAfter: 0 });
    }
  }, 120_000);
});
