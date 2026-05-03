import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { parseImport, type ImportSource } from "@/lib/importers";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId } = await requireOwner();
  const { id } = await params;

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { id, tenantId } }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const res = await fetch(job.fileBlobUrl);
    if (!res.ok) throw new Error(`Failed to fetch file (${res.status})`);
    const text = await res.text();

    const { drafts, errors } = parseImport(job.source as ImportSource, text);

    const summary = await withTenantContext(tenantId, async (tx) => {
      const emails = drafts.map((d) => d.email);
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
        sampleDrafts: drafts.slice(0, 5),
        sampleErrors: errors.slice(0, 10),
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
