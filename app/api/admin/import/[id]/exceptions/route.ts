// GET /api/admin/import/[id]/exceptions — the TeamUp import's exceptions as a
// CSV (teamup-2, 2 Oct 2026). Owner-only like every import route; tenant-
// scoped; read from what the preview or commit stored on the job, so it works
// after the source file has been deleted. The rows name the owner's own
// members (their data); every text cell carries the formula guard. Audited.
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { exceptionsCsv, type ExceptionRow } from "@/lib/importers/teamup-exceptions";

export const runtime = "nodejs";

function rowsFrom(v: unknown): ExceptionRow[] | null {
  const t2 = v && typeof v === "object" ? (v as { teamup2?: { exceptionRows?: unknown } }).teamup2 : undefined;
  return Array.isArray(t2?.exceptionRows) ? (t2!.exceptionRows as ExceptionRow[]) : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  const { job, club } = await withTenantContext(tenantId, async (tx) => ({
    job: await tx.importJob.findFirst({
      where: { id, tenantId },
      select: { id: true, source: true, fileName: true, sourceExportedAt: true, manifest: true, dryRunSummary: true },
    }),
    club: await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  }));
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.source !== "teamup") return NextResponse.json({ error: "Exceptions are listed for TeamUp imports only." }, { status: 400 });

  // The committed manifest wins over the preview: it is what was written.
  const rows = rowsFrom(job.manifest) ?? rowsFrom(job.dryRunSummary);
  if (!rows) return NextResponse.json({ error: "This import has no exceptions list yet — preview it first." }, { status: 409 });

  await logAudit({
    tenantId,
    userId,
    action: "import.exceptions.download",
    entityType: "ImportJob",
    entityId: job.id,
    metadata: { rows: rows.length },
    req,
  });

  const asOf = job.sourceExportedAt ? job.sourceExportedAt.toISOString().slice(0, 10) : null;
  const body = exceptionsCsv(rows, { club: club?.name ?? "", file: job.fileName, asOf });
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="teamup-import-exceptions-${job.id}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
