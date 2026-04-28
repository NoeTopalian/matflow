import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";

const schema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  membershipType: z.string().max(60).optional(),
  dateOfBirth: z.string().optional().nullable(),
});

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const rawTake = parseInt(searchParams.get("take") ?? "50", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 50 : rawTake, 200);

  try {
    const members = await prisma.member.findMany({
      where: { tenantId: session.user.tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        paymentStatus: true,
        membershipType: true,
        joinedAt: true,
        waiverAccepted: true,
        memberRanks: {
          take: 1,
          orderBy: { achievedAt: "desc" },
          select: {
            stripes: true,
            achievedAt: true,
            rankSystem: { select: { name: true, color: true, discipline: true } },
          },
        },
      },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take,
      orderBy: { joinedAt: "desc" },
    });

    const nextCursor = members.length === take ? members[members.length - 1].id : null;
    return NextResponse.json({ members, nextCursor });
  } catch {
    return NextResponse.json({ members: [], nextCursor: null });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canAdd = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canAdd) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const member = await prisma.member.create({
      data: {
        tenantId: session.user.tenantId,
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        membershipType: parsed.data.membershipType,
        dateOfBirth: parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : null,
      },
    });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.create",
      entityType: "Member",
      entityId: member.id,
      metadata: { name: member.name, email: member.email },
      req,
    });
    return NextResponse.json(member, { status: 201 });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A member with that email already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create member" }, { status: 500 });
  }
}
