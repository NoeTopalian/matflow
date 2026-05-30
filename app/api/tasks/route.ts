// Team Tasks MVP v1 — list + create.
//
// GET  /api/tasks  → open tasks where (assignedToId = me) OR (createdById = me)
// POST /api/tasks  → create a task, body { title, assignedToId }
//
// Both gated to staff (owner | manager | coach | admin). Members never reach
// here. Tenant scope is enforced via withTenantContext + explicit where filter.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { STAFF_ROLES } from "@/lib/authz";

export const runtime = "nodejs";

const createSchema = z.object({
  title: z.string().min(1).max(140),
  assignedToId: z.string().cuid(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  const tasks = await withTenantContext(tenantId, (tx) =>
    tx.task.findMany({
      where: {
        tenantId,
        status: "open",
        OR: [{ assignedToId: userId }, { createdById: userId }],
      },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(tasks);
}

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const tenantId = session.user.tenantId;
  const createdById = session.user.id;
  const { title, assignedToId } = parsed.data;

  // Block self-assignment: a task assigned to yourself is just a personal note —
  // the team-tasks surface is specifically for sending work to teammates. UI
  // already excludes the caller from the dropdown; this guards the raw API too.
  if (assignedToId === createdById) {
    return NextResponse.json({ error: "Cannot assign a task to yourself" }, { status: 400 });
  }

  // Verify the assignee is a STAFF user in the same tenant — never accept a
  // forged userId from another tenant, a member id, or (defensively) a non-staff
  // role even though the User table is staff-only by CHECK constraint today.
  try {
    const created = await withTenantContext(tenantId, async (tx) => {
      const assignee = await tx.user.findFirst({
        where: { id: assignedToId, tenantId, role: { in: [...STAFF_ROLES] } },
        select: { id: true },
      });
      if (!assignee) return null;
      return tx.task.create({
        data: { tenantId, createdById, assignedToId, title: title.trim() },
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
        },
      });
    });
    if (!created) {
      return NextResponse.json({ error: "Assignee not found in this gym" }, { status: 400 });
    }
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
