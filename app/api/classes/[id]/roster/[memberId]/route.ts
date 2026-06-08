import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; memberId: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "admin"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id, memberId } = await ctx.params;
  const tenantId = session.user.tenantId;

  try {
    await withTenantContext(tenantId, async (tx) => {
      await tx.classRoster.delete({
        where: { classId_memberId: { classId: id, memberId } },
      });
      await tx.classSubscription.deleteMany({ where: { classId: id, memberId } });
    });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.roster.remove",
      entityType: "ClassRoster",
      entityId: `${id}:${memberId}`,
      metadata: { classId: id, memberId, cascadeCancelledSubscription: true },
      req,
    });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2025") {
      return NextResponse.json({ error: "Roster entry not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to remove from roster" }, { status: 500 });
  }
}
