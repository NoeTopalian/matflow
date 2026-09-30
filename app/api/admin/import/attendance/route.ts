// /api/admin/import/attendance — a club's attendance history, imported.
//
//   POST   multipart, mode=preview  → store the file, plan it, keep the totals
//   POST   multipart, mode=commit   → re-read the stored file, re-plan, write
//   DELETE ?jobId=…                 → remove what one commit wrote
//
// An imported attendance is history, not an event. The commit writes plain
// `ClassInstance` and `AttendanceRecord` rows and nothing else: no email, no
// notification, no class-pack credit, no streak or leaderboard side effect.
// That is why this route never goes near lib/checkin.ts — every side effect a
// real check-in has is one an import must not trigger.
//
// The plan (lib/importers/attendance.ts) is never trusted from storage: a
// commit re-reads the file and re-plans against the club as it is now, so a
// member added or a class renamed between preview and commit is honoured.
//
// Review mode (lib/review-lock.ts) does NOT refuse this route: importing
// history is exactly what a club in review is inspecting.
//
// Contract: docs/runbooks/ATTENDANCE-IMPORT.md.

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { deleteImportFile, importStorageAvailable, putImportFile, readImportFile, sha256 } from "@/lib/import-storage";
import {
  parseAttendanceCsv,
  planAttendanceImport,
  sessionDayMarker,
  type AttendancePlan,
  type PlannedRecord,
  type PlannedSession,
  type QuarantineReason,
} from "@/lib/importers/attendance";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

export const runtime = "nodejs";
export const maxDuration = 300;

const SOURCE = "teamup-attendance";
const MAPPING_VERSION = "attendance@2026-09-30";
const MAX_BYTES = 10 * 1024 * 1024;
/** Records per transaction. */
const SLICE = 200;
/** Quarantined / excluded entries kept on the preview summary. */
const LIST_CAP = 500;
/** Above this many created sessions the ids are not recorded, and rollback leaves the sessions in place. */
const INSTANCE_ID_CAP = 5000;
/** A run older than the longest a commit can take has died and may be re-run. */
const STALE_RUN_MS = (maxDuration + 60) * 1000;
const RL_MAX = 30;
const RL_WINDOW_MS = 60 * 60 * 1000;

type Quarantined = { sourceRowId: string; line: number; reason: QuarantineReason | "future_session"; detail?: string };

type PlanInputs = {
  timezone: string;
  members: { id: string; name: string; email: string; externalRef: string | null }[];
  classes: { id: string; name: string; duration: number }[];
};

type Committable = {
  plan: AttendancePlan;
  /** Records for sessions that have started, with a matched class. */
  records: PlannedRecord[];
  sessionByKey: Map<string, PlannedSession>;
  quarantined: Quarantined[];
  mappedColumns: Record<string, string | null>;
  unmappedColumns: string[];
};

async function loadPlanInputs(tenantId: string): Promise<PlanInputs> {
  return withTenantContext(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    // Every member, whatever their status: a cancelled member's history is still history.
    const members = await tx.member.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true, externalRef: true },
    });
    const classes = await tx.class.findMany({
      where: { tenantId, isActive: true, deletedAt: null },
      select: { id: true, name: true, duration: true },
    });
    return { timezone: tenant?.timezone ?? "", members, classes };
  });
}

/**
 * Parse and plan, then hold back every session that has not started yet: an
 * import writes history, and a future session is a booking, not attendance.
 * Throws only for an invalid club timezone (the planner refuses to guess one).
 */
