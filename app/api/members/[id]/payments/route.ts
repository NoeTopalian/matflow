import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "admin", "coach"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const payments = await prisma.payment.findMany({
    where: { memberId: id, tenantId: session.user.tenantId },
    orderBy: { paidAt: "desc" },
    take: 100,
    select: {
      id: true,
      amountPence: true,
      currency: true,
      status: true,
      description: true,
      paidAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ payments });
}
