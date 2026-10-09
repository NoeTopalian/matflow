import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { createUpload, UPLOAD_REFUSAL_STATUS } from "@/lib/import-upload";
import { z } from "zod";

// Lane C2 (9 Oct 2026): exactly what lib/import-upload-client.ts sends; createUpload still judges the values.
const bodySchema = z.strictObject({
  purpose: z.string().max(64),
  fileName: z.string().max(1024),
  bytes: z.number().finite(),
  sha256: z.string().max(128),
});

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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(raw);
  if (!parsedBody.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const body = parsedBody.data;

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
