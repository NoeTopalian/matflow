import { NextResponse } from "next/server";
import { withRlsBypass } from "@/lib/prisma-tenant";

/**
 * Review mode (Total BJJ controlled launch, gate G2).
 *
 * A club's real data can be loaded and inspected by its owner while the old
 * platform (TeamUp) still collects the money. While `Tenant.reviewLockedAt` is
 * set, anything that could bill a member, invite members in bulk or destroy
 * data is refused on the server — a hidden button is not a control. Reads,
 * logins, waivers, check-ins and ordinary edits keep working, because looking
 * around and correcting data is the whole point of the review.
 *
 * The operator sets and clears the lock (app/api/admin/customers/[id]/review-lock).
 */

export type ReviewLockAction =
  | "subscription_start"
  | "card_charge"
  | "membership_migration"
  | "bulk_invite"
  | "erase"
  | "club_delete";

const REFUSAL: Record<ReviewLockAction, string> = {
  subscription_start: "Card and Direct Debit sign-ups are paused while this club is in review — your current platform is still collecting payments.",
  card_charge: "Card payments are paused while this club is in review — your current platform is still collecting payments.",
  membership_migration: "Memberships can't be moved to MatFlow billing while this club is in review.",
  bulk_invite: "Invitations to all members are paused while this club is in review.",
  erase: "Erasing a member is paused while this club is in review. Contact MatFlow if this is urgent.",
  club_delete: "This club is in review and can't be deleted until the review ends.",
};

export type ReviewState = { lockedAt: Date; snapshotAt: Date | null; note: string | null };

export async function getReviewState(tenantId: string): Promise<ReviewState | null> {
  const t = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { reviewLockedAt: true, reviewSnapshotAt: true, reviewNote: true },
    }),
  );
  if (!t?.reviewLockedAt) return null;
  return { lockedAt: t.reviewLockedAt, snapshotAt: t.reviewSnapshotAt, note: t.reviewNote };
}

/**
 * Returns a 423 response when the club is in review, otherwise null.
 * Call it after authentication and before any side effect.
 */
export async function refuseIfReviewLocked(
  tenantId: string,
  action: ReviewLockAction,
): Promise<NextResponse | null> {
  const state = await getReviewState(tenantId);
  if (!state) return null;
  return NextResponse.json(
    { error: REFUSAL[action], reason: "review_locked" },
    { status: 423 },
  );
}
