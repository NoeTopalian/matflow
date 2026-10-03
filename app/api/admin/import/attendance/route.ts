// /api/admin/import/attendance — a club's attendance history, imported.
//
//   POST {action:"preview", uploadId, sourceExportedAtLocal|sourceExportedAt, sourceExportedAtProvenance?}
//        → verify the uploaded file, plan it against the club, keep a preview job
//   POST {action:"repreview", jobId}           → plan again (after decisions)
//   POST {action:"decide", decisions, jobId?}  → store person / offering / venue decisions
//   POST {action:"commit", jobId, planHash}    → start the commit (creates historical classes)
//   POST {action:"step", jobId}                → advance the commit; call until complete
//   GET  ?jobId=                               → job status and progress
//   GET  ?jobId=&list=people&offset=&limit=&state=pending|all → people, paged
//   DELETE ?jobId=                             → roll one commit back
//
// The file arrives through /api/admin/import/uploads in chunks (each request
// well under the host's 4.5 MB body limit) and is verified by size and sha256
// before anything here reads it. The engine is lib/attendance-import.ts; this
// route authenticates (owner, MFA, same origin), rate-limits and dispatches.
// An imported attendance is history, not an event: nothing here goes near
// lib/checkin.ts. Contract: docs/runbooks/ATTENDANCE-IMPORT.md.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { DB_UPLOAD_PREFIX, deleteImportFile, readImportFile } from "@/lib/import-storage";
import { claimUpload, readUploadBytes } from "@/lib/import-upload";
import { sniffCsvKind, WRONG_PATH_MESSAGE } from "@/lib/importers/sniff";
import { clubWallClockToInstant, EXPORT_TIME_PROVENANCES, type ExportTimeProvenance } from "@/lib/importers";
import { ensureTodayInstances } from "@/lib/today-sessions";
import {
  buildPlan,
  claimLease,
  createHistoricalClasses,
  emptyProgress,
  JOB_SOURCE,
  loadClubInputs,
  MAPPING_VERSION,
  planHashOf,
  previewSummary,
  releaseLease,
  rollbackJob,
  runStep,
  saveDecisions,
  type DecisionInput,
  type JobMappings,
} from "@/lib/attendance-import";

export const runtime = "nodejs";
// Steps stop starting batches after 20 s; a rollback of a full year (~15k
// bookings) runs in one transaction and was measured in rehearsal. 300 s is
// the platform default on every plan.
export const maxDuration = 300;

const RL_WINDOW_MS = 60 * 60 * 1000;
const PURPOSE = "attendance";

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json({ error: "Too many import requests. Try again later." }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
}

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

/** What a browser may see of a job: never the stored file's address. */
function jobView(job: {
  id: string; status: string; fileName: string; totalRows: number; processedRows: number; importedRows: number; skippedRows: number; errorRows: number;
  createdAt: Date; startedAt: Date | null; completedAt: Date | null; rolledBackAt: Date | null; sourceExportedAt: Date | null;
  sourceExportedAtProvenance: string | null; fileHash: string | null; manifest: unknown; errorLog: unknown; leaseUntil: Date | null;
}) {
  const manifest = (job.manifest ?? null) as Record<string, unknown> | null;
  return {
    id: job.id,
    status: job.status,
    // The states the owner sees.
    phase: job.rolledBackAt ? "rolled_back"
      : job.status === "preview" ? "previewed"
      : job.status === "running" ? "importing"
      : job.status === "failed" ? (job.processedRows > 0 ? "partial" : "failed")
      : job.status === "complete" ? "completed" : job.status,
    fileName: job.fileName,
    fileHash: job.fileHash ? job.fileHash.slice(0, 12) : null,
    sourceExportedAt: job.sourceExportedAt,
    sourceExportedAtProvenance: job.sourceExportedAtProvenance,
    total: job.totalRows,
    processed: job.processedRows,
    attendanceCreated: job.importedRows,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    rolledBackAt: job.rolledBackAt,
    stepInFlight: !!job.leaseUntil && job.leaseUntil > new Date(),
    progress: manifest?.progress ?? null,
    manifest: job.status === "complete" || job.rolledBackAt ? manifest : null,
    error: job.status === "failed" ? job.errorLog : null,
  };
}

