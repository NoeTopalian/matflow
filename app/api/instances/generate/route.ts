/**
 * POST /api/instances/generate
 * Generates ClassInstance rows for all active classes for the next N weeks.
 * Safe to call repeatedly — skips already-existing instances.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({ weeks: z.number().int().min(1).max(52).default(4) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = schema.safeParse(body);
  const weeks = parsed.success ? parsed.data.weeks : 4;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + weeks * 7);

  const classes = await prisma.class.findMany({
    where: { tenantId: session.user.tenantId, isActive: true },
    include: { schedules: { where: { isActive: true } } },
  });

  const toCreate: { classId: string; date: Date; startTime: string; endTime: string }[] = [];

  for (const cls of classes) {
    for (const sched of cls.schedules) {
      const current = new Date(today);
      while (current.getDay() !== sched.dayOfWeek) {
        current.setDate(current.getDate() + 1);
      }
      while (current <= endDate) {
        toCreate.push({
          classId: cls.id,
          date: new Date(current),
          startTime: sched.startTime,
          endTime: sched.endTime,
        });
        current.setDate(current.getDate() + 7);
      }
    }
  }

  if (toCreate.length === 0) return NextResponse.json({ created: 0 });

  const classIds = [...new Set(toCreate.map((c) => c.classId))];
  const rangeStart = toCreate.reduce(
    (min, c) => (c.date < min ? c.date : min),
    toCreate[0].date,
  );
  const rangeEnd = toCreate.reduce(
    (max, c) => (c.date > max ? c.date : max),
    toCreate[0].date,
  );

  try {
    // Pre-fetch existing instances once to avoid per-row upsert round-trips.
    const existing = await prisma.classInstance.findMany({
      where: {
        classId: { in: classIds },
        date: { gte: rangeStart, lte: rangeEnd },
      },
      select: { classId: true, date: true, startTime: true },
    });
    const existingKeys = new Set(
      existing.map(
        (e) => `${e.classId}|${e.date.toISOString()}|${e.startTime}`,
      ),
    );

    const newRows = toCreate.filter(
      (c) =>
        !existingKeys.has(
          `${c.classId}|${c.date.toISOString()}|${c.startTime}`,
        ),
    );

    if (newRows.length > 0) {
      await prisma.classInstance.createMany({
        data: newRows,
        skipDuplicates: true,
      });
    }

    return NextResponse.json({ created: newRows.length });
  } catch {
    return NextResponse.json({ error: "Failed to generate instances" }, { status: 500 });
  }
}
