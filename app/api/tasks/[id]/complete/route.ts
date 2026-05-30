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

export const runtime = "nodejs";

const STAFF_ROLES = ["owner", "manager", "coach", "admin"];

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

  const result = await withTenantContext(tenantId, async (tx) => {
    const task = await tx.task.findFirst({
      where: { id: taskId, tenantId },
      select: { id: true, assignedToId: true, status: true },
    });
    if (!task) return { kind: "not-found" as const };
    if (task.status !== "open") return { kind: "not-open" as const };
    if (task.assignedToId !== userId && !isOwner) return { kind: "forbidden" as const };

    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "done", completedAt: new Date() },
      select: {
        id: true,
        title: true,
        status: true,
        completedAt: true,
      },
    });
    return { kind: "ok" as const, task: updated };
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
