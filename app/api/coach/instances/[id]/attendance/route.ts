import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

const schema = z.object({
  memberId: z.string().min(1),
  attended: z.boolean(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId, role } = await requireStaff();
  const { id: classInstanceId } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const isPrivileged = ["owner", "manager", "admin"].includes(role);
  const instance = await prisma.classInstance.findFirst({
    where: {
      id: classInstanceId,
      class: {
        tenantId,
        ...(isPrivileged ? {} : { instructorId: userId }),
      },
    },
    select: { id: true },
  });
  if (!instance) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const member = await prisma.member.findFirst({
    where: { id: parsed.data.memberId, tenantId },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  try {
    if (parsed.data.attended) {
      await prisma.attendanceRecord.upsert({
        where: { memberId_classInstanceId: { memberId: member.id, classInstanceId } },
        create: { tenantId, memberId: member.id, classInstanceId, checkInMethod: "admin" },
        update: { checkInMethod: "admin" },
      });
      await logAudit({
        tenantId, userId,
        action: "attendance.mark",
        entityType: "AttendanceRecord",
        entityId: `${classInstanceId}:${member.id}`,
        metadata: { classInstanceId, memberId: member.id },
        req,
      });
    } else {
      await prisma.attendanceRecord.deleteMany({
        where: { memberId: member.id, classInstanceId },
      });
      await logAudit({
        tenantId, userId,
        action: "attendance.unmark",
        entityType: "AttendanceRecord",
        entityId: `${classInstanceId}:${member.id}`,
        metadata: { classInstanceId, memberId: member.id },
        req,
      });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to update attendance" }, { status: 500 });
  }
}
