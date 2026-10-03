import { NextResponse } from "next/server";
import { importStorageAvailable, putImportFile, sha256 } from "@/lib/import-storage";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { clubWallClockToInstant, EXPORT_TIME_PROVENANCES, MAPPING_VERSION, type ExportTimeProvenance, type ImportSource } from "@/lib/importers";
import { usableTimezone } from "@/lib/class-time";
import { sniffCsvKind, WRONG_PATH_MESSAGE } from "@/lib/importers/sniff";
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
  fileHash?: string | null; sourceExportedAt?: Date | null; sourceExportedAtProvenance?: string | null; mappingVersion?: string | null;
  manifest?: unknown; rolledBackAt?: Date | null; mode?: string | null;
}) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    createdById: job.createdById,
    source: job.source,
    mode: job.mode ?? "create",
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
    // "owner_stated" | "provisional" | null (no time given).
    sourceExportedAtProvenance: job.sourceExportedAtProvenance ?? null,
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

  // The platform cuts a request body at 10 MB, so an oversized upload arrives
  // truncated and formData() throws before the size check below can run — it
  // used to answer 500 (e2e lc-3, 30 Sep 2026). Refuse on the declared length,
  // and treat an unreadable body as the client's problem, not the server's.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 413 });
  }
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Couldn't read the upload. Check the file is a CSV under 10MB and try again." }, { status: 400 });
  }

  try {
    const file = formData.get("file");
    const source = String(formData.get("source") ?? "generic") as ImportSource;
    if (!ALLOWED_SOURCES.includes(source)) return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });

    // Accept text/csv or text/plain (some browsers send the latter for .csv)
    if (!["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"].includes(file.type) && !file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "Only CSV files are supported" }, { status: 400 });
    }

    // TeamUp only: "create" adds people (the first import); "refresh" updates
    // the TeamUp-owned standing of people already imported and creates nobody
    // (readiness spec v3 §7).
    const modeRaw = String(formData.get("mode") ?? "create");
    if (modeRaw !== "create" && modeRaw !== "refresh") return NextResponse.json({ error: "Invalid import mode" }, { status: 400 });
    const mode = modeRaw;
    if (mode === "refresh" && source !== "teamup") {
      return NextResponse.json({ error: "A status refresh is only available for TeamUp exports." }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileHash = sha256(bytes);

    // The Source the owner picked is checked against the file's own header
    // before anything is stored (3 Oct 2026: a TeamUp memberships export under
    // the default "Generic CSV" reached the generic parser and answered only
    // "Couldn't find name or email columns", totalRows 1). A file meant for
    // another path is refused with the path to use; no job is created.
    const kind = sniffCsvKind(new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)));
    if (kind === "teamup_memberships" && source !== "teamup") {
      return NextResponse.json({ error: WRONG_PATH_MESSAGE.membershipsAsOtherSource, detected: kind }, { status: 400 });
    }
    if (kind === "teamup_attendance") {
      return NextResponse.json({ error: WRONG_PATH_MESSAGE.attendanceAsMembers, detected: kind }, { status: 400 });
    }

    // The same file imported twice would double nothing (the commit dedupes by
    // email) but would muddle the record of what came from where. A file that
    // has already been committed, and not rolled back, is refused by name.
    const prior = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({
        // Per mode: the file that first created people may later be the
        // file a refresh is run from, and that is not a duplicate.
        where: { tenantId, fileHash, mode, status: "complete", rolledBackAt: null },
        select: { id: true, completedAt: true, fileName: true },
      }),
    );
    if (prior) {
      return NextResponse.json(
        {
          error: `This exact file was already ${mode === "refresh" ? "used for a status refresh" : "imported"} (${prior.fileName}${prior.completedAt ? `, ${prior.completedAt.toISOString().slice(0, 10)}` : ""}). Export a fresh file, or roll that import back first.`,
          priorJobId: prior.id,
        },
        { status: 409 },
      );
    }

    // When the source platform produced the file, as the owner states it; the
    // reconciliation is only ever as current as this. Two spellings: an
    // instant (`sourceExportedAt`, ISO), or — what the panel sends since 3 Oct
    // 2026 — the club wall-clock time the owner typed (`sourceExportedAtLocal`,
    // "YYYY-MM-DDTHH:mm"), read in the CLUB's timezone so an owner abroad
    // cannot shift the as-of date by their laptop's zone.
    const exportedRaw = String(formData.get("sourceExportedAt") ?? "").trim();
    const exportedLocal = String(formData.get("sourceExportedAtLocal") ?? "").trim();
    let sourceExportedAt: Date | null = exportedRaw ? new Date(exportedRaw) : null;
    if (!sourceExportedAt && exportedLocal) {
      const tz = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
      sourceExportedAt = clubWallClockToInstant(exportedLocal, usableTimezone(tz?.timezone)) ?? new Date(NaN);
    }
    if (sourceExportedAt && (isNaN(sourceExportedAt.getTime()) || sourceExportedAt.getTime() > Date.now() + 5 * 60 * 1000)) {
      return NextResponse.json({ error: "The export date must be a real date that is not in the future." }, { status: 400 });
    }
    // How that time is known: stated by the owner (the default when a time is
    // given) or a provisional estimate to be confirmed by a status refresh.
    const provenanceRaw = String(formData.get("sourceExportedAtProvenance") ?? "").trim();
    if (provenanceRaw && !EXPORT_TIME_PROVENANCES.includes(provenanceRaw as ExportTimeProvenance)) {
      return NextResponse.json({ error: "Invalid export-time provenance." }, { status: 400 });
    }
    if (provenanceRaw && !sourceExportedAt) {
      return NextResponse.json({ error: "Enter the estimated export time, or untick \"This is an estimate\"." }, { status: 400 });
    }
    const sourceExportedAtProvenance: ExportTimeProvenance | null = sourceExportedAt
      ? ((provenanceRaw as ExportTimeProvenance) || "owner_stated")
      : null;
    // A refresh's whole value is "status as of <export time>"; without it
    // staff could not tell how old the standing is.
    if (mode === "refresh" && !sourceExportedAt) {
      return NextResponse.json({ error: "Enter when the TeamUp file was exported — a status refresh is only as current as the export." }, { status: 400 });
    }
    // teamup-2: entitlement (started / scheduled / expired) is read at the
    // snapshot date, so a first import needs it too.
    if (source === "teamup" && !sourceExportedAt) {
      return NextResponse.json({ error: "Enter when the TeamUp file was exported — memberships that start or end around that date depend on it." }, { status: 400 });
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
          mode,
          fileName: file.name.slice(0, 200),
          fileBlobUrl: fileUrl,
          status: "pending",
          fileHash,
          sourceExportedAt,
          sourceExportedAtProvenance,
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
      metadata: { source, mode, fileName: job.fileName, sizeBytes: file.size, fileHash, mappingVersion: MAPPING_VERSION[source], sourceExportedAt: sourceExportedAt?.toISOString() ?? null, sourceExportedAtProvenance },
      req,
    });

    return NextResponse.json(publicJobView(job), { status: 201 });
  } catch (e) {
    return apiError("Import upload failed", 500, e, "[admin/import/upload]");
  }
}
