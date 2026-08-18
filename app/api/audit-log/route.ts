import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination, nextCursorFor } from "@/lib/pagination";
import { requireApiOwner } from "@/lib/api-authz";

/**
 * GET /api/audit-log — owner-only audit trail for the current tenant.
 *
 * Pagination via opaque cursor (the row id of the last item) so subsequent
 * pages don't drift if new entries arrive between requests. Returns at most
 * 100 rows per call (`?take=N`, capped at 100).
 *
 * Response shape:
 *   { entries: AuditLog[], nextCursor: string | null }
 */
export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { take, cursor, skip } = parsePagination(req, { defaultTake: 100, maxTake: 100 });

  // Optional entity filter (2026-08-17, member details-history panel):
  // ?entityType=Member&entityId=<id> narrows to one entity's trail. Both
  // params must be present together; values are length-capped, and the
  // query stays tenant-scoped regardless.
  const url = new URL(req.url);
  const entityType = url.searchParams.get("entityType")?.slice(0, 40) || undefined;
  const entityId = url.searchParams.get("entityId")?.slice(0, 50) || undefined;
  const entityFilter = entityType && entityId ? { entityType, entityId } : {};

  try {
    const entries = await withTenantContext(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId, ...entityFilter },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        cursor: cursor ? { id: cursor } : undefined,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
    );
    return NextResponse.json({ entries, nextCursor: nextCursorFor(entries, take) });
  } catch {
    return NextResponse.json({ entries: [], nextCursor: null });
  }
}
