import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

const createSchema = z.object({
  title:    z.string().min(1).max(120),
  body:     z.string().min(1).max(2000),
  imageUrl: z.string().url().optional().nullable(),
  pinned:   z.boolean().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const announcements = await prisma.announcement.findMany({
      where: { tenantId: session.user.tenantId },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      take: 50,
    });
    return NextResponse.json(announcements);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canPost = ["owner", "manager"].includes(session.user.role);
  if (!canPost) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const announcement = await prisma.announcement.create({
      data: {
        tenantId: session.user.tenantId,
        title:    parsed.data.title,
        body:     parsed.data.body,
        imageUrl: parsed.data.imageUrl ?? null,
        pinned:   parsed.data.pinned   ?? false,
      },
    });
    return NextResponse.json(announcement, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create announcement" }, { status: 500 });
  }
}
