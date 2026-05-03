/**
 * POST /api/checkin
 * Records a member attendance for a class instance.
 * Can be called by: staff (admin tool — any method), or authenticated member (self).
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { parseTime } from "@/lib/class-time";

const CHECKIN_WINDOW_BEFORE_MIN = 30;
const CHECKIN_WINDOW_AFTER_MIN = 30;

export const checkinSchema = z.object({
  classInstanceId: z.string().min(1),
  memberId: z.string().optional(),  // admin flow only — self flow resolves from session
  checkInMethod: z.enum(["admin", "self", "auto"]).default("admin"),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = checkinSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { classInstanceId, memberId, checkInMethod } = parsed.data;
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated staff or member
  const resolvedTenantId: string = session.user.tenantId;
  let resolvedMemberId: string;

  if (memberId) {
    // Admin checking in a specific member — validate member belongs to this tenant
    const isStaff = ["owner", "manager", "coach", "admin"].includes(session.user.role);
    if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const adminMember = await withTenantContext(resolvedTenantId, (tx) =>
      tx.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
      }),
    );
    if (!adminMember) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = adminMember.id;
  } else {
    // Member self-check-in — look up their member record by session email
    const member = await withTenantContext(resolvedTenantId, (tx) =>
      tx.member.findFirst({
        where: { tenantId: session.user.tenantId, email: session.user.email! },
      }),
    );
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = member.id;
  }

  // Validate the class instance belongs to this tenant
  const instance = await withTenantContext(resolvedTenantId, (tx) =>
    tx.classInstance.findFirst({
      where: { id: classInstanceId, class: { tenantId: resolvedTenantId } },
      include: {
        class: {
          include: {
            requiredRank: { select: { order: true } },
            maxRank: { select: { order: true } },
          },
        },
      },
    }),
  );
  if (!instance) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  if (instance.isCancelled) return NextResponse.json({ error: "Class has been cancelled" }, { status: 409 });

  // Sprint 4-A US-402: enforce maxRank/requiredRank for self check-in (admin/auto bypass).
  // Unranked members fail-closed only against requiredRank — they're allowed under maxRank.
  if (checkInMethod === "self") {
    if (instance.class.requiredRankId || instance.class.maxRankId) {
      const memberRank = await withTenantContext(resolvedTenantId, (tx) =>
        tx.memberRank.findFirst({
          where: { memberId: resolvedMemberId },
          orderBy: { rankSystem: { order: "desc" } },
          select: { rankSystem: { select: { order: true } } },
        }),
      );
      const memberOrder = memberRank?.rankSystem.order ?? null;
      if (instance.class.requiredRankId && instance.class.requiredRank) {
        if (memberOrder === null || memberOrder < instance.class.requiredRank.order) {
          return NextResponse.json({ error: "Your current rank is below this class's required rank." }, { status: 403 });
        }
      }
      if (instance.class.maxRankId && instance.class.maxRank && memberOrder !== null) {
        if (memberOrder > instance.class.maxRank.order) {
          return NextResponse.json({ error: "Your current rank is above this class's maximum rank." }, { status: 403 });
        }
      }
    }
  }

  // Enforce class time window for self check-in (admin/auto can override).
  if (checkInMethod === "self") {
    const now = new Date();
    const startsAt = parseTime(instance.startTime, instance.date);
    const endsAt = parseTime(instance.endTime, instance.date);
    const windowOpen = new Date(startsAt.getTime() - CHECKIN_WINDOW_BEFORE_MIN * 60_000);
    const windowClose = new Date(endsAt.getTime() + CHECKIN_WINDOW_AFTER_MIN * 60_000);
    if (now < windowOpen || now > windowClose) {
      return NextResponse.json(
        { error: `Check-in is only available from ${CHECKIN_WINDOW_BEFORE_MIN} min before until ${CHECKIN_WINDOW_AFTER_MIN} min after class.` },
        { status: 409 },
      );
    }
  }

  // Decide whether the booking is covered by a recurring subscription, a class pack, or neither.
  // Admin / auto check-ins bypass the gate (owner override).
  const requiresCoverage = checkInMethod === "self";
  const memberRecord = await withTenantContext(resolvedTenantId, (tx) =>
    tx.member.findUnique({
      where: { id: resolvedMemberId },
      select: { paymentStatus: true, stripeSubscriptionId: true },
    }),
  );
  const hasActiveSubscription = !!memberRecord?.stripeSubscriptionId && memberRecord.paymentStatus === "paid";

  try {
    if (requiresCoverage && !hasActiveSubscription) {
      // Try to redeem a class pack atomically
      const result = await withTenantContext(resolvedTenantId, async (tx) => {
        const activePack = await tx.memberClassPack.findFirst({
          where: {
            memberId: resolvedMemberId,
            tenantId: resolvedTenantId,
            status: "active",
            creditsRemaining: { gt: 0 },
            expiresAt: { gt: new Date() },
          },
          orderBy: { expiresAt: "asc" },
        });

        if (!activePack) {
          return { kind: "no_coverage" as const };
        }

        const updatedPack = await tx.memberClassPack.update({
          where: { id: activePack.id },
          data: { creditsRemaining: { decrement: 1 } },
        });

        const record = await tx.attendanceRecord.create({
          data: {
            tenantId: resolvedTenantId,
            memberId: resolvedMemberId,
            classInstanceId,
            checkInMethod,
          },
        });

        await tx.classPackRedemption.create({
          data: {
            memberPackId: activePack.id,
            attendanceRecordId: record.id,
          },
        });

        return {
          kind: "pack_redeemed" as const,
          record,
          creditsRemaining: updatedPack.creditsRemaining,
          packName: activePack.packId,
        };
      });

      if (result.kind === "no_coverage") {
        return NextResponse.json(
          { error: "No active membership or class pack credits. Buy a pack or contact your gym." },
          { status: 402 },
        );
      }
      return NextResponse.json({
        success: true,
        record: result.record,
        coverage: { kind: "pack", creditsRemaining: result.creditsRemaining },
      }, { status: 201 });
    }

    const record = await withTenantContext(resolvedTenantId, (tx) =>
      tx.attendanceRecord.create({
        data: {
          tenantId: resolvedTenantId,
          memberId: resolvedMemberId,
          classInstanceId,
          checkInMethod,
        },
      }),
    );
    return NextResponse.json({
      success: true,
      record,
      coverage: { kind: hasActiveSubscription ? "subscription" : "manual" },
    }, { status: 201 });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "Already checked in" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isStaff = ["owner", "manager", "coach", "admin"].includes(session.user.role);
  if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const classInstanceId = searchParams.get("classInstanceId");
  const memberId = searchParams.get("memberId");

  if (!classInstanceId || !memberId) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  try {
    await withTenantContext(session.user.tenantId, (tx) =>
      tx.attendanceRecord.deleteMany({
        where: { classInstanceId, memberId, classInstance: { class: { tenantId: session.user.tenantId } } },
      }),
    );
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "attendance.override",
      entityType: "AttendanceRecord",
      entityId: `${classInstanceId}:${memberId}`,
      metadata: { classInstanceId, memberId },
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove check-in" }, { status: 500 });
  }
}
