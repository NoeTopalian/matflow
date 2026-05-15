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

// F5 parent-deletion gateway (see plans/.../majestic-bubbling-gosling.md and
// docs/KIDS-PARENT-LINKAGE-ASSESSMENT-2026-05-15.md). When the Member being
// deleted has one or more linked kids, the caller MUST pick a strategy:
//
//   - reassign — kids point at a different parent (same tenant, not a kid
//     themselves). Atomic update before the parent row is dropped.
//   - cascade  — every kid runs through deleteMemberCascade alongside the
//     parent. The parent is deleted last. One audit log row per kid.
//   - orphan   — kids stay in the tenant but lose their parent link. To keep
//     invariant I1 (`accountType='kids' ⇒ parentMemberId IS NOT NULL`)
//     intact, each kid's accountType is forced to 'junior' first. A flag
//     surfaces them in the dashboard as "needs new guardian".
//
// A first-pass call with strategy=undefined is the discovery shape: returns
// `kids-present` so the UI can show the three-option picker without spending
// a transaction.
export type ParentDeletionStrategy =
  | { kind: "reassign"; toParentMemberId: string }
  | { kind: "cascade" }
  | { kind: "orphan" }
  | undefined;

export type ParentDeletionOutcome =
  | { kind: "ok"; name: string; kidsAffected: number }
  | { kind: "not-found" }
  | { kind: "race" }
  | { kind: "kids-present"; kids: Array<{ id: string; name: string }> }
  | { kind: "invalid-reassign"; reason: string };

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

// Parent-aware deletion. Use this from any route that deletes a Member that
// might be a parent (every staff-side delete path; not needed on the parent
// self-serve kid-delete since kids cannot themselves be parents — no nesting).
//
// First call (strategy=undefined): probes whether kids exist. Returns
// `kids-present` if yes — the caller surfaces the picker UI. Otherwise falls
// through to the standard cascade.
//
// Subsequent call (strategy supplied): applies the chosen branch inside the
// same transaction, then runs deleteMemberCascade on the parent row.
export async function deleteParentMemberWithKidsResolution(
  tx: Prisma.TransactionClient,
  where: Prisma.MemberWhereInput & { id: string; tenantId: string },
  strategy: ParentDeletionStrategy,
): Promise<ParentDeletionOutcome> {
  const member = await tx.member.findFirst({
    where,
    select: { id: true, name: true },
  });
  if (!member) return { kind: "not-found" };

  const kids = await tx.member.findMany({
    where: { parentMemberId: member.id, tenantId: where.tenantId },
    select: { id: true, name: true, accountType: true },
    orderBy: { name: "asc" },
  });

  // No kids — standard cascade, nothing to disambiguate.
  if (kids.length === 0) {
    const result = await deleteMemberCascade(tx, where);
    if (result.kind === "ok") return { kind: "ok", name: result.name, kidsAffected: 0 };
    return result; // not-found | race
  }

  // Kids exist but caller hasn't picked a strategy. Surface the picker.
  if (!strategy) {
    return {
      kind: "kids-present",
      kids: kids.map((k) => ({ id: k.id, name: k.name })),
    };
  }

  if (strategy.kind === "reassign") {
    // Validate the target parent: same tenant, not the member being deleted,
    // not itself a kid (parentMemberId must be null).
    if (strategy.toParentMemberId === member.id) {
      return { kind: "invalid-reassign", reason: "Cannot reassign kids to the member being deleted" };
    }
    const target = await tx.member.findFirst({
      where: { id: strategy.toParentMemberId, tenantId: where.tenantId },
      select: { id: true, parentMemberId: true, accountType: true },
    });
    if (!target) {
      return { kind: "invalid-reassign", reason: "Target parent not found in this tenant" };
    }
    if (target.parentMemberId !== null) {
      return { kind: "invalid-reassign", reason: "Target is itself a sub-account — pick a top-level Member" };
    }
    if (target.accountType === "kids") {
      return { kind: "invalid-reassign", reason: "Target must be an adult or parent, not a kid" };
    }

    await tx.member.updateMany({
      where: { parentMemberId: member.id, tenantId: where.tenantId },
      data: { parentMemberId: target.id },
    });

    const result = await deleteMemberCascade(tx, where);
    if (result.kind === "ok") return { kind: "ok", name: result.name, kidsAffected: kids.length };
    return result;
  }

  if (strategy.kind === "cascade") {
    // Delete each kid through the same cascade walk so all FK-RESTRICT
    // dependents (ranks, attendance, photos, etc.) are handled identically
    // to a stand-alone kid deletion.
    for (const kid of kids) {
      const result = await deleteMemberCascade(tx, {
        id: kid.id,
        tenantId: where.tenantId,
      });
      if (result.kind === "race") return { kind: "race" };
      // not-found is fine — the kid may have been deleted by another caller
      // mid-transaction. Keep going.
    }

    const result = await deleteMemberCascade(tx, where);
    if (result.kind === "ok") return { kind: "ok", name: result.name, kidsAffected: kids.length };
    return result;
  }

  // orphan: flip each kid's accountType to 'junior' (preserves CHECK
  // constraint Member_kids_must_have_parent once parentMemberId becomes null
  // via onDelete: SetNull when the parent row drops below).
  // The kids stay in the tenant; staff surface them as "needs new guardian".
  await tx.member.updateMany({
    where: { parentMemberId: member.id, tenantId: where.tenantId, accountType: "kids" },
    data: { accountType: "junior" },
  });

  const result = await deleteMemberCascade(tx, where);
  if (result.kind === "ok") return { kind: "ok", name: result.name, kidsAffected: kids.length };
  return result;
}
