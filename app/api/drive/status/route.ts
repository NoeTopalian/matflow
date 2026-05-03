import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";

export async function GET() {
  const { tenantId } = await requireOwner();
  const { conn, fileCount } = await withTenantContext(tenantId, async (tx) => {
    const c = await tx.googleDriveConnection.findUnique({
      where: { tenantId },
      select: { folderId: true, folderName: true, connectedAt: true, lastIndexedAt: true, scope: true },
    });
    if (!c) return { conn: null, fileCount: 0 };
    const fc = await tx.indexedDriveFile.count({ where: { tenantId } });
    return { conn: c, fileCount: fc };
  });

  if (!conn) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    folderId: conn.folderId || null,
    folderName: conn.folderName || null,
    connectedAt: conn.connectedAt.toISOString(),
    lastIndexedAt: conn.lastIndexedAt?.toISOString() ?? null,
    scope: conn.scope,
    fileCount,
  });
}
