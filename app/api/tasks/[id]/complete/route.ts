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

  // Atomic completion (audit H-2 fix): the WHERE clause embeds every guard —
  // tenant scope, open status, and assignee-or-owner authz. A concurrent
  // second request finds zero rows because status is now "done" and bails.
  // No findFirst+update race window.
  const result = await withTenantContext(tenantId, async (tx) => {
    const update = await tx.task.updateMany({
      where: {
        id: taskId,
        tenantId,
        status: "open",
        ...(isOwner ? {} : { assignedToId: userId }),
      },
      data: { status: "done", completedAt: new Date() },
    });
    if (update.count === 1) {
      const task = await tx.task.findFirst({
        where: { id: taskId, tenantId },
        select: { id: true, title: true, status: true, completedAt: true },
      });
      return { kind: "ok" as const, task };
    }
    // Update affected 0 rows — distinguish why for clearer client errors.
    const existing = await tx.task.findFirst({
      where: { id: taskId, tenantId },
      select: { id: true, status: true, assignedToId: true },
    });
    if (!existing) return { kind: "not-found" as const };
    if (existing.status !== "open") return { kind: "not-open" as const };
    return { kind: "forbidden" as const };
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
  return NextResponse.json(result.task);
}
