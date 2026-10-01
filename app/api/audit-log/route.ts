import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination, nextCursorFor } from "@/lib/pagination";
import { requireApiOwner } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import { decideUndo, type AuditRowLike } from "@/lib/undo-registry";
import { UNDO_PREFIX } from "@/lib/audit-labels";

/**
 * GET /api/audit-log — owner-only audit trail for the current tenant.
 *
 * Pagination via opaque cursor (the row id of the last item) so subsequent
 * pages don't drift if new entries arrive between requests. Returns at most
 * 100 rows per call (`?take=N`, capped at 100).
 *
 * Filters (all optional, all tenant-scoped regardless):
 *   ?entityType=Member&entityId=<id>  one entity's trail (member "Details history")
 *   ?userId=<staff id>                 one staff member's actions (Activity page)
 *   ?action=<prefix>                   action name prefix, e.g. "member." or "undo."
 *   ?from=<ISO>&to=<ISO>               time window
 *
 * Response shape:
 *   { entries: (AuditLog & { undo: {ok} | {ok:false, reason} })[], nextCursor, staff }
 * `undo` is the owner-facing reversibility decision (lib/undo-registry.ts);
 * `staff` is the filter list for the Activity page.
 */
export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { take, cursor, skip } = parsePagination(req, { defaultTake: 100, maxTake: 100 });

  const url = new URL(req.url);
  const entityType = url.searchParams.get("entityType")?.slice(0, 40) || undefined;
  const entityId = url.searchParams.get("entityId")?.slice(0, 50) || undefined;
  const entityFilter = entityType && entityId ? { entityType, entityId } : {};
  const userId = url.searchParams.get("userId")?.slice(0, 50) || undefined;
  const actionPrefix = url.searchParams.get("action")?.slice(0, 40) || undefined;
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const createdAt = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  try {
    const { entries, undone, staff } = await withTenantContext(tenantId, async (tx) => {
      const entries = await tx.auditLog.findMany({
        where: {
          tenantId,
          ...entityFilter,
          ...(userId ? { userId } : {}),
          ...(actionPrefix ? { action: { startsWith: actionPrefix } } : {}),
          ...(createdAt ? { createdAt } : {}),
        },
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
        cursor: cursor ? { id: cursor } : undefined,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      });
      // Which of these rows have already been undone? Undo rows reference the
      // original by id in metadata; read the undo rows written since the
      // oldest row on this page and match in memory (one query, no JSON path
      // filter per row).
      const oldest = entries.length ? entries[entries.length - 1].createdAt : null;
      const undoRows = oldest
        ? await tx.auditLog.findMany({
            where: { tenantId, action: { startsWith: UNDO_PREFIX }, createdAt: { gte: oldest } },
            select: { metadata: true },
          })
        : [];
      const undone = new Set<string>();
      for (const r of undoRows) {
        const id = (r.metadata as { undoneAuditId?: unknown } | null)?.undoneAuditId;
        if (typeof id === "string") undone.add(id);
      }
      const staff = await tx.user.findMany({
        where: { tenantId },
        select: { id: true, name: true, role: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      });
      return { entries, undone, staff };
    });

    const withUndo = entries.map((e) => ({
      ...e,
      undo: decideUndo(e as AuditRowLike, undone.has(e.id)),
    }));
    return NextResponse.json({ entries: withUndo, nextCursor: nextCursorFor(entries, take), staff });
  } catch (e) {
    // UI-RULES §7: never `200 []` for a failed read — the page would render
    // "nothing recorded yet" over a database fault.
    return apiError("Couldn't load the activity log.", 500, e);
  }
}

function parseDate(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
