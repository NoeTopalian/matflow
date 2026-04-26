import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json([]);

  const rows = await prisma.payment.findMany({
    where: { memberId, tenantId: session.user.tenantId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      amountPence: true,
      currency: true,
      status: true,
      description: true,
      paidAt: true,
      refundedAt: true,
      refundedAmountPence: true,
      createdAt: true,
    },
  });
  return NextResponse.json(rows);
}
