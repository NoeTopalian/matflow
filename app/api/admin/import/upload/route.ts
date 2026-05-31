import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import type { ImportSource } from "@/lib/importers";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_SOURCES: ImportSource[] = ["generic", "mindbody", "glofox", "wodify"];

export const runtime = "nodejs";

// Audit iter-1-operator-admin A6I1-S-1: sanitise the job projection sent to
// the client. The Vercel Blob URL (`fileBlobUrl`) is a publicly-readable URL
// — anyone who sees it can download the raw member CSV (names, emails,
// phones, dates of birth). We DO need to store the URL server-side (the
// preview + commit routes fetch from it), but we must NOT leak it through
// API responses. Combined with `addRandomSuffix: true` (128 bits of entropy
// in the path) + `del()` on commit completion (defence-in-depth — see
// commit route), this collapses the exposure window to "server-side only".
function publicJobView(job: {
  id: string; tenantId: string; createdById: string; source: string;
  fileName: string; status: string; totalRows: number; processedRows: number;
  importedRows: number; skippedRows: number; errorRows: number;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
  errorLog: unknown;
}) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    createdById: job.createdById,
    source: job.source,
    fileName: job.fileName,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    importedRows: job.importedRows,
    skippedRows: job.skippedRows,
    errorRows: job.errorRows,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    errorLog: job.errorLog,
    // NOTE: fileBlobUrl deliberately omitted.
  };
}
export { publicJobView };

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { tenantId, userId } = await requireOwner();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "File uploads not configured" }, { status: 503 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const source = String(formData.get("source") ?? "generic") as ImportSource;
    if (!ALLOWED_SOURCES.includes(source)) return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });

    // Accept text/csv or text/plain (some browsers send the latter for .csv)
    if (!["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"].includes(file.type) && !file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "Only CSV files are supported" }, { status: 400 });
    }

    const cuid = randomBytes(12).toString("hex");
    // Audit iter-1-operator-admin A6I1-S-1: @vercel/blob only supports
    // `access: "public"` — there is no native private mode. Mitigations
    // applied: (1) `addRandomSuffix: true` adds 128 bits of entropy to the
    // path (un-guessable), (2) the URL is never returned to the client —
    // see `publicJobView` above, (3) the commit route calls `del()` on
    // successful completion so the blob lives only for the lifetime of
    // the import job.
    const blob = await put(`tenants/${tenantId}/imports/${cuid}.csv`, file, {
      access: "public",
      contentType: "text/csv",
      addRandomSuffix: true,
    });

    const job = await withTenantContext(tenantId, (tx) =>
      tx.importJob.create({
        data: {
          tenantId,
          createdById: userId,
          source,
          fileName: file.name.slice(0, 200),
          fileBlobUrl: blob.url,
          status: "pending",
        },
      }),
    );

    await logAudit({
      tenantId,
      userId,
      action: "import.upload",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { source, fileName: job.fileName, sizeBytes: file.size },
      req,
    });

    return NextResponse.json(publicJobView(job), { status: 201 });
  } catch (e) {
    return apiError("Import upload failed", 500, e, "[admin/import/upload]");
  }
}
