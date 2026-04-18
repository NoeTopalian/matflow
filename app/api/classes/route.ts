import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  coachName: z.string().max(100).optional(),
  location: z.string().max(100).optional(),
  duration: z.number().int().min(1).max(480),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional(),
  schedules: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        startDate: z.string().optional(),
        endDate: z.string().optional().nullable(),
      })
    )
    .optional(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const classes = await prisma.class.findMany({
      where: { tenantId: session.user.tenantId, isActive: true },
      include: {
        schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
        requiredRank: true,
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(classes);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

  const { schedules, ...classData } = parsed.data;

  try {
    const cls = await prisma.class.create({
      data: {
        tenantId: session.user.tenantId,
        ...classData,
        schedules: schedules
          ? {
              create: schedules.map((s) => ({
                dayOfWeek: s.dayOfWeek,
                startTime: s.startTime,
                endTime: s.endTime,
                startDate: s.startDate ? new Date(s.startDate) : new Date(),
                endDate: s.endDate ? new Date(s.endDate) : null,
              })),
            }
          : undefined,
      },
      include: {
        schedules: true,
        requiredRank: true,
      },
    });
    return NextResponse.json(cls, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create class" }, { status: 500 });
  }
}
