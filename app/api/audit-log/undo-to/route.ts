import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { withTenantContext } from "@/lib/prisma-tenant";
import { type AuditRowLike } from "@/lib/undo-registry";
import { planUndoTo, executeUndo, UndoBatchFailed } from "@/lib/undo-batch";
import { UNDO_PREFIX } from "@/lib/audit-labels";

export const runtime = "nodejs";

const bodySchema = z.object({
  userId: z.string().min(1).max(50),
  auditId: z.string().min(1).max(50),
  preview: z.boolean().optional().default(true),
  // On execute: the row ids the owner saw in the preview. If the plan has
  // changed since (the staff member acted in between), nothing is undone.
  expectedIds: z.array(z.string().min(1).max(50)).max(200).optional(),
});

/**
 * POST /api/audit-log/undo-to — "undo everything this person did since here"
 * (owner only). `preview: true` returns the plan (what will be put back, what
 * can't and why) and writes nothing; `preview: false` executes it newest→oldest
 * in ONE transaction — one stale row rolls the whole batch back and is named.
 *
 * Scope is one staff member's rows at or after the chosen row. Capped at 200
 * rows per batch so an owner cannot accidentally unwind a month in one click;
 * the plan says when the cap was hit.
 */
const MAX_ROWS = 200;

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId: ownerId } = gate;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError("userId and auditId are required.", 400);
  const { userId, auditId, preview, expectedIds } = parsed.data;
  if (!preview && !expectedIds) return apiError("Preview first — execute needs the rows you confirmed.", 400);

  if (!preview) {
    const rl = await checkRateLimit(`audit-undo-to:${tenantId}`, 10, 60 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ ok: false, error: "Too many batch undos in an hour. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } });
    }
  }

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const target = await tx.auditLog.findFirst({ where: { id: auditId, tenantId, userId } });
      if (!target) return { kind: "not-found" as const };
      const rows = await tx.auditLog.findMany({
        where: { tenantId, userId, createdAt: { gte: target.createdAt }, action: { not: { startsWith: UNDO_PREFIX } } },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS + 1,
      });
      const capped = rows.length > MAX_ROWS;
      const inScope = capped ? rows.slice(0, MAX_ROWS) : rows;
      const undoRows = await tx.auditLog.findMany({
        where: { tenantId, action: { startsWith: UNDO_PREFIX }, createdAt: { gte: target.createdAt } },
        select: { metadata: true },
      });
      const undone = new Set<string>();
      for (const r of undoRows) {
        const id = (r.metadata as { undoneAuditId?: unknown } | null)?.undoneAuditId;
        if (typeof id === "string") undone.add(id);
      }
      if (!inScope.some((r) => r.id === auditId)) return { kind: "capped-out" as const };
      const plan = planUndoTo(inScope as AuditRowLike[], auditId, undone);
      if (preview) return { kind: "plan" as const, plan, capped };
      const planned = plan.reversible.map((p) => p.row.id);
      const expected = expectedIds ?? [];
      if (planned.length !== expected.length || planned.some((id, i) => id !== expected[i])) {
        return { kind: "changed" as const };
      }
      const undoneIds = await executeUndo(tx, plan.reversible, {
        tenantId,
        userId: ownerId,
        ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: req.headers.get("user-agent"),
      });
      return { kind: "done" as const, undoneIds, skipped: plan.skipped.length };
    });

    if (outcome.kind === "not-found") return apiError("That row was not found for that staff member.", 404);
    if (outcome.kind === "changed") return NextResponse.json({ ok: false, error: "Their activity changed since you previewed this. Nothing was undone — open the preview again." }, { status: 409 });
    if (outcome.kind === "capped-out") return NextResponse.json({ ok: false, error: `That is more than ${MAX_ROWS} actions ago — choose a more recent starting point.` }, { status: 400 });
    if (outcome.kind === "plan") {
      const toItem = (p: { row: AuditRowLike; decision: { ok: boolean; reason?: string } }) => ({
        id: p.row.id,
        action: p.row.action,
        createdAt: p.row.createdAt.toISOString(),
        ...(p.decision.ok ? {} : { reason: (p.decision as { reason: string }).reason }),
      });
      return NextResponse.json({ ok: true, reversible: outcome.plan.reversible.map(toItem), skipped: outcome.plan.skipped.map(toItem), capped: outcome.capped });
    }
    return NextResponse.json({
      ok: true,
      undone: outcome.undoneIds,
      skipped: outcome.skipped,
      message: `Undone ${outcome.undoneIds.length} change(s); ${outcome.skipped} left as they were.`,
    });
  } catch (e) {
    if (e instanceof UndoBatchFailed) {
      return NextResponse.json({ ok: false, error: `Stopped at "${e.row.action}" — ${e.reason} Nothing was undone.` }, { status: 409 });
    }
    return apiError("Couldn't undo — nothing has changed.", 500, e, "audit-log/undo-to", { tenantId, userId: ownerId, req });
  }
}
