/**
 * POST /api/onboarding/csv-handoff
 *
 * Wizard v2 Step 13 — "white-glove" CSV import. Owner uploads their member
 * CSV during onboarding; instead of running the auto-importer, we save the
 * file and notify the MatFlow team, who import it by hand. No turnaround time
 * is promised (onboarding batch 1, 17 Oct 2026). Lets new gyms onboard without
 * learning the CSV column-mapping flow.
 *
 * Auth: requireOwner()
 * Body (multipart): file (CSV, max 10MB) + notes (optional, max 500)
 * Response: { jobId, message }
 *
 * Side effects:
 *   - Vercel Blob upload (private; the URL never leaves the server — not in
 *     client responses, not in the internal email)
 *   - ImportJob row with status='pending_white_glove'
 *   - Email to MATFLOW_APPLICATIONS_TO with the job id, tenant slug + notes
 *   - Audit log onboarding.csv_handoff
 */
import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { createHash, randomBytes } from "crypto";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { isEmailDeliveryOn } from "@/lib/email-delivery";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { z } from "zod";
import { checkUploadRateLimit, formFields, normaliseUploadFilename } from "@/lib/upload-guard";

// Lane C2 (9 Oct 2026): exactly `file`, an optional `notes` and (onboarding
// batch 1, 16 Oct 2026) an optional `clientRef`; anything else is refused.
//
// `clientRef` makes a retry safe. The wizard mints one random reference per
// chosen file and resends it on every retry of that file. If the first
// attempt was accepted but its response never reached the browser, the retry
// finds that job and returns it instead of storing the file again, creating a
// second job and emailing the team twice. It lives in the blob pathname, so no
// schema change is needed to look it up.
const CLIENT_REF = /^[a-f0-9]{32}$/;
const formSchema = z.strictObject({
  file: z.unknown().optional(),
  notes: z.string().max(4000).optional(),
  clientRef: z.string().regex(CLIENT_REF).optional(),
});
const CLIENT_REF_LOCK_NS = 0x43535648; // "CSVH"

const MAIL_OFF =
  "Your file is uploaded and safe. Email is turned off for this club, so the MatFlow team was not notified automatically — let your MatFlow contact know it's there.";

// No timing or delivery promise: a sent notification is all the code can see.
const SENT =
  "Your file is uploaded and safe, and a notification about it was sent to the MatFlow team. Your members will appear on the Members page once they're imported.";

/**
 * The same reference sent with different file content: refused, so the owner
 * is never told "we already have this file" about a file we don't have. The
 * wizard then forgets the reference, and sending again is a new hand-off.
 */
function refMismatch() {
  return NextResponse.json(
    { error: "This upload reference belongs to a different file. Choose the file again to send it as a new upload.", code: "handoff_ref_mismatch" },
    { status: 409 },
  );
}

/**
 * The reply to a retry that found the first hand-off. Whether the first
 * attempt reached the MatFlow team is read from its audit row, never assumed:
 * the owner may never have seen the first reply, which is the only place they
 * would have been told to contact us. Unknown (no row, or the first attempt
 * stopped before notifying) is said as unknown.
 */
