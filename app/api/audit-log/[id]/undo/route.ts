import { NextResponse } from "next/server";
import { requireApiOwner } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { withTenantContext } from "@/lib/prisma-tenant";
import { decideUndo, UndoStale, type AuditRowLike } from "@/lib/undo-registry";
import { executeUndo, UndoBatchFailed } from "@/lib/undo-batch";
import { auditLabel, UNDO_PREFIX } from "@/lib/audit-labels";

export const runtime = "nodejs";

/**
 * POST /api/audit-log/[id]/undo — reverse ONE staff action (owner only).
 *
 * The registry (lib/undo-registry.ts) decides whether the row carries enough
 * to put the entity back and refuses with a sentence when it does not. The
 * reversal and its own `undo.<action>` audit row commit in one transaction;
 * if the entity has changed since the action, nothing is written and the
 * owner is told so (409).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  const rl = await checkRateLimit(`audit-undo:${tenantId}`, 60, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ ok: false, error: "Too many undos in an hour. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } });
  }

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const row = await tx.auditLog.findFirst({ where: { id, tenantId } });
      if (!row) return { kind: "not-found" as const };
      const already = await tx.auditLog.findFirst({
        where: { tenantId, action: { startsWith: UNDO_PREFIX }, metadata: { path: ["undoneAuditId"], equals: id } },
        select: { id: true },
      });
      const decision = decideUndo(row as AuditRowLike, !!already);
      if (!decision.ok) return { kind: "refused" as const, reason: decision.reason };
      await executeUndo(tx, [{ row: row as AuditRowLike, decision }], {
        tenantId,
        userId,
        ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: req.headers.get("user-agent"),
      });
      return { kind: "ok" as const, action: row.action };
    });

    if (result.kind === "not-found") return apiError("That activity row was not found.", 404);
    if (result.kind === "refused") return NextResponse.json({ ok: false, error: result.reason }, { status: 409 });
    return NextResponse.json({ ok: true, message: `Undone: ${auditLabel(result.action).toLowerCase()}.` });
  } catch (e) {
    if (e instanceof UndoBatchFailed || e instanceof UndoStale) {
      const reason = e instanceof UndoBatchFailed ? e.reason : e.message;
      return NextResponse.json({ ok: false, error: reason }, { status: 409 });
    }
    return apiError("Couldn't undo that — nothing has changed.", 500, e, "audit-log/undo", { tenantId, userId, req });
  }
}
