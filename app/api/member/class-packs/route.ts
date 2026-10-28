import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { isPackPastExpiry } from "@/lib/class-pack-terms";

/**
 * The member's packs and the packs on sale.
 *
 * Expiry is chosen per pack product (owner decision, 27 Oct 2026; see
 * lib/class-pack-terms.ts). A purchase is listed while it is "active" and has
 * no expiry or an expiry still ahead; a dated pack past its date is expired and
 * not listed, as before. The rule is applied here when reading, with no write:
 * this route used to mark such a pack "expired" in the database, and nothing
 * else depends on that stored status (lib/checkin.ts claimPack applies the same
 * date rule itself). Not writing also means a no-expiry pack can never be
 * marked expired by a `null < now` comparison.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ owned: [], available: [] });

  const tenantId = session.user.tenantId;
  const now = new Date();

  const { ownedRows, available } = await withTenantContext(tenantId, async (tx) => {
    const [rows, packs] = await Promise.all([
      tx.memberClassPack.findMany({
        where: { memberId, tenantId, status: "active" },
        include: { pack: true },
        // The order credits are spent in (claimPack).
        orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { purchasedAt: "asc" }, { id: "asc" }],
      }),
      tx.classPack.findMany({
        where: { tenantId, isActive: true },
        orderBy: { pricePence: "asc" },
      }),
    ]);
    return { ownedRows: rows, available: packs };
  });

  return NextResponse.json({
    owned: ownedRows
      .filter((mp) => !isPackPastExpiry(mp.expiresAt, now))
      .map((mp) => ({
        id: mp.id,
        packId: mp.packId,
        name: mp.pack.name,
        creditsRemaining: mp.creditsRemaining,
        totalCredits: mp.pack.totalCredits,
        purchasedAt: mp.purchasedAt.toISOString(),
        expiresAt: mp.expiresAt ? mp.expiresAt.toISOString() : null,
      })),
    available: available.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      totalCredits: p.totalCredits,
      validityDays: p.validityDays,
      pricePence: p.pricePence,
      currency: p.currency,
    })),
  });
}
