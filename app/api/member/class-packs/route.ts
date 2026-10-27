import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

/**
 * The member's packs and the packs on sale.
 *
 * G6 (owner decision, 27 Oct 2026): "It should be till it runs out". A pack is
 * the member's until its credits are used or it is refunded, so this route
 * neither reads `expiresAt` nor writes the status "expired" (it used to mark a
 * pack expired here when its date passed — the only writer of that status).
 * A legacy "expired" pack with credits left is listed like any other, because
 * lib/checkin.ts claimPack spends it like any other. An active pack with no
 * credits left stays listed (as before); an expired one without credits does
 * not, since it never showed.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ owned: [], available: [] });

  const tenantId = session.user.tenantId;

  const { ownedRows, available } = await withTenantContext(tenantId, async (tx) => {
    const [rows, packs] = await Promise.all([
      tx.memberClassPack.findMany({
        where: {
          memberId,
          tenantId,
          OR: [{ status: "active" }, { status: "expired", creditsRemaining: { gt: 0 } }],
        },
        include: { pack: true },
        // The order credits are spent in (claimPack): oldest purchase first.
        orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],
      }),
      tx.classPack.findMany({
        where: { tenantId, isActive: true },
        orderBy: { pricePence: "asc" },
      }),
    ]);
    return { ownedRows: rows, available: packs };
  });

  return NextResponse.json({
    owned: ownedRows.map((mp) => ({
      id: mp.id,
      packId: mp.packId,
      name: mp.pack.name,
      creditsRemaining: mp.creditsRemaining,
      totalCredits: mp.pack.totalCredits,
      purchasedAt: mp.purchasedAt.toISOString(),
    })),
    available: available.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      totalCredits: p.totalCredits,
      pricePence: p.pricePence,
      currency: p.currency,
    })),
  });
}
