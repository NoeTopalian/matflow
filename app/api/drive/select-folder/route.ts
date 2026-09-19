import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { indexFolder } from "@/lib/google-drive";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const schema = z.object({
  folderId: z.string().min(1),
  folderName: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  // Campaign lane L-B, J62 round 3. Choosing a folder before Drive is connected
  // was a 500: `googleDriveConnection.update` throws P2025 when the club has no
  // grant, and the catch below turned that into "Google Drive operation failed".
  // A club with no grant is the commonest state there is — every club that has
  // never connected Drive — so the product's own onboarding order answered a
  // server error, and `apiError` minted a reference for a fault that is not
  // ours. The sibling route already says this properly
  // (`app/api/drive/index/route.ts`: 400 "No folder selected"), so this one now
  // does too: 400, named, before anything is deleted.
  const connected = await withTenantContext(tenantId, (tx) =>
    tx.googleDriveConnection.findUnique({ where: { tenantId }, select: { tenantId: true } }),
  );
  if (!connected) {
    return NextResponse.json({ error: "Google Drive is not connected" }, { status: 400 });
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
