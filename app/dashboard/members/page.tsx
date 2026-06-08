import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import MembersList, { MemberRow } from "@/components/dashboard/MembersList";

// Lane 1 iter-1 P-01 [Critical] fix: hard cap on the SSR-rendered member
// list. Previous code was unbounded — at 5 000 members the route transferred
// ~5 MB per render and could OOM a 256 MB Vercel function. 500 is generous
// for the current tenant ceiling; the followup ([P-22, V-20]) is to add
// cursor-based pagination in MembersList so the cap can be a true page size.
const MEMBERS_SSR_TAKE = 500;

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
        waiverAccepted: true,
        accountType: true,
        dateOfBirth: true,
        parentMemberId: true,
        hasKidsHint: true,
        joinedAt: true,
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

  const mapped: MemberRow[] = visible.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    membershipType: m.membershipType,
    status: m.status,
    paymentStatus: m.paymentStatus,
    waiverAccepted: m.waiverAccepted,
    accountType: m.accountType ?? "adult",
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    parentMemberId: m.parentMemberId,
    hasKidsHint: m.hasKidsHint,
    joinedAt: m.joinedAt.toISOString(),
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

  let members: MemberRow[] = [];
  try {
    const result = await getMembers(session!.user.tenantId);
    members = result.rows;
  } catch (e) {
    // Lane 1 iter-1 P-29 follow-up: surface the failure to ops logs rather
    // than silently rendering an empty list. The UI still degrades gracefully
    // (empty state) but the cause is no longer invisible.
    console.error("[dashboard/members] data load failed", e);
  }

  return (
    <MembersList
      members={members}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
    />
  );
}
