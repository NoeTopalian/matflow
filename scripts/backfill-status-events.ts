/**
 * T8b: source-dated back-fill of status history from the TeamUp import ledger.
 *
 * Reconstructs each imported member's status history before the import day
 * from ImportedMembership rows (lib/status-backfill.ts has the rules) and
 * writes it as MemberStatusEvent rows with reason import, changedById null,
 * sourceJobId = the ledger's job and sourceAction = import_backfill.
 *
 * Needs migrations 20261017022302_status_event_source_provenance and
 * 20261017024714_status_event_backfill_source_action. Run first on a Neon
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
 *       refuses if the data moved since. One transaction per club: a refusal
 *       (a date not earlier than a member's first event) rolls back that club
 *       only and is reported. One AuditLog row per club written.
 *   ... --rollback
 *       deletes exactly the import_backfill events, per club, plus an AuditLog
 *       row. Import-day, refresh and staff events are never touched.
 *
 *   --expect-host  REQUIRED. ep-hidden-salad (TEST) or a whole child-branch
 *                  endpoint id. ep-bold-wave and --production are refused.
 *   --tenant       One club. Omitted: every club, one transaction each.
 *
 * Output carries ids and counts only: no names, emails or plan labels.
 * Exit codes: 0 ok, 1 a check failed or a club was refused, 2 target refused.
 */
import { createHash } from "node:crypto";
import { argValue, backfillMode, backfillTarget, TargetRefused } from "./backfill-status-events-guard.mjs";

const TAG = "[t8b-backfill]";

async function main() {
  const argv = process.argv.slice(2);
  let mode: "preview" | "apply" | "rollback";
  try {
    mode = backfillMode(argv);
    const host = backfillTarget(process.env.DATABASE_URL ?? "", argv);
    console.log(`${TAG} target ${host} — ${mode === "preview" ? "preview (no writes)" : mode.toUpperCase()}`);
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

  if (mode === "rollback") {
    console.log(`${TAG} run ${runId}`);
    let total = 0;
    for (const tenantId of tenantIds) {
      const r = await withTenantContext(tenantId, (tx) => sb.rollbackTenantBackfill(tx, tenantId, { runId }), { timeout: 120_000 });
      total += r.removed;
      if (r.removed > 0) console.log(`${TAG} club ${tenantId}: removed ${r.removed} back-filled event(s)`);
    }
    console.log(`${TAG} ${tenantIds.length} club(s), ${total} back-filled event(s) removed`);
    return;
  }

  // Read-only planning pass, one transaction per club (the preview itself, and
  // the digest gate in front of apply).
  type Plan = Awaited<ReturnType<typeof sb.planTenantBackfill>>;
  const plans: Plan[] = [];
  for (const tenantId of tenantIds) {
    plans.push(await withTenantContext(tenantId, (tx) => sb.planTenantBackfill(tx, tenantId), { timeout: 120_000 }));
  }
  const digestOf = (ps: Plan[]) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          ps.map((p) => ({
            tenantId: p.tenantId,
            alreadyApplied: p.alreadyApplied,
            events: p.inputs.length,
            byMonth: sb.monthTotals(p.byMonth),
            exceptionCounts: p.exceptionCounts,
          })),
        ),
      )
      .digest("hex")
      .slice(0, 16);
  const digest = digestOf(plans);

  for (const p of plans) {
    if (p.ledgerRows === 0 && !p.alreadyApplied) continue;
    console.log(
      `${TAG} club ${p.tenantId} (${p.timeZone}): ${p.ledgerRows} ledger row(s), ${p.membersWithLedger} member(s); ` +
        `${p.inputs.length} event(s) for ${p.membersPlanned} member(s); ${p.excludedRows} row(s) left out (scheduled or after the first event); ` +
        `${p.membersOnSeveralJobs} member(s) on several jobs (${p.rowsFromOtherJobs} row(s) from other jobs ignored)` +
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
          // The plan inside the transaction must be the one that was digested.
          if (res.status === "applied" && JSON.stringify(sb.monthTotals(res.plan.byMonth)) !== JSON.stringify(sb.monthTotals(p.byMonth))) {
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
      const monthsMatch = JSON.stringify(Object.entries(after.byMonth).sort()) === JSON.stringify(Object.entries(expected).sort());
      console.log(
        `${TAG} club ${tenantId}: ${r.status}, ${r.written} written; months match preview ${monthsMatch ? "yes" : "NO"}; ` +
          `duplicates ${after.duplicates}; latest-event mismatches ${before.latestEventMismatches} -> ${after.latestEventMismatches}`,
      );
      if (!monthsMatch || after.duplicates !== 0 || after.latestEventMismatches !== before.latestEventMismatches) {
        console.error(`${TAG} FAIL: club ${tenantId} detection check failed. Stop; roll back with --rollback or restore from the snapshot.`);
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
