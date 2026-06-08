/**
 * POST /api/member/tasks/[id]/complete
 *
 * Member ticks one of their own `member_note` tasks. Atomic updateMany
 * guarded by (id, tenantId, assigneeMemberId, status='open'); on
 * 0-rows-affected the route disambiguates with a findFirst → 404 / 409.
 *
 * System actions (synthetic ids starting with `sys:`) cannot be ticked here —
 * they live and die by their underlying condition. The route rejects them
 * with 400 so a malformed client cannot trigger an audit-log entry per tap.
 *
 * Auth: requireSession (any logged-in user with a memberId). Tenant scope is
 * enforced both via `assigneeMemberId = me` AND `tenantId = session.tenantId`
 * — defence in depth against a forged member id from another tenant.
 *
 * CSRF: same-origin assertion via assertSameOrigin — pattern matches every
 * other mutating API in the repo.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberId = (session.user as { memberId?: string }).memberId;
  if (!memberId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // System action sentinel — never write-through to the DB.
  if (id.startsWith("sys:")) {
    return NextResponse.json(
      { error: "System actions resolve automatically when their condition is fixed." },
      { status: 400 },
    );
  }

  const tenantId = session.user.tenantId;
  const completedById = session.user.id ?? null;

  const result = await withTenantContext(tenantId, async (tx) => {
    // Atomic guard: only count an update if the row is OPEN and addressed
    // to this member. Eliminates double-tick races and prevents one member
    // ticking another member's task by guessing the id.
    const updated = await tx.task.updateMany({
      where: {
        id,
        tenantId,
        assigneeMemberId: memberId,
        kind: "member_note",
        status: "open",
      },
      data: {
        status: "done",
        completedAt: new Date(),
        completedById,
      },
    });
    if (updated.count === 1) return { kind: "completed" as const };

    // No row updated — disambiguate so the client gets the right status code.
    const existing = await tx.task.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, assigneeMemberId: true, kind: true },
    });
    if (!existing) return { kind: "not-found" as const };
    if (existing.kind !== "member_note") return { kind: "wrong-kind" as const };
    if (existing.assigneeMemberId !== memberId) return { kind: "wrong-member" as const };
    if (existing.status === "done") return { kind: "already-done" as const };
    return { kind: "not-found" as const };
  });

  if (result.kind === "completed") {
    await logAudit({
      tenantId,
      userId: completedById,
      action: "task.member_note.complete",
      entityType: "Task",
      entityId: id,
      metadata: { memberId },
      req,
    });
    return NextResponse.json({ ok: true });
  }

  // Map outcomes to the right status. We deliberately return 404 for both
  // "not-found" and "wrong-member" so a member cannot probe other tenants'
  // task ids — the response shape is identical.
  if (result.kind === "already-done") {
    return NextResponse.json(
      { error: "This action is already marked done." },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
