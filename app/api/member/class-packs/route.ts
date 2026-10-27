import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

/**
 * True when a pack's expiry has passed. G6 (owner decision, 27 Oct 2026): a
 * pack lasts until its credits are used, so `expiresAt` is NULL on every pack
 * sold from then on and on every pack that was active at the migration. NULL
 * never expires. A non-NULL past date can no longer occur on an active pack;
 * if one does, the old rule still holds (lib/checkin.ts claimPack does not
 * spend it either), and only such a pack is ever marked "expired" — which the
 * database CHECK MemberClassPack_expired_has_expiry_check also enforces.
 */
function hasExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt < now;
}

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
        // The order credits are spent in (claimPack): oldest purchase first.
        orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],
      }),
      tx.classPack.findMany({
        where: { tenantId, isActive: true },
        orderBy: { pricePence: "asc" },
      }),
    ]);
    const expiredIds = rows.filter((mp) => hasExpired(mp.expiresAt, now)).map((mp) => mp.id);
    if (expiredIds.length > 0) {
      await tx.memberClassPack.updateMany({
        where: { id: { in: expiredIds }, tenantId, expiresAt: { not: null, lt: now } },
        data: { status: "expired" },
      });
    }
    return { ownedRows: rows, available: packs };
  });

  return NextResponse.json({
    owned: ownedRows
      .filter((mp) => !hasExpired(mp.expiresAt, now))
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
      pricePence: p.pricePence,
      currency: p.currency,
    })),
  });
}
