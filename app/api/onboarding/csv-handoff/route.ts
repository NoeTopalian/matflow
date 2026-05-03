/**
 * POST /api/onboarding/csv-handoff
 *
 * Wizard v2 Step 13 — "white-glove" CSV import. Owner uploads their member
 * CSV during onboarding; instead of running the auto-importer, we save the
 * file and email the MatFlow team to import it manually within 1 business
 * day. Lets new gyms onboard without learning the CSV column-mapping flow.
 *
 * Auth: requireOwner()
 * Body (multipart): file (CSV, max 10MB) + notes (optional, max 500)
 * Response: { jobId, message }
 *
 * Side effects:
 *   - Vercel Blob upload (still public-by-SDK; the URL never appears in
 *     client responses — only the internal email gets it)
 *   - ImportJob row with status='pending_white_glove'
 *   - Email to MATFLOW_APPLICATIONS_TO with download URL + notes
 *   - Audit log onboarding.csv_handoff
 */
import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NOTES_LEN = 500;

export const runtime = "nodejs";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { tenantId, userId } = await requireOwner();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "File uploads not configured" }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  const notes = String(formData.get("notes") ?? "").trim().slice(0, MAX_NOTES_LEN);

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

  try {
    const cuid = randomBytes(12).toString("hex");
    const blob = await put(`tenants/${tenantId}/imports/handoff-${cuid}.csv`, file, {
      access: "public",
      contentType: "text/csv",
      addRandomSuffix: true,
    });

    const { job, tenant, owner } = await withTenantContext(tenantId, async (tx) => {
      const j = await tx.importJob.create({
        data: {
          tenantId,
          createdById: userId,
          source: "generic",
          fileName: file.name.slice(0, 200),
          fileBlobUrl: blob.url,
          status: "pending_white_glove",
        },
      });
      const [t, o] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
      ]);
      return { job: j, tenant: t, owner: o };
    });

    const internalRecipients = (process.env.MATFLOW_APPLICATIONS_TO ?? "hello@matflow.io")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Fire-and-forget the team notifications — owner gets confirmation either way.
    await Promise.allSettled(
      internalRecipients.map((to) =>
        sendEmail({
          tenantId,
          templateId: "csv_handoff_internal",
          to,
          vars: {
            gymName: tenant?.name ?? "(unknown)",
            contactName: owner?.name ?? "",
            contactEmail: owner?.email ?? "",
            fileName: job.fileName,
            fileSizeKb: String(Math.round(file.size / 1024)),
            downloadUrl: blob.url,
            notes,
            jobId: job.id,
          },
        }),
      ),
    );

    await logAudit({
      tenantId,
      userId,
      action: "onboarding.csv_handoff",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, sizeBytes: file.size, notes: notes || null },
      req,
    });

    return NextResponse.json(
      {
        jobId: job.id,
        message: "We'll import your members within 1 business day and email you when they're ready.",
      },
      { status: 201 },
    );
  } catch (e) {
    return apiError("CSV handoff upload failed", 500, e, "[onboarding/csv-handoff]");
  }
}
