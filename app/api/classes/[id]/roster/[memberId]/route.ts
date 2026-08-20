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
    // Both deletes are scoped to the CALLER'S tenant. Previously they keyed on
    // (classId, memberId) straight from the URL with no tenant predicate and no
    // ownership check anywhere in the handler, so an owner/manager/admin of gym
    // A holding a gym B classId + memberId could remove that member from gym B's
    // class and cancel their subscription. The audit row below is written
    // against the CALLER's tenantId, so gym B's log would show nothing either.
    //
    // ClassRoster carries tenantId, so it filters directly. ClassSubscription
    // does not, so it scopes through the member relation.
    const removed = await withTenantContext(tenantId, async (tx) => {
      const result = await tx.classRoster.deleteMany({
        where: { classId: id, memberId, tenantId },
      });
      if (result.count === 0) return 0;
      await tx.classSubscription.deleteMany({
        where: { classId: id, memberId, member: { tenantId } },
      });
      return result.count;
    });

    if (removed === 0) {
      return NextResponse.json({ error: "Roster entry not found" }, { status: 404 });
    }

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
