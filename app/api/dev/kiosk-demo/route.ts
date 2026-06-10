// ⚠️ TEMP DEMO ROUTE — kiosk testing only. Safe to delete after the demo.
// Remove this whole file + the "TEMP DEMO" block in components/dashboard/KioskPanel.tsx.
//
// POST   /api/dev/kiosk-demo  → owner-only. Seeds (or refreshes) a "Demo Class"
//                               instance for today whose start time is NOW, so
//                               the kiosk check-in window is open immediately
//                               and stays open for ~3h — covering the 12:30
//                               meeting on any server timezone (local/BST or
//                               live/UTC), since the window check and the
//                               instance time both use the same server clock.
// DELETE /api/dev/kiosk-demo  → owner-only. Removes the demo class + its
//                               instances + any attendance recorded on them.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

const DEMO_CLASS_NAME = "Demo Class — 12:30 Meeting";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const tenantId = session.user.tenantId;

  // All times are server-local so they match performCheckin()'s window check
  // (lib/checkin.ts uses `new Date()` + parseTime, both server-local).
  const now = new Date();
  const date = new Date(now);
  date.setHours(0, 0, 0, 0); // today at server-local midnight (kiosk "today" filter)

  const startTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  // End 3h later so the window stays open well past 12:30 regardless of a
  // ±1h local/UTC offset. Clamp to 23:59 so it never spills to tomorrow.
  let endH = now.getHours() + 3;
  let endM = now.getMinutes();
  if (endH > 23) {
    endH = 23;
    endM = 59;
  }
  const endTime = `${pad(endH)}:${pad(endM)}`;

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      let cls = await tx.class.findFirst({
        where: { tenantId, name: DEMO_CLASS_NAME },
        select: { id: true },
      });
      if (!cls) {
        cls = await tx.class.create({
          data: {
            tenantId,
            name: DEMO_CLASS_NAME,
            duration: 180,
            coachName: "Demo",
            color: "#3b82f6",
          },
          select: { id: true },
        });
      }

      // Clear any earlier demo instances for today so the fresh one always
      // starts "now" (and repeat clicks don't pile up duplicates).
      const tomorrow = new Date(date);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const todays = await tx.classInstance.findMany({
        where: { classId: cls.id, date: { gte: date, lt: tomorrow } },
        select: { id: true },
      });
      if (todays.length) {
        const ids = todays.map((t) => t.id);
        await tx.attendanceRecord.deleteMany({ where: { classInstanceId: { in: ids } } });
        await tx.classInstance.deleteMany({ where: { id: { in: ids } } });
      }

      const inst = await tx.classInstance.create({
        data: { classId: cls.id, date, startTime, endTime },
        select: { id: true },
      });
      return { classId: cls.id, instanceId: inst.id };
    });

    return NextResponse.json({ ok: true, name: DEMO_CLASS_NAME, startTime, endTime, ...result });
  } catch (e) {
    console.error("[kiosk-demo] seed failed", e);
    return NextResponse.json({ error: "Failed to seed demo class" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const tenantId = session.user.tenantId;

  try {
    await withTenantContext(tenantId, async (tx) => {
      const cls = await tx.class.findFirst({
        where: { tenantId, name: DEMO_CLASS_NAME },
        select: { id: true },
      });
      if (!cls) return;

      const insts = await tx.classInstance.findMany({
        where: { classId: cls.id },
        select: { id: true },
      });
      const ids = insts.map((i) => i.id);
      if (ids.length) {
        await tx.attendanceRecord.deleteMany({ where: { classInstanceId: { in: ids } } });
        await tx.classWaitlist.deleteMany({ where: { classInstanceId: { in: ids } } });
        await tx.classInstance.deleteMany({ where: { id: { in: ids } } });
      }
      // Defensive: demo class has no rosters/subs/schedules, but clear any
      // join rows so the final class delete can't hit an FK restriction.
      await tx.classRoster.deleteMany({ where: { classId: cls.id } });
      await tx.classSubscription.deleteMany({ where: { classId: cls.id } });
      await tx.classSchedule.deleteMany({ where: { classId: cls.id } });
      await tx.class.delete({ where: { id: cls.id } });
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[kiosk-demo] cleanup failed", e);
    return NextResponse.json({ error: "Failed to remove demo class" }, { status: 500 });
  }
}