function buildPlan(text: string, inputs: PlanInputs, now: Date): { errors: string[] } | Committable {
  const parsed = parseAttendanceCsv(text);
  if (parsed.errors.length) return { errors: parsed.errors };

  const plan = planAttendanceImport(parsed.rows, {
    timezone: inputs.timezone,
    members: inputs.members.map((m) => ({
      id: m.id,
      name: m.name,
      // A synthesised no-login address is ours, not the member's: it can never
      // appear in another platform's export, so it is never matched on.
      email: isSynthesisedEmail(m.email) ? "" : m.email,
      sourceIds: m.externalRef ? [m.externalRef] : [],
    })),
    classes: inputs.classes.map((c) => ({ id: c.id, name: c.name, duration: c.duration })),
  });

  const lineOf = new Map<string, number>();
  for (const r of parsed.rows) if (!lineOf.has(r.sourceRowId)) lineOf.set(r.sourceRowId, r.line);
  const sessionByKey = new Map(plan.sessions.map((s) => [s.key, s]));
  const quarantined: Quarantined[] = [...plan.quarantined];
  const records: PlannedRecord[] = [];
  for (const rec of plan.records) {
    const session = sessionByKey.get(rec.sessionKey)!;
    if (Date.parse(session.startUtc) > now.getTime()) {
      const sourceRowId = rec.sourceRowIds[0];
      quarantined.push({ sourceRowId, line: lineOf.get(sourceRowId) ?? 0, reason: "future_session", detail: session.startUtc });
      continue;
    }
    records.push(rec);
  }
  return { plan, records, sessionByKey, quarantined, mappedColumns: parsed.mappedColumns, unmappedColumns: parsed.unmappedColumns };
}

function byReason(list: { reason: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of list) out[q.reason] = (out[q.reason] ?? 0) + 1;
  return out;
}

function previewSummary(c: Committable) {
  const recordsByMonth: Record<string, number> = {};
  const sessions = new Set<string>();
  for (const r of c.records) {
    const s = c.sessionByKey.get(r.sessionKey)!;
    recordsByMonth[s.localDate.slice(0, 7)] = (recordsByMonth[s.localDate.slice(0, 7)] ?? 0) + 1;
    sessions.add(s.key);
  }
  return {
    inputRows: c.plan.totals.inputRows,
    toImport: c.records.length,
    sessions: sessions.size,
    quarantined: c.quarantined.length,
    excluded: c.plan.excluded.length,
    duplicates: c.plan.totals.duplicates,
    recordsByMonth,
    quarantinedByReason: byReason(c.quarantined),
    excludedByReason: byReason(c.plan.excluded),
    mappedColumns: c.mappedColumns,
    unmappedColumns: c.unmappedColumns,
    reconciles: c.records.length + c.quarantined.length + c.plan.excluded.length === c.plan.totals.inputRows,
  };
}

/** "HH:mm" plus minutes, wrapping at midnight. */
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Too many import requests. Try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

