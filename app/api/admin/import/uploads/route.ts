import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { createUpload, UPLOAD_REFUSAL_STATUS } from "@/lib/import-upload";

/**
 * POST /api/admin/import/uploads — open a chunked import upload.
 *
 * JSON { purpose, fileName, bytes, sha256 } → 201 { uploadId, token,
 * chunkSize, chunkCount, expiresAt }. The token is shown once; only its hash is
 * stored. The file itself arrives through …/[id]/chunks/[index] and is
 * verified by …/[id]/complete (lib/import-upload.ts).
 */

export const runtime = "nodejs";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  const rl = await checkRateLimit(`import-upload:create:${tenantId}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many uploads. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: { purpose?: unknown; fileName?: unknown; bytes?: unknown; sha256?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const out = await withTenantContext(tenantId, (tx) =>
      createUpload(tx, {
        tenantId,
        userId,
        purpose: String(body.purpose ?? ""),
        fileName: typeof body.fileName === "string" ? body.fileName : "",
        bytes: typeof body.bytes === "number" ? body.bytes : NaN,
        sha256: typeof body.sha256 === "string" ? body.sha256 : "",
      }),
    );
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: UPLOAD_REFUSAL_STATUS[out.code] });

    await logAudit({
      tenantId,
      userId,
      action: "import.upload_started",
      entityType: "ImportUpload",
      entityId: out.id,
      metadata: {
        purpose: body.purpose,
        bytes: body.bytes,
        sha256: String(body.sha256).slice(0, 12),
        chunkCount: out.chunkCount,
      },
      req,
    });

    return NextResponse.json(
      { uploadId: out.id, token: out.token, chunkSize: out.chunkSize, chunkCount: out.chunkCount, expiresAt: out.expiresAt.toISOString() },
      { status: 201 },
    );
  } catch (e) {
    return apiError("Import upload failed", 500, e, "[admin/import/uploads]");
  }
}
