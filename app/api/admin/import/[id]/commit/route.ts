import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import type { Prisma } from "@prisma/client";
import { requireApiOwner } from "@/lib/api-authz";
import { parseImport, type ImportSource } from "@/lib/importers";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { membershipTierWrite, type ResolvedMembershipTier } from "@/lib/membership-tier";
import { recordStatusEventsBulk } from "@/lib/member-status";
// Audit iter-1-operator-admin A6I1-S-1: del() removes the publicly-readable
// CSV from Vercel Blob storage after we've finished importing it. Combined
// with `addRandomSuffix: true` on upload + response-sanitisation, this
// closes the persistence window for member PII outside the tenant DB.
import { del, get } from "@vercel/blob";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. Commits a whole membership import. The sibling upload route
  // guards; these two did not.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
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
    // Import blobs are written `access: "private"` (app/api/admin/import/upload,
    // line 84), and a private blob cannot be fetched without the store token.
    // This used to resolve `head().downloadUrl` first and fetch THAT, which
    // does not work: @vercel/blob builds `downloadUrl` as the plain blob URL
    // with `?download=1` appended and attaches no credential, so the fetch
    // 403'd and every commit failed with "Failed to fetch file (403)". `get()`
    // is the credentialled reader (the same fix as app/api/blob-image) — it
    // sends `authorization: Bearer <BLOB_READ_WRITE_TOKEN>` server-side,
    // returns null when the blob is genuinely absent and throws otherwise.
    const blob = await get(job.fileBlobUrl, { access: "private" });
    if (!blob) throw new Error("Import file is no longer in blob storage");
    if (blob.statusCode !== 200) throw new Error(`Failed to fetch file (${blob.statusCode})`);
    const text = await new Response(blob.stream).text();

    const { drafts, errors } = parseImport(job.source as ImportSource, text);

    // Track F — membershipType→tier resolution. Fetched once, not per-row:
    // a 1000-row import matching against the same handful of tenant tiers
    // should not cost 1000 lookups. Matched case-insensitively on name
    // because vendor CSVs are free-text ("BJJ Unlimited" vs "bjj unlimited")
    // and the owner's tier name is the only thing we can compare against —
    // no vendor ships our internal tier ids.
    const tiers = await withTenantContext(tenantId, (tx) =>
      tx.membershipTier.findMany({
        where: { tenantId },
        select: { id: true, name: true, billingCycle: true },
      }),
    );
    const tierByName = new Map<string, ResolvedMembershipTier>(
      tiers.map((t) => [t.name.trim().toLowerCase(), t]),
    );

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
            data: fresh.map((d) => {
              // membershipType→tier: reuse the same "columns to write" helper
              // the manual tier-picker uses (lib/membership-tier.ts), so a row
              // that matches a tier gets both the id AND the tier's own name
              // as the legacy label — never the CSV's own free-text spelling,
              // which would drift from the tier the moment it's renamed. A row
              // with no match, or no membershipType at all, keeps the CSV's
              // free-text label only (membershipTierId stays null).
              const matchedTier = d.membershipType
                ? tierByName.get(d.membershipType.trim().toLowerCase())
                : undefined;
              const tierCols = membershipTierWrite(matchedTier ?? null, {
                // Only seed nextDueAt from the tier's billing cycle when the
                // CSV didn't already carry an explicit due date — an
                // imported row's own billing data always wins over an
                // inferred one.
                currentNextDueAt: d.nextDueAt ? new Date(d.nextDueAt) : null,
              });
              return {
                tenantId,
                name: d.name,
                email: d.email,
                phone: d.phone ?? null,
                dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth) : null,
                membershipType: tierCols.membershipType ?? d.membershipType ?? null,
                membershipTierId: tierCols.membershipTierId ?? null,
                status: d.status ?? "active",
                accountType: d.accountType ?? "adult",
                notes: d.notes ?? null,
                paymentStatus: d.paymentStatus ?? "paid",
                ...(tierCols.nextDueAt
                  ? { nextDueAt: tierCols.nextDueAt }
                  : d.nextDueAt
                    ? { nextDueAt: new Date(d.nextDueAt) }
                    : {}),
                ...(d.joinedAt ? { joinedAt: new Date(d.joinedAt) } : {}),
              };
            }),
            skipDuplicates: true,
          });

          // Funnel (M1): route import writes through the single MemberStatusEvent
          // writer, reason "import" — recorded but excluded from conversion math
          // (lib/attribution.ts). createMany doesn't return the created rows, so
          // the freshly-inserted members are re-read by email inside this same
          // transaction to get their ids; this mirrors the duplicate pre-check
          // above rather than adding a second round-trip pattern to the file.
          if (result.count > 0) {
            const createdRows = await tx.member.findMany({
              where: { tenantId, email: { in: fresh.map((d) => d.email) } },
              select: { id: true, status: true },
            });
            await recordStatusEventsBulk(
              tx,
              createdRows.map((m) => ({
                tenantId,
                memberId: m.id,
                fromStatus: null,
                toStatus: m.status,
                reason: "import" as const,
                changedById: null,
              })),
            );
          }

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
