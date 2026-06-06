// Team Tasks v2 — list + create.
//
// GET  /api/tasks  → open tasks where (assignedToId = me) OR (createdById = me)
//                    Staff-only (member assignees fetch via /api/member/tasks).
// POST /api/tasks  → discriminated-union create:
//                    - { kind: "staff_task", title, assignedToId }    legacy staff→staff
//                    - { kind: "member_note", title, body, assigneeMemberId, sendPush? }
//                      feat/member-tickable-notes Phase 5 — staff→member tickable action
//
// Both gated to staff (owner | manager | coach | admin). Members never reach
// here. Tenant scope is enforced via withTenantContext + explicit where filter.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { STAFF_ROLES } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { notesField } from "@/lib/schemas/notes-sanitiser";
import { notifyMemberAction } from "@/lib/notify-member-action";

export const runtime = "nodejs";

// Legacy create payload — staff sends a 140-char title to another staff user.
// Backwards compatible: clients that omit `kind` are treated as staff_task so
// the existing AddTaskModal contract still works.
const staffTaskSchema = z.object({
  kind: z.literal("staff_task").default("staff_task"),
  title: z.string().min(1).max(140),
  assignedToId: z.string().cuid(),
});

// feat/member-tickable-notes Phase 5 — new create payload for staff→member
// tickable actions. `body` runs through the shared notesField sanitiser
// (strips control + zero-width chars, rejects oversize, coerces empty→null).
// We then re-coerce to "" in the route because body is REQUIRED for member_note
// (DB CHECK constraint Task_member_note_check); a whitespace-only payload is
// a 400 from the schema before it reaches the DB.
const memberNoteSchema = z.object({
  kind: z.literal("member_note"),
  title: z.string().min(1).max(140),
  body: z.string().min(1).max(1000),
  assigneeMemberId: z.string().cuid(),
  sendPush: z.boolean().optional().default(true),
});

const createSchema = z.union([memberNoteSchema, staffTaskSchema]);

const bodySanitiser = notesField(1000);
const titleSanitiser = notesField(140);

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // Staff view: shows tasks I'm involved with (mine + ones I sent). Includes
  // member_note tasks I authored — they appear here as "sent items" so staff
  // can chase up if a member hasn't ticked theirs.
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
        body: true,
        kind: true,
        status: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
        assigneeMember: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  // Audit iter-2 M2-3: explicit cache directive for per-user, always-live data.
  return NextResponse.json(tasks, {
    headers: { "Cache-Control": "private, no-store" },
  });
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
  const payload = parsed.data;

  // ──────────────────────────────────────────────────────────────────────
  // member_note branch
  // ──────────────────────────────────────────────────────────────────────
  if (payload.kind === "member_note") {
    // Sanitise title + body through the shared notes sanitiser — strips
    // control + zero-width chars. After strip, both must remain non-empty
    // (member_note requires a body per the DB CHECK constraint).
    const cleanTitle = titleSanitiser.safeParse(payload.title);
    const cleanBody = bodySanitiser.safeParse(payload.body);
    if (!cleanTitle.success || !cleanBody.success || !cleanTitle.data || !cleanBody.data) {
      return NextResponse.json(
        { error: "Title and body must contain printable text after sanitisation." },
        { status: 400 },
      );
    }

    try {
      const result = await withTenantContext(tenantId, async (tx) => {
        const member = await tx.member.findFirst({
          where: { id: payload.assigneeMemberId, tenantId },
          select: { id: true, name: true },
        });
        if (!member) return { kind: "no-member" as const };

        try {
          const created = await tx.task.create({
            data: {
              tenantId,
              createdById,
              assigneeMemberId: payload.assigneeMemberId,
              kind: "member_note",
              title: cleanTitle.data!,
              body: cleanBody.data!,
            },
            select: {
              id: true,
              title: true,
              body: true,
              kind: true,
              status: true,
              createdAt: true,
              createdBy: { select: { id: true, name: true } },
              assigneeMember: { select: { id: true, name: true } },
            },
          });
          return { kind: "created" as const, task: created };
        } catch (e: unknown) {
          // P2002 = the partial unique index Task_member_note_open_unique
          // matched — there's already an OPEN member_note with the same
          // (tenantId, assigneeMemberId, lower(title)). Return 409 with the
          // existing task id so the UI can link/highlight it instead of
          // double-sending.
          if ((e as { code?: string }).code === "P2002") {
            const existing = await tx.task.findFirst({
              where: {
                tenantId,
                assigneeMemberId: payload.assigneeMemberId,
                kind: "member_note",
                status: "open",
                title: { equals: cleanTitle.data!, mode: "insensitive" },
              },
              select: { id: true, title: true, createdAt: true },
            });
            return { kind: "duplicate" as const, existing: existing ?? null };
          }
          throw e;
        }
      });

      if (result.kind === "no-member") {
        return NextResponse.json({ error: "Member not found in this gym" }, { status: 400 });
      }
      if (result.kind === "duplicate") {
        return NextResponse.json(
          {
            error: "A similar action is already open for this member. Wait for them to tick it, or edit/cancel the existing one.",
            existingTask: result.existing,
          },
          { status: 409 },
        );
      }

      // Audit log — log field names + ids, never the body content (GDPR).
      await logAudit({
        tenantId,
        userId: createdById,
        action: "task.member_note.create",
        entityType: "Task",
        entityId: result.task.id,
        metadata: {
          assigneeMemberId: payload.assigneeMemberId,
          titleLength: cleanTitle.data!.length,
          bodyLength: cleanBody.data!.length,
        },
        req,
      });

      // Fire-and-forget notification bundle. Errors do not break the response.
      void notifyMemberAction({
        tenantId,
        memberId: payload.assigneeMemberId,
        title: cleanTitle.data!,
        body: cleanBody.data!,
        fromName: result.task.createdBy?.name ?? null,
        skipPush: payload.sendPush === false,
        req,
      });

      return NextResponse.json(result.task, { status: 201 });
    } catch {
      return NextResponse.json({ error: "Failed to send action" }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // staff_task branch (legacy)
  // ──────────────────────────────────────────────────────────────────────
  const { title, assignedToId } = payload;

  // Block self-assignment: a task assigned to yourself is just a personal note —
  // the team-tasks surface is specifically for sending work to teammates. UI
  // already excludes the caller from the dropdown; this guards the raw API too.
  if (assignedToId === createdById) {
    return NextResponse.json({ error: "Cannot assign a task to yourself" }, { status: 400 });
  }

  try {
    const created = await withTenantContext(tenantId, async (tx) => {
      const assignee = await tx.user.findFirst({
        where: { id: assignedToId, tenantId, role: { in: [...STAFF_ROLES] } },
        select: { id: true },
      });
      if (!assignee) return null;
      return tx.task.create({
        data: {
          tenantId,
          createdById,
          assignedToId,
          kind: "staff_task",
          title: title.trim(),
        },
        select: {
          id: true,
          title: true,
          body: true,
          kind: true,
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
    // Lane 1 iter-2 L1-I2-S-04 [High] fix: audit log on staff_task creation.
    // The member_note branch above already logs; this branch was missed.
    await logAudit({
      tenantId,
      userId: createdById,
      action: "task.staff_task.create",
      entityType: "Task",
      entityId: created.id,
      metadata: { assignedToId, titleLength: title.trim().length },
      req,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
