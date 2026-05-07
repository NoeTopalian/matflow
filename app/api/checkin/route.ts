/**
 * POST /api/checkin
 * Records a member attendance for a class instance.
 * Can be called by: staff (admin tool — any method), or authenticated member (self).
 *
 * Business rules live in lib/checkin.ts so the public kiosk route
 * (POST /api/kiosk/[token]/checkin) can share them without re-implementing
 * rank gates, time windows, or class-pack redemption.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { performCheckin } from "@/lib/checkin";
import { assertSameOrigin } from "@/lib/csrf";

export const checkinSchema = z.object({
  classInstanceId: z.string().min(1),
  memberId: z.string().optional(),  // admin flow only — self flow resolves from session
  checkInMethod: z.enum(["admin", "self", "auto"]).default("admin"),
});

export async function POST(req: Request) {
  // Defence-in-depth CSRF guard. SameSite=Lax + JSON CORS preflight already
  // mitigate most cross-origin POSTs, but the codebase's stated policy applies
  // assertSameOrigin to every state-mutating route — this one was missed.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

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

  const tenantId: string = session.user.tenantId;
  let resolvedMemberId: string;
  // Server-side determination of the effective method, NOT trusting the
  // client-supplied value. Without this, a member could POST
  // { checkInMethod: "admin" } with no memberId and reach the self path
  // with all enforcement disabled — bypass-of-rank-gate / coverage / time-window
  // (HIGH severity finding, security audit 2026-05-07).
  let effectiveMethod: "admin" | "self" | "auto";

  if (memberId) {
    // Admin checking in a specific member — validate member belongs to this tenant
    const isStaff = ["owner", "manager", "coach", "admin"].includes(session.user.role);
    if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const adminMember = await withTenantContext(tenantId, (tx) =>
      tx.member.findFirst({ where: { id: memberId, tenantId } }),
    );
    if (!adminMember) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = adminMember.id;
    // Staff path: trust the staff-supplied method (admin / auto for special flows).
    effectiveMethod = checkInMethod;
  } else {
    // Member self-check-in — look up their member record by session email
    const member = await withTenantContext(tenantId, (tx) =>
      tx.member.findFirst({ where: { tenantId, email: session.user.email! } }),
    );
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = member.id;
    // Self path: force "self" regardless of what the client sent. Otherwise a
    // member could send { checkInMethod: "admin" } and bypass enforcement.
    effectiveMethod = "self";
  }

  // Self-check-in: full rules. Admin / auto: bypass.
  const isSelf = effectiveMethod === "self";
  const result = await performCheckin({
    tenantId,
    memberId: resolvedMemberId,
    classInstanceId,
    method: effectiveMethod,
    enforceRankGate: isSelf,
    enforceTimeWindow: isSelf,
    requireCoverage: isSelf,
    // Record which staff user clicked "check in" so the attendance row can
    // show "by [admin name]". Only stamped on staff-driven check-ins.
    checkedInByUserId: effectiveMethod === "admin" ? session.user.id : null,
  });

  switch (result.kind) {
    case "success":
      return NextResponse.json({ success: true, record: result.record, coverage: result.coverage }, { status: 201 });
    case "class_not_found":
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    case "class_cancelled":
      return NextResponse.json({ error: "Class has been cancelled" }, { status: 409 });
    case "rank_below":
      return NextResponse.json({ error: "Your current rank is below this class's required rank." }, { status: 403 });
    case "rank_above":
      return NextResponse.json({ error: "Your current rank is above this class's maximum rank." }, { status: 403 });
    case "outside_window":
      return NextResponse.json(
        { error: "Check-in is only available from 30 min before until 30 min after class." },
        { status: 409 },
      );
    case "no_coverage":
      return NextResponse.json(
        { error: "No active membership or class pack credits. Buy a pack or contact your gym." },
        { status: 402 },
      );
    case "duplicate":
      return NextResponse.json({ error: "Already checked in" }, { status: 409 });
    case "member_not_found":
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    case "error":
      return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

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