// ── POST: preview or commit ──────────────────────────────────────────────────

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  const rl = await checkRateLimit(`import:attendance:${tenantId}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) return rateLimited(rl.retryAfterSeconds);

  if (!importStorageAvailable()) {
    return NextResponse.json({ error: "File uploads not configured" }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form" }, { status: 400 });
  }
  const mode = String(formData.get("mode") ?? "preview");
  if (mode === "commit") return commit(req, tenantId, userId, String(formData.get("jobId") ?? "").trim());
  if (mode !== "preview") return NextResponse.json({ error: "mode must be preview or commit" }, { status: 400 });

  try {
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    if (!["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"].includes(file.type) && !file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "Only CSV files are supported" }, { status: 400 });
    }

    // When the source platform produced the file, as the owner states it.
    const exportedRaw = String(formData.get("sourceExportedAt") ?? "").trim();
    const sourceExportedAt = exportedRaw ? new Date(exportedRaw) : null;
    if (sourceExportedAt && (isNaN(sourceExportedAt.getTime()) || sourceExportedAt.getTime() > Date.now() + 5 * 60 * 1000)) {
      return NextResponse.json({ error: "The export date must be a real date that is not in the future." }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileHash = sha256(bytes);
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

    const text = new TextDecoder("utf-8").decode(bytes);
    const inputs = await loadPlanInputs(tenantId);
    let built: ReturnType<typeof buildPlan>;
    try {
      built = buildPlan(text, inputs, new Date());
    } catch {
      return NextResponse.json({ error: "The club's timezone is not set correctly. Fix it in Settings before importing." }, { status: 422 });
    }
    if ("errors" in built) return NextResponse.json({ error: built.errors.join(" "), errors: built.errors }, { status: 400 });

    const summary = previewSummary(built);
    const fileUrl = await putImportFile(tenantId, bytes);
    const job = await withTenantContext(tenantId, (tx) =>
      tx.importJob.create({
        data: {
          tenantId,
          createdById: userId,
          source: SOURCE,
          fileName: file.name.slice(0, 200),
          fileBlobUrl: fileUrl,
          status: "preview",
          fileHash,
          sourceExportedAt,
          mappingVersion: MAPPING_VERSION,
          totalRows: summary.inputRows,
          dryRunSummary: {
            ...summary,
            quarantinedList: built.quarantined.slice(0, LIST_CAP),
            excludedList: built.plan.excluded.slice(0, LIST_CAP),
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    );

    await logAudit({
      tenantId,
      userId,
      action: "import.attendance.preview",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, sizeBytes: file.size, fileHash, mappingVersion: MAPPING_VERSION, toImport: summary.toImport },
      req,
    });

    return NextResponse.json({ jobId: job.id, status: "preview", summary }, { status: 201 });
  } catch (e) {
    return apiError("Attendance import preview failed", 500, e, "[admin/import/attendance]");
  }
}

async function commit(req: Request, tenantId: string, userId: string, jobId: string) {
  if (!jobId) return NextResponse.json({ error: "jobId is required to commit" }, { status: 400 });

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { id: jobId, tenantId, source: SOURCE } }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.rolledBackAt) return NextResponse.json({ error: "This import was rolled back" }, { status: 409 });
  if (job.status === "complete") return NextResponse.json({ error: "Job already complete" }, { status: 409 });
  // A run that died part-way stays "running" for ever. Once it is older than
  // the longest a commit can run it may be re-run: every row it wrote is
  // skipped on the unique keys, and the sessions it created are carried over
  // from the progress it recorded.
  if (job.status === "running" && job.startedAt && Date.now() - job.startedAt.getTime() < STALE_RUN_MS) {
    return NextResponse.json({ error: "Job already running" }, { status: 409 });
  }
  if (!["preview", "failed", "running"].includes(job.status)) {
    return NextResponse.json({ error: "Preview the file before committing it" }, { status: 409 });
  }
  if (job.fileHash) {
    const prior = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({
        // Complete, or still running and not stale (connection register gap 14).
        where: {
          tenantId, fileHash: job.fileHash, rolledBackAt: null, id: { not: job.id },
          OR: [{ status: "complete" }, { status: "running", startedAt: { gte: new Date(Date.now() - STALE_RUN_MS) } }],
        },
        select: { id: true },
      }),
    );
    if (prior) return NextResponse.json({ error: "This exact file was already imported.", priorJobId: prior.id }, { status: 409 });
  }
  const resumed = job.status === "running";
  // A retry after a FAILED run carries its created sessions over too
  // (connection register gap 17, 30 Sep 2026): only a stale "running" run did,
  // so a failed-then-retried import forgot the sessions the failed run made
  // and a later rollback left them behind. The failure path keeps the manifest.
  const carryOver = job.status === "running" || job.status === "failed";
  const priorManifest = (job.manifest ?? {}) as { createdInstanceIds?: unknown; createdInstanceCount?: unknown; createdInstanceIdsTruncated?: unknown };
  const createdInstanceIds: string[] = carryOver && Array.isArray(priorManifest.createdInstanceIds) ? (priorManifest.createdInstanceIds as string[]) : [];
  let createdInstanceCount = carryOver && typeof priorManifest.createdInstanceCount === "number" ? priorManifest.createdInstanceCount : createdInstanceIds.length;
  let truncated = carryOver && priorManifest.createdInstanceIdsTruncated === true;

  // Claim the run in one conditional write (connection register gap 13).
  const claimed = await withTenantContext(tenantId, (tx) =>
    tx.importJob.updateMany({
      where: {
        id: job.id, tenantId,
        OR: [
          { status: { in: ["preview", "failed"] } },
          { status: "running", OR: [{ startedAt: null }, { startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }] },
        ],
      },
      data: { status: "running", startedAt: new Date(), processedRows: 0, importedRows: 0, skippedRows: 0 },
    }),
  );
  if (claimed.count !== 1) return NextResponse.json({ error: "Job already running" }, { status: 409 });

  try {
    const text = await readImportFile(job.fileBlobUrl);
    if (text === null) throw new Error("Import file is no longer in storage");

    const inputs = await loadPlanInputs(tenantId);
    const built = buildPlan(text, inputs, new Date());
    if ("errors" in built) throw new Error(built.errors.join(" "));
    const { plan, records, sessionByKey, quarantined } = built;
    const classById = new Map(inputs.classes.map((c) => [c.id, c]));

    const slotOf = (s: PlannedSession) => ({
      classId: s.classId!,
      date: sessionDayMarker(s),
      startTime: s.startTime,
      endTime: s.endTime ?? addMinutes(s.startTime, classById.get(s.classId!)?.duration ?? 60),
    });
    const slotKey = (x: { classId: string; date: Date; startTime: string }) => `${x.classId}|${x.date.toISOString()}|${x.startTime}`;

    let alreadyPresent = 0;
    for (let i = 0; i < records.length; i += SLICE) {
      const slice = records.slice(i, i + SLICE);
      const out = await withTenantContext(
        tenantId,
        async (tx) => {
          // 1. The past sessions this slice needs: find, create the missing
          //    ones (skipDuplicates on @@unique([classId, date, startTime])),
          //    find again. Only an id absent before and present after was
          //    created here — a cron-made or live session is never claimed.
          const slots = [...new Map(slice.map((r) => {
            const slot = slotOf(sessionByKey.get(r.sessionKey)!);
            return [slotKey(slot), slot] as const;
          })).values()];
          const findSlots = () =>
            tx.classInstance.findMany({
              where: { class: { tenantId }, OR: slots.map((s) => ({ classId: s.classId, date: s.date, startTime: s.startTime })) },
              select: { id: true, classId: true, date: true, startTime: true },
            });
          const before = await findSlots();
          const beforeKeys = new Set(before.map(slotKey));
          const missing = slots.filter((s) => !beforeKeys.has(slotKey(s)));
          if (missing.length) await tx.classInstance.createMany({ data: missing, skipDuplicates: true });
          const after = missing.length ? await findSlots() : before;
          const idBySlot = new Map(after.map((x) => [slotKey(x), x.id]));
          const newIds = after.filter((x) => !beforeKeys.has(slotKey(x))).map((x) => x.id);

          // 2. The records. A check-in already there (live, or another
          //    import) wins: skipDuplicates on @@unique([memberId, classInstanceId]).
          const rows = slice.map((r) => {
            const instanceId = idBySlot.get(slotKey(slotOf(sessionByKey.get(r.sessionKey)!)));
            if (!instanceId) throw new Error(`No class session for ${r.sessionKey}`);
            return {
              tenantId,
              memberId: r.memberId,
              classInstanceId: instanceId,
              checkInTime: new Date(r.checkInTimeUtc),
              checkInMethod: "import",
              importJobId: job.id,
              sourceRowId: r.sourceRowIds[0],
            };
          });
          const existing = await tx.attendanceRecord.findMany({
            where: {
              tenantId,
              classInstanceId: { in: [...new Set(rows.map((r) => r.classInstanceId))] },
              memberId: { in: [...new Set(rows.map((r) => r.memberId))] },
            },
            select: { memberId: true, classInstanceId: true, importJobId: true },
          });
          const existingBy = new Map(existing.map((e) => [`${e.memberId}|${e.classInstanceId}`, e.importJobId]));
          let already = 0;
          for (const r of rows) {
            const k = `${r.memberId}|${r.classInstanceId}`;
            // A row this same job wrote on an earlier, interrupted run is its own, not "already there".
            if (existingBy.has(k) && existingBy.get(k) !== job.id) already += 1;
          }
          await tx.attendanceRecord.createMany({ data: rows, skipDuplicates: true });
          return { newIds, already };
        },
        { timeout: 30_000 },
      );

      alreadyPresent += out.already;
      createdInstanceCount += out.newIds.length;
      if (!truncated && createdInstanceIds.length + out.newIds.length > INSTANCE_ID_CAP) {
        truncated = true;
        createdInstanceIds.length = 0;
      }
      if (!truncated) createdInstanceIds.push(...out.newIds);

      // Progress, and the sessions created so far, so a resumed run and a
      // rollback both know what this job made.
      const processed = Math.min(i + slice.length, records.length);
      await withTenantContext(tenantId, (tx) =>
        tx.importJob.update({
          where: { id: job.id },
          data: {
            processedRows: processed,
            manifest: {
              inProgress: true,
              createdInstanceCount,
              createdInstanceIdsTruncated: truncated,
              ...(truncated ? {} : { createdInstanceIds }),
            } as unknown as Prisma.InputJsonValue,
          },
        }),
      );
    }

    // What this job's rows actually are, read back from the database.
    const created = await withTenantContext(
      tenantId,
      (tx) =>
        tx.attendanceRecord.findMany({
          where: { tenantId, importJobId: job.id },
          select: { classInstance: { select: { classId: true, date: true } } },
        }),
      { timeout: 30_000 },
    );
    const byMonth: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    for (const r of created) {
      const month = r.classInstance.date.toISOString().slice(0, 7);
      byMonth[month] = (byMonth[month] ?? 0) + 1;
      const name = classById.get(r.classInstance.classId)?.name ?? r.classInstance.classId;
      byClass[name] = (byClass[name] ?? 0) + 1;
    }

    const manifest = {
      kind: "attendance",
      mappingVersion: job.mappingVersion,
      sourceExportedAt: job.sourceExportedAt?.toISOString() ?? null,
      resumed,
      input: { rows: plan.totals.inputRows },
      created: { total: created.length, byMonth, byClass },
      alreadyPresent,
      quarantined: { total: quarantined.length, byReason: byReason(quarantined) },
      excluded: { total: plan.excluded.length, byReason: byReason(plan.excluded), duplicates: plan.totals.duplicates },
      sessions: { created: createdInstanceCount },
      createdInstanceCount,
      createdInstanceIdsTruncated: truncated,
      ...(truncated ? {} : { createdInstanceIds }),
      // Every input row is exactly one of: written by this job, already in
      // MatFlow, held back with a reason, or excluded with a reason.
      reconciles: created.length + alreadyPresent + quarantined.length + plan.excluded.length === plan.totals.inputRows,
    };

    await withTenantContext(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: {
          status: "complete",
          completedAt: new Date(),
          totalRows: plan.totals.inputRows,
          processedRows: records.length,
          importedRows: created.length,
          skippedRows: alreadyPresent + plan.excluded.length,
          errorRows: quarantined.length,
          manifest: manifest as unknown as Prisma.InputJsonValue,
        },
      }),
    );

    // The file holds member names and emails; it goes as soon as it is used.
    try { await deleteImportFile(job.fileBlobUrl); }
    catch (e) { console.warn("[import-attendance] file delete failed", e); }

    await logAudit({
      tenantId,
      userId,
      action: "import.attendance.commit",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: {
        created: created.length,
        alreadyPresent,
        quarantined: quarantined.length,
        excluded: plan.excluded.length,
        sessionsCreated: createdInstanceCount,
        reconciles: manifest.reconciles,
        resumed,
      },
      req,
    });

    return NextResponse.json({ ok: true, jobId: job.id, manifest });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Import failed";
    console.error(`[admin/import/attendance ${job.id}] commit failed`, e);
    await withTenantContext(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: { status: "failed", completedAt: new Date(), errorLog: [{ row: 0, reason: msg }] as unknown as Prisma.InputJsonValue },
      }),
    );
    return NextResponse.json({ error: "Import failed — see import history for details" }, { status: 500 });
  }
}

// ── DELETE: roll one commit back ─────────────────────────────────────────────

export async function DELETE(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  const rl = await checkRateLimit(`import:attendance:${tenantId}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) return rateLimited(rl.retryAfterSeconds);

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({
      where: { id: jobId, tenantId, source: SOURCE },
      select: { id: true, status: true, rolledBackAt: true, fileName: true, manifest: true },
    }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.rolledBackAt) return NextResponse.json({ error: "This import was already rolled back" }, { status: 409 });
  if (job.status !== "complete") return NextResponse.json({ error: "Only a completed import can be rolled back" }, { status: 409 });

  const manifest = (job.manifest ?? {}) as Record<string, unknown>;
  const instanceIds = Array.isArray(manifest.createdInstanceIds) ? (manifest.createdInstanceIds as string[]) : null;

  try {
    const result = await withTenantContext(
      tenantId,
      async (tx) => {
        // The sessions this job's rows sat in, before they go.
        const touched = await tx.attendanceRecord.findMany({
          where: { tenantId, importJobId: job.id },
          select: { classInstanceId: true },
          distinct: ["classInstanceId"],
        });
        // Only this job's rows. A live check-in never carries an importJobId.
        const records = await tx.attendanceRecord.deleteMany({ where: { tenantId, importJobId: job.id } });

        // Sessions an EARLIER attendance import created that this job's rows kept
        // alive: once those rows go they may be empty, and nobody else will ever
        // remove them (verifier lane 5, 30 Sep 2026). Created-by-import only —
        // a session the timetable made is never touched.
        const touchedIds = touched.map((t) => t.classInstanceId);
        const importCreated = new Set<string>();
        if (touchedIds.length) {
          const otherJobs = await tx.importJob.findMany({
            where: { tenantId, source: SOURCE, id: { not: job.id } },
            select: { manifest: true },
          });
          for (const o of otherJobs) {
            const ids = (o.manifest as { createdInstanceIds?: unknown } | null)?.createdInstanceIds;
            if (Array.isArray(ids)) for (const id of ids) if (touchedIds.includes(id as string)) importCreated.add(id as string);
          }
        }

        // Sessions this job created, in the past, that nothing else uses now.
        let instancesRemoved = 0;
        let instancesKept = 0;
        const sessionCandidates = [...new Set([...(instanceIds ?? []), ...importCreated])];
        if (sessionCandidates.length) {
          const candidates = await tx.classInstance.findMany({
            where: { id: { in: sessionCandidates }, class: { tenantId }, date: { lt: new Date() } },
            select: { id: true, _count: { select: { attendances: true, waitlists: true } } },
          });
          const removable = candidates.filter((c) => c._count.attendances === 0 && c._count.waitlists === 0).map((c) => c.id);
          if (removable.length) {
            const del = await tx.classInstance.deleteMany({ where: { id: { in: removable }, class: { tenantId } } });
            instancesRemoved = del.count;
          }
          instancesKept = (instanceIds?.length ?? 0) - Math.min(instancesRemoved, instanceIds?.length ?? 0);
        }

        await tx.importJob.update({
          where: { id: job.id },
          data: {
            rolledBackAt: new Date(),
            manifest: {
              ...manifest,
              rollback: { recordsRemoved: records.count, instancesRemoved, instancesKept, instanceIdsTruncated: !instanceIds },
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return { recordsRemoved: records.count, instancesRemoved, instancesKept };
      },
      { timeout: 60_000 },
    );

    await logAudit({
      tenantId,
      userId,
      action: "import.attendance.rollback",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, ...result, instanceIdsTruncated: !instanceIds },
      req,
    });

    return NextResponse.json({
      ok: true,
      ...result,
      ...(instanceIds
        ? {}
        : {
            message: `This import created more than ${INSTANCE_ID_CAP.toLocaleString("en-GB")} class sessions, so they were not recorded one by one and have been left in place. Its attendance records have been removed.`,
          }),
    });
  } catch (e) {
    return apiError("Rollback failed — nothing was removed", 500, e, "[admin/import/attendance]");
  }
}
