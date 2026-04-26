import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireOwnerOrManager } from "@/lib/authz";

export async function GET(req: Request) {
  const { tenantId } = await requireOwnerOrManager();
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const memberId = searchParams.get("memberId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const take = Math.min(Math.max(Number(searchParams.get("limit") ?? 50), 1), 200);
  const cursor = searchParams.get("cursor");

  const where: Record<string, unknown> = { tenantId };
  if (status) where.status = status;
  if (memberId) where.memberId = memberId;
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  try {
    const rows = await prisma.payment.findMany({
      where,
      include: { member: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const nextCursor = rows.length > take ? rows[take].id : null;
    return NextResponse.json({ payments: rows.slice(0, take), nextCursor });
  } catch {
    return NextResponse.json({ payments: [], nextCursor: null });
  }
}
