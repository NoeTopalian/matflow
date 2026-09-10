import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { signCardToken } from "@/lib/card-token";
import { MemberCardSheet, type PrintCardMember } from "@/components/print/MemberCardSheet";

/**
 * Printable member ID cards.
 *
 * WHY THE requireStaff() CALL BELOW IS LOAD-BEARING
 * ------------------------------------------------
 * This route deliberately sits OUTSIDE app/dashboard/** — the dashboard layout
 * owns a max-w-6xl container and an A4 sheet cannot live inside it. But
 * proxy.ts's role rules are PREFIX-SCOPED: it blocks the `member` role from
 * /dashboard and staff from /member, and everything else it merely requires a
 * session for. So placement here buys authentication and nothing more. Without
 * the explicit staff gate, any logged-in member could load a sheet carrying
 * every other member's photograph, name, grade and scan token.
 *
 * The card tokens are minted server-side (lib/card-token.ts) and signed under
 * their own key domain, so the QR on a printed card is useless at the public
 * kiosk check-in endpoint.
 */

// A print sheet is generated on demand from live data and must never be served
// from a cache shared between tenants.
export const dynamic = "force-dynamic";

/**
 * A guillotine and a laminator set the real ceiling here long before the
 * database does, and an unbounded query would render every member of a large
 * tenant into one document. 300 cards is 150 sheets of A4 — already an
 * afternoon's work.
 */
const CARD_LIMIT = 300;

export default async function MemberCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ memberId?: string }>;
}) {
  const ctx = await requireStaff();
  const { memberId } = await searchParams;

  // UI-RULES §7: deliberately unguarded. A try/catch here would make
  // app/print/member-cards/error.tsx unreachable and turn a database outage
  // into "no members to print".
  const data = await withTenantContext(ctx.tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirst({
      where: { id: ctx.tenantId },
      select: { name: true, logoUrl: true },
    });

    const members = await tx.member.findMany({
      where: {
        tenantId: ctx.tenantId,
        // A single card takes that member whatever their status — staff
        // reprint for someone who has just come back. The bulk sheet is
        // active members only.
        ...(memberId ? { id: memberId } : { status: "active" }),
      },
      select: {
        id: true,
        name: true,
        cardVersion: true,
        photos: {
          where: { kind: "profile" },
          select: { url: true },
          take: 1,
        },
        memberRanks: {
          // RankSystem.deletedAt is a soft delete: a rank the gym has retired
          // must not be printed onto a laminated card as a member's current
          // grade.
          where: { rankSystem: { deletedAt: null } },
          select: {
            stripes: true,
            rankSystem: { select: { name: true, color: true, stripes: true } },
          },
          orderBy: { achievedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
      take: CARD_LIMIT,
    });

    return { tenant, members };
  });

  if (!data.tenant) {
    // The session carries a tenantId that no longer resolves. Throwing reaches
    // the segment boundary; rendering an empty sheet would imply the club has
    // no members.
    throw new Error("Tenant not found for the current session");
  }

  const cards: PrintCardMember[] = data.members.map((m) => {
    const current = m.memberRanks[0];
    return {
      id: m.id,
      name: m.name,
      cardToken: signCardToken({
        tenantId: ctx.tenantId,
        memberId: m.id,
        cardVersion: m.cardVersion,
      }),
      photoUrl: m.photos[0]?.url ?? null,
      rank: current
        ? {
            name: current.rankSystem.name,
            color: current.rankSystem.color,
            // MemberRank.stripes is what this member earned; RankSystem.stripes
            // is the belt's maximum. They are different numbers and the belt
            // primitive needs both.
            stripes: current.stripes,
            maxStripes: current.rankSystem.stripes,
          }
        : null,
    };
  });

  return (
    <MemberCardSheet
      club={{ name: data.tenant.name, logoUrl: data.tenant.logoUrl }}
      members={cards}
    />
  );
}
