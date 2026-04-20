/**
 * GET /api/member/schedule
 * Returns all active classes + schedules for the logged-in member's tenant.
 * Used by the member Schedule and Home pages.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const DEMO_CLASSES = [
  { id: "m1",  name: "Fundamentals BJJ", startTime: "09:30", endTime: "10:30", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 1 },
  { id: "m2",  name: "No-Gi",            startTime: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 1 },
  { id: "m3",  name: "Open Mat",         startTime: "20:00", endTime: "21:30", coach: "Open",        location: "Main Mat", capacity: null, dayOfWeek: 1 },
  { id: "t1",  name: "Beginner BJJ",     startTime: "10:00", endTime: "11:00", coach: "Coach Sarah", location: "Mat 1",    capacity: 16, dayOfWeek: 2 },
  { id: "t2",  name: "Open Mat",         startTime: "12:00", endTime: "14:00", coach: "Coach Sarah", location: "Main Mat", capacity: null, dayOfWeek: 2 },
  { id: "w1",  name: "Kids BJJ",         startTime: "17:00", endTime: "17:45", coach: "Coach Emma",  location: "Mat 2",    capacity: 12, dayOfWeek: 3 },
  { id: "w2",  name: "Advanced BJJ",     startTime: "19:00", endTime: "20:15", coach: "Coach Mike",  location: "Mat 1",    capacity: 18, dayOfWeek: 3 },
  { id: "th1", name: "No-Gi",            startTime: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 4 },
  { id: "th2", name: "Beginners",        startTime: "19:15", endTime: "20:15", coach: "Coach Sarah", location: "Mat 2",    capacity: 14, dayOfWeek: 4 },
  { id: "f1",  name: "Beginner BJJ",     startTime: "10:00", endTime: "11:00", coach: "Coach Sarah", location: "Mat 1",    capacity: 16, dayOfWeek: 5 },
  { id: "f2",  name: "Open Mat",         startTime: "18:00", endTime: "20:00", coach: "Open",        location: "Main Mat", capacity: null, dayOfWeek: 5 },
  { id: "s1",  name: "Saturday Session", startTime: "10:00", endTime: "12:00", coach: "Coach Mike",  location: "Main Mat", capacity: 30, dayOfWeek: 6 },
  { id: "s2",  name: "Kids BJJ",         startTime: "09:00", endTime: "09:45", coach: "Coach Emma",  location: "Mat 2",    capacity: 12, dayOfWeek: 6 },
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date"); // YYYY-MM-DD, optional

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json(DEMO_CLASSES);
  }

  try {
    const classes = await prisma.class.findMany({
      where: { tenantId: session.user.tenantId, isActive: true },
      select: {
        id: true,
        name: true,
        coachName: true,
        location: true,
        maxCapacity: true,
        schedules: {
          where: { isActive: true },
          select: { id: true, dayOfWeek: true, startTime: true, endTime: true },
        },
      },
    });

    // When a date is requested, fetch ClassInstances for that day so we can
    // return their IDs for self-check-in.
    const instanceMap = new Map<string, string>(); // `${classId}-${startTime}` → instanceId
    if (dateParam) {
      const startOfDay = new Date(`${dateParam}T00:00:00.000Z`);
      const endOfDay   = new Date(`${dateParam}T23:59:59.999Z`);
      const instances  = await prisma.classInstance.findMany({
        where: {
          class: { tenantId: session.user.tenantId },
          date: { gte: startOfDay, lte: endOfDay },
          isCancelled: false,
        },
        select: { id: true, classId: true, startTime: true },
      });
      for (const inst of instances) {
        instanceMap.set(`${inst.classId}-${inst.startTime}`, inst.id);
      }
    }

    // Flatten class+schedule into per-day entries (same shape as demo data)
    const result = classes.flatMap((cls: typeof classes[number]) =>
      cls.schedules.map((sched: typeof classes[number]["schedules"][number]) => ({
        id: `${cls.id}-${sched.id}`,
        classId: cls.id,
        scheduleId: sched.id,
        name: cls.name,
        startTime: sched.startTime,
        endTime: sched.endTime,
        coach: cls.coachName ?? "TBC",
        location: cls.location ?? "",
        capacity: cls.maxCapacity,
        dayOfWeek: sched.dayOfWeek, // 0=Sun, 1=Mon … 6=Sat (JS getDay() convention)
        classInstanceId: instanceMap.get(`${cls.id}-${sched.startTime}`) ?? null,
      }))
    );

    return NextResponse.json(result);
  } catch {
    if (session.user.tenantId === "demo-tenant") return NextResponse.json(DEMO_CLASSES);
    return NextResponse.json([]);
  }
}
