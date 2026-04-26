import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { revokeConnection } from "@/lib/google-drive";
import { logAudit } from "@/lib/audit-log";

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwner();
  try {
    await revokeConnection(tenantId);
    await logAudit({
      tenantId,
      userId,
      action: "drive.disconnect",
      entityType: "GoogleDriveConnection",
      entityId: tenantId,
      req,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
