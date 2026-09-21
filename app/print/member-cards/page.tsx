import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { signCardToken } from "@/lib/card-token";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  MemberCardSheet,
  type PrintCardMember,
  type PrintCardTruncation,
} from "@/components/print/MemberCardSheet";
import type { SheetMode } from "@/components/print/PrintControls";

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
 *
 * The cap must never apply SILENTLY. A 412-member club told "300 cards across
 * 150 A4 sheets" is being given a true fact about the paper and a false one
 * about the club: 112 people would be found to have no card weeks later, one
 * at a time, at the door. So the query fetches one row beyond the cap purely
 * to detect the overflow, then counts to report it honestly.
 */
const CARD_LIMIT = 300;

/** `?mode=` accepts only the two known values; anything else is ignored rather
 * than trusted, since it flows straight into the sheet layout. */
function parseSheetMode(raw: string | undefined): SheetMode | null {
  return raw === "a4-two" || raw === "a5-one" ? raw : null;
}

export default async function MemberCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ memberId?: string; mode?: string }>;
}) {
  const ctx = await requireStaff();
  const { memberId, mode } = await searchParams;

  // UI-RULES §7: deliberately unguarded. A try/catch here would make
  // app/print/member-cards/error.tsx unreachable and turn a database outage
  // into "no members to print".
  const data = await withTenantContext(ctx.tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirst({
      where: { id: ctx.tenantId },
      select: { name: true, logoUrl: true },
    });

    // The tenant filter is the isolation boundary, not a hint: `id: memberId`
    // is ANDed onto it, never substituted for it, so a memberId belonging to
    // another club returns nothing rather than another club's member.
    const where = {
      tenantId: ctx.tenantId,
      // A single card takes that member whatever their status — staff
      // reprint for someone who has just come back. The bulk sheet is
      // active members only.
      ...(memberId ? { id: memberId } : { status: "active" }),
    };

    const rows = await tx.member.findMany({
      where,
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
      // One past the cap: the extra row is the overflow flag, and it costs a
      // row rather than a second query on the common path.
      take: CARD_LIMIT + 1,
    });

    const members = rows.slice(0, CARD_LIMIT);
    // Only when the cap actually bit — the count is worth a round trip solely
    // to put a real denominator in front of staff.
    const total = rows.length > CARD_LIMIT ? await tx.member.count({ where }) : members.length;

    return { tenant, members, total };
  });

  if (!data.tenant) {
    // The session carries a tenantId that no longer resolves. Throwing reaches
    // the segment boundary; rendering an empty sheet would imply the club has
    // no members.
    throw new Error("Tenant not found for the current session");
  }

  if (memberId && data.members.length === 0) {
    // A memberId that does not exist, or belongs to another club and was
    // correctly filtered out. Rendering "0 cards across 0 A4 sheets" would be
    // a not-found dressed as an empty result — the shape UI-RULES §7 bans. No
    // retry: the same URL will fail the same way.
    return (
      <div className="p-8">
        <ErrorState message="No such member in this club, so there is no card to print. Check the link and try again from the members list." />
      </div>
    );
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

  const truncation: PrintCardTruncation | null =
    data.total > cards.length ? { shown: cards.length, total: data.total } : null;

  // A single member's card has no second card to share an A4 sheet with, so
  // that print starts on A5-one-per-sheet unless the caller named a mode
  // explicitly. The owner's toggle can still change it from there — this only
  // picks the sensible starting point.
  const initialSheetMode: SheetMode = parseSheetMode(mode) ?? (memberId ? "a5-one" : "a4-two");

  return (
    <MemberCardSheet
      club={{ name: data.tenant.name, logoUrl: data.tenant.logoUrl }}
      members={cards}
      truncation={truncation}
      initialSheetMode={initialSheetMode}
    />
  );
}
