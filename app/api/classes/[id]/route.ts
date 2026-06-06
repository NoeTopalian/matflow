import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";

const rosterEntrySchema = z.object({ memberId: z.string().min(1) });

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  coachName: z.string().max(100).optional().nullable(),
  coachUserId: z.string().optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  duration: z.number().int().min(1).max(480).optional(),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  maxRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional(),
  // Task 5: optional roster array; mutually exclusive with rank fields at the API layer.
  roster: z.array(rosterEntrySchema).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const cls = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.findFirst({
        where: { id, tenantId: session.user.tenantId },
        include: {
          schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
        },
      }),
    );
    if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(cls);
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: Params) {
  // Lane 1 iter-1 CSRF-sweep [High]: assertSameOrigin guard. Inserted by the
  // bulk-fix script in audit/loop-fixes-01-dashboard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const tenantId = session.user.tenantId;

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

  const wantsRankGate = parsed.data.requiredRankId !== undefined || parsed.data.maxRankId !== undefined;
  const wantsRoster = Array.isArray(parsed.data.roster);
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    // Compute affected subscribers (those who would lose access) for warning UI.
    const affected = await withTenantContext(tenantId, async (tx) => {
      let losers: string[] = [];
      if (wantsRankGate && parsed.data.requiredRankId) {
        const newRank = await tx.rankSystem.findFirst({
          where: { id: parsed.data.requiredRankId, tenantId, deletedAt: null },
          select: { id: true, order: true, discipline: true },
        });
        if (newRank) {
          const subs = await tx.classSubscription.findMany({
            where: { classId: id },
            include: { member: { include: { memberRanks: { include: { rankSystem: true } } } } },
          });
          losers = subs
            .filter((s) => {
              const r = s.member.memberRanks.find((mr) => mr.rankSystem.discipline === newRank.discipline);
              return !r || r.rankSystem.order < newRank.order;
            })
            .map((s) => s.memberId);
        }
      }
      if (wantsRoster) {
        const rosterIds = (parsed.data.roster ?? []).map((m) => m.memberId);
        const subs = await tx.classSubscription.findMany({
          where: { classId: id, memberId: { notIn: rosterIds } },
          select: { memberId: true },
        });
        losers = [...losers, ...subs.map((s) => s.memberId)];
      }
      return Array.from(new Set(losers));
    });

    if (dryRun) {
      return NextResponse.json({ dryRun: true, affectedMemberIds: affected });
    }

    const updated = await withTenantContext(tenantId, async (tx) => {
      // Mutual exclusion: setting rank fields clears roster; setting roster clears rank fields.
      if (wantsRankGate) {
        await tx.classRoster.deleteMany({ where: { classId: id } });
      }
      if (wantsRoster) {
        await tx.classRoster.deleteMany({ where: { classId: id } });
        const rows = (parsed.data.roster ?? []).map((m) => ({
          tenantId,
          classId: id,
          memberId: m.memberId,
          addedByUserId: session.user.id,
        }));
        if (rows.length > 0) {
          await tx.classRoster.createMany({ data: rows, skipDuplicates: true });
        }
      }
      // Cascade-cancel ClassSubscription rows for members losing access.
      if (affected.length > 0) {
        await tx.classSubscription.deleteMany({
          where: { classId: id, memberId: { in: affected } },
        });
      }
      // Strip the API-layer-only `roster` field before passing to Prisma's class.update.
      const { roster: _r, ...classFields } = parsed.data;
      // When roster mode is requested, clear the rank fields explicitly.
      if (wantsRoster) {
        classFields.requiredRankId = null;
        classFields.maxRankId = null;
      }
      const r = await tx.class.updateMany({
        where: { id, tenantId },
        data: classFields,
      });
      if (r.count === 0) return null;
      return tx.class.findFirst({
        where: { id, tenantId },
        include: { schedules: { where: { isActive: true } }, requiredRank: true, maxRank: true, coachUser: { select: { id: true, name: true } } },
      });
    });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.updated",
      entityType: "Class",
      entityId: id,
      metadata: {
        fields: Object.keys(parsed.data),
        cascadeCancelledSubscriptions: affected.length,
      },
      req,
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Failed to update class" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  // Lane 1 iter-1 CSRF-sweep [High]: assertSameOrigin guard. Inserted by the
  // bulk-fix script in audit/loop-fixes-01-dashboard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const tenantId = session.user.tenantId;
  const force = new URL(req.url).searchParams.get("force") === "true";

  try {
    // Task 6: precondition counts. Refuse delete if attendance OR roster exists, unless ?force=true.
    const [attendanceCount, rosterCount] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.attendanceRecord.count({ where: { classInstance: { class: { id } } } }),
        tx.classRoster.count({ where: { classId: id } }),
      ]),
    );

    if (!force && (attendanceCount > 0 || rosterCount > 0)) {
      return NextResponse.json(
        {
          error: "Class has attendance or roster history. Pass ?force=true to delete anyway.",
          attendanceCount,
          rosterCount,
        },
        { status: 409 },
      );
    }

    // Soft-delete by setting isActive = false
    const result = await withTenantContext(tenantId, (tx) =>
      tx.class.updateMany({
        where: { id, tenantId },
        data: { isActive: false },
      }),
    );

    if (result.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.deleted",
      entityType: "Class",
      entityId: id,
      metadata: { soft: true, force, attendanceCount, rosterCount },
      req,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete class" }, { status: 500 });
  }
}
