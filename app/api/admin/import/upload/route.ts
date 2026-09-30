import { NextResponse } from "next/server";
import { importStorageAvailable, putImportFile, sha256 } from "@/lib/import-storage";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { MAPPING_VERSION, type ImportSource } from "@/lib/importers";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_SOURCES: ImportSource[] = ["generic", "mindbody", "glofox", "wodify", "teamup"];

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
  fileHash?: string | null; sourceExportedAt?: Date | null; mappingVersion?: string | null;
  manifest?: unknown; rolledBackAt?: Date | null;
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
    fileHash: job.fileHash ? job.fileHash.slice(0, 12) : null,
    sourceExportedAt: job.sourceExportedAt ?? null,
    mappingVersion: job.mappingVersion ?? null,
    manifest: job.manifest ?? null,
    rolledBackAt: job.rolledBackAt ?? null,
    // NOTE: fileBlobUrl deliberately omitted.
  };
}
export { publicJobView };

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  if (!importStorageAvailable()) {
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

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileHash = sha256(bytes);

    // The same file imported twice would double nothing (the commit dedupes by
    // email) but would muddle the record of what came from where. A file that
    // has already been committed, and not rolled back, is refused by name.
    const prior = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({
        where: { tenantId, fileHash, status: "complete", rolledBackAt: null },
        select: { id: true, completedAt: true, fileName: true },
      }),
    );
    if (prior) {
      return NextResponse.json(
        {
          error: `This exact file was already imported (${prior.fileName}${prior.completedAt ? `, ${prior.completedAt.toISOString().slice(0, 10)}` : ""}). Export a fresh file, or roll that import back first.`,
          priorJobId: prior.id,
        },
        { status: 409 },
      );
    }

    // When the source platform produced the file, as the owner states it; the
    // reconciliation is only ever as current as this.
    const exportedRaw = String(formData.get("sourceExportedAt") ?? "").trim();
    const sourceExportedAt = exportedRaw ? new Date(exportedRaw) : null;
    if (sourceExportedAt && (isNaN(sourceExportedAt.getTime()) || sourceExportedAt.getTime() > Date.now() + 5 * 60 * 1000)) {
      return NextResponse.json({ error: "The export date must be a real date that is not in the future." }, { status: 400 });
    }

    // Private Blob in production (random-suffixed, URL never returned to the
    // client, deleted after commit); a temp file in local rehearsals only
    // (lib/import-storage.ts).
    const fileUrl = await putImportFile(tenantId, bytes);

    const job = await withTenantContext(tenantId, (tx) =>
      tx.importJob.create({
        data: {
          tenantId,
          createdById: userId,
          source,
          fileName: file.name.slice(0, 200),
          fileBlobUrl: fileUrl,
          status: "pending",
          fileHash,
          sourceExportedAt,
          mappingVersion: MAPPING_VERSION[source],
        },
      }),
    );

    await logAudit({
      tenantId,
      userId,
      action: "import.upload",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { source, fileName: job.fileName, sizeBytes: file.size, fileHash, mappingVersion: MAPPING_VERSION[source] },
      req,
    });

    return NextResponse.json(publicJobView(job), { status: 201 });
  } catch (e) {
    return apiError("Import upload failed", 500, e, "[admin/import/upload]");
  }
}
