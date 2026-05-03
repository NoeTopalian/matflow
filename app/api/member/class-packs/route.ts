import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

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
        orderBy: { expiresAt: "asc" },
      }),
      tx.classPack.findMany({
        where: { tenantId, isActive: true },
        orderBy: { pricePence: "asc" },
      }),
    ]);
    const expiredIds = rows.filter((mp) => mp.expiresAt < now).map((mp) => mp.id);
    if (expiredIds.length > 0) {
      await tx.memberClassPack.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: "expired" },
      });
    }
    return { ownedRows: rows, available: packs };
  });

  return NextResponse.json({
    owned: ownedRows
      .filter((mp) => mp.expiresAt >= now)
      .map((mp) => ({
        id: mp.id,
        packId: mp.packId,
        name: mp.pack.name,
        creditsRemaining: mp.creditsRemaining,
        totalCredits: mp.pack.totalCredits,
        purchasedAt: mp.purchasedAt.toISOString(),
        expiresAt: mp.expiresAt.toISOString(),
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
