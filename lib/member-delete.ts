/**
 * Cascade-safe Member deletion.
 *
 * Almost every Member-referencing FK in the schema is `ON DELETE RESTRICT`
 * (migration 20260424205716_init: AttendanceRecord, MemberRank, RankHistory,
 * ClassSubscription, ClassWaitlist; 20260427112350: MemberClassPack +
 * ClassPackRedemption). A naive `Member.delete` fails with P2003 the moment
 * the row has any history.
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
 *  - SignedWaiver: ON DELETE SET NULL (migration
 *    20260816090000_signed_waiver_retention_on_member_delete) — RETAINED,
 *    DETACHED, under legal hold. Waivers are the club's liability defence
 *    and the privacy policy promises 6-year post-departure retention, so
 *    they must outlive the Member row. Postgres nulls `memberId` and leaves
 *    signerName, titleSnapshot, contentSnapshot, signatureImageUrl,
 *    ipAddress and acceptedAt intact. This helper deliberately does NOT
 *    delete them — the old `signedWaiver.deleteMany` here destroyed the
 *    evidence on every hard delete (audit P0-2). If a waiver genuinely must
 *    go (GDPR Article 17 with no live liability interest), erase it
 *    explicitly through the DSAR path, not as a side effect of a delete.
 *
 * Explicitly cleaned (defence-in-depth):
 *  - LoginEvent: schema declares ON DELETE CASCADE, but migration
 *    20260504000000_login_events shipped without the FK statements
 *    (drift, fixed in 20260513000002). The explicit deleteMany below
 *    keeps the helper correct regardless of whether the FK fix has
 *    been applied to a given environment.
 *  - ImportedBooking + ImportSourceMapping (kind=person): imported history
 *    and the owner's person mapping. The booking FK is ON DELETE SET NULL,
 *    which would orphan the source name and email rather than remove them.
 *    (ImportedMembership is ON DELETE CASCADE and needs nothing here.)
 *
 * Pass a `where` predicate that includes BOTH `id` and `tenantId` (and
 * optionally `parentMemberId`) — we use it both for the existence check at
 * the top and the final `member.deleteMany` to guard against TOCTOU races.
 */

/**
 * ARCHIVE, NOT DELETE (6 Nov 2026, PR 3; Noe: "Save all past user data").
 * Staff "Remove member" and a parent removing their own child now ARCHIVE:
 * `archiveMember` / `archiveParentMemberWithKidsResolution` below stamp
 * `archivedAt` and delete nothing, so attendance, status events, imported plan
 * history, sign-in records, photos and roster places all stay, and Restore
 * brings the member back exactly as they were. `deleteMemberCascade` remains
 * ONLY for the two true deletes: a formal erasure request (DSAR, owner-only,
 * Settings → Data requests) and the operator's tenant purge.
 */


import type { Prisma } from "@prisma/client";
import { scrubImportConflictsFor } from "@/lib/importers/import-conflicts-scrub";
import { ERASED_EMAIL } from "@/lib/login-email";

export type DeleteMemberCascadeOutcome =
  | { kind: "ok"; name: string }
  | { kind: "not-found" }
  | { kind: "race" };

// F5 parent gateway (see plans/.../majestic-bubbling-gosling.md and
// docs/KIDS-PARENT-LINKAGE-ASSESSMENT-2026-05-15.md), now for ARCHIVING. When
// the Member being archived has one or more linked kids, the caller MUST pick
// a strategy, so an archived parent never silently archives or orphans a
// child:
//
//   - reassign — kids point at a different parent (same tenant, not a kid
//     themselves, not archived). Atomic update before the parent is archived.
//   - cascade  — every kid is archived alongside the parent, with the SAME
//     archivedAt instant, so restoring the parent restores exactly those kids.
//   - orphan   — kids stay current but lose their parent link. To keep
//     invariant I1 (`accountType='kids' ⇒ parentMemberId IS NOT NULL`) intact,
//     each kid's accountType is forced to 'junior' first. (Deletion used to
//     null the link through ON DELETE SET NULL; archiving keeps the parent row,
//     so the link is cleared explicitly.)
//
// A first-pass call with strategy=undefined is the discovery shape: returns
// `kids-present` so the UI can show the three-option picker. Kids already
// archived on their own are not "present": nothing happens to them.
export type ParentDeletionStrategy =
  | { kind: "reassign"; toParentMemberId: string }
  | { kind: "cascade" }
  | { kind: "orphan" }
  | undefined;

