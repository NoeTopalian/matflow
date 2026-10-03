import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { CHUNK_SIZE, putChunk, UPLOAD_REFUSAL_STATUS } from "@/lib/import-upload";

/**
 * PUT /api/admin/import/uploads/[id]/chunks/[index] — one chunk of a chunked
 * import upload. Raw `application/octet-stream` body, `x-upload-token` header.
 * 200 { index, received: true }. A wrong token, another club's upload or
 * another user's upload is 404 (existence is not revealed); expired is 410; a
 * wrong length or index is 400. Re-sending a chunk replaces it.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const TOO_LARGE = () => NextResponse.json({ error: "Chunk too large" }, { status: 413 });

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  // Refused on the declared length before a byte of the body is read.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > CHUNK_SIZE + 1024) return TOO_LARGE();

  const rl = await checkRateLimit(`import-upload:chunk:${tenantId}`, 600, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const token = req.headers.get("x-upload-token") ?? "";
  if (!token) return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  const { id, index: indexRaw } = await params;
  if (!/^\d{1,6}$/.test(indexRaw)) return NextResponse.json({ error: "Chunk index out of range" }, { status: 400 });
  const index = Number(indexRaw);

  let body: ArrayBuffer;
  try {
    body = await req.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "Couldn't read the chunk. Try again." }, { status: 400 });
  }
  if (body.byteLength > CHUNK_SIZE) return TOO_LARGE();

  try {
    // A 1 MiB write: the default 15 s budget was exceeded on a slow link to
    // the database (rehearsal 3 Oct 2026, 28 s); the route allows 60 s.
    const out = await withTenantContext(tenantId, (tx) =>
      putChunk(tx, { tenantId, userId, uploadId: id, token, index, bytes: new Uint8Array(body) }),
      { timeout: 45_000, maxWait: 10_000 },
    );
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: UPLOAD_REFUSAL_STATUS[out.code] });
    return NextResponse.json({ index: out.index, received: true });
  } catch (e) {
    return apiError("Chunk upload failed", 500, e, "[admin/import/uploads/chunks]");
  }
}
