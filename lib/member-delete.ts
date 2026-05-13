/**
 * Cascade-safe Member deletion.
 *
 * Almost every Member-referencing FK in the schema is `ON DELETE RESTRICT`
 * (migration 20260424205716_init: AttendanceRecord, MemberRank, RankHistory,
 * ClassSubscription, ClassWaitlist; 20260426162644: SignedWaiver;
 * 20260427112350: MemberClassPack + ClassPackRedemption). A naive
 * `Member.delete` fails with P2003 the moment the row has any history.
 *
 * This helper walks every dependent table in dependency order inside the
 * caller's transaction, then drops the Member row. Used by both the
 * staff-side delete (`/api/members/[id]`) and the parent-side child delete
 * (`/api/member/children/[id]`) so they cannot drift.
 *
 * Auto-handled (caller does NOT need to touch):
 *  - ClassRoster: ON DELETE CASCADE (migration 20260509115719) — drops
 *    automatically when the Member row goes.
 *  - MemberPhoto: ON DELETE CASCADE (migration 20260513000001) — kid
 *    evidence + milestone uploads dropped automatically.
 *  - Payment / Order / Notification: ON DELETE SET NULL — preserved
 *    with memberId=null for audit / accounting.
 *  - Parent.children (Member.parentMemberId): ON DELETE SET NULL — kids of
 *    a deleted parent become orphaned and visible to gym staff for re-link.
 *
 * Explicitly cleaned (defence-in-depth):
 *  - LoginEvent: schema declares ON DELETE CASCADE, but migration
 *    20260504000000_login_events shipped without the FK statements
 *    (drift, fixed in 20260513000002). The explicit deleteMany below
 *    keeps the helper correct regardless of whether the FK fix has
 *    been applied to a given environment.
 *
 * Pass a `where` predicate that includes BOTH `id` and `tenantId` (and
 * optionally `parentMemberId`) — we use it both for the existence check at
 * the top and the final `member.deleteMany` to guard against TOCTOU races.
 */

import type { Prisma } from "@prisma/client";

export type DeleteMemberCascadeOutcome =
  | { kind: "ok"; name: string }
  | { kind: "not-found" }
  | { kind: "race" };

export async function deleteMemberCascade(
  tx: Prisma.TransactionClient,
  where: Prisma.MemberWhereInput & { id: string; tenantId: string },
): Promise<DeleteMemberCascadeOutcome> {
  const member = await tx.member.findFirst({
    where,
    select: { id: true, name: true },
  });
  if (!member) return { kind: "not-found" };

  const memberId = member.id;

  // Order matters: every table below RESTRICTs Member deletion until empty.
  // RankHistory references MemberRank, so wipe that first.
  const ranks = await tx.memberRank.findMany({
    where: { memberId },
    select: { id: true },
  });
  if (ranks.length > 0) {
    await tx.rankHistory.deleteMany({
      where: { memberRankId: { in: ranks.map((r) => r.id) } },
    });
  }
  await tx.memberRank.deleteMany({ where: { memberId } });

  // ClassPackRedemption references MemberClassPack — same drill.
  const packs = await tx.memberClassPack.findMany({
    where: { memberId },
    select: { id: true },
  });
  if (packs.length > 0) {
    await tx.classPackRedemption.deleteMany({
      where: { memberPackId: { in: packs.map((p) => p.id) } },
    });
  }
  await tx.memberClassPack.deleteMany({ where: { memberId } });

  await tx.attendanceRecord.deleteMany({ where: { memberId } });
  await tx.classSubscription.deleteMany({ where: { memberId } });
  await tx.classWaitlist.deleteMany({ where: { memberId } });
  await tx.signedWaiver.deleteMany({ where: { memberId } });

  // LoginEvent: defence-in-depth against the FK migration drift (see header
  // comment). When the FK is present and ON DELETE CASCADE, this deleteMany
  // is a no-op (rows are already gone by the time the final member.deleteMany
  // runs). When the FK is missing, this is the only thing stopping orphans.
  await tx.loginEvent.deleteMany({ where: { memberId } });

  // Final deletion uses the original `where` predicate so a concurrent
  // mutation that changed the row no longer matches and returns count=0.
  const deleted = await tx.member.deleteMany({ where });
  if (deleted.count === 0) return { kind: "race" };
  return { kind: "ok", name: member.name };
}
