// Review RP (11 Oct 2026), adopted by lane PC for RP-3. Copied from <scratchpad>/pay/RP/tests/rp-backfill-db.test.ts:
// the MemberSubscription backfill statement exactly as the migration runs it, against crafted rows inside ONE
// transaction that is rolled back — now followed by the RP-3 cleanup migration's DELETE, exactly as
// production runs them (backfill, then cleanup), with the reviewer's three cases asserted:
//   B1 a TeamUp-billed member whose pointer names a subscription  -> NOT mapped (cleanup removes it);
//   B2 two members pointing at one subscription                    -> the earliest-joined is mapped, the other
//                                                                     is left unmapped and REPORTED by the
//                                                                     cleanup migration's counts;
//   B3 a member of a club with no account id (disconnected in-app) -> not mapped, and reported likewise.
// TEST branch only; both runners.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `rpbf${Date.now().toString(36)}`;

function statement(file: string, startsWith: string): string {
  const sql = readFileSync(path.join(process.cwd(), "prisma/migrations", file, "migration.sql"), "utf8");
  const start = sql.indexOf(startsWith);
  if (start < 0) throw new Error(`no ${startsWith} in ${file}`);
  return sql.slice(start, sql.indexOf(";", start));
}

describe.skipIf(!HAS_DB)("RP-3 - backfill then cleanup on crafted rows (rolled back)", () => {
  it("B1-B3: who keeps an adopted mapping, and what is reported", async () => {
    const backfill = statement("20261011190000_pay_pc_member_subscription_mapping", 'INSERT INTO "MemberSubscription"');
    const cleanup = statement("20261011220100_pay_pc_backfill_cleanup", 'DELETE FROM "MemberSubscription"');
    expect(backfill).toMatch(/ON CONFLICT \("stripeSubscriptionId"\) DO NOTHING$/);
    expect(cleanup).toMatch(/"billedBy" IS DISTINCT FROM 'matflow'$/);
    class Rollback extends Error {}
    let afterBackfill: unknown = null;
    let afterCleanup: Array<{ memberId: string; stripeSubscriptionId: string; source: string }> = [];
    let reported: { unmapped: number; shared: number } | null = null;
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: `${STAMP}-t`, name: STAMP, slug: `${STAMP}-t`, stripeAccountId: `acct_${STAMP}`, stripeConnected: false } });
      await tx.tenant.create({ data: { id: `${STAMP}-n`, name: `${STAMP} n`, slug: `${STAMP}-n` } });
      const mk = (id: string, tenantId: string, data: Record<string, unknown>, joined: string) =>
        tx.member.create({ data: { id: `${STAMP}-${id}`, tenantId, name: id, email: `${STAMP}-${id}@example.test`, joinedAt: new Date(joined), ...data } });
      await mk("teamup", `${STAMP}-t`, { billedBy: "teamup", stripeSubscriptionId: `sub_${STAMP}_tu` }, "2026-01-01");
      await mk("q1", `${STAMP}-t`, { stripeSubscriptionId: `sub_${STAMP}_q` }, "2026-01-02");
      await mk("q2", `${STAMP}-t`, { stripeSubscriptionId: `sub_${STAMP}_q` }, "2026-01-03");
      await mk("noacct", `${STAMP}-n`, { stripeSubscriptionId: `sub_${STAMP}_n` }, "2026-01-04");
      const mine = () => tx.memberSubscription.findMany({
        where: { stripeSubscriptionId: { startsWith: `sub_${STAMP}` } },
        select: { memberId: true, stripeSubscriptionId: true, source: true },
        orderBy: { stripeSubscriptionId: "asc" },
      });
      await tx.$executeRawUnsafe(backfill);
      afterBackfill = await mine();
      await tx.$executeRawUnsafe(cleanup);
      afterCleanup = await mine();
      // The cleanup migration RAISEs these two counts as a NOTICE in the deploy log; the same queries,
      // scoped to the crafted rows, are what an operator sees.
      const rows = await tx.$queryRaw<Array<{ unmapped: bigint; shared: bigint }>>`
        SELECT
          (SELECT count(*) FROM "Member" m WHERE m."stripeSubscriptionId" LIKE ${`sub_${STAMP}%`}
             AND NOT EXISTS (SELECT 1 FROM "MemberSubscription" s WHERE s."stripeSubscriptionId" = m."stripeSubscriptionId" AND s."memberId" = m."id")) AS unmapped,
          (SELECT count(*) FROM (SELECT "stripeSubscriptionId" FROM "Member" WHERE "stripeSubscriptionId" LIKE ${`sub_${STAMP}%`}
             GROUP BY "stripeSubscriptionId" HAVING count(*) > 1) d) AS shared`;
      reported = { unmapped: Number(rows[0].unmapped), shared: Number(rows[0].shared) };
      throw new Rollback("undo");
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    process.stderr.write(`[rpbf] after backfill ${JSON.stringify(afterBackfill)} after cleanup ${JSON.stringify(afterCleanup)} reported ${JSON.stringify(reported)}\n`);

    // The committed backfill (left unedited: changing it would re-stamp its checksum) maps the TeamUp member…
    expect(afterBackfill).toEqual([
      { memberId: `${STAMP}-q1`, stripeSubscriptionId: `sub_${STAMP}_q`, source: "adopted" },
      { memberId: `${STAMP}-teamup`, stripeSubscriptionId: `sub_${STAMP}_tu`, source: "adopted" },
    ]);
    // …and the cleanup that runs after it removes that mapping (B1).
    expect(afterCleanup).toEqual([{ memberId: `${STAMP}-q1`, stripeSubscriptionId: `sub_${STAMP}_q`, source: "adopted" }]);
    // B2: one subscription shared by two members — the earliest-joined is mapped, the other is reported.
    // B3: the member of a club with no account id is not mapped, and is reported.
    // Unmapped pointers: teamup (after cleanup), q2 (duplicate) and noacct (no account) = 3; shared ids = 1.
    expect(reported).toEqual({ unmapped: 3, shared: 1 });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { id: { startsWith: STAMP } } }));
    expect(left).toBe(0);
  });
});
