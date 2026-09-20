import { NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { parseImport, type ImportSource } from "@/lib/importers";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

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

  try {
    // Private-blob-safe read. `head().downloadUrl` carries NO credential —
    // @vercel/blob builds it as the plain blob URL with `?download=1` — so the
    // bare fetch that used to follow it 403'd against these `access: "private"`
    // CSVs and the preview always reported "Failed to fetch file (403)". Same
    // defect, same fix as app/api/blob-image/route.ts: `get()` sends the store
    // token server-side. It returns null for a blob that is not there and
    // throws for everything else, so absence gets its own message.
    const blob = await get(job.fileBlobUrl, { access: "private" });
    if (!blob) throw new Error("Import file is no longer in blob storage");
    if (blob.statusCode !== 200) throw new Error(`Failed to fetch file (${blob.statusCode})`);
    const text = await new Response(blob.stream).text();

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
