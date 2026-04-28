import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ id: string }> };

/** POST — manually cancel or restore a specific instance */
const cancelSchema = z.object({
  isCancelled: z.boolean(),
  cancellationReason: z.string().max(300).optional(),
});

export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const rawTake = parseInt(searchParams.get("take") ?? "30", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 30 : rawTake, 200);

  try {
    const instances = await prisma.classInstance.findMany({
      where: { classId: id, class: { tenantId: session.user.tenantId } },
      include: { _count: { select: { attendances: true } } },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: { date: "desc" },
      take,
    });
    const nextCursor = instances.length === take ? instances[instances.length - 1].id : null;
    return NextResponse.json({ instances, nextCursor });
  } catch {
    return NextResponse.json({ instances: [], nextCursor: null });
  }
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Generate instances for next N weeks
  const genSchema = z.object({ weeks: z.number().int().min(1).max(52).default(4) });
  const parsed = genSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const cls = await prisma.class.findFirst({
    where: { id, tenantId: session.user.tenantId },
    include: { schedules: { where: { isActive: true } } },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + parsed.data.weeks * 7);

  const candidates: { classId: string; date: Date; startTime: string; endTime: string }[] = [];

  for (const sched of cls.schedules) {
    const current = new Date(today);
    // advance to next occurrence of this weekday
    while (current.getDay() !== sched.dayOfWeek) {
      current.setDate(current.getDate() + 1);
    }
    while (current <= endDate) {
      candidates.push({
        classId: id,
        date: new Date(current),
        startTime: sched.startTime,
        endTime: sched.endTime,
      });
      current.setDate(current.getDate() + 7);
    }
  }

  // Pre-fetch all existing instances for this class in the date range in one query
  const existing = await prisma.classInstance.findMany({
    where: {
      classId: id,
      date: { gte: today, lte: endDate },
    },
    select: { date: true, startTime: true },
  });
  const existingKeys = new Set(
    existing.map((e) => `${e.date.toISOString()}|${e.startTime}`)
  );

  const toCreate = candidates.filter(
    (c) => !existingKeys.has(`${c.date.toISOString()}|${c.startTime}`)
  );

  try {
    const created = await prisma.classInstance.createMany({ data: toCreate });
    return NextResponse.json({ created: created.count });
  } catch {
    return NextResponse.json({ error: "Failed to generate instances" }, { status: 500 });
  }
}