async function alreadyReceived(tenantId: string, jobId: string, submittedNotes: string) {
  const row = await withTenantContext(tenantId, (tx) =>
    tx.auditLog.findFirst({
      where: { tenantId, action: "onboarding.csv_handoff", entityId: jobId },
      select: { metadata: true },
    }),
  ).catch(() => null);
  const meta = (row?.metadata ?? null) as { teamNotified?: unknown; notes?: unknown } | null;
  // What the first attempt recorded decides the reply, not today's mail
  // setting: a notification sent then was sent, whatever the setting is now.
  let message: string;
  if (meta?.teamNotified === true) {
    message = "We already have this file, so it wasn't sent twice. A notification about it was sent to the MatFlow team.";
  } else if (!isEmailDeliveryOn()) {
    message = `We already have this file, so it wasn't sent twice. ${MAIL_OFF.replace(/^Your file is uploaded and safe\. /, "")}`;
  } else {
    message = "We already have this file, so it wasn't sent twice — but we can't confirm the MatFlow team was told about it. Email hello@matflow.studio so we can import it.";
  }
  // Whether the notes sent now are the notes the first upload stored: null
  // when there is no record to compare with.
  const notesMatch = meta ? (typeof meta.notes === "string" ? meta.notes : "") === submittedNotes : null;
  if (notesMatch === false) {
    // Same channel as the sentence above it.
    message += meta?.teamNotified === true || isEmailDeliveryOn()
      ? " Notes you changed after your first attempt weren't added — email them to hello@matflow.studio."
      : " Notes you changed after your first attempt weren't added — pass them to your MatFlow contact too.";
  }
  return NextResponse.json({ jobId, message, alreadyReceived: true, notesMatch }, { status: 200 });
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NOTES_LEN = 500;

export const runtime = "nodejs";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  // WHAT THE CALLER SENT IS JUDGED FIRST; OUR STORAGE CONFIG IS OUR PROBLEM.
  //
  // The `BLOB_READ_WRITE_TOKEN` check used to stand here, ahead of every
  // validation, so on a deployment without blob storage an empty upload, a
  // 20 MB file and a .docx were all answered 503 "File uploads not
  // configured": the wrong fault, the wrong message, and — because a 5xx
  // invites a retry — advice that can never work. This is the same defect
  // round 2 fixed on the initiative-attachments route and the same fix; the
  // check now sits below, reached only by a file that would otherwise have
  // been stored.
  //
  // The oversize case is judged from `Content-Length` before the body is read
  // at all, because Next truncates the body clone it makes for the proxy at
  // 10 MB (node_modules/next/dist/server/body-streams.js:30, 93-103). Past
  // that the route is handed a multipart body cut off mid-part and
  // `req.formData()` throws — which is a caller's fault arriving as a parse
  // failure. The declared length is only ever used to REFUSE; `file.size`
  // below remains the authority on what is accepted, so a lying header buys
  // nothing.
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const fields = formFields(formData);
  const parsedForm = fields.ok ? formSchema.safeParse(fields.fields) : null;
  if (!parsedForm || !parsedForm.success) {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = parsedForm.data.file;
  const notes = (parsedForm.data.notes ?? "").trim().slice(0, MAX_NOTES_LEN);

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }
  // Accept .csv with the usual MIME variants browsers send.
  const ok =
    ["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"].includes(file.type) ||
    file.name.toLowerCase().endsWith(".csv");
  if (!ok) {
    return NextResponse.json({ error: "Only CSV files are supported" }, { status: 400 });
  }

  // A retry of a hand-off that already arrived: answer with that job and do
  // nothing else (no second file, job, email or rate-limit spend).
  const clientRef = parsedForm.data.clientRef ?? null;
  const refMarker = clientRef ? `/handoff-${clientRef}` : null;
  // What was sent, so a replay is only ever a replay of the same bytes.
  const contentHash = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  if (refMarker) {
    const existing = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({
        where: { tenantId, createdById: userId, status: "pending_white_glove", fileBlobUrl: { contains: refMarker } },
        select: { id: true, fileHash: true },
      }),
    );
    if (existing) {
      if (existing.fileHash !== contentHash) return refMismatch();
      return alreadyReceived(tenantId, existing.id, notes);
    }
  }

  // Every accepted hand-off is stored AND emails the MatFlow team, so the
  // budget is spent here — after the caller's own mistakes are refused, before
  // anything is stored or sent (lane C2; lib/upload-guard.ts says what backs it).
  const limited = await checkUploadRateLimit("csvHandoff", tenantId, userId);
  if (limited) return limited;

  // Reached only by a file we would otherwise have stored — see the note above.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "File uploads not configured", code: "uploads_unavailable" }, { status: 503 });
  }

  // Set once the file is stored, and once its job is committed: a failure in
  // between must not leave member data in storage with no job pointing at it.
  let storedUrl: string | null = null;
  let committed = false;
  try {
    const cuid = clientRef ?? randomBytes(12).toString("hex");
    // Private (audit P0-1): the handoff CSV is raw member PII — names,
    // emails, phones, dates of birth. A public blob URL is a permanent
    // unauthenticated download link, and this one was previously emailed
    // out. Same posture as the admin import upload: private blob, random
    // suffix, URL never returned to the client or put in an email; the
    // preview/commit readers resolve a signed downloadUrl via head().
    const blob = await put(`tenants/${tenantId}/imports/handoff-${cuid}.csv`, file, {
      access: "private",
      contentType: "text/csv",
      addRandomSuffix: true,
    });
    storedUrl = blob.url;
    // Deduplication finds a retry by this marker in the stored URL; if the
    // provider ever stops keeping the pathname, say so rather than fail open.
    if (refMarker && !blob.url.includes(refMarker)) {
      console.error("[onboarding/csv-handoff] clientRef not in blob url; retries of this upload cannot be matched");
    }

    const created = await withTenantContext(tenantId, async (tx) => {
      if (refMarker) {
        // A retry can arrive while the first attempt is still being stored.
        // Serialise per reference and look again, so only one job is created.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLIENT_REF_LOCK_NS}::int4, hashtext(${`${tenantId}:${clientRef}`}::text))`;
        const raced = await tx.importJob.findFirst({
          where: { tenantId, createdById: userId, status: "pending_white_glove", fileBlobUrl: { contains: refMarker } },
          select: { id: true, fileHash: true },
        });
        if (raced) return { kind: "duplicate" as const, duplicateOf: raced.id, sameFile: raced.fileHash === contentHash };
      }
      const j = await tx.importJob.create({
        data: {
          tenantId,
          createdById: userId,
          source: "generic",
          fileName: normaliseUploadFilename(file.name, "members.csv"),
          fileBlobUrl: blob.url,
          // The content hash: a replay under this reference must carry the
          // same bytes. (The admin import's duplicate guards only consider
          // complete or running jobs, so a pending hand-off refuses nothing.)
          fileHash: contentHash,
          status: "pending_white_glove",
        },
      });
      const [t, o] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } }),
        tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
      ]);
      return { kind: "created" as const, job: j, tenant: t, owner: o };
    });
    committed = true;
    if (created.kind === "duplicate") {
      // The first attempt won the race: drop this copy of the file and answer
      // with the first job. Best effort — an orphaned private blob holds no job.
      await del(blob.url).catch(() => {});
      if (!created.sameFile) return refMismatch();
      return alreadyReceived(tenantId, created.duplicateOf, notes);
    }
    const { job, tenant, owner } = created;

    // Unset default must actually deliver — see app/api/apply/route.ts note.
    const internalRecipients = (process.env.MATFLOW_APPLICATIONS_TO ?? "noetopalian@gmail.com")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // The team notifications. The owner gets confirmation either way, but the
    // confirmation must not promise an email when none can go out (7 Oct 2026,
    // mail-dark): whether a human at MatFlow was reached is read off the results.
    const notified = await Promise.allSettled(
      internalRecipients.map((to) =>
        sendEmail({
          tenantId,
          templateId: "csv_handoff_internal",
          to,
          // Audit P0-1: no blob URL here. The CSV is a private blob and the
          // job id + tenant slug are enough for an operator to open it
          // through the admin import flow, which is authenticated.
          vars: {
            gymName: tenant?.name ?? "(unknown)",
            tenantSlug: tenant?.slug ?? "",
            contactName: owner?.name ?? "",
            contactEmail: owner?.email ?? "",
            fileName: job.fileName,
            fileSizeKb: String(Math.round(file.size / 1024)),
            notes,
            jobId: job.id,
          },
        }),
      ),
    );

    const teamReached = notified.some((r) => r.status === "fulfilled" && r.value?.ok === true);

    // Durable (awaited, own transaction): a retry reads teamNotified and notes
    // back from this row (alreadyReceived). If the write still fails, the job
    // and email stand; a later replay then says it can't confirm, which is true.
    await logAudit({
      tenantId,
      userId,
      action: "onboarding.csv_handoff",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, sizeBytes: file.size, notes: notes || null, teamNotified: teamReached },
      req,
      durable: true,
    }).catch((e) => console.warn("[onboarding/csv-handoff] audit write failed", e instanceof Error ? e.message : e));

    const message = !isEmailDeliveryOn()
      ? MAIL_OFF
      : teamReached
        ? SENT
        : "Your file is uploaded and safe, but our automatic notification to the MatFlow team didn't go through — email hello@matflow.studio so we can import it.";

    return NextResponse.json(
      {
        jobId: job.id,
        message,
        teamNotified: teamReached,
      },
      { status: 201 },
    );
  } catch (e) {
    // Stored but no job committed (the transaction failed): remove the file
    // unless a job does point at it (the commit landed but its answer was
    // lost), so member data is never left in storage with nothing to find it.
    if (storedUrl && !committed) {
      const url = storedUrl;
      const owned = await withTenantContext(tenantId, (tx) =>
        tx.importJob.findFirst({ where: { tenantId, fileBlobUrl: url }, select: { id: true } }),
      ).catch(() => ({ id: "unknown" }));
      if (!owned) await del(url).catch(() => {});
    }
    return apiError("CSV handoff upload failed", 500, e, "[onboarding/csv-handoff]");
  }
}