const JOB_SELECT = {
  id: true, status: true, fileName: true, totalRows: true, processedRows: true, importedRows: true, skippedRows: true, errorRows: true,
  createdAt: true, startedAt: true, completedAt: true, rolledBackAt: true, sourceExportedAt: true, sourceExportedAtProvenance: true,
  fileHash: true, manifest: true, errorLog: true, leaseUntil: true, fileBlobUrl: true, dryRunSummary: true,
} as const;

async function readJobFile(tenantId: string, url: string) {
  return readImportFile(url, tenantId);
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return bad("Choose the file again under Settings → Import → Attendance history: it is now uploaded in parts before the preview.", 415);
  }
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return bad("Invalid JSON"); }
  const action = String(body.action ?? "");

  // Steps are many small calls; everything else is rare.
  const rl = action === "step"
    ? await checkRateLimit(`import:attendance:step:${tenantId}`, 600, RL_WINDOW_MS)
    : await checkRateLimit(`import:attendance:${tenantId}`, 120, RL_WINDOW_MS);
  if (!rl.allowed) return rateLimited(rl.retryAfterSeconds);

  try {
    switch (action) {
      case "preview": return await preview(req, tenantId, userId, body);
      case "repreview": return await repreview(tenantId, String(body.jobId ?? ""));
      case "decide": return await decide(req, tenantId, userId, body);
      case "commit": return await commit(req, tenantId, userId, String(body.jobId ?? ""), String(body.planHash ?? ""));
      case "step": return await step(req, tenantId, userId, String(body.jobId ?? ""));
      case "discard": return await discard(tenantId, String(body.jobId ?? ""));
      default: return bad("Unknown action");
    }
  } catch (e) {
    return apiError("Attendance import failed", 500, e, "[admin/import/attendance]");
  }
}

