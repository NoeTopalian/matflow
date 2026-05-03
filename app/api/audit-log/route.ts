import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination, nextCursorFor } from "@/lib/pagination";
import { requireOwner } from "@/lib/authz";

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
  const { tenantId } = await requireOwner();
  const { take, cursor, skip } = parsePagination(req, { defaultTake: 100, maxTake: 100 });

  try {
    const entries = await withTenantContext(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId },
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
