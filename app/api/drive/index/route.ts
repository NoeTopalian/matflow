import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { indexFolder } from "@/lib/google-drive";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwner();

  const rl = await checkRateLimit(`drive:index:${tenantId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Re-index rate limit hit. Try again later." }, {
      status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) },
    });
  }

  const conn = await withTenantContext(tenantId, (tx) =>
    tx.googleDriveConnection.findUnique({ where: { tenantId } }),
  );
  if (!conn || !conn.folderId) {
    return NextResponse.json({ error: "No folder selected" }, { status: 400 });
  }

  try {
    const result = await indexFolder(tenantId, conn.folderId);
    await logAudit({
      tenantId, userId,
      action: "drive.index",
      entityType: "GoogleDriveConnection",
      entityId: tenantId,
      metadata: result,
      req,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return apiError("Google Drive operation failed", 500, e, "[drive/index]");
  }
}
