/**
 * POST /api/checkin
 * Records a member attendance for a class instance.
 * Can be called by: admin (any method), member (self), or QR scan (requires memberId in body).
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

export const checkinSchema = z.object({
  classInstanceId: z.string().min(1),
  memberId: z.string().optional(), // required for admin check-in; omit for self-check-in
  checkInMethod: z.enum(["qr", "admin", "self", "auto"]).default("admin"),
  tenantSlug: z.string().optional(), // required for QR (unauthenticated) flow
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

  const { classInstanceId, memberId, checkInMethod, tenantSlug } = parsed.data;
  const session = await auth();

  let resolvedTenantId: string;
  let resolvedMemberId: string;

  if (checkInMethod === "qr" && tenantSlug && memberId) {
    // QR flow — no session required, but validate instance and member belong to tenant
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) return NextResponse.json({ error: "Gym not found" }, { status: 404 });
    resolvedTenantId = tenant.id;
    const qrMember = await prisma.member.findFirst({ where: { id: memberId, tenantId: tenant.id } });
    if (!qrMember) return NextResponse.json({ error: "Member not found" }, { status: 404 });
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
    include: { class: true },
  });
  if (!instance) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  if (instance.isCancelled) return NextResponse.json({ error: "Class has been cancelled" }, { status: 409 });

  try {
    const record = await prisma.attendanceRecord.create({
      data: {
        memberId: resolvedMemberId,
        classInstanceId,
        checkInMethod,
      },
    });
    return NextResponse.json({ success: true, record }, { status: 201 });
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
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove check-in" }, { status: 500 });
  }
}
