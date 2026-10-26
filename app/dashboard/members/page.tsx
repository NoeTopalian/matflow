import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import MembersList, { MemberRow, type MonthWindowProp } from "@/components/dashboard/MembersList";
import { clubMonthWindow, clubMonthWindowForKey } from "@/lib/club-month";
import { rangeAsMonthWindow, resolveReportPeriod } from "@/lib/report-period";
import { getMemberListCounts } from "@/lib/member-list-counts-server";
import PrintCardsLink from "@/components/dashboard/PrintCardsLink";
import PromotionAlerts from "@/components/dashboard/PromotionAlerts";
import { PAYMENT_EVIDENCE_LABEL, latestSettledPayment, paymentEvidence, paymentEvidenceSentence, shownPaymentStatus } from "@/lib/overdue";
import { isConfirmedDebt, loadOtherAccountsOwing, otherOwingTotals } from "@/lib/other-accounts-owing";
import { loadMonthMovement } from "@/lib/membership-report";
import type { MovementBucket } from "@/lib/membership-movement";

// Lane 1 iter-1 P-01 [Critical] fix: hard cap on the SSR-rendered member
// list. Previous code was unbounded — at 5 000 members the route transferred
// ~5 MB per render and could OOM a 256 MB Vercel function. 500 is generous
// for the current tenant ceiling; the followup ([P-22, V-20]) is to add
// cursor-based pagination in MembersList so the cap can be a true page size.
//
// 3 Oct 2026: raised from 500. A first TeamUp import of one real club makes
// many hundreds of rows (people, cancelled history included, plus guardian
// records), so 500 silently dropped everyone after roughly "L" — from the
// list, the search and every count, with nothing on screen to say so. The
// row select is narrow (no wide columns, one rank, one visit, one photo), so
// 1,500 stays far below the 5,000-row payload P-01 was about. When the cap is
// hit the page now says so (MembersList `truncatedAt`).
//
// 23 Oct 2026 (review L5): the cap now limits the TABLE only. Every total on
// the page (headline, tiles, chips) is counted on the server over the whole
// population (getMemberListCounts), so a club past the cap is never told it
// has fewer members than Reports says.
const MEMBERS_SSR_TAKE = 1500;

