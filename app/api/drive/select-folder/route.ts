import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { indexFolder } from "@/lib/google-drive";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

const schema = z.object({
  folderId: z.string().min(1),
  folderName: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwner();
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await withTenantContext(tenantId, async (tx) => {
      await tx.indexedDriveFile.deleteMany({ where: { tenantId } });
      await tx.googleDriveConnection.update({
        where: { tenantId },
        data: { folderId: parsed.data.folderId, folderName: parsed.data.folderName },
      });
    });
    const result = await indexFolder(tenantId, parsed.data.folderId).catch(() => ({ indexed: 0, skipped: 0 }));
    await logAudit({
      tenantId,
      userId,
      action: "drive.folder.select",
      entityType: "GoogleDriveConnection",
      entityId: tenantId,
      metadata: { folderId: parsed.data.folderId, folderName: parsed.data.folderName, ...result },
      req,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return apiError("Google Drive operation failed", 500, e, "[drive/select-folder]");
  }
}
