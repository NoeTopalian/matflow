import { NextResponse } from "next/server";
import { readImportFile } from "@/lib/import-storage";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { parseImport, unmatchedPlanLabels, withoutProvisionalStanding, type ImportSource, type MemberDraft } from "@/lib/importers";
import { classifyAdults, classifyChildren, needsParent } from "@/lib/importers/import-match";
import { normaliseEmail } from "@/lib/email-normalise";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import type { Prisma } from "@prisma/client";
import { parseTeamUp } from "@/lib/importers/teamup";
import { planRefresh, REFRESH_MEMBER_SELECT, tierMap } from "@/lib/importers/teamup-refresh";
import { asOfDate } from "@/lib/importers/as-of";
import { buildExceptionRows } from "@/lib/importers/teamup-exceptions";

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
    const text = await readImportFile(job.fileBlobUrl, tenantId);
    if (text === null) throw new Error("Import file is no longer in storage");

    if (job.mode === "refresh") {
      if (job.source !== "teamup") return NextResponse.json({ error: "A status refresh is only available for TeamUp exports." }, { status: 400 });
      const summary = await previewRefresh(tenantId, job, text);
      return NextResponse.json(summary);
    }

    const tz = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
    const asOf = asOfDate(job.sourceExportedAt, tz?.timezone);
    const { drafts, errors, summary: sourceSummary, rows: ledgerRows } = parseImport(job.source as ImportSource, text, { asOf });

    const summary = await withTenantContext(tenantId, async (tx) => {
      // The same classification the commit uses (lib/importers/import-match),
      // so these counts are the commit's outcomes for this file (25 Oct 2026).
      const tiers = await tx.membershipTier.findMany({ where: { tenantId }, select: { id: true, name: true } });
      const tierByName = tierMap(tiers);
      const tierNames = new Set(tierByName.keys());
      const planOf = (d: MemberDraft) => {
        const t = d.membershipType ? tierByName.get(d.membershipType.trim().toLowerCase()) : undefined;
        return { tierId: t?.id ?? null, label: t?.name ?? d.membershipType ?? null };
      };
      // Rows the commit refuses because a staff login holds the address (AH-01).
      const realEmails = [...new Set(drafts.filter((d) => !d.nonContactable).map((d) => normaliseEmail(d.email)))];
      const staffEmails = new Set(
        realEmails.length ? (await tx.user.findMany({ where: { tenantId, email: { in: realEmails } }, select: { email: true } })).map((u) => normaliseEmail(u.email)) : [],
      );
      const staffHeld = new Set(drafts.filter((d) => staffEmails.has(normaliseEmail(d.email))).map((d) => d.email));
      const adults = drafts.filter((d) => !needsParent(d));
      const children = drafts.filter(needsParent);
      const parentsInFile = new Set(adults.flatMap((d) => [d.email, d.unverifiedEmail].filter((e): e is string => !!e)));
      const adultOutcomes = await classifyAdults(tx, tenantId, adults, { jobId: job.id, planOf, skipEmails: staffHeld });
      const childOutcomes = await classifyChildren(tx, tenantId, children, { jobId: job.id, planOf, skipEmails: staffHeld, parentsInFile });
      const kinds = [...adultOutcomes.values(), ...[...childOutcomes.values()].flatMap((o) => (o.classification ? [o.classification] : []))].map((c) => c.kind);
      const count = (k: string) => kinds.filter((x) => x === k).length;
      const childrenWithoutParent = [...childOutcomes.values()].filter((o) => !o.classification).length;
      const totalRows = drafts.length + errors.length;
      // Plan labels a live membership carries with no tier: shown BEFORE commit.
      const unmatched = unmatchedPlanLabels(drafts, tierNames);
      const willImport = count("new");
      const sameAsMatFlow = count("duplicate") + count("own");
      const toReviewDiffers = count("conflict");
      const toReviewUncertain = count("ambiguous");
      const s = {
        totalRows,
        validRows: drafts.length,
        errorRows: errors.length,
        // Everyone already in the club, whatever happens to them (kept for older clients).
        existingMatches: sameAsMatFlow + toReviewDiffers + toReviewUncertain,
        willImport,
        sameAsMatFlow,
        toReviewDiffers,
        toReviewUncertain,
        staffLoginRefused: staffHeld.size,
        childrenWithoutParent,
        willSkip: sameAsMatFlow + toReviewDiffers + toReviewUncertain + staffHeld.size + childrenWithoutParent + errors.length,
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
        // teamup-2: what the owner must decide or confirm, before anything is written.
        ...(ledgerRows
          ? {
              teamup2: {
                asOf,
                // Provisional when no export time was given (the as-of date is
                // the upload date) OR the owner marked the time as an estimate.
                asOfIsProvisional: !job.sourceExportedAt || job.sourceExportedAtProvenance === "provisional",
                asOfProvenance: job.sourceExportedAt ? (job.sourceExportedAtProvenance ?? "owner_stated") : null,
                ledger: {
                  rows: ledgerRows.length,
                  byDisposition: ledgerRows.reduce<Record<string, number>>((m, r) => ((m[r.disposition.split(":")[0]] = (m[r.disposition.split(":")[0]] ?? 0) + 1), m), {}),
                },
                decisions: drafts.filter((d) => d.decision).map((d) => ({ name: d.name, options: d.decision!.options, rows: d.decision!.rows })),
                scheduled: drafts.filter((d) => d.scheduled).map((d) => ({ name: d.name, ...d.scheduled! })),
                guardians: {
                  suggestedFromSharedEmail: drafts.filter((d) => d.guardianSuggestedBy === "shared_email").length,
                  draftsFromEmergencyContact: drafts.filter((d) => d.unverified && d.accountType === "parent").length,
                },
                exceptions: {
                  missingEmailActive: drafts.filter((d) => d.nonContactable && !d.unverifiedEmail && !["kids", "junior", "parent"].includes(d.accountType ?? "") && d.status === "active").length,
                  sharedEmailAdults: drafts.filter((d) => d.unverifiedEmail && !d.unverified).length,
                  cancelledWithoutDate: drafts.filter((d) => d.status === "cancelled" && !d.cancelledAt).length,
                  // Live (current / scheduled / held) labels with no tier — the owner
                  // should create these first; history-only labels need no tier.
                  unmatchedPlanLabels: unmatched.live,
                  unmatchedHistoryPlanLabels: unmatched.historyOnly,
                  refusedRows: errors.length,
                },
                // One row per thing to decide/confirm; the download reads this.
                exceptionRows: buildExceptionRows(drafts, errors, tierNames),
              },
            }
          : {}),
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

/**
 * Refresh mode (TeamUp only): match each person to a member by the key the
 * first import stored, and list what would change — before and after — and
 * every exception. Writes nothing to any member; only the job's preview record.
 */
async function previewRefresh(
  tenantId: string,
  job: { id: string; sourceExportedAt: Date | null; sourceExportedAtProvenance?: string | null },
  text: string,
) {
  const tzRow = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
  const { drafts, errors, summary: sourceSummary } = parseTeamUp(text, { asOf: asOfDate(job.sourceExportedAt, tzRow?.timezone) });
  const keys = drafts.map((d) => d.sourceKey).filter((k): k is string => !!k);
  return withTenantContext(tenantId, async (tx) => {
    const [members, tiers] = await Promise.all([
      tx.member.findMany({
        where: { tenantId, OR: [{ billedBy: "teamup" }, ...(keys.length ? [{ externalRef: { in: keys } }] : [])] },
        select: REFRESH_MEMBER_SELECT,
      }),
      tx.membershipTier.findMany({ where: { tenantId }, select: { id: true, name: true, billingCycle: true } }),
    ]);
    const plan = planRefresh({ drafts, errors, members: await withoutProvisionalStanding(tx, tenantId, members), tiers, job });
    const totalRows = drafts.length + errors.length;
    const ex = plan.exceptions;
    const s = {
      mode: "refresh" as const,
      sourceExportedAtProvenance: job.sourceExportedAtProvenance ?? null,
      totalRows,
      validRows: drafts.length,
      errorRows: errors.length,
      matched: plan.matched.length,
      willChange: plan.changed,
      unchanged: plan.unchanged,
      payerRecords: plan.payerRecords,
      reconciles: plan.reconciles,
      // teamup-2: an export older than the recorded standing is shown here and
      // refused at commit — nothing moves backwards in time.
      ...(plan.olderThanRecorded ? { olderThanRecorded: plan.olderThanRecorded } : {}),
      changes: plan.matched
        .filter((c) => c.fields.length > 0)
        .map((c) => ({
          memberId: c.memberId,
          name: c.name,
          fields: c.fields.map((f) => ({ field: f, before: c.before[f], after: c.after[f] })),
        })),
      exceptions: {
        notInMatFlow: ex.notInMatFlow.map((e) => ({ name: e.name, email: e.email, rows: e.rows })),
        notInFile: ex.notInFile,
        billedByMatFlow: ex.billedByMatFlow,
        refused: ex.refused,
        // Holds the refresh will keep, listed BEFORE commit (functional review
        // F9, 30 Sep 2026: they only appeared after it).
        holdKept: ex.holdKept ?? [],
        decisions: ex.decisions ?? [],
      },
      ...(sourceSummary ? { source: sourceSummary as unknown as Prisma.InputJsonObject } : {}),
    };
    await tx.importJob.update({
      where: { id: job.id },
      data: {
        status: "preview",
        totalRows,
        skippedRows: 0,
        errorRows: errors.length,
        dryRunSummary: s as unknown as Prisma.InputJsonObject,
        errorLog: errors.length > 0 ? (errors as unknown as object) : undefined,
      },
    });
    return s;
  });
}
