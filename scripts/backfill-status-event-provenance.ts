/**
 * T8d back-fill: give the import create events written before T8d their
 * provenance (sourceJobId = Member.importJobId, sourceAction = import_create).
 *
 * Run ONLY after migration 20261017022302_status_event_source_provenance, and
 * first on a Neon child branch. Release R4 rules: a snapshot just before, the
 * detection queries before and after.
 *
 * Usage:
 *   npx tsx scripts/backfill-status-event-provenance.ts --expect-host <endpoint> [--tenant <id>] [--apply] [--production]
 *
 *   --expect-host  REQUIRED. ep-hidden-salad (TEST), a whole child-branch
 *                  endpoint id, or ep-bold-wave (production, needs --production).
 *                  The DATABASE_URL host is checked against it by the shared
 *                  readiness guard before any connection opens.
 *   --tenant       One club. Omitted: every club, one transaction per club.
 *   --apply        Write. Omitted: a preview that reads and writes nothing.
 *   --production   Admit the production endpoint. Never pass it before the
 *                  child-branch rehearsal has been read.
 *
 * What it prints: per club, the candidate count, the events left alone (member
 * has no importJobId), and the touched event ids grouped by job (ids only, no
 * personal data); then the detection results. The occurredAt checksum is
 * printed before and after and the run fails loudly if it moved.
 *
 * Idempotent: only events with no sourceJobId are candidates, so a second run
 * changes 0 rows. Never rewrites occurredAt. Recovery: set sourceJobId and
 * sourceAction to NULL for exactly the ids this run logged.
 */
import { resolveDbTarget, TargetRefused } from "./readiness/db-target.mjs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

async function main() {
  const expectHost = arg("--expect-host");
  const tenantArg = arg("--tenant");
  const apply = has("--apply");
  const allowProduction = has("--production");
  try {
    const host = resolveDbTarget(process.env.DATABASE_URL ?? "", { expectHost, allowProduction });
    console.log(`[t8d-backfill] target ${host} — ${apply ? "APPLY" : "preview (no writes)"}`);
  } catch (e) {
    if (e instanceof TargetRefused) {
      console.error(`[t8d-backfill] ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  // Imported only after the guard, so nothing can connect before it passes.
  const { withTenantContext, withRlsBypass } = await import("../lib/prisma-tenant");
  const { backfillCreateEventProvenance } = await import("../lib/status-event-provenance");

  // Detection (ticket T8d, Data impact): the occurredAt checksum, the
  // provenance tally, and the "provenance only on import events" check. The
  // checksum covers the rows that existed when the run began, so an event the
  // live app writes meanwhile cannot read as a moved date.
  const cutoff = new Date();
  const detect = () =>
    withRlsBypass(async (tx) => {
      const [sum] = await tx.$queryRaw<{ md5: string | null }[]>`
        SELECT md5(string_agg(id || ':' || "occurredAt"::text, ',' ORDER BY id)) AS md5
        FROM "MemberStatusEvent" WHERE "createdAt" <= ${cutoff}`;
      const tally = await tx.$queryRaw<{ sourceAction: string | null; n: bigint }[]>`
        SELECT "sourceAction", COUNT(*) AS n FROM "MemberStatusEvent" GROUP BY 1 ORDER BY 1`;
      const [wrong] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM "MemberStatusEvent" WHERE "sourceJobId" IS NOT NULL AND reason <> 'import'`;
      return { checksum: sum?.md5 ?? null, tally: tally.map((t) => ({ sourceAction: t.sourceAction, n: Number(t.n) })), nonImportWithProvenance: Number(wrong?.n ?? 0) };
    });

  const before = await detect();
  console.log("[t8d-backfill] before", JSON.stringify(before));

  const tenantIds = tenantArg
    ? [tenantArg]
    : await withRlsBypass((tx) => tx.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })).then((ts) => ts.map((t) => t.id));

  let totalCandidates = 0;
  let totalUpdated = 0;
  for (const tenantId of tenantIds) {
    const r = await withTenantContext(tenantId, (tx) => backfillCreateEventProvenance(tx, tenantId, { apply }), { timeout: 60_000 });
    totalCandidates += r.candidates;
    totalUpdated += r.updated;
    if (r.candidates === 0) continue;
    console.log(`[t8d-backfill] club ${tenantId}: ${r.candidates} candidate(s), ${r.withoutJob} left alone (no importJobId), ${r.updated} updated`);
    for (const g of r.byJob) console.log(`  job ${g.sourceJobId}: ${g.eventIds.length} event(s) ${g.eventIds.join(",")}`);
  }

  const after = await detect();
  console.log("[t8d-backfill] after", JSON.stringify(after));
  console.log(`[t8d-backfill] ${tenantIds.length} club(s), ${totalCandidates} candidate(s), ${totalUpdated} updated`);

  if (before.checksum !== after.checksum) {
    console.error("[t8d-backfill] FAIL: the occurredAt checksum moved. Stop and restore from the snapshot.");
    process.exit(1);
  }
  if (after.nonImportWithProvenance !== 0) {
    console.error("[t8d-backfill] FAIL: provenance found on non-import events.");
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("[t8d-backfill] failed", e);
    process.exit(1);
  },
);
