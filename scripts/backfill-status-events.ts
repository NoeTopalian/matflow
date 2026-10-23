/**
 * T8b: source-dated back-fill of status history from the TeamUp import ledger.
 *
 * Reconstructs each imported member's status history before the import day
 * from ImportedMembership rows (lib/status-backfill.ts has the rules) and
 * writes it as MemberStatusEvent rows with reason import, changedById null,
 * sourceJobId = the ledger's job and sourceAction = import_backfill.
 *
 * Needs migration 20261017022302_status_event_source_provenance (its CHECK
 * admits import_backfill). Run first on a Neon
 * child branch. Release R4 rules: a snapshot immediately before apply, and the
 * preview reviewed by Noe. This build REFUSES the production endpoint.
 *
 * Usage:
 *   npx tsx scripts/backfill-status-events.ts --expect-host <endpoint> [--tenant <id>]
 *       preview (default): reads only. Prints, per club, the proposed events per
 *       month and kind, the exceptions by ledger row id, and a plan digest.
 *   ... --apply --plan-digest <digest>
 *       writes. The digest must equal the one the preview printed for the same
 *       target and club scope, so apply always follows a reviewed dry run and
 *       refuses if the data moved since. The digest covers every planned event
 *       (member, date, status), the months by kind and the exceptions by
 *       ledger row id, not just the totals (review F6). One transaction per
 *       club: a refusal (a date not earlier than a member's first event) rolls
 *       back that club only and is reported. One AuditLog row per club written.
 *   ... --rollback
 *       previews a rollback, read-only: per club, the back-filled events it
 *       would delete by month and kind, and a rollback digest (review F6).
 *   ... --rollback --confirm-digest <digest>
 *       deletes exactly the events the rollback preview listed, per club, plus
 *       an AuditLog row. Refused when the digest no longer matches, and a club
 *       whose back-filled events changed between this pass and its delete is
 *       left untouched. Import-day, refresh and staff events are never touched.
 *
 *   --expect-host  REQUIRED. ep-hidden-salad (TEST) or a whole child-branch
 *                  endpoint id. ep-bold-wave and --production are refused.
 *   --tenant       One club. Omitted: every club, one transaction each.
 *
 * Output carries ids and counts only: no names, emails or plan labels.
 * Exit codes: 0 ok, 1 a check failed or a club was refused, 2 target refused.
 */
import { argValue, backfillMode, backfillPlanDigest, backfillRollbackDigest, backfillTarget, TargetRefused } from "./backfill-status-events-guard.mjs";

const TAG = "[t8b-backfill]";

