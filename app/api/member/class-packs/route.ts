import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ owned: [], available: [] });

  const tenantId = session.user.tenantId;
  const now = new Date();

  const [owned, available] = await Promise.all([
    prisma.memberClassPack.findMany({
      where: { memberId, tenantId, status: "active" },
      include: { pack: true },
      orderBy: { expiresAt: "asc" },
    }),
    prisma.classPack.findMany({
      where: { tenantId, isActive: true },
      orderBy: { pricePence: "asc" },
    }),
  ]);

  // Auto-expire any packs whose deadline has passed
  const expiredIds = owned.filter((mp) => mp.expiresAt < now).map((mp) => mp.id);
  if (expiredIds.length > 0) {
    await prisma.memberClassPack.updateMany({
      where: { id: { in: expiredIds } },
      data: { status: "expired" },
    });
  }

  return NextResponse.json({
    owned: owned
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
