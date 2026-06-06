// Team Tasks MVP v1 — mark a task done.
//
// POST /api/tasks/[id]/complete
//
// Allowed by: the task's assignee (the natural case), OR the gym owner as an
// override for stuck cases. Anyone else gets 403 even though they can see the
// task in their list (e.g. the creator viewing their own backlog).

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { STAFF_ROLES } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const isOwner = session.user.role === "owner";
  const { id: taskId } = await params;

  // Atomic completion (audit H-2 fix + iter-2 H2-2 follow-up): use `update`
  // (not `updateMany`) with the full guarded WHERE clause. `update` returns
  // the row in ONE round-trip on the happy path. On no-match, Prisma throws
  // P2025 which we catch and disambiguate with a single findFirst for clear
  // 404 / 409 / 403 errors. Two round-trips only on the unhappy path.
  const result = await withTenantContext(tenantId, async (tx) => {
    try {
      const task = await tx.task.update({
        where: {
          id: taskId,
          tenantId,
          status: "open",
          ...(isOwner ? {} : { assignedToId: userId }),
        },
        data: { status: "done", completedAt: new Date() },
        select: { id: true, title: true, status: true, completedAt: true, kind: true, assignedToId: true, assigneeMemberId: true },
      });
      return { kind: "ok" as const, task };
    } catch (err) {
      // P2025 = "An operation failed because it depends on one or more records that were required but not found."
      const code = (err as { code?: string }).code;
      if (code !== "P2025") throw err;
      // Update affected 0 rows — disambiguate why for clearer client errors.
      const existing = await tx.task.findFirst({
        where: { id: taskId, tenantId },
        select: { id: true, status: true, assignedToId: true },
      });
      if (!existing) return { kind: "not-found" as const };
      if (existing.status !== "open") return { kind: "not-open" as const };
      // Audit iter-3 H3-1: assert the only remaining valid reason for P2025
      // (non-owner caller, task open, but assignedToId !== userId). If isOwner
      // is true, an open-in-tenant task should always match the WHERE — so
      // reaching here as owner is an invariant violation, not a 403. Surface
      // as a 500 rather than silently denying. Same for a non-owner whose
      // assignedToId DOES match — that should have succeeded too.
      if (!isOwner && existing.assignedToId !== userId) {
        return { kind: "forbidden" as const };
      }
      throw new Error(
        `Unexpected P2025 on task ${taskId} (tenant=${tenantId}, isOwner=${isOwner}, ` +
          `existing.assignedToId=${existing.assignedToId}, caller=${userId})`,
      );
    }
  });

  if (result.kind === "not-found") {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (result.kind === "not-open") {
    return NextResponse.json({ error: "Task is not open" }, { status: 409 });
  }
  if (result.kind === "forbidden") {
    return NextResponse.json({ error: "Only the assignee or the gym owner can complete this task" }, { status: 403 });
  }
  // Lane 1 iter-2 L1-I2-S-04 [High] fix: audit the closure. Per-task it
  // records the task kind (staff_task vs member_note), whether the
  // completion was an owner override of someone else's task, and whether
  // it was a member-targeted note (the note recipient cannot use this
  // route — they hit the member route — so this is always staff-side).
  await logAudit({
    tenantId,
    userId,
    action: "task.complete",
    entityType: "Task",
    entityId: result.task.id,
    metadata: {
      kind: result.task.kind,
      ownerOverride: isOwner && result.task.assignedToId !== null && result.task.assignedToId !== userId,
      hadMemberAssignee: result.task.assigneeMemberId !== null,
    },
    req,
  });
  return NextResponse.json({
    id: result.task.id,
    title: result.task.title,
    status: result.task.status,
    completedAt: result.task.completedAt,
  });
}
