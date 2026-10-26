import type { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

/**
 * T8d back-fill: provenance on the create events written before T8d.
 *
 * A TeamUp create import writes one `reason = 'import'`, `fromStatus = null`
 * event per member it creates, and stamps the member with `importJobId`.
 * Events written before migration 20261017022302 carry no `sourceJobId`; this
 * gives each such event `sourceJobId = Member.importJobId` and
 * `sourceAction = 'import_create'`.
 *
 * Rules (ticket T8d, Migration/backfill):
 * - Per club, inside the caller's `withTenantContext` transaction, every query
 *   filtered on `tenantId`.
 * - Only events still carrying no `sourceJobId` are candidates, and the update
 *   repeats that filter, so a second run changes 0 rows.
 * - `occurredAt` is never written: the update's data names the two provenance
 *   columns and nothing else.
 * - A member with no `importJobId` (added by staff, or by a self sign-up) is
 *   left alone: their first event is not an import's to claim.
 * - Returns the touched event ids (ids only, no personal data) so a run can be
 *   logged and, if it must be undone, reversed by setting the two columns back
 *   to null for exactly those ids.
 *
 * `apply: false` is a preview: the same reads, no write.
 */
export interface ProvenanceBackfillResult {
  tenantId: string;
  /** Import create events with no provenance yet. */
  candidates: number;
  /** Of those, how many belong to a member with no importJobId (left alone). */
  withoutJob: number;
  /** The events given provenance (preview: the events that would be), grouped by job. */
  byJob: Array<{ sourceJobId: string; eventIds: string[] }>;
  /** Rows actually updated (0 in a preview). */
  updated: number;
}

export async function backfillCreateEventProvenance(
  tx: TxClient,
  tenantId: string,
  { apply }: { apply: boolean },
): Promise<ProvenanceBackfillResult> {
  if (!tenantId) throw new Error("backfillCreateEventProvenance requires a tenantId");
  const events = await tx.memberStatusEvent.findMany({
    where: { tenantId, reason: "import", fromStatus: null, sourceJobId: null },
    select: { id: true, memberId: true },
    orderBy: { id: "asc" },
  });
  const members = events.length
    ? await tx.member.findMany({
        where: { tenantId, id: { in: [...new Set(events.map((e) => e.memberId))] }, importJobId: { not: null } },
        select: { id: true, importJobId: true },
      })
    : [];
  const jobOf = new Map(members.map((m) => [m.id, m.importJobId as string]));

  const grouped = new Map<string, string[]>();
  let withoutJob = 0;
  for (const e of events) {
    const job = jobOf.get(e.memberId);
    if (!job) {
      withoutJob += 1;
      continue;
    }
    const ids = grouped.get(job) ?? [];
    ids.push(e.id);
    grouped.set(job, ids);
  }
  const byJob = [...grouped].map(([sourceJobId, eventIds]) => ({ sourceJobId, eventIds }));

  let updated = 0;
  if (apply) {
    for (const { sourceJobId, eventIds } of byJob) {
      const res = await tx.memberStatusEvent.updateMany({
        where: { tenantId, id: { in: eventIds }, reason: "import", fromStatus: null, sourceJobId: null },
        data: { sourceJobId, sourceAction: "import_create" },
      });
      updated += res.count;
    }
  }
  return { tenantId, candidates: events.length, withoutJob, byJob, updated };
}
