import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional().nullable(),
  membershipType: z.string().max(60).optional().nullable(),
  status: z.enum(["active", "inactive", "cancelled"]).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const member = await prisma.member.findFirst({
      where: { id, tenantId: session.user.tenantId },
      include: {
        memberRanks: {
          include: {
            rankSystem: true,
            rankHistory: {
              orderBy: { promotedAt: "desc" },
              take: 10,
            },
          },
          orderBy: { achievedAt: "desc" },
        },
        attendances: {
          include: {
            classInstance: {
              include: { class: true },
            },
          },
          orderBy: { checkInTime: "desc" },
          take: 20,
        },
      },
    });

    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(member);
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canEdit = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const member = await prisma.member.updateMany({
      where: { id, tenantId: session.user.tenantId },
      data: parsed.data,
    });

    if (member.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const updated = await prisma.member.findUnique({ where: { id } });
    return NextResponse.json(updated);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update member" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    await prisma.member.deleteMany({ where: { id, tenantId: session.user.tenantId } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete member" }, { status: 500 });
  }
}