async function preview(req: Request, tenantId: string, userId: string, body: Record<string, unknown>) {
  const uploadId = String(body.uploadId ?? "").trim();
  if (!uploadId) return bad("Upload the file first.");

  // When the source platform produced the file, as the owner states it, read
  // in the CLUB's timezone (an owner abroad must not shift it). Required: a
  // later export may only change a booking's state if it is newer.
  const tenant = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
  const exportedRaw = String(body.sourceExportedAt ?? "").trim();
  const exportedLocal = String(body.sourceExportedAtLocal ?? "").trim();
  let sourceExportedAt: Date | null = exportedRaw ? new Date(exportedRaw) : null;
  if (!sourceExportedAt && exportedLocal) sourceExportedAt = clubWallClockToInstant(exportedLocal, tenant?.timezone || "Europe/London") ?? new Date(NaN);
  if (!sourceExportedAt) return bad("Enter when the TeamUp file was exported — a later export only updates a booking when it is newer.");
  if (isNaN(sourceExportedAt.getTime()) || sourceExportedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return bad("The export date must be a real date that is not in the future.");
  }
  const provenanceRaw = String(body.sourceExportedAtProvenance ?? "").trim();
  if (provenanceRaw && !EXPORT_TIME_PROVENANCES.includes(provenanceRaw as ExportTimeProvenance)) return bad("Invalid export-time provenance.");
  const sourceExportedAtProvenance = (provenanceRaw as ExportTimeProvenance) || "owner_stated";

  // The verified upload: this owner's, for this purpose, complete, intact.
  const upload = await withTenantContext(tenantId, (tx) =>
    tx.importUpload.findFirst({ where: { id: uploadId, tenantId }, select: { createdById: true, purpose: true, status: true, expiresAt: true, expectedSha256: true, fileName: true, expectedBytes: true } }),
  );
  if (!upload || upload.createdById !== userId) return bad("Upload not found.", 404);
  if (upload.purpose !== PURPOSE) return bad("This upload was not made for the attendance import.");
  if (upload.status !== "complete") return bad(upload.status === "consumed" ? "This upload has already been used. Choose the file again." : "The upload has not finished.", 409);
  if (upload.expiresAt <= new Date()) return bad("The upload expired. Choose the file again.", 410);
  const bytes = await withTenantContext(tenantId, (tx) => readUploadBytes(tx, tenantId, uploadId), { timeout: 45_000, maxWait: 10_000 });
  if (!bytes) return bad("The upload is incomplete. Choose the file again.", 409);
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  if (fileHash !== upload.expectedSha256) return bad("The upload did not arrive intact. Choose the file again.", 409);

  const text = new TextDecoder("utf-8").decode(bytes);
  const kind = sniffCsvKind(text.slice(0, 4096));
  if (kind === "teamup_memberships") return bad(WRONG_PATH_MESSAGE.membershipsAsAttendance, 400, { detected: kind });

  const inputs = await withTenantContext(tenantId, (tx) => loadClubInputs(tx, tenantId));
  const built = buildPlan(text, inputs, new Date());
  if (built.errors) return bad(built.errors.join(" "), 400, { errors: built.errors });
  // Bounded preview: a club has tens of offerings and a handful of venues and
  // statuses. Thousands of distinct labels is not an attendance export.
  if (built.plan.offerings.length > 300 || built.plan.venues.length > 50 || Object.keys(built.controls.byStatus).length > 50 || Object.keys(built.controls.byBookingMethod).length > 50 || Object.keys(built.controls.byBookingSource).length > 50) {
    return bad(`This file has ${built.plan.offerings.length.toLocaleString("en-GB")} different class names and ${built.plan.venues.length.toLocaleString("en-GB")} venues, more than an attendance export holds. Check it is TeamUp's attendance report.`);
  }

  const summary = await withTenantContext(tenantId, (tx) => previewSummary(tx, tenantId, built, inputs, sourceExportedAt), { timeout: 30_000 });
  const planHash = planHashOf(fileHash, inputs);
  const prior = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { tenantId, source: JOB_SOURCE, fileHash, status: "complete", rolledBackAt: null }, select: { id: true, completedAt: true } }),
  );

  // One upload feeds one job: claim it and create the job together.
  const job = await withTenantContext(tenantId, async (tx) => {
    const claim = await claimUpload(tx, { tenantId, userId, uploadId, purpose: PURPOSE });
    if (!claim.ok) return null;
    // A new file makes every earlier attendance preview stale: it can never be
    // committed, and its stored file (member names and emails) goes now.
    const stale = await tx.importJob.findMany({ where: { tenantId, source: JOB_SOURCE, status: "preview" }, select: { fileBlobUrl: true } });
    await tx.importJob.updateMany({ where: { tenantId, source: JOB_SOURCE, status: "preview" }, data: { status: "superseded" } });
    const staleUploads = stale.map((j) => j.fileBlobUrl).filter((u) => u.startsWith(DB_UPLOAD_PREFIX)).map((u) => u.slice(DB_UPLOAD_PREFIX.length));
    if (staleUploads.length) {
      await tx.importUploadChunk.deleteMany({ where: { tenantId, uploadId: { in: staleUploads } } });
      await tx.importUpload.deleteMany({ where: { tenantId, id: { in: staleUploads } } });
    }
    return tx.importJob.create({
      data: {
        tenantId, createdById: userId, source: JOB_SOURCE, fileName: upload.fileName.slice(0, 200), fileBlobUrl: `${DB_UPLOAD_PREFIX}${uploadId}`,
        status: "preview", fileHash, sourceExportedAt, sourceExportedAtProvenance, mappingVersion: MAPPING_VERSION, totalRows: summary.rows,
        dryRunSummary: { planHash, summary } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });
  if (!job) return bad("This upload has already been used. Choose the file again.", 409);

  await logAudit({
    tenantId, userId, action: "import.attendance.preview", entityType: "ImportJob", entityId: job.id, req,
    metadata: { sizeBytes: upload.expectedBytes, fileHash, mappingVersion: MAPPING_VERSION, rows: summary.rows, bookings: summary.bookings, sourceExportedAt: sourceExportedAt.toISOString(), sourceExportedAtProvenance },
  });
  return NextResponse.json({ jobId: job.id, status: "preview", planHash, summary, priorImport: prior ? { jobId: prior.id, completedAt: prior.completedAt } : null }, { status: 201 });
}

/** Set a preview aside: it can never be committed and is not offered again; its stored file goes. */
async function discard(tenantId: string, jobId: string) {
  const job = await loadJob(tenantId, jobId);
  if (!job) return bad("Not found", 404);
  const res = await withTenantContext(tenantId, (tx) => tx.importJob.updateMany({ where: { id: job.id, tenantId, status: "preview" }, data: { status: "superseded" } }));
  if (res.count !== 1) return bad("Only a preview can be set aside.", 409);
  try { await deleteImportFile(job.fileBlobUrl, tenantId); } catch { /* retention removes it */ }
  return NextResponse.json({ ok: true });
}

async function loadJob(tenantId: string, jobId: string) {
  if (!jobId) return null;
  return withTenantContext(tenantId, (tx) => tx.importJob.findFirst({ where: { id: jobId, tenantId, source: JOB_SOURCE }, select: JOB_SELECT }));
}

async function repreview(tenantId: string, jobId: string) {
  const job = await loadJob(tenantId, jobId);
  if (!job) return bad("Not found", 404);
  if (job.status !== "preview" || job.rolledBackAt) return bad("This import is no longer a preview.", 409);
  const text = await readJobFile(tenantId, job.fileBlobUrl);
  if (text === null) return bad("The uploaded file is no longer stored. Choose it again.", 410);
  const inputs = await withTenantContext(tenantId, (tx) => loadClubInputs(tx, tenantId));
  const built = buildPlan(text, inputs, new Date());
  if (built.errors) return bad(built.errors.join(" "), 400, { errors: built.errors });
  const summary = await withTenantContext(tenantId, (tx) => previewSummary(tx, tenantId, built, inputs, job.sourceExportedAt), { timeout: 30_000 });
  const planHash = planHashOf(job.fileHash ?? "", inputs);
  await withTenantContext(tenantId, (tx) =>
    tx.importJob.updateMany({ where: { id: job.id, tenantId, status: "preview" }, data: { dryRunSummary: { planHash, summary } as unknown as Prisma.InputJsonValue } }),
  );
  return NextResponse.json({ jobId: job.id, status: "preview", planHash, summary });
}

async function decide(req: Request, tenantId: string, userId: string, body: Record<string, unknown>) {
  const list = Array.isArray(body.decisions) ? (body.decisions as DecisionInput[]) : [];
  if (!list.length || list.length > 1000) return bad("Send between 1 and 1,000 decisions.");
  // A decision made from a preview that is no longer current is refused before anything is stored.
  if (body.jobId) {
    const job = await loadJob(tenantId, String(body.jobId));
    if (!job) return bad("Not found", 404);
    if (job.status !== "preview" || job.rolledBackAt) return bad("This preview is no longer current. Choose the file again.", 409);
  }
  const err = await withTenantContext(tenantId, (tx) => saveDecisions(tx, tenantId, userId, list), { timeout: 30_000 });
  if (err) return bad(err);
  await logAudit({
    tenantId, userId, action: "import.attendance.decisions", entityType: "ImportSourceMapping", entityId: String(body.jobId ?? "") || "club", req,
    metadata: { count: list.length, byKind: list.reduce<Record<string, number>>((a, d) => ((a[`${d.kind}:${d.action}`] = (a[`${d.kind}:${d.action}`] ?? 0) + 1), a), {}) },
  });
  if (body.jobId) return repreview(tenantId, String(body.jobId));
  return NextResponse.json({ ok: true });
}

async function commit(req: Request, tenantId: string, userId: string, jobId: string, planHash: string) {
  const job = await loadJob(tenantId, jobId);
  if (!job) return bad("Not found", 404);
  if (job.rolledBackAt) return bad("This import was rolled back.", 409);
  if (job.status === "running" || job.status === "failed") return NextResponse.json({ job: jobView(job), resume: true });
  if (job.status === "complete") return bad("This import is already complete.", 409);
  if (job.status !== "preview") return bad("Preview the file before importing it.", 409);

  const text = await readJobFile(tenantId, job.fileBlobUrl);
  if (text === null) return bad("The uploaded file is no longer stored. Choose it again.", 410);
  const inputs = await withTenantContext(tenantId, (tx) => loadClubInputs(tx, tenantId));
  const now = new Date();
  const built = buildPlan(text, inputs, now);
  if (built.errors) return bad(built.errors.join(" "), 400);
  const current = planHashOf(job.fileHash ?? "", inputs);
  const previewed = (job.dryRunSummary as { planHash?: string } | null)?.planHash;
  // A preview is only committable as previewed: same file, decisions and roster.
  if (!planHash || planHash !== previewed || planHash !== current) {
    return bad("Something changed since this preview (a decision, a member or a class). Preview again before importing.", 409, { stale: true });
  }
  if (built.plan.rejected.length) return bad(`${built.plan.rejected.length} rows could not be read. Fix the export and upload it again.`, 409);
  const undecided = [
    ...built.plan.offerings.filter((o) => !o.decision).map((o) => `class for "${o.label}"`),
    ...built.plan.venues.filter((v) => !v.decision).map((v) => `venue "${v.label}"`),
  ];
  if (undecided.length) return bad(`Decide these first: ${undecided.join(", ")}.`, 409, { undecided });

  const started = await withTenantContext(tenantId, async (tx) => {
    const token = await claimLease(tx, tenantId, job.id, ["preview"]);
    if (!token) return null;
    const mappings: JobMappings = { createdClasses: {}, snapshotAt: job.sourceExportedAt?.toISOString() ?? null, decisions: inputs.decisions };
    await createHistoricalClasses(tx, tenantId, job.id, built.plan, inputs, mappings.createdClasses);
    // Today's live sessions come from the timetable (with their end times)
    // before any of today's history is attached to them.
    await ensureTodayInstances(tx, tenantId, inputs.timezone);
    await releaseLease(tx, tenantId, job.id, token, {
      status: "running", startedAt: now, processedRows: 0, importedRows: 0, skippedRows: 0, errorRows: 0,
      totalRows: built.plan.bookings.length,
      mappings: mappings as unknown as Prisma.InputJsonValue,
      manifest: { kind: "attendance", inProgress: true, progress: emptyProgress() } as unknown as Prisma.InputJsonValue,
    });
    return mappings;
  }, { timeout: 60_000 });
  if (!started) return bad("This import is already starting in another tab.", 409, { busy: true });

  await logAudit({
    tenantId, userId, action: "import.attendance.commit", entityType: "ImportJob", entityId: job.id, req,
    metadata: { bookings: built.plan.bookings.length, classesCreated: Object.keys(started.createdClasses).length, planHash: planHash.slice(0, 12) },
  });
  const fresh = await loadJob(tenantId, job.id);
  return NextResponse.json({ job: fresh ? jobView(fresh) : null }, { status: 202 });
}

async function step(req: Request, tenantId: string, userId: string, jobId: string) {
  const job = await loadJob(tenantId, jobId);
  if (!job) return bad("Not found", 404);
  if (job.rolledBackAt) return bad("This import was rolled back.", 409);
  if (job.status === "complete") return NextResponse.json({ job: jobView(job), done: true });
  if (job.status !== "running" && job.status !== "failed") return bad("Start the import first.", 409);

  const r = await runStep(tenantId, jobId, (url) => readJobFile(tenantId, url));
  const fresh = await loadJob(tenantId, jobId);
  if (r.kind === "busy") return NextResponse.json({ job: fresh ? jobView(fresh) : null, busy: true }, { status: 202 });
  if (r.kind === "not_found") return bad("Not found", 404);
  if (r.kind === "failed") return NextResponse.json({ job: fresh ? jobView(fresh) : null, error: "This step failed; the import stopped at its last saved point and can be resumed." }, { status: 500 });
  if (r.kind === "complete") {
    // The file holds member names and emails; it goes as soon as it is used.
    try { await deleteImportFile(job.fileBlobUrl, tenantId); } catch (e) { console.warn("[import-attendance] file delete failed", e); }
    await logAudit({
      tenantId, userId, action: "import.attendance.complete", entityType: "ImportJob", entityId: jobId, req,
      metadata: { outcomes: (r.manifest as { outcomes?: unknown }).outcomes, attendance: (r.manifest as { attendance?: unknown }).attendance, reconciles: (r.manifest as { reconciles?: unknown }).reconciles },
    });
    return NextResponse.json({ job: fresh ? jobView(fresh) : null, done: true });
  }
  return NextResponse.json({ job: fresh ? jobView(fresh) : null, done: false });
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const url = new URL(req.url);
  // The panel, reopened: the import still in progress (or waiting for a decision), if any.
  if (url.searchParams.get("latest") === "1") {
    const open = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({ where: { tenantId, source: JOB_SOURCE, rolledBackAt: null, status: { in: ["preview", "running", "failed"] } }, orderBy: { createdAt: "desc" }, select: JOB_SELECT }),
    );
    if (!open) return NextResponse.json({ job: null });
    return NextResponse.json({ job: jobView(open), fileName: open.fileName, summary: open.status === "preview" ? (open.dryRunSummary as { summary?: unknown } | null)?.summary ?? null : null, planHash: open.status === "preview" ? (open.dryRunSummary as { planHash?: string } | null)?.planHash ?? null : null });
  }
  const job = await loadJob(tenantId, url.searchParams.get("jobId")?.trim() ?? "");
  if (!job) return bad("Not found", 404);
  const list = url.searchParams.get("list");
  if (!list) return NextResponse.json({ job: jobView(job), summary: job.status === "preview" ? (job.dryRunSummary as { summary?: unknown } | null)?.summary ?? null : null, planHash: job.status === "preview" ? (job.dryRunSummary as { planHash?: string } | null)?.planHash ?? null : null });
  if (list !== "people") return bad("Unknown list");

  const text = await readJobFile(tenantId, job.fileBlobUrl);
  if (text === null) return bad("The uploaded file is no longer stored.", 410);
  const inputs = await withTenantContext(tenantId, (tx) => loadClubInputs(tx, tenantId));
  const built = buildPlan(text, inputs, job.startedAt ?? new Date());
  if (built.errors) return bad(built.errors.join(" "));
  const memberName = new Map(inputs.members.map((m) => [m.id, m.name]));
  const state = url.searchParams.get("state") === "all" ? "all" : "pending";
  const people = built.plan.people.filter((p) => state === "all" || !p.memberId);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  return NextResponse.json({
    total: people.length,
    offset,
    limit,
    people: people.slice(offset, offset + limit).map((p) => ({
      personKey: p.personKey, name: p.name, email: p.email, bookings: p.bookings, attended: p.attended,
      memberId: p.memberId, memberName: p.memberId ? memberName.get(p.memberId) ?? null : null, matchMethod: p.matchMethod,
      decidedPending: p.decidedPending, sharedEmail: p.sharedEmail, missingEmail: p.missingEmail,
      candidates: p.candidates.map((c) => ({ ...c, name: memberName.get(c.memberId) ?? "" })),
    })),
  });
}

// ── DELETE: roll one commit back ─────────────────────────────────────────────

export async function DELETE(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const rl = await checkRateLimit(`import:attendance:${tenantId}`, 120, RL_WINDOW_MS);
  if (!rl.allowed) return rateLimited(rl.retryAfterSeconds);

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim() ?? "";
  const job = await loadJob(tenantId, jobId);
  if (!job) return bad("Not found", 404);
  if (job.rolledBackAt) return bad("This import was already rolled back.", 409);
  if (job.status !== "complete" && job.status !== "failed") return bad("Only a completed or stopped import can be rolled back.", 409);
  // Never while another attendance import is mid-run: it may be changing the very bookings this would undo.
  const running = await withTenantContext(tenantId, (tx) => tx.importJob.count({ where: { tenantId, source: JOB_SOURCE, status: "running", id: { not: job.id } } }));
  if (running) return bad("Another attendance import is running. Let it finish (or stop) before rolling back.", 409, { busy: true });

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const token = await claimLease(tx, tenantId, job.id, ["complete", "failed"]);
      if (!token) return null;
      const report = await rollbackJob(tx, tenantId, job.id);
      const manifest = (job.manifest ?? {}) as Record<string, unknown>;
      await releaseLease(tx, tenantId, job.id, token, { rolledBackAt: new Date(), manifest: { ...manifest, rollback: report } as unknown as Prisma.InputJsonValue });
      return report;
    }, { timeout: 120_000, maxWait: 15_000 });
    if (!result) return bad("This import is busy in another tab. Try again in a minute.", 409, { busy: true });
    // A stopped import may still hold its file.
    try { await deleteImportFile(job.fileBlobUrl, tenantId); } catch { /* already gone */ }
    await logAudit({ tenantId, userId, action: "import.attendance.rollback", entityType: "ImportJob", entityId: job.id, req, metadata: result });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return apiError("Rollback failed — nothing was removed", 500, e, "[admin/import/attendance]");
  }
}
