/**
 * POST /api/checkin
 * Records a member attendance for a class instance.
 * Can be called by: admin (any method), member (self), or QR scan (requires HMAC token).
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyCheckinToken } from "@/lib/checkin-token";
import { logAudit } from "@/lib/audit-log";
import { parseTime } from "@/lib/class-time";

const CHECKIN_WINDOW_BEFORE_MIN = 30;
const CHECKIN_WINDOW_AFTER_MIN = 30;

export const checkinSchema = z.object({
  classInstanceId: z.string().min(1),
  memberId: z.string().optional(),  // admin / self flows
  token: z.string().optional(),     // QR flow (replaces raw memberId)
  checkInMethod: z.enum(["qr", "admin", "self", "auto"]).default("admin"),
  tenantSlug: z.string().optional(),
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

  const { classInstanceId, memberId, token, checkInMethod, tenantSlug } = parsed.data;
  const session = await auth();

  let resolvedTenantId: string;
  let resolvedMemberId: string;

  if (checkInMethod === "qr") {
    // QR flow: must use HMAC token, no raw memberId accepted
    if (!tenantSlug || !token) {
      return NextResponse.json({ error: "Missing check-in token" }, { status: 401 });
    }
    const ip = getClientIp(req);
    const rl = await checkRateLimit(`checkin:${ip}`, 10, 5 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many check-ins. Please slow down." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) return NextResponse.json({ error: "Invalid request" }, { status: 401 });
    const payload = verifyCheckinToken(token, tenant.id);
    if (!payload) return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    const qrMember = await prisma.member.findFirst({ where: { id: payload.memberId, tenantId: tenant.id } });
    if (!qrMember) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedTenantId = tenant.id;
    resolvedMemberId = qrMember.id;
  } else if (session) {
    // Authenticated staff or member
    resolvedTenantId = session.user.tenantId;
    if (memberId) {
      // Admin checking in a specific member — validate member belongs to this tenant
      const isStaff = ["owner", "manager", "coach", "admin"].includes(session.user.role);
      if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      const adminMember = await prisma.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
      });
      if (!adminMember) return NextResponse.json({ error: "Member not found" }, { status: 404 });
      resolvedMemberId = adminMember.id;
    } else {
      // Member self-check-in — look up their member record
      const member = await prisma.member.findFirst({
        where: { tenantId: session.user.tenantId, email: session.user.email! },
      });
      if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
      resolvedMemberId = member.id;
    }
  } else {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate the class instance belongs to this tenant
  const instance = await prisma.classInstance.findFirst({
    where: { id: classInstanceId, class: { tenantId: resolvedTenantId } },
    include: {
      class: {
        include: {
          requiredRank: { select: { order: true } },
          maxRank: { select: { order: true } },
        },
      },
    },
  });
  if (!instance) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  if (instance.isCancelled) return NextResponse.json({ error: "Class has been cancelled" }, { status: 409 });

  // Sprint 4-A US-402: enforce maxRank/requiredRank for self + QR check-in (admin/auto bypass).
  // Unranked members fail-closed only against requiredRank — they're allowed under maxRank.
  if (checkInMethod === "qr" || checkInMethod === "self") {
    if (instance.class.requiredRankId || instance.class.maxRankId) {
      const memberRank = await prisma.memberRank.findFirst({
        where: { memberId: resolvedMemberId },
        orderBy: { rankSystem: { order: "desc" } },
        select: { rankSystem: { select: { order: true } } },
      });
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

  // Enforce class time window for QR + self check-in (admin/auto can override).
  if (checkInMethod === "qr" || checkInMethod === "self") {
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
  const requiresCoverage = checkInMethod === "qr" || checkInMethod === "self";
  const memberRecord = await prisma.member.findUnique({
    where: { id: resolvedMemberId },
    select: { paymentStatus: true, stripeSubscriptionId: true },
  });
  const hasActiveSubscription = !!memberRecord?.stripeSubscriptionId && memberRecord.paymentStatus === "paid";

  try {
    if (requiresCoverage && !hasActiveSubscription) {
      // Try to redeem a class pack atomically
      const result = await prisma.$transaction(async (tx) => {
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

    const record = await prisma.attendanceRecord.create({
      data: {
        tenantId: resolvedTenantId,
        memberId: resolvedMemberId,
        classInstanceId,
        checkInMethod,
      },
    });
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
    await prisma.attendanceRecord.deleteMany({
      where: { classInstanceId, memberId, classInstance: { class: { tenantId: session.user.tenantId } } },
    });
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