export type ParentDeletionOutcome =
  | { kind: "ok"; name: string; kidsAffected: number; kidIds: string[] }
  | { kind: "not-found" }
  | { kind: "race" }
  | { kind: "kids-present"; kids: Array<{ id: string; name: string }> }
  | { kind: "invalid-reassign"; reason: string };

export type ArchiveMemberOutcome = { kind: "ok"; name: string } | { kind: "not-found" } | { kind: "race" };

/**
 * Archive one member: stamp archivedAt (and who), bump sessionVersion so every
 * live member-app session ends at its next request. Deletes nothing. `where`
 * must carry `id` and `tenantId`; an already-archived member is not-found.
 */
export async function archiveMember(
  tx: Prisma.TransactionClient,
  where: Prisma.MemberWhereInput & { id: string; tenantId: string },
  by: { userId: string | null; at: Date },
): Promise<ArchiveMemberOutcome> {
  const member = await tx.member.findFirst({ where: { ...where, archivedAt: null }, select: { id: true, name: true } });
  if (!member) return { kind: "not-found" };
  // Same lock order as the check-in engine (Class, then Member): a check-in in
  // flight finishes first, or waits and then finds the member archived.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Member" WHERE "id" = ${member.id} AND "tenantId" = ${where.tenantId} AND "archivedAt" IS NULL FOR UPDATE
  `;
  if (locked.length === 0) return { kind: "race" };
  const done = await tx.member.updateMany({
    where: { ...where, archivedAt: null },
    data: { archivedAt: by.at, archivedById: by.userId, sessionVersion: { increment: 1 } },
  });
  if (done.count === 0) return { kind: "race" };
  return { kind: "ok", name: member.name };
}

export type RestoreMemberOutcome =
  | { kind: "ok"; name: string; restoredKidIds: string[]; subscriptionEnding: boolean; parentErased?: boolean }
  | { kind: "not-found" }
  | { kind: "race" }
  /** Already current (a second Restore): nothing to do, not an error. */
  | { kind: "already-current"; name: string }
  /** Erased on a formal request: nothing personal is left to bring back. */
  | { kind: "erased" }
  /** A child whose guardian is still archived: restore the guardian first (or link the child elsewhere). */
  | { kind: "parent-archived"; parentName: string };

/**
 * Restore an archived member: clear archivedAt and archivedById. Kids archived
 * WITH this parent (same parent, same archivedAt instant: the cascade
 * strategy) come back with them; a kid archived on its own stays archived.
 */
export async function restoreMember(
  tx: Prisma.TransactionClient,
  where: { id: string; tenantId: string },
): Promise<RestoreMemberOutcome> {
  const member = await tx.member.findFirst({
    where,
    select: { id: true, name: true, email: true, archivedAt: true, parentMemberId: true },
  });
  if (!member) return { kind: "not-found" };
  // Idempotent: a second Restore (a double click, a retry after a lost
  // response) finds the member already current and changes nothing.
  if (!member.archivedAt) return { kind: "already-current", name: member.name };
  if (ERASED_EMAIL.test(member.email)) return { kind: "erased" };
  // Lock order (review, 6 Nov 2026): the same rows the archive route locks —
  // the member, its children and, for a child, its parent — in ONE statement,
  // FOR UPDATE, in id order, exactly as DELETE /api/members/[id] does. Two
  // writers taking overlapping rows in the same order cannot deadlock.
  const locked = await tx.$queryRaw<{ id: string; name: string; email: string; archivedAt: Date | null }[]>`
    SELECT "id", "name", "email", "archivedAt" FROM "Member"
    WHERE "tenantId" = ${where.tenantId}
      AND ("id" = ${member.id} OR "parentMemberId" = ${member.id} OR "id" = ${member.parentMemberId ?? member.id})
    ORDER BY "id"
    FOR UPDATE
  `;
  let parentErased = false;
  if (member.parentMemberId) {
    const parent = locked.find((r) => r.id === member.parentMemberId);
    // An ERASED parent does not block the restore: the child comes back still
    // linked to the scrubbed parent row (the link is not changed here), and
    // staff are told to re-link it to another parent if it needs one.
    if (parent && ERASED_EMAIL.test(parent.email)) parentErased = true;
    else if (parent?.archivedAt) return { kind: "parent-archived", parentName: parent.name };
  }
  const at = new Date(member.archivedAt.getTime());
  const done = await tx.member.updateMany({
    where: { ...where, archivedAt: at },
    data: { archivedAt: null, archivedById: null },
  });
  if (done.count === 0) return { kind: "race" };
  // Kids archived WITH this parent come back, never one erased since.
  const notErased = { NOT: { AND: [{ email: { startsWith: "deleted-" } }, { email: { endsWith: "@deleted.invalid" } }] } };
  const kids = await tx.member.findMany({
    where: { tenantId: where.tenantId, parentMemberId: member.id, archivedAt: at, ...notErased },
    select: { id: true },
  });
  if (kids.length > 0) {
    await tx.member.updateMany({
      where: { tenantId: where.tenantId, id: { in: kids.map((k) => k.id) }, archivedAt: at },
      data: { archivedAt: null, archivedById: null },
    });
  }
  // Billing: did the removal set a card subscription to end, for this member
  // or a child coming back with them? The archive's audit row says: the
  // parent route records the ids it cancelled (stripeCancelledMemberIds), the
  // child route its own count. A child archived WITH a parent is found in the
  // parent's row. Restoring does not restart billing.
  const comingBack = new Set([member.id, ...kids.map((k) => k.id)]);
  const ownRow = await tx.auditLog.findFirst({
    where: { tenantId: where.tenantId, entityId: member.id, action: { in: ["member.archive", "member.child.archive"] } },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const viaParent = member.parentMemberId
    ? await tx.auditLog.findFirst({
        where: { tenantId: where.tenantId, entityId: member.parentMemberId, action: "member.archive", createdAt: { gte: new Date(at.getTime() - 60_000) } },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      })
    : null;
  const ending = (row: { metadata: unknown } | null) => {
    const m = (row?.metadata ?? null) as { stripeCancelledMemberIds?: unknown; stripeSubscriptionsCancelled?: unknown } | null;
    if (!m) return false;
    if (Array.isArray(m.stripeCancelledMemberIds)) return m.stripeCancelledMemberIds.some((id) => typeof id === "string" && comingBack.has(id));
    return Number(m.stripeSubscriptionsCancelled ?? 0) > 0;
  };
  return {
    kind: "ok",
    name: member.name,
    restoredKidIds: kids.map((k) => k.id),
    subscriptionEnding: ending(ownRow) || ending(viaParent),
    ...(parentErased ? { parentErased: true } : {}),
  };
}

export async function deleteMemberCascade(
  tx: Prisma.TransactionClient,
  where: Prisma.MemberWhereInput & { id: string; tenantId: string },
): Promise<DeleteMemberCascadeOutcome> {
  const member = await tx.member.findFirst({
    where,
    select: { id: true, name: true, externalRef: true },
  });
  if (!member) return { kind: "not-found" };

  const memberId = member.id;

  // T7 lock order: the Member row FIRST, before any of its packs, attendance
  // or bookings. The check-in engine holds Class, then this Member row, then
  // the member's pack (lib/checkin.ts). Without this lock a cascade that
  // reached the pack first (the DSAR child cascade and the tenant purge call
  // this with no prior lock on the member) would hold the pack while waiting
  // to delete a Member row a check-in holds, while that check-in waits for the
  // pack: a deadlock (planning evidence §8b.3 C1). With it, the cascade
  // simply waits for the check-in to commit, or the check-in waits and then
  // finds no member. Callers that already hold the lock re-take it for free.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Member" WHERE "id" = ${memberId} AND "tenantId" = ${where.tenantId} FOR UPDATE
  `;
  if (locked.length === 0) return { kind: "race" };

  // Imported history. ImportedBooking.memberId is ON DELETE SET NULL, which
  // would leave the row behind with the source's name and email on it — the
  // person's data, now attached to nobody. Delete it explicitly, and with it
  // the owner's person mapping (its sourceKey embeds the same email and name).
  await tx.importedBooking.deleteMany({ where: { tenantId: where.tenantId, memberId } });
  await tx.importSourceMapping.deleteMany({
    where: {
      tenantId: where.tenantId,
      kind: "person",
      OR: [{ targetId: memberId }, ...(member.externalRef ? [{ sourceKey: member.externalRef }] : [])],
    },
  });

  // The people an import listed for review keep no trace of this member (25 Oct 2026).
  await scrubImportConflictsFor(tx, where.tenantId, memberId, member.externalRef);

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

  // NOTE: SignedWaiver is deliberately absent. The FK is ON DELETE SET NULL,
  // so Postgres detaches the waivers when the Member row drops and the
  // liability evidence survives. See the header comment.

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

// Parent-aware ARCHIVE. Use this from any route that removes a Member that
// might be a parent (every staff-side remove path; not needed on the parent
// self-serve kid removal since kids cannot themselves be parents).
//
// First call (strategy=undefined): probes whether current kids exist. Returns
// `kids-present` if yes — the caller surfaces the picker UI. Otherwise
// archives the member alone.
//
// Subsequent call (strategy supplied): applies the chosen branch inside the
// same transaction, then archives the parent.
export async function archiveParentMemberWithKidsResolution(
  tx: Prisma.TransactionClient,
  where: Prisma.MemberWhereInput & { id: string; tenantId: string },
  strategy: ParentDeletionStrategy,
  by: { userId: string | null; at: Date },
): Promise<ParentDeletionOutcome> {
  const member = await tx.member.findFirst({
    where: { ...where, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!member) return { kind: "not-found" };

  const kids = await tx.member.findMany({
    where: { parentMemberId: member.id, tenantId: where.tenantId, archivedAt: null },
    select: { id: true, name: true, accountType: true },
    orderBy: { name: "asc" },
  });

  const archiveParent = async (kidIds: string[]): Promise<ParentDeletionOutcome> => {
    const result = await archiveMember(tx, where, by);
    if (result.kind === "ok") return { kind: "ok", name: result.name, kidsAffected: kidIds.length, kidIds };
    return result;
  };

  // No current kids — archive the member, nothing to disambiguate.
  if (kids.length === 0) return archiveParent([]);

  // Kids exist but caller hasn't picked a strategy. Surface the picker.
  if (!strategy) {
    return {
      kind: "kids-present",
      kids: kids.map((k) => ({ id: k.id, name: k.name })),
    };
  }
  const kidIds = kids.map((k) => k.id);

  if (strategy.kind === "reassign") {
    // Validate the target parent: same tenant, not the member being archived,
    // not itself a kid (parentMemberId must be null), not archived.
    if (strategy.toParentMemberId === member.id) {
      return { kind: "invalid-reassign", reason: "Cannot reassign kids to the member being removed" };
    }
    // Locked, so the target cannot be archived between this check and the move.
    const lockedTarget = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Member" WHERE "id" = ${strategy.toParentMemberId} AND "tenantId" = ${where.tenantId} AND "archivedAt" IS NULL FOR UPDATE
    `;
    const target = lockedTarget.length === 0 ? null : await tx.member.findFirst({
      where: { id: strategy.toParentMemberId, tenantId: where.tenantId, archivedAt: null },
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
      where: { parentMemberId: member.id, tenantId: where.tenantId, archivedAt: null },
      data: { parentMemberId: target.id },
    });
    return archiveParent(kidIds);
  }

  if (strategy.kind === "cascade") {
    // Each kid is archived with the parent's instant, so Restore on the parent
    // brings back exactly these kids (restoreMember).
    for (const kid of kids) {
      const result = await archiveMember(tx, { id: kid.id, tenantId: where.tenantId, parentMemberId: member.id }, by);
      if (result.kind === "race") return { kind: "race" };
      // not-found is fine — the kid may have been archived by another caller.
    }
    return archiveParent(kidIds);
  }

  // orphan: flip each kid's accountType to 'junior' (keeps CHECK constraint
  // Member_kids_must_have_parent), then clear the link explicitly. The kids
  // stay current; staff surface them as "needs new guardian".
  await tx.member.updateMany({
    where: { parentMemberId: member.id, tenantId: where.tenantId, archivedAt: null, accountType: "kids" },
    data: { accountType: "junior" },
  });
  await tx.member.updateMany({
    where: { parentMemberId: member.id, tenantId: where.tenantId, archivedAt: null },
    data: { parentMemberId: null },
  });
  return archiveParent(kidIds);
}
