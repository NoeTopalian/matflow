import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";

export async function GET() {
  const { tenantId } = await requireOwner();
  const conn = await prisma.googleDriveConnection.findUnique({
    where: { tenantId },
    select: { folderId: true, folderName: true, connectedAt: true, lastIndexedAt: true, scope: true },
  });

  if (!conn) {
    return NextResponse.json({ connected: false });
  }

  const fileCount = await prisma.indexedDriveFile.count({ where: { tenantId } });

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
