/**
 * PATCH /api/classes/[id]/instances/[instanceId] — cancel or restore ONE
 * session of a recurring class (J33).
 *
 * `ClassInstance.isCancelled` has been read by five surfaces since before this
 * route existed — `lib/checkin.ts:148`, `app/api/checkin/card/route.ts`,
 * `/api/coach/today`, `/api/kiosk/[token]/classes`, `/api/member/schedule` —
 * and written by NOTHING. A gym could not call off tonight's class. The only
 * thing available was deleting the instance, which also destroys its register.
 *
 * So this is a writer and a control, not a feature: the readers were already
 * there and correct.
 *
 * Cancel, not delete, is the whole point. The row survives with its attendance
 * intact, and un-cancelling is the same call with `false` — a mis-click is
 * recoverable, which a `deleteMany` never is.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string; instanceId: string }> };

const cancelSchema = z.object({
  isCancelled: z.boolean(),
  // Shown to members beside the struck-through session, so it is bounded and
  // trimmed. 200 characters is a sentence — "Coach ill, back Thursday" — not a
  // notice board.
  cancellationReason: z.string().trim().max(200).optional().nullable(),
});

export async function PATCH(req: Request, { params }: Params) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  // Owner and manager only, matching POST /api/classes and the Generate
  // buttons. A coach marks the register; calling off a session that members
  // have paid for and planned around is the club's decision, not the mat's.
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;

  const { id, instanceId } = await params;
  const { tenantId, userId } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      // OWNERSHIP BEFORE DISCLOSURE. The instance is resolved through its class
      // relation with the tenant predicate, and NOTHING about it — not that it
      // exists, not its current state — is read into the response before that
      // resolves. A foreign id is a bare 404, exactly as the round-1
      // `DELETE /api/classes/[id]` fix installed, never a 403 that confirms the
      // id is real. ClassInstance carries no tenantId of its own, so the class
      // relation IS the boundary.
      const owned = await tx.classInstance.findFirst({
        where: { id: instanceId, classId: id, class: { tenantId } },
        select: { id: true, isCancelled: true, date: true, startTime: true },
      });
      if (!owned) return null;

      // Idempotent: cancelling an already-cancelled session is a 200 and no
      // second audit row, so a double-tap on a phone cannot write twice.
      if (owned.isCancelled === parsed.data.isCancelled) {
        return { instance: owned, changed: false };
      }

      await tx.classInstance.updateMany({
        where: { id: instanceId, classId: id, class: { tenantId } },
        data: {
          isCancelled: parsed.data.isCancelled,
          // Restoring clears the reason — leaving yesterday's "Coach ill"
          // attached to a session that is running again is a lie the next
          // reader would repeat.
          cancellationReason: parsed.data.isCancelled
            ? parsed.data.cancellationReason || null
            : null,
        },
      });
      return { instance: owned, changed: true };
    });

    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (result.changed) {
      await logAudit({
        tenantId,
        userId,
        action: parsed.data.isCancelled ? "class.instance_cancelled" : "class.instance_restored",
        entityType: "ClassInstance",
        entityId: instanceId,
        metadata: {
          classId: id,
          date: result.instance.date.toISOString(),
          startTime: result.instance.startTime,
          reason: parsed.data.isCancelled ? parsed.data.cancellationReason || null : null,
        },
        req,
      });
    }

    return NextResponse.json({
      id: instanceId,
      isCancelled: parsed.data.isCancelled,
      cancellationReason: parsed.data.isCancelled
        ? parsed.data.cancellationReason || null
        : null,
      changed: result.changed,
    });
  } catch (e) {
    return apiError("Failed to update this session", 500, e, "classes/instances/PATCH", {
      req,
      tenantId,
      userId,
    });
  }
}
