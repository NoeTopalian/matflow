import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import type { Prisma } from "@prisma/client";
import { requireApiOwner } from "@/lib/api-authz";
import { parseImport, unmatchedPlanLabels, withoutProvisionalStanding, type ImportSource, type MemberDraft, type RowDisposition } from "@/lib/importers";
import { asOfDate } from "@/lib/importers/as-of";
import { buildExceptionRows } from "@/lib/importers/teamup-exceptions";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { membershipTierWrite, type ResolvedMembershipTier } from "@/lib/membership-tier";
import { recordStatusEventsBulk } from "@/lib/member-status";
// Audit iter-1-operator-admin A6I1-S-1: del() removes the publicly-readable
// CSV from Vercel Blob storage after we've finished importing it. Combined
// with `addRandomSuffix: true` on upload + response-sanitisation, this
// closes the persistence window for member PII outside the tenant DB.
import { deleteImportFile, readImportFile } from "@/lib/import-storage";
import { assertSameOrigin } from "@/lib/csrf";
import { parseTeamUp } from "@/lib/importers/teamup";
import {
  changedFields,
  planRefresh,
  refreshWrite,
  REFRESH_MEMBER_SELECT,
  standingOf,
  type RefreshChange,
} from "@/lib/importers/teamup-refresh";

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
  if (job.status === "complete") {
    return NextResponse.json({ error: "Job already complete" }, { status: 409 });
  }
  // A run that died part-way (function timeout, deploy, crash) stays "running"
  // for ever. Once it is older than the longest a commit can run, it may be
  // re-run: every row it created carries this job's id and is found again by
  // the duplicate checks, so nothing is created twice.
  const STALE_RUN_MS = (maxDuration + 60) * 1000;
  if (job.status === "running" && job.startedAt && Date.now() - job.startedAt.getTime() < STALE_RUN_MS) {
    return NextResponse.json({ error: "Job already running" }, { status: 409 });
  }
  // Two uploads of one file (two tabs) both reach "preview"; only the first to
  // commit may import it (verifier lane 5, 30 Sep 2026).
  if (job.fileHash) {
    const prior = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({
        // Complete, or still running and not yet stale (connection register
        // gap 14, 30 Sep 2026: an in-progress run was ignored, so a second tab
        // could start the same file alongside it).
        where: {
          tenantId, fileHash: job.fileHash, mode: job.mode, rolledBackAt: null, id: { not: job.id },
          OR: [{ status: "complete" }, { status: "running", startedAt: { gte: new Date(Date.now() - STALE_RUN_MS) } }],
        },
        select: { id: true },
      }),
    );
    if (prior) {
      return NextResponse.json({ error: "This exact file was already imported by another run. Roll that import back first.", priorJobId: prior.id }, { status: 409 });
    }
  }
  const resumed = job.status === "running";
  const jobId = job.id;
  const jobSource = job.source;
  const jobExportedAt = job.sourceExportedAt ?? null;

  // What the job looked like before this run claimed it, for giving the claim back.
  const statusBeforeClaim = job.status;
  const startedAtBeforeClaim = job.startedAt;
  // Claim the run in one conditional write (connection register gap 13, 30 Sep
  // 2026): the status check above and a plain update were two statements, so
  // two commits of one job could both start. Only a job that is not complete
  // and not running (or running but stale) can be claimed.
  const claimed = await withTenantContext(tenantId, (tx) =>
    tx.importJob.updateMany({
      where: {
        id: job.id, tenantId,
        OR: [
          { status: { notIn: ["running", "complete"] } },
          { status: "running", OR: [{ startedAt: null }, { startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }] },
        ],
      },
      data: { status: "running", startedAt: new Date(), processedRows: 0, importedRows: 0, skippedRows: 0 },
    }),
  );
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "Job already running" }, { status: 409 });
  }
  // Two uploads of one file committed in the same instant both passed the
  // "already imported" check above, which ran before either claimed (functional
  // review F6, 30 Sep 2026). Now that this run holds its claim, look again: if
  // a rival run of the same file is complete, or running and older (by id, so
  // both sides agree), this one gives its claim back.
  if (job.fileHash) {
    const rival = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findFirst({
        where: {
          tenantId, fileHash: job.fileHash, mode: job.mode, rolledBackAt: null, id: { not: job.id },
          OR: [{ status: "complete" }, { status: "running", startedAt: { gte: new Date(Date.now() - STALE_RUN_MS) } }],
        },
        select: { id: true, status: true },
      }),
    );
    if (rival && (rival.status === "complete" || rival.id < job.id)) {
      await withTenantContext(tenantId, (tx) =>
        tx.importJob.update({ where: { id: job.id }, data: { status: statusBeforeClaim, startedAt: startedAtBeforeClaim } }),
      );
      return NextResponse.json({ error: "This exact file is already being imported by another run.", priorJobId: rival.id }, { status: 409 });
    }
  }
  // A resumed run finds the people it created before it stopped; those are its
  // own work, not "already in the club" (functional review F2, 30 Sep 2026).
  const ownRowsBeforeRun = statusBeforeClaim === "running"
    ? await withTenantContext(tenantId, (tx) => tx.member.count({ where: { tenantId, importJobId: job.id } }))
    : 0;

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
    const text = await readImportFile(job.fileBlobUrl);
    if (text === null) throw new Error("Import file is no longer in storage");

    if (job.mode === "refresh") {
      if (job.source !== "teamup") throw new Error("A status refresh is only available for TeamUp exports");
      const out = await commitRefresh({ tenantId, job, text, resumed });
      if ("refused" in out) {
        // Recorded as failed so the owner sees why in the history; nothing was written.
        await withTenantContext(tenantId, (tx) =>
          tx.importJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date(), errorLog: [{ row: 0, reason: out.refused }] as unknown as Prisma.InputJsonValue } }),
        );
        return NextResponse.json({ ok: false, error: out.refused, olderThanRecorded: out.olderThanRecorded }, { status: 409 });
      }
      await logAudit({
        tenantId, userId,
        action: "import.refresh",
        entityType: "ImportJob",
        entityId: job.id,
        metadata: { source: job.source, fileName: job.fileName, mappingVersion: job.mappingVersion ?? null, sourceExportedAt: job.sourceExportedAt ? job.sourceExportedAt.toISOString() : null, sourceExportedAtProvenance: job.sourceExportedAtProvenance ?? null, changed: out.changed, unchanged: out.unchanged, exceptions: out.exceptionCount, reconciles: out.manifest.reconciles, resumed },
        req,
      });
      if (job.fileBlobUrl) {
        try { await deleteImportFile(job.fileBlobUrl); }
        catch (e) { console.warn("[import-commit] blob del failed", e); }
      }
      // No completion email, no invitations, no Stripe: a refresh only moves standing.
      return NextResponse.json({ ok: true, mode: "refresh", changed: out.changed, unchanged: out.unchanged, exceptions: out.exceptionCount, manifest: out.manifest });
    }

    // TeamUp entitlement is read at the export snapshot date in the club zone
    // (teamup-2). Other sources ignore the option.
    const tz = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
    const asOf = asOfDate(job.sourceExportedAt, tz?.timezone);
    const { drafts, errors, summary: sourceSummary, rows: ledgerRows } = parseImport(job.source as ImportSource, text, { asOf });

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
    // Rows lost to a system error (a whole slice's write failed), as opposed to
    // rows refused for a reason. Any of these and the run did not finish.
    let systemFailedRows = 0;

    /** The Member columns one draft writes. Shared by both passes below. */
    function columnsFor(d: MemberDraft, parentMemberId: string | null) {
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
      // Only seed nextDueAt from the tier's billing cycle when the CSV
      // didn't already carry an explicit due date — an imported row's own
      // billing data always wins over an inferred one. NEVER for a TeamUp
      // import (real-data rehearsal F-R5-1, 2 Oct 2026): TeamUp owns that
      // schedule, the export has no such date, and a seeded one would be an
      // executable billing date invented from a tier cycle.
      const tierCols = membershipTierWrite(
        matchedTier ?? null,
        jobSource === "teamup" ? undefined : { currentNextDueAt: d.nextDueAt ? new Date(d.nextDueAt) : null },
      );
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
        ...(d.cancelledAt ? { cancelledAt: new Date(d.cancelledAt) } : {}),
        emergencyContactName: d.emergencyContactName ?? null,
        emergencyContactPhone: d.emergencyContactPhone ?? null,
        emergencyContactRelation: d.emergencyContactRelation ?? null,
        // A parent link from an import is SUGGESTED, never granted:
        // guardianConfirmedAt stays NULL until the owner confirms it, and the
        // parent portal acts for a child only once it is set.
        ...(parentMemberId ? { parentMemberId, guardianConfirmedAt: null, guardianSuggestedBy: d.guardianSuggestedBy ?? "shared_email" } : {}),
        ...(d.unverifiedEmail ? { unverifiedEmail: d.unverifiedEmail } : {}),
        // Provenance: rollback-by-job only ever touches rows carrying this.
        importJobId: jobId,
        ...(d.sourceKey ? { externalRef: d.sourceKey } : {}),
        // TeamUp bridge (readiness spec v3 §7): TeamUp keeps collecting for
        // everyone it exported, and the standing is as true as the export.
        ...(jobSource === "teamup"
          ? { billedBy: "teamup", billingStatusAsOf: jobExportedAt, billingStatusSource: jobId }
          : {}),
      };
    }

    // Two passes. Kids carry `parentEmail` and a database CHECK refuses a
    // kid with no parent, so every adult/parent lands first and each kid then
    // resolves its parent (freshly created or pre-existing) by that email.
    // Kids and no-email adults carry synthesised addresses that can never
    // collide with an existing row, so their duplicate check is by
    // (parent, name, date of birth) instead of by email.
    // Ten-club audit 2026-09-25 (F-TC-6): this used to split on accountType ===
    // "kids" alone, so a 13–17 junior whose file named a parent went through the
    // adult pass and landed with no parentMemberId — the guardian link, the
    // parent-pays path and the parent-signed waiver all lost for a third of a
    // club's under-18s. A junior may stand alone (no CHECK forces a parent), but
    // one that carries a parentEmail is linked exactly like a kid.
    const needsParent = (d: MemberDraft) => d.accountType === "kids" || (d.accountType === "junior" && !!d.parentEmail);
    const firstPass = drafts.filter((d) => !needsParent(d));
    const kidPass = drafts.filter(needsParent);

    // Batch in groups of 25 to keep transactions short.
    // Audit iter-1-operator-admin A6I1-P-1: collapse per-row N+1.
    // Was: one `withTenantContext` transaction PER row × 1000 rows = 1000
    // round-trips per CSV. Now: per 25-row slice, one duplicate-check
    // `findMany` + one bulk `createMany({ skipDuplicates: true })`. A
    // 1000-row import drops from 1000 transactions to ~40 (one per slice).
    const BATCH = 25;
    let processed = 0;
    for (let i = 0; i < firstPass.length; i += BATCH) {
      const slice = firstPass.slice(i, i + BATCH);
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
          // A no-email adult has a fresh synthesised address every run; dedupe
          // them by name + date of birth among the tenant's other
          // non-contactable adults so a re-import cannot double them.
          // Guardian drafts are excluded here: they carry no date of birth and a
          // bare first name is not identity (real-data rehearsal F-R5-2, 2 Oct
          // 2026 — two emergency contacts with the same first name collapsed
          // into one and the second child was never imported). They are
          // identified by unverifiedEmail below.
          const nonContactable = slice.filter((d) => d.nonContactable && !d.unverified && !existingEmails.has(d.email));
          const existingByNameDob = new Set<string>();
          if (nonContactable.length > 0) {
            const rows = await tx.member.findMany({
              where: { tenantId, email: { endsWith: "@no-login.matflow.local" }, name: { in: nonContactable.map((d) => d.name), mode: "insensitive" }, parentMemberId: null },
              select: { name: true, dateOfBirth: true },
            });
            for (const r of rows) existingByNameDob.add(`${r.name.toLowerCase()}|${r.dateOfBirth?.toISOString().slice(0, 10) ?? ""}`);
          }
          // A guardian draft is identified by the payer address it keeps as
          // unverifiedEmail; a re-run must not make a second one.
          const unverified = slice.map((d) => d.unverifiedEmail).filter((e): e is string => !!e);
          const existingUnverified = new Set(
            unverified.length
              ? (await tx.member.findMany({ where: { tenantId, unverifiedEmail: { in: unverified } }, select: { unverifiedEmail: true } })).map((m) => m.unverifiedEmail)
              : [],
          );
          const fresh = slice.filter(
            (d) =>
              !existingEmails.has(d.email) &&
              !(d.nonContactable && !d.unverified && existingByNameDob.has(`${d.name.toLowerCase()}|${d.dateOfBirth ?? ""}`)) &&
              !(d.unverified && d.unverifiedEmail && existingUnverified.has(d.unverifiedEmail)),
          );
          if (fresh.length === 0) return 0;
          const result = await tx.member.createMany({
            data: fresh.map((d) => columnsFor(d, null)),
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
        console.error("[import-commit] slice failed", e);
        systemFailedRows += slice.length;
        for (const [idx, d] of slice.entries()) {
          commitErrors.push({ row: i + idx, email: d.email, error: msg });
        }
      }

      // Audit iter-1-operator-admin L-A6I1-5: progress writes can stay
      // per-slice — 40 PK-indexed UPDATEs across a 1000-row import is
      // fast enough and the UI poller benefits from the granularity.
      processed = Math.min(i + slice.length, firstPass.length);
      await withTenantContext(tenantId, (tx) =>
        tx.importJob.update({ where: { id: job.id }, data: { processedRows: processed } }),
      );
    }

    for (let i = 0; i < kidPass.length; i += BATCH) {
      const slice = kidPass.slice(i, i + BATCH);
      try {
        const inserted = await withTenantContext(tenantId, async (tx) => {
          const parentEmails = [...new Set(slice.map((d) => d.parentEmail).filter((e): e is string => !!e))];
          const parents = parentEmails.length
            ? await tx.member.findMany({
                // An adult member by their login address, or a guardian draft by
                // the payer address it keeps as unverifiedEmail (its login is
                // synthesised and never matches a source email).
                where: { tenantId, OR: [{ email: { in: parentEmails } }, { unverifiedEmail: { in: parentEmails } }] },
                select: { id: true, email: true, unverifiedEmail: true, children: { select: { name: true, dateOfBirth: true } } },
              })
            : [];
          const parentByEmail = new Map<string, (typeof parents)[number]>();
          for (const p of parents) {
            if (p.unverifiedEmail && !parentByEmail.has(p.unverifiedEmail)) parentByEmail.set(p.unverifiedEmail, p);
          }
          // A real adult on the address wins over a draft (the parser only makes a
          // draft when no adult row shares the address, but a later import may add one).
          for (const p of parents) parentByEmail.set(p.email, p);
          const fresh: Array<{ d: MemberDraft; parentId: string }> = [];
          for (const [idx, d] of slice.entries()) {
            const parent = d.parentEmail ? parentByEmail.get(d.parentEmail) : undefined;
            if (!parent) {
              commitErrors.push({ row: i + idx, email: d.parentEmail, error: `${d.name}: parent ${d.parentEmail ?? "(none)"} was not imported, so this child was not either.` });
              continue;
            }
            const dup = parent.children.some(
              (c) => c.name.toLowerCase() === d.name.toLowerCase() && (c.dateOfBirth?.toISOString().slice(0, 10) ?? "") === (d.dateOfBirth ?? ""),
            );
            if (dup) { skippedExisting += 1; continue; }
            fresh.push({ d, parentId: parent.id });
          }
          if (fresh.length === 0) return 0;
          const result = await tx.member.createMany({
            data: fresh.map(({ d, parentId }) => columnsFor(d, parentId)),
            skipDuplicates: true,
          });
          if (result.count > 0) {
            const createdRows = await tx.member.findMany({
              where: { tenantId, email: { in: fresh.map(({ d }) => d.email) } },
              select: { id: true, status: true },
            });
            await recordStatusEventsBulk(
              tx,
              createdRows.map((m) => ({ tenantId, memberId: m.id, fromStatus: null, toStatus: m.status, reason: "import" as const, changedById: null })),
            );
          }
          return result.count;
        });
        imported += inserted;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        console.error("[import-commit] slice failed", e);
        systemFailedRows += slice.length;
        for (const [idx, d] of slice.entries()) {
          commitErrors.push({ row: i + idx, email: d.parentEmail, error: msg });
        }
      }
      processed = firstPass.length + Math.min(i + slice.length, kidPass.length);
      await withTenantContext(tenantId, (tx) =>
        tx.importJob.update({ where: { id: job.id }, data: { processedRows: processed } }),
      );
    }

    const allErrors = [...errors, ...commitErrors];
    const totalRows = drafts.length + errors.length;

    // The manifest is read back from the database, not from the counters
    // above: it states what this job's rows actually are.
    skippedExisting = Math.max(0, skippedExisting - ownRowsBeforeRun);
    // teamup-2: every CSV record becomes one ImportedMembership row — attached
    // to the member it belongs to (created now, created by a resumed run, or
    // already in the club) or to no member (duplicate, deleted customer,
    // quarantined, refused). The unique (importJobId, sourceRow) key makes a
    // resumed run idempotent here too.
    if (ledgerRows && ledgerRows.length > 0) {
      const keys = [...new Set(ledgerRows.map((r) => r.sourceKey).filter((k): k is string => !!k))];
      const byKey = new Map<string, string>();
      for (let i = 0; i < keys.length; i += 500) {
        const found = await withTenantContext(tenantId, (tx) =>
          tx.member.findMany({ where: { tenantId, externalRef: { in: keys.slice(i, i + 500) } }, select: { id: true, externalRef: true } }),
        );
        for (const m of found) if (m.externalRef) byKey.set(m.externalRef, m.id);
      }
      const asDate = (v?: string) => (v ? new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v) : null);
      const data = ledgerRows.map((r: RowDisposition) => ({
        tenantId,
        importJobId: job.id,
        memberId: r.sourceKey ? byKey.get(r.sourceKey) ?? null : null,
        sourceRow: r.sourceRow,
        sourceFingerprint: r.sourceFingerprint,
        planLabel: r.membership.planLabel,
        type: r.membership.type,
        status: r.membership.status,
        processor: r.membership.processor ?? null,
        purchaseDate: asDate(r.membership.purchaseDate),
        startDate: asDate(r.membership.startDate),
        expiryDate: asDate(r.membership.expiryDate),
        cancelledDate: asDate(r.membership.cancelledDate),
        completedAt: asDate(r.membership.completedAt),
        isFirst: r.membership.isFirst ?? null,
        otherActive: r.membership.otherActive ?? null,
        entitlement: r.membership.entitlement,
        disposition: r.disposition,
      }));
      for (let i = 0; i < data.length; i += 500) {
        await withTenantContext(tenantId, (tx) => tx.importedMembership.createMany({ data: data.slice(i, i + 500), skipDuplicates: true }));
      }
    }

    const manifest = await withTenantContext(tenantId, async (tx) => {
      const created = await tx.member.findMany({
        where: { tenantId, importJobId: job.id },
        select: { status: true, accountType: true, membershipType: true, paymentStatus: true, membershipTierId: true },
      });
      const ledgerCount = ledgerRows ? await tx.importedMembership.count({ where: { tenantId, importJobId: job.id } }) : null;
      const tally2 = (xs: string[]) => xs.reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
      // Same rule as the preview: live labels with no tier, history-only apart.
      const unmatched = unmatchedPlanLabels(drafts, new Set(tierByName.keys()));
      const teamup2 = ledgerRows
        ? {
            asOf,
            // The as-of date is only as good as the export time it came from.
            asOfIsProvisional: !job.sourceExportedAt || job.sourceExportedAtProvenance === "provisional",
            asOfProvenance: job.sourceExportedAt ? (job.sourceExportedAtProvenance ?? "owner_stated") : null,
            ledger: {
              rows: ledgerRows.length,
              persisted: ledgerCount,
              byDisposition: tally2(ledgerRows.map((r) => r.disposition.split(":")[0])),
              byEntitlement: tally2(ledgerRows.map((r) => r.membership.entitlement)),
            },
            decisions: drafts.filter((x) => x.decision).map((x) => ({ name: x.name, sourceKey: x.sourceKey, kind: x.decision!.kind, options: x.decision!.options, rows: x.decision!.rows })),
            scheduled: drafts.filter((x) => x.scheduled).map((x) => ({ name: x.name, sourceKey: x.sourceKey, ...x.scheduled! })),
            guardians: {
              suggestedFromSharedEmail: drafts.filter((x) => x.guardianSuggestedBy === "shared_email").length,
              draftsFromEmergencyContact: drafts.filter((x) => x.unverified && x.accountType === "parent").length,
              kidsOnDrafts: drafts.filter((x) => x.guardianSuggestedBy === "emergency_contact").length,
            },
            exceptions: {
              missingEmailActive: drafts.filter((x) => x.nonContactable && !x.unverifiedEmail && !["kids", "junior", "parent"].includes(x.accountType ?? "") && x.status === "active").length,
              sharedEmailAdults: drafts.filter((x) => x.unverifiedEmail && !x.unverified).length,
              cancelledWithoutDate: drafts.filter((x) => x.status === "cancelled" && !x.cancelledAt).length,
              unmatchedPlanLabels: unmatched.live,
              unmatchedHistoryPlanLabels: unmatched.historyOnly,
              refusedRows: errors.length,
            },
            exceptionRows: buildExceptionRows(drafts, errors, new Set(tierByName.keys())),
          }
        : null;
      const tally = (key: (m: (typeof created)[number]) => string | null) =>
        created.reduce<Record<string, number>>((acc, m) => {
          const k = key(m) ?? "(none)";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
      const draftTally = (key: (d: MemberDraft) => string | undefined) =>
        drafts.reduce<Record<string, number>>((acc, d) => {
          const k = key(d) ?? "(none)";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
      return {
        mappingVersion: job.mappingVersion,
        sourceExportedAt: job.sourceExportedAt?.toISOString() ?? null,
        sourceExportedAtProvenance: job.sourceExportedAt ? (job.sourceExportedAtProvenance ?? "owner_stated") : null,
        resumed,
        input: { rows: totalRows, people: drafts.length, parseErrors: errors.length },
        source: sourceSummary ?? null,
        expected: {
          byStatus: draftTally((d) => d.status ?? "active"),
          byPlan: draftTally((d) => d.membershipType),
          byAccountType: draftTally((d) => d.accountType ?? "adult"),
        },
        created: {
          total: created.length,
          byStatus: tally((m) => m.status),
          byPlan: tally((m) => m.membershipType),
          byAccountType: tally((m) => m.accountType),
          byPaymentStatus: tally((m) => m.paymentStatus),
          unmatchedPlan: created.filter((m) => m.membershipType && !m.membershipTierId).length,
        },
        skippedExisting,
        commitErrors: commitErrors.length,
        // Every person in the file is exactly one of: created by this job,
        // already in the club, or refused with a reason — and (teamup-2) every
        // CSV record has exactly one persisted disposition.
        reconciles:
          created.length + skippedExisting + commitErrors.length === drafts.length &&
          (teamup2 === null || teamup2.ledger.persisted === teamup2.ledger.rows),
        ...(ownRowsBeforeRun > 0 ? { resumedWith: ownRowsBeforeRun } : {}),
        ...(teamup2 ? { teamup2 } : {}),
      };
    });
    await withTenantContext(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: job.id },
        data: {
          // Connection register gap 12 (30 Sep 2026): a run whose slices failed
          // on a system error used to end "complete", which also blocked
          // re-importing the same file. "failed" lets the owner simply run it
          // again: people already created are recognised, never created twice.
          status: systemFailedRows > 0 ? "failed" : "complete",
          completedAt: new Date(),
          totalRows,
          processedRows: drafts.length,
          // The whole run's creations, including those an interrupted earlier
          // call made (acceptance S9, 2 Oct 2026: a resumed run said "447
          // imported" for 922 people). The response's `imported` stays this
          // call's own count; the manifest carries both.
          importedRows: imported + ownRowsBeforeRun,
          skippedRows: skippedExisting,
          errorRows: allErrors.length,
          errorLog: allErrors.length > 0 ? (allErrors as unknown as Prisma.InputJsonValue) : undefined,
          manifest: manifest as unknown as Prisma.InputJsonValue,
        },
      }),
    );

    await logAudit({
      tenantId, userId,
      action: "import.commit",
      entityType: "ImportJob",
      entityId: job.id,
      // Provenance on the event itself (acceptance S10/S12, 2 Oct 2026): which
      // file, exported when, under which mapping.
      metadata: { source: job.source, fileName: job.fileName, mappingVersion: job.mappingVersion ?? null, sourceExportedAt: job.sourceExportedAt ? job.sourceExportedAt.toISOString() : null, sourceExportedAtProvenance: job.sourceExportedAtProvenance ?? null, imported, skipped: skippedExisting + errors.length, errors: allErrors.length, created: manifest.created.total, reconciles: manifest.reconciles, resumed },
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
      try { await deleteImportFile(job.fileBlobUrl); }
      catch (e) { console.warn("[import-commit] blob del failed", e); }
    }

    // Best-effort completion email to the owner
    const owner = await withTenantContext(tenantId, (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, tenant: { select: { name: true } } },
      }),
    );
    // Only for a run that finished: a run with failed slices answers the owner
    // on screen with what to do next (gap 12).
    if (owner?.email && systemFailedRows === 0) {
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

    if (systemFailedRows > 0) {
      return NextResponse.json(
        {
          ok: false,
          incomplete: true,
          error: `${systemFailedRows} ${systemFailedRows === 1 ? "person" : "people"} couldn't be saved because of a system error; ${imported} were imported. Run the import again — people already imported are recognised and not created twice.`,
          imported, skipped: skippedExisting + errors.length, errors: allErrors.length, manifest,
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, imported, skipped: skippedExisting + errors.length, errors: allErrors.length, manifest });
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

/**
 * Status refresh commit (TeamUp only, readiness spec v3 §7). Updates ONLY the
 * TeamUp-owned standing (lib/importers/teamup-refresh REFRESH_OWNED_FIELDS)
 * plus "status as of" and its source job, on members matched by the key the
 * first import stored. Creates nobody. Every write's before and after values
 * are appended to the job manifest in the same transaction as the write, so a
 * run that dies part-way can be resumed (members already carrying this job as
 * their source are skipped) and every change can be rolled back.
 */
async function commitRefresh({
  tenantId,
  job,
  text,
  resumed,
}: {
  tenantId: string;
  job: { id: string; sourceExportedAt: Date | null; sourceExportedAtProvenance?: string | null; mappingVersion: string | null };
  text: string;
  resumed: boolean;
}) {
  const tzRow = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
  const { drafts, errors, summary: sourceSummary } = parseTeamUp(text, { asOf: asOfDate(job.sourceExportedAt, tzRow?.timezone) });
  const keys = drafts.map((d) => d.sourceKey).filter((k): k is string => !!k);

  const { plan, recorded } = await withTenantContext(tenantId, async (tx) => {
    const [members, tiers, current] = await Promise.all([
      tx.member.findMany({
        where: { tenantId, OR: [{ billedBy: "teamup" }, ...(keys.length ? [{ externalRef: { in: keys } }] : [])] },
        select: REFRESH_MEMBER_SELECT,
      }),
      tx.membershipTier.findMany({ where: { tenantId }, select: { id: true, name: true, billingCycle: true } }),
      tx.importJob.findUnique({ where: { id: job.id }, select: { manifest: true } }),
    ]);
    const m = (current?.manifest ?? {}) as { refresh?: { changes?: RefreshChange[] } };
    // A standing dated by a provisional export time does not block the
    // refresh that carries the real time (lib/importers withoutProvisionalStanding).
    return { plan: planRefresh({ drafts, errors, members: await withoutProvisionalStanding(tx, tenantId, members), tiers, job }), recorded: m.refresh?.changes ?? [] };
  });

  // teamup-2: never move standing backwards in time. The preview already
  // showed this; a commit that reaches it anyway is refused before any write.
  if (plan.olderThanRecorded) {
    const o = plan.olderThanRecorded;
    return {
      refused: `This file was exported ${o.fileExportedAt.slice(0, 10)}, but ${o.members} ${o.members === 1 ? "member already carries" : "members already carry"} standing from ${o.newestRecordedAt.slice(0, 10)}. Export a newer file — nothing was changed.`,
      olderThanRecorded: o,
    } as const;
  }

  // A resumed run: whatever an earlier run already wrote is in the manifest
  // with its true before-values and is not written again.
  const done = new Set(recorded.map((c) => c.memberId));
  const todo = plan.matched.filter((c) => !done.has(c.memberId) && c.before.billingStatusSource !== job.id);

  const BATCH = 25;
  let written = [...recorded];
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    written = await withTenantContext(tenantId, async (tx) => {
      // Re-read inside the write's own transaction: the before-values recorded
      // are the ones this write replaces, not the ones the plan saw.
      const fresh = await tx.member.findMany({
        where: { tenantId, id: { in: slice.map((c) => c.memberId) }, billedBy: "teamup" },
        select: REFRESH_MEMBER_SELECT,
      });
      const byId = new Map(fresh.map((f) => [f.id, f]));
      const applied: RefreshChange[] = [];
      for (const c of slice) {
        const f = byId.get(c.memberId);
        if (!f) continue;
        const before = standingOf(f);
        const change: RefreshChange = { ...c, before, fields: changedFields(before, c.after) };
        await tx.member.updateMany({ where: { id: c.memberId, tenantId, billedBy: "teamup" }, data: refreshWrite(c.after) });
        applied.push(change);
      }
      await recordStatusEventsBulk(
        tx,
        applied.map((c) => ({ tenantId, memberId: c.memberId, fromStatus: c.before.status, toStatus: c.after.status, reason: "import" as const, changedById: null })),
      );
      const cur = await tx.importJob.findUnique({ where: { id: job.id }, select: { manifest: true } });
      const man = (cur?.manifest ?? {}) as Record<string, unknown>;
      const prevRefresh = (man.refresh ?? {}) as { changes?: RefreshChange[] };
      const all = [...(prevRefresh.changes ?? []), ...applied];
      await tx.importJob.update({
        where: { id: job.id },
        data: {
          processedRows: Math.min(i + slice.length, todo.length),
          manifest: { ...man, mode: "refresh", refresh: { ...prevRefresh, changes: all } } as unknown as Prisma.InputJsonValue,
        },
      });
      return all;
    });
  }

  const changed = written.filter((c) => c.fields.length > 0).length;
  const unchanged = written.length - changed;
  const ex = plan.exceptions;
  const exceptionCount = ex.notInMatFlow.length + ex.notInFile.length + ex.billedByMatFlow.length + ex.refused.length + (ex.holdKept?.length ?? 0) + (ex.decisions?.length ?? 0);
  const manifest = {
    mode: "refresh" as const,
    mappingVersion: job.mappingVersion,
    sourceExportedAt: job.sourceExportedAt?.toISOString() ?? null,
    sourceExportedAtProvenance: job.sourceExportedAt ? (job.sourceExportedAtProvenance ?? "owner_stated") : null,
    resumed,
    input: { rows: drafts.length + errors.length, people: drafts.length, parseErrors: errors.length },
    source: sourceSummary ?? null,
    refresh: {
      matched: plan.matched.length,
      changed,
      unchanged,
      payerRecords: plan.payerRecords,
      changes: written,
      exceptions: ex,
    },
    reconciles: plan.reconciles,
  };
  await withTenantContext(tenantId, (tx) =>
    tx.importJob.update({
      where: { id: job.id },
      data: {
        status: "complete",
        completedAt: new Date(),
        totalRows: drafts.length + errors.length,
        processedRows: drafts.length,
        importedRows: changed,
        skippedRows: unchanged,
        errorRows: exceptionCount,
        errorLog: errors.length > 0 ? (errors as unknown as Prisma.InputJsonValue) : undefined,
        manifest: manifest as unknown as Prisma.InputJsonValue,
      },
    }),
  );
  return { changed, unchanged, exceptionCount, manifest };
}
