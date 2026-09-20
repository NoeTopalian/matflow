import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination } from "@/lib/pagination";
import { classCreateSchema as createSchema } from "@/lib/schemas/class";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { clubDayMarker, scheduleStartMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Hard-cap response size to avoid unbounded reads. Cursor support is opt-in
  // via ?cursor/?take query params; default behaviour returns up to 100 active
  // classes — sufficient for the largest gym we anticipate without forcing
  // existing callers (which expect an array) to change.
  const { take, cursor, skip } = parsePagination(req, { defaultTake: 100, maxTake: 100 });

  try {
    const classes = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.findMany({
        // RULES §5: soft-delete columns must be filtered by every reader.
        where: { tenantId: session.user.tenantId, isActive: true, deletedAt: null },
        include: {
          schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
        cursor: cursor ? { id: cursor } : undefined,
        skip,
        take,
      }),
    );
    // Lane 1 iter-2 L1-I2-S-02 [High]: per-tenant class listing.
    return NextResponse.json(classes, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json([], {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
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

  const { schedules, roster, ...classData } = parsed.data;

  // Roster mode and rank gates are mutually exclusive — the same rule the PATCH
  // route enforces by clearing one when the other is set. At create time there
  // is nothing to clear, so naming both is a refusal rather than a silent
  // winner: the owner finds out now, not when the gate they thought they set
  // turns out not to be there.
  if (roster && roster.length > 0 && (classData.requiredRankId || classData.maxRankId)) {
    return NextResponse.json(
      { error: "A class uses either a rank gate or a roster, not both. Clear the rank fields to use a roster." },
      { status: 400 },
    );
  }

  try {
    const { cls, instancesCreated } = await withTenantContext(session.user.tenantId, async (tx) => {
      // The club's zone is needed BEFORE the write, not only for the window
      // below: `startDate` is a day marker and the club's calendar date is what
      // it must say (see `scheduleStartMarker`).
      const tenant = await tx.tenant.findUnique({ where: { id: session.user.tenantId }, select: { timezone: true } });
      const timeZone = usableTimezone(tenant?.timezone);
      const now = new Date();
      const cls = await tx.class.create({
        data: {
          tenantId: session.user.tenantId,
          ...classData,
          schedules: {
            create: schedules.map((s: typeof schedules[number]) => ({
              dayOfWeek: s.dayOfWeek,
              startTime: s.startTime,
              endTime: s.endTime,
              startDate: scheduleStartMarker(s.startDate, now, timeZone),
              endDate: s.endDate ? new Date(s.endDate) : null,
            })),
          },
        },
        include: {
          schedules: true,
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
        },
      });
      // The allow-list, in the same transaction as the class: a class that
      // exists with nobody on its roster is a class anyone can check into, so
      // the two must commit together. The ticked ids are re-read under the
      // tenant context first — an id from another gym is not written, it is
      // simply absent, exactly as the roster POST route refuses one.
      if (roster && roster.length > 0) {
        const ours = await tx.member.findMany({
          where: { id: { in: roster.map((r) => r.memberId) }, tenantId: session.user.tenantId },
          select: { id: true },
        });
        if (ours.length > 0) {
          await tx.classRoster.createMany({
            data: ours.map((m) => ({
              tenantId: session.user.tenantId,
              classId: cls.id,
              memberId: m.id,
              addedByUserId: session.user.id,
            })),
            skipDuplicates: true,
          });
        }
      }

      // A class exists on the timetable the moment it is created, not the
      // morning after the cron (which on production has never run). Same
      // window and spelling as the PATCH route and the cron, so the three
      // cannot fight: idempotent on @@unique([classId, date, startTime]).
      // Noe, 18 Sep 2026: "it doesn't come up with the option to sign people
      // into classes happening at this moment."
      const rows = buildInstanceRows([{ id: cls.id, schedules: cls.schedules }], {
        from: clubDayMarker(now, timeZone),
        days: ROLLING_WINDOW_DAYS,
      });
      const minted = rows.length > 0 ? await tx.classInstance.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      return { cls, instancesCreated: minted.count };
    });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "class.created",
      entityType: "Class",
      entityId: cls.id,
      metadata: { name: cls.name, instancesCreated },
      req,
    });
    return NextResponse.json({ ...cls, instancesCreated }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create class" }, { status: 500 });
  }
}
