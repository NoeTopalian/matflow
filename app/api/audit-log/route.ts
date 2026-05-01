import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const rawTake = parseInt(searchParams.get("take") ?? "100", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 100 : rawTake, 100);

  try {
    const entries = await prisma.auditLog.findMany({
      where: { tenantId },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take,
      orderBy: { createdAt: "desc" },
    });
    const nextCursor = entries.length === take ? entries[entries.length - 1].id : null;
    return NextResponse.json({ entries, nextCursor });
  } catch {
    return NextResponse.json({ entries: [], nextCursor: null });
  }
}
