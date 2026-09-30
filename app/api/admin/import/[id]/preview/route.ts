import { NextResponse } from "next/server";
import { readImportFile } from "@/lib/import-storage";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { parseImport, type ImportSource } from "@/lib/importers";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. Mutating POST on the same import job as commit.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { id } = await params;

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { id, tenantId } }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A committed (or running) job has had its file deleted; previewing it again
  // used to fail, flip the job to "failed" and so block its rollback for good
  // (verifier lane 5, 30 Sep 2026). Refuse and leave the job alone.
  if (job.status === "complete" || job.status === "running" || job.rolledBackAt) {
    return NextResponse.json({ error: `This import is already ${job.rolledBackAt ? "rolled back" : job.status}; upload the file again to preview it.` }, { status: 409 });
  }

  try {
    // Private-blob-safe read. `head().downloadUrl` carries NO credential —
    // @vercel/blob builds it as the plain blob URL with `?download=1` — so the
    // bare fetch that used to follow it 403'd against these `access: "private"`
    // CSVs and the preview always reported "Failed to fetch file (403)". Same
    // defect, same fix as app/api/blob-image/route.ts: `get()` sends the store
    // token server-side. It returns null for a blob that is not there and
    // throws for everything else, so absence gets its own message.
    const text = await readImportFile(job.fileBlobUrl);
    if (text === null) throw new Error("Import file is no longer in storage");

    const { drafts, errors, summary: sourceSummary } = parseImport(job.source as ImportSource, text);

    const summary = await withTenantContext(tenantId, async (tx) => {
      // Synthesised (non-contactable) addresses are fresh on every parse, so
      // the existing-email check cannot see them; the commit dedupes those by
      // name + date of birth. Here they count as importable.
      const emails = drafts.filter((d) => !d.nonContactable).map((d) => d.email);
      const existing = emails.length
        ? await tx.member.findMany({
            where: { tenantId, email: { in: emails } },
            select: { email: true },
          })
        : [];
      const existingSet = new Set(existing.map((m) => m.email));
      const totalRows = drafts.length + errors.length;
      const willImport = drafts.filter((d) => !existingSet.has(d.email)).length;
      const willSkipExisting = drafts.filter((d) => existingSet.has(d.email)).length;
      const s = {
        totalRows,
        validRows: drafts.length,
        errorRows: errors.length,
        existingMatches: willSkipExisting,
        willImport,
        willSkip: willSkipExisting + errors.length,
        sampleDrafts: drafts.slice(0, 5).map((d) => ({
          name: d.name,
          email: d.nonContactable ? "(no email)" : d.email,
          membershipType: d.membershipType,
          nextDueAt: d.nextDueAt,
          paymentStatus: d.paymentStatus,
          accountType: d.accountType,
          unverified: d.unverified ?? false,
        })),
        sampleErrors: errors.slice(0, 10),
        ...(sourceSummary ? { source: sourceSummary as Prisma.InputJsonObject } : {}),
      };
      await tx.importJob.update({
        where: { id: job.id },
        data: {
          status: "preview",
          totalRows,
          skippedRows: 0,
          errorRows: errors.length,
          dryRunSummary: s,
          errorLog: errors.length > 0 ? (errors as unknown as object) : undefined,
        },
      });
      return s;
    });

    return NextResponse.json(summary);
  } catch (e) {
    await withTenantContext(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: { status: "failed", errorLog: [{ row: 0, reason: "Import preview failed" }] as unknown as object },
      }),
    );
    return apiError("Import preview failed", 500, e, "[admin/import/preview]");
  }
}
