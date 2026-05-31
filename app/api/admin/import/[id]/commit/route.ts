import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import type { Prisma } from "@prisma/client";
import { requireOwner } from "@/lib/authz";
import { parseImport, type ImportSource } from "@/lib/importers";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
// Audit iter-1-operator-admin A6I1-S-1: del() removes the publicly-readable
// CSV from Vercel Blob storage after we've finished importing it. Combined
// with `addRandomSuffix: true` on upload + response-sanitisation, this
// closes the persistence window for member PII outside the tenant DB.
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwner();
  const { id } = await params;

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { id, tenantId } }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.status === "running" || job.status === "complete") {
    return NextResponse.json({ error: `Job already ${job.status}` }, { status: 409 });
  }

  await withTenantContext(tenantId, (tx) =>
    tx.importJob.update({
      where: { id: job.id },
      data: { status: "running", startedAt: new Date(), processedRows: 0, importedRows: 0, skippedRows: 0 },
    }),
  );

  try {
    const res = await fetch(job.fileBlobUrl);
    if (!res.ok) throw new Error(`Failed to fetch file (${res.status})`);
    const text = await res.text();

    const { drafts, errors } = parseImport(job.source as ImportSource, text);

    let imported = 0;
    let skippedExisting = 0;
    const commitErrors: { row: number; email?: string; error: string }[] = [];

    // Batch in groups of 25 to keep transactions short.
    // Audit iter-1-operator-admin A6I1-P-1: collapse per-row N+1.
    // Was: one `withTenantContext` transaction PER row × 1000 rows = 1000
    // round-trips per CSV. Now: per 25-row slice, one duplicate-check
    // `findMany` + one bulk `createMany({ skipDuplicates: true })`. A
    // 1000-row import drops from 1000 transactions to ~40 (one per slice).
    const BATCH = 25;
    for (let i = 0; i < drafts.length; i += BATCH) {
      const slice = drafts.slice(i, i + BATCH);
      // Pre-check duplicates by email in one query so we count "skipped"
      // accurately. createMany({ skipDuplicates: true }) handles the race
      // case but doesn't tell us how many were skipped.
      const sliceEmails = slice.map((d) => d.email).filter(Boolean);
      try {
        const inserted = await withTenantContext(tenantId, async (tx) => {
          const existing = sliceEmails.length
            ? await tx.member.findMany({
                where: { tenantId, email: { in: sliceEmails } },
                select: { email: true },
              })
            : [];
          const existingEmails = new Set(existing.map((m) => m.email));
          const fresh = slice.filter((d) => !existingEmails.has(d.email));
          if (fresh.length === 0) return 0;
          const result = await tx.member.createMany({
            data: fresh.map((d) => ({
              tenantId,
              name: d.name,
              email: d.email,
              phone: d.phone ?? null,
              dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth) : null,
              membershipType: d.membershipType ?? null,
              status: d.status ?? "active",
              accountType: d.accountType ?? "adult",
              notes: d.notes ?? null,
              ...(d.joinedAt ? { joinedAt: new Date(d.joinedAt) } : {}),
            })),
            skipDuplicates: true,
          });
          return result.count;
        });
        imported += inserted;
        skippedExisting += slice.length - inserted;
      } catch (e: unknown) {
        // Bulk failure — fall back to per-row error reporting so the
        // operator can see which rows broke. We don't retry; this branch
        // is a defensive fallback for unexpected DB errors (e.g. a
        // misconfigured column type) rather than the happy path.
        const msg = e instanceof Error ? e.message : "Unknown error";
        for (const [idx, d] of slice.entries()) {
          commitErrors.push({ row: i + idx, email: d.email, error: msg });
        }
      }

      // Audit iter-1-operator-admin L-A6I1-5: progress writes can stay
      // per-slice — 40 PK-indexed UPDATEs across a 1000-row import is
      // fast enough and the UI poller benefits from the granularity.
      await withTenantContext(tenantId, (tx) =>
        tx.importJob.update({
          where: { id: job.id },
          data: {
            processedRows: Math.min(i + slice.length, drafts.length),
          },
        }),
      );
    }

    const allErrors = [...errors, ...commitErrors];
    const totalRows = drafts.length + errors.length;
    await withTenantContext(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: {
          status: "complete",
          completedAt: new Date(),
          totalRows,
          processedRows: drafts.length,
          importedRows: imported,
          skippedRows: skippedExisting,
          errorRows: allErrors.length,
          errorLog: allErrors.length > 0 ? (allErrors as unknown as Prisma.InputJsonValue) : undefined,
        },
      }),
    );

    await logAudit({
      tenantId, userId,
      action: "import.commit",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { source: job.source, imported, skipped: skippedExisting + errors.length, errors: allErrors.length },
      req,
    });

    // Audit iter-1-operator-admin A6I1-S-1: best-effort delete the publicly-
    // readable CSV from blob storage. Defence-in-depth: we've already
    // sanitised the URL out of API responses (see upload + job-detail
    // routes) and the path carries 128 bits of random-suffix entropy, but
    // shrinking the persistence window further means the URL can't leak
    // months later via DB dump or operator screenshot. Errors are swallowed
    // — the import already succeeded, blob cleanup must not roll back.
    if (job.fileBlobUrl) {
      try { await del(job.fileBlobUrl); }
      catch (e) { console.warn("[import-commit] blob del failed", e); }
    }

    // Best-effort completion email to the owner
    const owner = await withTenantContext(tenantId, (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, tenant: { select: { name: true } } },
      }),
    );
    if (owner?.email) {
      const result = await sendEmail({
        tenantId,
        templateId: "import_complete",
        to: owner.email,
        vars: {
          ownerName: owner.name,
          gymName: owner.tenant.name,
          importedCount: String(imported),
          skippedCount: String(skippedExisting + errors.length),
        },
      });
      if (!result.ok) {
        console.error("[import-commit] notification email failed", result);
        // Don't fail the whole import; just log.
      }
    }

    return NextResponse.json({ ok: true, imported, skipped: skippedExisting + errors.length, errors: allErrors.length });
  } catch (e) {
    // WP-J: keep the detailed error in our own DB row + server logs but
    // return a generic message to the client (could leak Prisma constraint
    // names, table names, or secret-bearing connection strings on rare
    // driver-level failures).
    const msg = e instanceof Error ? e.message : "Import failed";
    console.error(`[admin/import/${job.id}/commit] failed`, e);
    await withTenantContext(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: { status: "failed", completedAt: new Date(), errorLog: [{ row: 0, reason: msg }] as unknown as object },
      }),
    );
    return NextResponse.json({ error: "Import failed — see import history for details" }, { status: 500 });
  }
}
