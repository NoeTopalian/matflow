import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { restorePackCreditsForAttendance } from "@/lib/checkin";

const schema = z.object({
  memberId: z.string().min(1),
  attended: z.boolean(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const { tenantId, userId, role } = await requireStaff();
  const { id: classInstanceId } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const isPrivileged = ["owner", "manager", "admin"].includes(role);

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const instance = await tx.classInstance.findFirst({
        where: {
          id: classInstanceId,
          class: {
            tenantId,
            ...(isPrivileged ? {} : { instructorId: userId }),
          },
        },
        select: { id: true },
      });
      if (!instance) return "no-instance" as const;
      const member = await tx.member.findFirst({
        where: { id: parsed.data.memberId, tenantId },
        select: { id: true },
      });
      if (!member) return "no-member" as const;
      if (parsed.data.attended) {
        await tx.attendanceRecord.upsert({
          where: { memberId_classInstanceId: { memberId: member.id, classInstanceId } },
          create: { tenantId, memberId: member.id, classInstanceId, checkInMethod: "admin" },
          update: { checkInMethod: "admin" },
        });
      } else {
        // Unmark is the inverse of a check-in: if the attendance was covered
        // by a class pack, the credit goes back in the same transaction
        // (audit P2-1). Ids are fetched first so the redemption rows can be
        // found before the attendance rows disappear.
        const records = await tx.attendanceRecord.findMany({
          where: { memberId: member.id, classInstanceId },
          select: { id: true },
        });
        if (records.length > 0) {
          const ids = records.map((r) => r.id);
          await restorePackCreditsForAttendance(tx, ids);
          await tx.attendanceRecord.deleteMany({ where: { id: { in: ids } } });
        }
      }
      return { memberId: member.id };
    });

    if (outcome === "no-instance") return NextResponse.json({ error: "Class not found" }, { status: 404 });
    if (outcome === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });

    await logAudit({
      tenantId, userId,
      action: parsed.data.attended ? "attendance.mark" : "attendance.unmark",
      entityType: "AttendanceRecord",
      entityId: `${classInstanceId}:${outcome.memberId}`,
      metadata: { classInstanceId, memberId: outcome.memberId },
      req,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to update attendance" }, { status: 500 });
  }
}
