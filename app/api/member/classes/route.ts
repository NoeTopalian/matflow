import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

const DEMO_CLASSES = [
  { id: "demo-1", name: "No-Gi",            day: "Monday",   time: "18:00", coach: "Coach Mike" },
  { id: "demo-2", name: "Fundamentals BJJ", day: "Tuesday",  time: "09:30", coach: "Coach Mike" },
  { id: "demo-3", name: "Open Mat",         day: "Friday",   time: "18:00", coach: "Open" },
  { id: "demo-4", name: "Saturday Session", day: "Saturday", time: "10:00", coach: "Coach Mike" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.tenantId === "demo-tenant") return NextResponse.json(DEMO_CLASSES);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json([]);

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const rawTake = parseInt(searchParams.get("take") ?? "50", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 50 : rawTake, 200);

  try {
    const records = await withTenantContext(session.user.tenantId, (tx) =>
      tx.attendanceRecord.findMany({
        where: { memberId },
        include: { classInstance: { include: { class: true } } },
        cursor: cursor ? { id: cursor } : undefined,
        skip: cursor ? 1 : 0,
        orderBy: { checkInTime: "desc" },
        take,
      }),
    );

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
