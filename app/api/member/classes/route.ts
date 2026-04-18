import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const DEMO_CLASSES = [
  { id: "demo-1", name: "No-Gi",            day: "Monday",   time: "18:00", coach: "Coach Mike" },
  { id: "demo-2", name: "Fundamentals BJJ", day: "Tuesday",  time: "09:30", coach: "Coach Mike" },
  { id: "demo-3", name: "Open Mat",         day: "Friday",   time: "18:00", coach: "Open" },
  { id: "demo-4", name: "Saturday Session", day: "Saturday", time: "10:00", coach: "Coach Mike" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.tenantId === "demo-tenant") return NextResponse.json(DEMO_CLASSES);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json([]);

  try {
    const records = await prisma.attendanceRecord.findMany({
      where: { memberId },
      include: { classInstance: { include: { class: true } } },
      orderBy: { checkInTime: "desc" },
      take: 100,
    });

    const seen = new Set<string>();
    const result: Array<{ id: string; name: string; day: string; time: string; coach: string }> = [];
    for (const r of records) {
      const cls = r.classInstance?.class;
      if (!cls) continue;
      if (seen.has(cls.id)) continue;
      seen.add(cls.id);
      result.push({
        id: cls.id,
        name: cls.name,
        day: DAY_NAMES[r.classInstance.date.getDay()] ?? "",
        time: r.classInstance.startTime,
        coach: cls.coachName ?? "Coach",
      });
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json([]);
  }
}
