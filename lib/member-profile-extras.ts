import { withTenantContext } from "@/lib/prisma-tenant";

export type RosterMembership = { id: string; classId: string; addedAt: Date; class: { id: string; name: string } };

export type MemberProfileExtras = {
  /** null when the read failed: never treat that as "2FA off". */
  totpRow: { totpEnabled: boolean } | null;
  rosterMemberships: RosterMembership[];
  /** True when the read failed, so the page can say so instead of showing "none". */
  extrasUnavailable: boolean;
};

/**
 * The staff member profile's two optional extras: whether the member has 2FA
 * (for the Reset 2FA card) and their comp-class roster places. One tenant
 * transaction, both reads in parallel (audit A8I3-P-H-2).
 *
 * Round 2 (10 Nov 2026): a failure used to come back as "no 2FA" and "no
 * roster", which hid both sections as if they did not apply. It now comes back
 * as `extrasUnavailable`, with nothing that could enable an action: the reset
 * card needs a confirmed `totpEnabled`, and `totpRow` is null here.
 */
export async function loadMemberProfileExtras(tenantId: string, memberId: string): Promise<MemberProfileExtras> {
  try {
    return await withTenantContext(tenantId, async (tx) => {
      const [totpRow, rosterMemberships] = await Promise.all([
        tx.member.findFirst({
          where: { id: memberId, tenantId },
          select: { totpEnabled: true },
        }),
        tx.classRoster.findMany({
          where: { memberId, tenantId },
          select: { id: true, classId: true, addedAt: true, class: { select: { id: true, name: true } } },
          orderBy: { addedAt: "desc" },
        }),
      ]);
      return { totpRow, rosterMemberships, extrasUnavailable: false };
    });
  } catch {
    return { totpRow: null, rosterMemberships: [], extrasUnavailable: true };
  }
}
