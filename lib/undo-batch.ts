/**
 * "Undo to a point" — plan and execute the reversal of one staff member's
 * actions, newest first, down to and including a chosen audit row
 * (1 Oct 2026). The plan is pure so the owner sees exactly what will and
 * will not come back before confirming; execution runs in ONE transaction so
 * a single stale row rolls the whole batch back and names itself.
 */
import type { AuditRowLike, TxLike, UndoDecision } from "@/lib/undo-registry";
import { decideUndo, applyUndo, UndoStale } from "@/lib/undo-registry";
import { UNDO_PREFIX } from "@/lib/audit-labels";

export type PlanItem = { row: AuditRowLike; decision: UndoDecision };

export type UndoPlan = {
  /** Newest → oldest, in the order they will be reversed. */
  reversible: PlanItem[];
  /** Left as they are, each with the reason the owner reads. */
  skipped: PlanItem[];
};

/**
 * `rows` = the staff member's rows at or after the target, any order.
 * `undoneIds` = audit ids already referenced by an `undo.*` row.
 */
export function planUndoTo(rows: AuditRowLike[], targetId: string, undoneIds: ReadonlySet<string>): UndoPlan {
  const target = rows.find((r) => r.id === targetId);
  if (!target) throw new Error("Target row not in the set");
  const inScope = rows
    .filter((r) => r.createdAt.getTime() > target.createdAt.getTime() || r.id === targetId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  const reversible: PlanItem[] = [];
  const skipped: PlanItem[] = [];
  for (const row of inScope) {
    const decision = decideUndo(row, undoneIds.has(row.id));
    (decision.ok ? reversible : skipped).push({ row, decision });
  }
  return { reversible, skipped };
}

export type UndoOutcome =
  | { ok: true; undone: string[] }
  | { ok: false; failedAt: string; action: string; reason: string };

/**
 * Reverse every reversible item in order, writing an `undo.<action>` audit
 * row per reversal inside the same transaction. Throws on the first failure
 * so the caller's transaction rolls back; the thrown error carries which row.
 */
export async function executeUndo(
  tx: TxLike,
  items: PlanItem[],
  actor: { tenantId: string; userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<string[]> {
  const undone: string[] = [];
  for (const { row } of items) {
    try {
      await applyUndo(tx, row);
    } catch (e) {
      if (e instanceof UndoStale) throw new UndoBatchFailed(row, e.message);
      throw e;
    }
    await tx.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: `${UNDO_PREFIX}${row.action}`,
        entityType: row.entityType,
        entityId: row.entityId,
        metadata: { undoneAuditId: row.id, undoneAction: row.action, undoneByUserId: row.userId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });
    undone.push(row.id);
  }
  return undone;
}

export class UndoBatchFailed extends Error {
  constructor(public readonly row: AuditRowLike, public readonly reason: string) {
    super(`Undo stopped at ${row.action} (${row.id}): ${reason}`);
    this.name = "UndoBatchFailed";
  }
}
