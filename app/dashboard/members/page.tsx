import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import MembersList, { MemberRow } from "@/components/dashboard/MembersList";
import PrintCardsLink from "@/components/dashboard/PrintCardsLink";
import PromotionAlerts from "@/components/dashboard/PromotionAlerts";
import { shownPaymentStatus } from "@/lib/overdue";

// Lane 1 iter-1 P-01 [Critical] fix: hard cap on the SSR-rendered member
// list. Previous code was unbounded — at 5 000 members the route transferred
// ~5 MB per render and could OOM a 256 MB Vercel function. 500 is generous
// for the current tenant ceiling; the followup ([P-22, V-20]) is to add
// cursor-based pagination in MembersList so the cap can be a true page size.
//
// 3 Oct 2026: raised from 500. A first TeamUp import of one real club makes
// over 900 rows (~700 people, cancelled history included, plus ~219 guardian
// records), so 500 silently dropped everyone after roughly "L" — from the
// list, the search and every count, with nothing on screen to say so. The
// row select is narrow (no wide columns, one rank, one visit, one photo), so
// 1,500 stays far below the 5,000-row payload P-01 was about. When the cap is
// hit the page now says so (MembersList `truncatedAt`).
const MEMBERS_SSR_TAKE = 1500;

async function getMembers(tenantId: string): Promise<{ rows: MemberRow[]; truncated: boolean }> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.member.findMany({
      where: { tenantId },
      // Explicit select to skip the wide columns (passwordHash, sessionVersion,
      // totpSecret, medicalConditions, etc.) that this page never renders.
      // Cuts the row payload from Postgres -> Node by ~60-80% on this hot path.
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        membershipType: true,
        status: true,
        paymentStatus: true,
        nextDueAt: true,
        stripeSubscriptionId: true,
        waiverAccepted: true,
        accountType: true,
        dateOfBirth: true,
        parentMemberId: true,
        hasKidsHint: true,
        joinedAt: true,
        cancelledAt: true,
        billedBy: true,
        billingStatusAsOf: true,
        memberRanks: {
          select: {
            stripes: true,
            rankSystem: { select: { name: true, color: true, discipline: true } },
          },
          orderBy: { achievedAt: "desc" },
          take: 1,
        },
        attendances: {
          orderBy: { checkInTime: "desc" },
          take: 1,
          select: { checkInTime: true },
        },
        // Lane 1 iter-1 P-01 fix: include the profile picture so SSR matches
        // /api/members shape (avatars render without a client refetch flash).
        photos: {
          where: { kind: "profile" },
          select: { url: true },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
      take: MEMBERS_SSR_TAKE + 1, // +1 sentinel so we can detect truncation
    }),
  );

  const truncated = rows.length > MEMBERS_SSR_TAKE;
  const visible = truncated ? rows.slice(0, MEMBERS_SSR_TAKE) : rows;
  if (truncated) {
    console.warn(
      "[dashboard/members] SSR cap hit",
      { tenantId, cap: MEMBERS_SSR_TAKE },
    );
  }

  const now = new Date();
  const mapped: MemberRow[] = visible.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    membershipType: m.membershipType,
    status: m.status,
    paymentStatus: shownPaymentStatus(m, now),
    waiverAccepted: m.waiverAccepted,
    accountType: m.accountType ?? "adult",
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    parentMemberId: m.parentMemberId,
    hasKidsHint: m.hasKidsHint,
    joinedAt: m.joinedAt.toISOString(),
    cancelledAt: m.cancelledAt ? m.cancelledAt.toISOString() : null,
    billedBy: m.billedBy,
    billingStatusAsOf: m.billingStatusAsOf ? m.billingStatusAsOf.toISOString() : null,
    lastVisitAt: m.attendances[0]?.checkInTime.toISOString() ?? null,
    profilePictureUrl: m.photos[0]?.url ?? null,
    rank: m.memberRanks[0]
      ? {
          name: m.memberRanks[0].rankSystem.name,
          color: m.memberRanks[0].rankSystem.color,
          discipline: m.memberRanks[0].rankSystem.discipline,
          stripes: m.memberRanks[0].stripes,
        }
      : null,
  }));
  return { rows: mapped, truncated };
}

export default async function MembersPage() {
  const { session } = await requireStaff();

  // UI-RULES §7: unguarded on purpose. Catching here rendered "No members yet"
  // whenever the database was unreachable — a gym with 200 members told it has
  // none. The throw now reaches app/dashboard/error.tsx (retry + reference);
  // instrumentation.ts's onRequestError keeps the ops-log line the old catch
  // was added for.
  const { rows: members, truncated } = await getMembers(session!.user.tenantId);

  // Guardian links an import suggested and nobody has confirmed — counted
  // across the whole club for the header badge. Owner and manager only: the
  // roles that may confirm (POST /api/members/[id]/guardian). Unguarded like
  // the load above (UI-RULES §7): a failure reaches the segment error page
  // rather than reading as "nothing to review".
  const role = session!.user.role;
  const tenantId = session!.user.tenantId;
  const guardianReviewCount =
    role === "owner" || role === "manager"
      ? await withTenantContext(tenantId, (tx) =>
          tx.member.count({ where: { tenantId, parentMemberId: { not: null }, guardianConfirmedAt: null } }),
        )
      : null;

  return (
    <>
      {/* The way into /print/member-cards — see the component for why it is a
          client component and why it opens in a new tab. */}
      <PrintCardsLink />
      {/* Owner-only: the data behind this is `requireApiOwner`, so for a coach,
          manager or admin it can only ever 403. The component correctly renders
          an ErrorState rather than pretending nobody is due a promotion — which
          meant three of the four staff roles saw a permanent red "couldn't
          check who's ready to move" banner at the top of the Members page,
          with a retry button that could never clear it. A role check is the
          honest gate; an error state is not. */}
      {session!.user.role === "owner" && <PromotionAlerts />}
      <MembersList
        members={members}
        primaryColor={session!.user.primaryColor}
        role={session!.user.role}
        guardianReviewCount={guardianReviewCount}
        truncatedAt={truncated ? MEMBERS_SSR_TAKE : null}
      />
    </>
  );
}
