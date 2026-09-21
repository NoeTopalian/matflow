import type { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

/**
 * The conversion funnel's single writer (M1).
 *
 * Every status transition a member goes through — taster created at the desk,
 * a Stripe webhook activating a subscription, an importer seeding a roster,
 * staff flipping a status by hand — is recorded here as one MemberStatusEvent
 * row. AuditLog cannot back the funnel: it purges at 365 days, and a
 * conversion rate has to look further back than that. This module is the ONLY
 * place MemberStatusEvent rows are written, so the funnel has one shape and one
 * set of invariants rather than six near-copies drifting apart.
 *
 * `reason` mirrors the CHECK constraint on the column (migration ec98ab1).
 * import-reason events are deliberately EXCLUDED from conversion math
 * (see lib/attribution.ts) — a bulk import is not a coach converting a taster.
 */
export const MEMBER_STATUS_EVENT_REASONS = [
  "staff_edit",
  "stripe_webhook",
  "import",
  "self_signup",
] as const;

export type MemberStatusEventReason = (typeof MEMBER_STATUS_EVENT_REASONS)[number];

export interface RecordStatusEventInput {
  tenantId: string;
  memberId: string;
  /** The status the member is leaving. `null` for the very first event (create). */
  fromStatus: string | null;
  toStatus: string;
  reason: MemberStatusEventReason;
  /** The staff User behind the change, or `null` for webhook / import writes. */
  changedById?: string | null;
}

/**
 * Insert one MemberStatusEvent inside the CALLER's transaction.
 *
 * Takes `tx` and never opens its own transaction, so the event and the status
 * change it describes commit or roll back together — a status write that
 * succeeds while its funnel event is lost (or vice versa) is exactly the
 * divergence this single-writer design exists to prevent.
 *
 * Idempotent-friendly: a no-op transition (`fromStatus === toStatus`) writes
 * nothing and returns `null`. That is what lets a PATCH handler call this
 * unconditionally with `(oldStatus -> newStatus)` without seeding the funnel
 * with events for edits that never moved the member.
 */
export async function recordStatusEvent(
  tx: TxClient,
  input: RecordStatusEventInput,
): Promise<{ id: string } | null> {
  if (input.fromStatus === input.toStatus) return null;
  return tx.memberStatusEvent.create({
    data: {
      tenantId: input.tenantId,
      memberId: input.memberId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason,
      changedById: input.changedById ?? null,
    },
    select: { id: true },
  });
}

/**
 * Bulk variant for the importer: one `createMany` for a whole batch, inside the
 * caller's transaction. No-op transitions are filtered out first, same rule as
 * the single writer. Returns the number of rows actually written.
 */
export async function recordStatusEventsBulk(
  tx: TxClient,
  inputs: RecordStatusEventInput[],
): Promise<number> {
  const rows = inputs.filter((input) => input.fromStatus !== input.toStatus);
  if (rows.length === 0) return 0;
  const result = await tx.memberStatusEvent.createMany({
    data: rows.map((input) => ({
      tenantId: input.tenantId,
      memberId: input.memberId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason,
      changedById: input.changedById ?? null,
    })),
  });
  return result.count;
}
