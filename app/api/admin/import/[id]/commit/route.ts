import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requireOwner } from "@/lib/authz";
import { parseImport, type ImportSource } from "@/lib/importers";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwner();
  const { id } = await params;

  const job = await prisma.importJob.findFirst({ where: { id, tenantId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.status === "running" || job.status === "complete") {
    return NextResponse.json({ error: `Job already ${job.status}` }, { status: 409 });
  }

  await prisma.importJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date(), processedRows: 0, importedRows: 0, skippedRows: 0 },
  });

  try {
    const res = await fetch(job.fileBlobUrl);
    if (!res.ok) throw new Error(`Failed to fetch file (${res.status})`);
    const text = await res.text();

    const { drafts, errors } = parseImport(job.source as ImportSource, text);

    let imported = 0;
    let skippedExisting = 0;
    const commitErrors: { row: number; email?: string; error: string }[] = [];

    // Batch in groups of 25 to keep transactions short
    const BATCH = 25;
    for (let i = 0; i < drafts.length; i += BATCH) {
      const slice = drafts.slice(i, i + BATCH);
      for (const [idx, d] of slice.entries()) {
        try {
          const existing = await prisma.member.findFirst({
            where: { tenantId, email: d.email },
            select: { id: true },
          });
          if (existing) {
            skippedExisting += 1;
            continue;
          }
          await prisma.member.create({
            data: {
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
            },
          });
          imported += 1;
        } catch (e: unknown) {
          const code = (e as { code?: string }).code;
          if (code === "P2002") {
            // Unique-constraint hit — already exists, skip silently.
            skippedExisting += 1;
            continue;
          }
          commitErrors.push({
            row: i + idx,
            email: d.email,
            error: e instanceof Error ? e.message : "Unknown error",
          });
        }
      }
      await prisma.importJob.update({
        where: { id: job.id },
        data: {
          processedRows: Math.min(i + slice.length, drafts.length),
        },
      });
    }

    const allErrors = [...errors, ...commitErrors];
    const totalRows = drafts.length + errors.length;
    await prisma.importJob.update({
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
    });

    await logAudit({
      tenantId, userId,
      action: "import.commit",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { source: job.source, imported, skipped: skippedExisting + errors.length, errors: allErrors.length },
      req,
    });

    // Best-effort completion email to the owner
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, tenant: { select: { name: true } } },
    });
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
    const msg = e instanceof Error ? e.message : "Import failed";
    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: "failed", completedAt: new Date(), errorLog: [{ row: 0, reason: msg }] as unknown as object },
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