async function main() {
  const argv = process.argv.slice(2);
  let mode: "preview" | "apply" | "rollback_preview" | "rollback";
  try {
    mode = backfillMode(argv);
    const host = backfillTarget(process.env.DATABASE_URL ?? "", argv);
    const label = mode === "preview" ? "preview (no writes)" : mode === "rollback_preview" ? "rollback preview (no writes)" : mode.toUpperCase();
    console.log(`${TAG} target ${host} — ${label}`);
  } catch (e) {
    if (e instanceof TargetRefused) {
      console.error(`${TAG} ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const tenantArg = argValue(argv, "--tenant");

  // Imported only after the guard, so nothing can connect before it passes.
  const { withTenantContext, withRlsBypass } = await import("../lib/prisma-tenant");
  const sb = await import("../lib/status-backfill");
  const { StatusEventPlacementRefused } = await import("../lib/member-status");

  const tenantIds = tenantArg
    ? [tenantArg]
    : await withRlsBypass((tx) => tx.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })).then((ts) => ts.map((t) => t.id));

  const runId = `t8b-${new Date().toISOString()}`;
  let failed = false;

  if (mode === "rollback_preview" || mode === "rollback") {
    // Read-only pass, one transaction per club: the rollback preview itself,
    // and the digest gate in front of the delete (review F6).
    const previews = [];
    for (const tenantId of tenantIds) {
      previews.push(await withTenantContext(tenantId, (tx) => sb.previewTenantBackfillRollback(tx, tenantId), { timeout: 120_000 }));
    }
    const rollbackDigest = backfillRollbackDigest(previews);
    let toRemove = 0;
    for (const p of previews) {
      if (p.events === 0) continue;
      toRemove += p.events;
      console.log(`${TAG} club ${p.tenantId} (${p.timeZone}): ${p.events} back-filled event(s) would be removed`);
      for (const month of Object.keys(p.byMonth).sort()) {
        const k = p.byMonth[month];
        console.log(`  ${month}  start ${k.start}  rejoin ${k.rejoin}  cancelled ${k.cancelled}  completed course ${k.completed_course}`);
      }
    }
    console.log(`${TAG} ${previews.filter((p) => p.events > 0).length} club(s), ${toRemove} back-filled event(s) to remove`);
    console.log(`${TAG} rollback digest ${rollbackDigest}`);
    if (mode === "rollback_preview") {
      console.log(`${TAG} rollback preview only. To delete: --rollback --confirm-digest ${rollbackDigest}`);
      return;
    }
    const confirmed = argValue(argv, "--confirm-digest");
    if (confirmed !== rollbackDigest) {
      console.error(`${TAG} REFUSED: --confirm-digest ${confirmed ?? "(missing)"} does not match this rollback (${rollbackDigest}). Run the rollback preview, review it, then confirm with its digest.`);
      process.exit(1);
    }
    console.log(`${TAG} run ${runId}`);
    let total = 0;
    for (const p of previews) {
      if (p.events === 0) continue;
      const tenantId = p.tenantId;
      try {
        // Deletes exactly the previewed ids; refuses (club untouched) if they changed since.
        const r = await withTenantContext(tenantId, (tx) => sb.rollbackTenantBackfill(tx, tenantId, { runId, expectedEventIds: p.eventIds }), { timeout: 120_000 });
        total += r.removed;
        console.log(`${TAG} club ${tenantId}: removed ${r.removed} back-filled event(s)`);
      } catch (e) {
        failed = true;
        console.error(`${TAG} club ${tenantId}: rollback refused, club untouched (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    console.log(`${TAG} ${total} back-filled event(s) removed`);
    if (failed) process.exit(1);
    return;
  }

  // Read-only planning pass, one transaction per club (the preview itself, and
  // the digest gate in front of apply).
  type Plan = Awaited<ReturnType<typeof sb.planTenantBackfill>>;
  const plans: Plan[] = [];
  for (const tenantId of tenantIds) {
    plans.push(await withTenantContext(tenantId, (tx) => sb.planTenantBackfill(tx, tenantId), { timeout: 120_000 }));
  }
  // Review F6: every planned event, the months by kind and the exceptions by
  // ledger row id, not just the totals.
  const digest = backfillPlanDigest(plans);

  for (const p of plans) {
    if (p.ledgerRows === 0 && !p.alreadyApplied) continue;
    console.log(
      `${TAG} club ${p.tenantId} (${p.timeZone}): ${p.ledgerRows} ledger row(s), ${p.membersWithLedger} member(s); ` +
        `${p.inputs.length} event(s) for ${p.membersPlanned} member(s); ${p.excludedRows} row(s) left out (scheduled or after the first event); ` +
        `${p.membersOnSeveralJobs} member(s) on several jobs (${p.rowsFromOtherJobs} row(s) from other jobs ignored)` +
        (p.membersAlreadyBackfilled > 0 ? `; ${p.membersAlreadyBackfilled} member(s) already back-filled, left out` : "") +
        (p.alreadyApplied ? `; ALREADY APPLIED (${p.existingBackfillEvents} back-filled event(s) on record)` : ""),
    );
    for (const month of Object.keys(p.byMonth).sort()) {
      const k = p.byMonth[month];
      console.log(`  ${month}  start ${k.start}  rejoin ${k.rejoin}  cancelled ${k.cancelled}  completed course ${k.completed_course}`);
    }
    const counts = Object.entries(p.exceptionCounts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(`  exceptions: ${p.exceptions.length}${counts ? ` (${counts})` : ""}`);
    for (const e of p.exceptions) console.log(`    ${e.kind}: ledger row(s) ${e.ledgerRowIds.join(",")}`);
  }
  console.log(`${TAG} plan digest ${digest}`);

  if (mode === "preview") {
    console.log(`${TAG} preview only. To write: add --apply --plan-digest ${digest}`);
    return;
  }

  const given = argValue(argv, "--plan-digest");
  if (given !== digest) {
    console.error(`${TAG} REFUSED: --plan-digest ${given ?? "(missing)"} does not match this plan (${digest}). Run the preview, review it, then apply with its digest.`);
    process.exit(1);
  }

  console.log(`${TAG} run ${runId}`);
  let totalWritten = 0;
  for (const p of plans) {
    if (p.inputs.length === 0 && !p.alreadyApplied) continue;
    const tenantId = p.tenantId;
    const before = await withTenantContext(tenantId, (tx) => sb.detectBackfill(tx, tenantId, p.timeZone), { timeout: 60_000 });
    try {
      const r = await withTenantContext(
        tenantId,
        async (tx) => {
          const res = await sb.applyTenantBackfill(tx, tenantId, { runId });
          // The plan inside the transaction must be the one that was digested:
          // the same events, months by kind and exceptions, not just the totals.
          if (res.status === "applied" && backfillPlanDigest([res.plan]) !== backfillPlanDigest([p])) {
            throw new Error("the plan changed between the preview pass and the write; rolled back");
          }
          return res;
        },
        { timeout: 300_000 },
      );
      if (r.status === "already_applied") {
        console.log(`${TAG} club ${tenantId}: already applied (${r.existingBackfillEvents} back-filled event(s)); 0 written`);
        continue;
      }
      totalWritten += r.written;
      const after = await withTenantContext(tenantId, (tx) => sb.detectBackfill(tx, tenantId, p.timeZone), { timeout: 60_000 });
      const expected = sb.monthTotals(p.byMonth);
      // This run's rows only: an earlier run's back-filled members stay on record.
      const added = sb.monthDelta(after.byMonth, before.byMonth);
      const monthsMatch = JSON.stringify(Object.entries(added).sort()) === JSON.stringify(Object.entries(expected).sort());
      console.log(
        `${TAG} club ${tenantId}: ${r.status}, ${r.written} written; months match preview ${monthsMatch ? "yes" : "NO"}; ` +
          `duplicates ${after.duplicates}; latest-event mismatches ${before.latestEventMismatches} -> ${after.latestEventMismatches}`,
      );
      if (!monthsMatch || after.duplicates !== 0 || after.latestEventMismatches !== before.latestEventMismatches) {
        console.error(`${TAG} FAIL: club ${tenantId} detection check failed. Stop; preview a rollback with --rollback (then --rollback --confirm-digest <digest>) or restore from the snapshot.`);
        failed = true;
      }
    } catch (e) {
      failed = true;
      if (e instanceof StatusEventPlacementRefused) {
        console.error(`${TAG} club ${tenantId}: REFUSED by the writer, club rolled back (${e.message})`);
      } else {
        console.error(`${TAG} club ${tenantId}: failed, club rolled back (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  console.log(`${TAG} ${totalWritten} back-filled event(s) written`);
  if (failed) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`${TAG} failed`, e);
    process.exit(1);
  },
);
