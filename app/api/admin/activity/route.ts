// GET /api/admin/activity — cross-tenant audit log feed.
//
// Today the AuditLog table is per-tenant indexed; this endpoint runs through
// withRlsBypass to query across tenants for the operator surface. Cursor-
// paginated, max 100 per page. Filters: tenantId, action prefix, date range.

import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export async function GET(req: Request) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  const actionPrefix = url.searchParams.get("action") ?? undefined;
  const since = url.searchParams.get("since"); // ISO date or null
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const where: Record<string, unknown> = {};
  if (tenantId) where.tenantId = tenantId;
  if (actionPrefix) where.action = { startsWith: actionPrefix };
  if (since) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) where.createdAt = { gte: d };
  }

  // AuditLog has a `user` relation but no back-relation to Tenant — so we
  // fetch the rows, then enrich with separate batched lookups for tenants.
  const { rows, tenantMap } = await withRlsBypass(async (tx) => {
    const rows = await tx.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      select: {
        id: true,
        tenantId: true,
        userId: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        user: { select: { email: true, name: true } },
      },
    });

    const tenantIds = Array.from(new Set(rows.map((r) => r.tenantId)));
    const tenants = tenantIds.length
      ? await tx.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true, slug: true },
        })
      : [];
    const tenantMap = new Map(tenants.map((t) => [t.id, t]));

    return { rows, tenantMap };
  });

  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({
    items: items.map((r) => {
      const t = tenantMap.get(r.tenantId);
      return {
        id: r.id,
        tenantId: r.tenantId,
        tenantName: t?.name ?? null,
        tenantSlug: t?.slug ?? null,
        actorEmail: r.user?.email ?? null,
        actorName: r.user?.name ?? null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        metadata: r.metadata as Record<string, unknown> | null,
        ipApprox: r.ipAddress ? r.ipAddress.replace(/\.\d+$/, ".0") : null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    nextCursor,
  });
}
