/**
 * The Members page totals, counted on the server over the club's FULL member
 * population (review L5): one `member.count` per total, every where from
 * lib/member-list-counts.ts (shared population fragments, explicit tenantId),
 * all inside one tenant-scoped transaction. Independent of the 1,500-row
 * display cap on the list.
 */
import { withTenantContext } from "@/lib/prisma-tenant";
import type { ClubMonthWindow } from "@/lib/club-month";
import { MEMBER_LIST_COUNT_KEYS, memberListCountWheres, type MemberListCounts } from "@/lib/member-list-counts";

export async function getMemberListCounts(
  tenantId: string,
  now: Date,
  month: Pick<ClubMonthWindow, "monthStart" | "nextMonthStart">,
): Promise<MemberListCounts> {
  const wheres = memberListCountWheres(tenantId, now, month);
  const values = await withTenantContext(
    tenantId,
    (tx) => Promise.all(MEMBER_LIST_COUNT_KEYS.map((key) => tx.member.count({ where: wheres[key] }))),
    // Seventeen counts in one transaction, two of them with an attendance
    // subquery: the same budget lib/reports.ts gives its aggregate block.
    { maxWait: 10_000, timeout: 30_000 },
  );
  return Object.fromEntries(MEMBER_LIST_COUNT_KEYS.map((key, i) => [key, values[i]])) as MemberListCounts;
}