async function getMembers(tenantId: string, now: Date, timeZone: string): Promise<{ rows: MemberRow[]; truncated: boolean }> {
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
        // Tells "No payment yet" from overdue (lib/overdue shownPaymentStatus, review L2).
        membershipTierId: true,
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
        // D10: the latest settled payment tells "payment failed" from "never
        // paid" and "outstanding" on the Payment badge (lib/overdue paymentEvidence).
        payments: {
          where: { tenantId, status: { in: ["succeeded", "failed"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true, createdAt: true },
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

  const mapped: MemberRow[] = visible.map((m) => {
    const evidence = paymentEvidence(m, now, latestSettledPayment(m.payments));
    return {
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    membershipType: m.membershipType,
    status: m.status,
    paymentStatus: shownPaymentStatus(m, now),
    paymentEvidence: evidence
      ? { kind: evidence.kind, label: PAYMENT_EVIDENCE_LABEL[evidence.kind], sentence: paymentEvidenceSentence(evidence, timeZone) }
      : null,
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
    };
  });
  return { rows: mapped, truncated };
}

/**
 * The month the two Reports drill-through slices list (review L4): resolved
 * here, on the server, in the club's zone — the `month` a Reports link
 * carries when it is well formed, otherwise the club's current month. The
 * client compares instants against these boundaries and never recomputes the
 * month in the browser's zone.
 */
async function getMonthWindow(tenantId: string, monthParam: string | undefined, fromParam?: string, toParam?: string): Promise<MonthWindowProp> {
  const club = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
  );
  const current = clubMonthWindow(new Date(), club?.timezone);
  // A Reports period of several months (lib/report-period) links with from/to:
  // the slice lists the whole run, start of `from` to the end of `to`, with
  // the same validation as Reports (whole months, ending no later than this
  // month, at most 24). A run of one month is that month.
  if (fromParam && toParam) {
    const run = resolveReportPeriod({ period: "custom", from: fromParam, to: toParam }, new Date(), club?.timezone);
    if (run.key === "custom") return rangeAsMonthWindow(run);
  }
  const requested = clubMonthWindowForKey(monthParam, club?.timezone);
  const window = requested ?? current;
  return { ...window, isCurrent: window.monthKey === current.monthKey };
}

interface Props {
  searchParams: Promise<{ month?: string | string[]; from?: string | string[]; to?: string | string[] }>;
}

export default async function MembersPage({ searchParams }: Props) {
  const { session } = await requireStaff();
  const { month, from, to } = await searchParams;

  // UI-RULES §7: unguarded on purpose. Catching here rendered "No members yet"
  // whenever the database was unreachable — a gym with 200 members told it has
  // none. The throw now reaches app/dashboard/error.tsx (retry + reference);
  // instrumentation.ts's onRequestError keeps the ops-log line the old catch
  // was added for.
  // One instant for the rows' shown payment status and the server counts, so
  // a member cannot be "overdue" in the table and "paid" in a total.
  const now = new Date();
  const monthWindow = await getMonthWindow(
    session!.user.tenantId,
    typeof month === "string" ? month : undefined,
    typeof from === "string" ? from : undefined,
    typeof to === "string" ? to : undefined,
  );
  const { rows: members, truncated } = await getMembers(session!.user.tenantId, now, monthWindow.timeZone);
  const counts = await getMemberListCounts(session!.user.tenantId, now, monthWindow);
  // D9 (23 Oct 2026): inactive or cancelled accounts with a confirmed debt,
  // and (owner instruction of 24 Oct 2026) those whose last charge failed with
  // nothing confirming a debt, apart. Counted over the whole club (not the
  // capped rows) for the payers sub-lines and the two chips; the flags let each
  // chip list exactly its accounts. Unguarded like the loads above (UI-RULES §7).
  const otherOwingRows = await withTenantContext(session!.user.tenantId, (tx) => loadOtherAccountsOwing(tx, session!.user.tenantId));
  const otherOwingIds = new Set(otherOwingRows.filter(isConfirmedDebt).map((r) => r.memberId));
  const toReconcileIds = new Set(otherOwingRows.filter((r) => !isConfirmedDebt(r)).map((r) => r.memberId));
  // D11: the members behind each movement figure for the club month in
  // `month=` — the same replay and window as the Reports Joined tile and the
  // Net New Members chart (the current month runs to now, a past month to
  // its last millisecond), so each drill-through lists exactly who was counted.
  const moveWindow = {
    start: new Date(monthWindow.monthStart),
    at: monthWindow.isCurrent ? now : new Date(new Date(monthWindow.nextMonthStart).getTime() - 1),
  };
  const { movers, basis: moversBasis, caption: moversCaption } = await withTenantContext(
    session!.user.tenantId,
    (tx) => loadMonthMovement(tx, session!.user.tenantId, now, moveWindow),
    { maxWait: 10_000, timeout: 30_000 },
  );
  const movedBy = new Map<string, MovementBucket[]>();
  for (const bucket of Object.keys(movers) as MovementBucket[]) {
    for (const id of movers[bucket]) movedBy.set(id, [...(movedBy.get(id) ?? []), bucket]);
  }
  const listed = members.map((m) => {
    const flagged = otherOwingIds.has(m.id)
      ? { ...m, otherOwing: true }
      : toReconcileIds.has(m.id)
        ? { ...m, failedToReconcile: true }
        : m;
    const moved = movedBy.get(m.id);
    return moved ? { ...flagged, moved } : flagged;
  });

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
        members={listed}
        primaryColor={session!.user.primaryColor}
        role={session!.user.role}
        guardianReviewCount={guardianReviewCount}
        truncatedAt={truncated ? MEMBERS_SSR_TAKE : null}
        monthWindow={monthWindow}
        serverCounts={counts}
        otherOwing={otherOwingTotals(otherOwingRows)}
        movers={{ new: movers.new.length, rejoined: movers.rejoined.length, lost: movers.lost.length, tasterAdded: movers.tasterAdded.length }}
        moversBasis={{ basis: moversBasis, caption: moversCaption }}
        supportScope={(session!.user as { supportScope?: "view" | "edit" }).supportScope ?? null}
      />
    </>
  );
}
