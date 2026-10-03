import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { completeUpload, UPLOAD_REFUSAL_STATUS } from "@/lib/import-upload";

/**
 * POST /api/admin/import/uploads/[id]/complete — verify a chunked upload.
 * Header `x-upload-token`. Every chunk present, total size and sha256 of the
 * reassembled file as declared → 200 { uploadId, bytes, sha256 }. Otherwise
 * 409 { error, reason, missing? } and the upload stays open for a re-send.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  const rl = await checkRateLimit(`import-upload:complete:${tenantId}`, 60, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const token = req.headers.get("x-upload-token") ?? "";
  if (!token) return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  const { id } = await params;

  try {
    // Reads and hashes every chunk of the file (up to 25 MiB): a realistic budget, under maxDuration.
    const out = await withTenantContext(tenantId, (tx) => completeUpload(tx, { tenantId, userId, uploadId: id, token }), { timeout: 45_000, maxWait: 10_000 });
    if (!out.ok) {
      return NextResponse.json(
        { error: out.error, ...(out.reason ? { reason: out.reason } : {}), ...(out.missing ? { missing: out.missing } : {}) },
        { status: UPLOAD_REFUSAL_STATUS[out.code] },
      );
    }

    await logAudit({
      tenantId,
      userId,
      action: "import.upload_completed",
      entityType: "ImportUpload",
      entityId: out.id,
      metadata: { purpose: out.purpose, bytes: out.bytes, sha256: out.sha256.slice(0, 12), chunkCount: out.chunkCount },
      req,
    });

    return NextResponse.json({ uploadId: out.id, bytes: out.bytes, sha256: out.sha256 });
  } catch (e) {
    return apiError("Upload verification failed", 500, e, "[admin/import/uploads/complete]");
  }
}
