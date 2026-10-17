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
  /**
   * When the transition happened, if not "now" (T8a). Clamped by the writer to
   * no earlier than the member's latest existing event and no later than now,
   * so a supplied date can never reorder the history behind the member's
   * current status. Absent: the column default (write time) applies and the
   * key is left out of the insert entirely.
   */
  occurredAt?: Date;
}

/*
 * Ordering and the latest-event invariant (T8a).
 *
 * A member's history is replayed in the order `(occurredAt, createdAt, id)`:
 * `occurredAt` is when the change happened, `createdAt` is when MatFlow wrote
 * it (always the write time), and `id` breaks a tie inside one write. The
 * invariant every writer keeps is: **the latest event's `toStatus` equals
 * `Member.status`**. The clamp below is what keeps it when a caller supplies a
 * date: an event written now describes the member's status now, so it may not
 * be dated before an event that is already on record — at worst it ties with
 * that event's `occurredAt` and sorts after it on `createdAt`.
 *
 * (A back-fill of history OLDER than every existing event is a different
 * operation and does not go through this clamp.)
 */

/** Clamp one supplied date to `[latest, now]`. `latest` null = the member has no events yet. */
export function clampOccurredAt(supplied: Date, latest: Date | null, now: Date): Date {
  let t = supplied.getTime();
  if (Number.isNaN(t)) return now;
  if (latest && t < latest.getTime()) t = latest.getTime();
  if (t > now.getTime()) t = now.getTime();
  return new Date(t);
}

function warnClamped(tenantId: string, count: number) {
  if (count === 0) return;
  // Structured, no personal data: which club, how many dates moved.
  console.warn("[member-status] supplied occurredAt clamped", { tenantId, count });
}

/** The data object one event inserts; `occurredAt` spread only when supplied. */
function eventData(input: RecordStatusEventInput, occurredAt: Date | undefined) {
  return {
    tenantId: input.tenantId,
    memberId: input.memberId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    changedById: input.changedById ?? null,
    ...(occurredAt ? { occurredAt } : {}),
  };
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
  let occurredAt: Date | undefined;
  if (input.occurredAt) {
    const latest = await tx.memberStatusEvent.findFirst({
      where: { tenantId: input.tenantId, memberId: input.memberId },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { occurredAt: true },
    });
    occurredAt = clampOccurredAt(input.occurredAt, latest?.occurredAt ?? null, new Date());
    warnClamped(input.tenantId, occurredAt.getTime() === input.occurredAt.getTime() ? 0 : 1);
  }
  return tx.memberStatusEvent.create({
    data: eventData(input, occurredAt),
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
  // One lookup for the whole batch: the latest event per member that was
  // given a date. Rows without a date need no lookup and keep the default.
  const dated = rows.filter((r) => r.occurredAt);
  const latestByMember = new Map<string, Date>();
  if (dated.length > 0) {
    const latest = await tx.memberStatusEvent.groupBy({
      by: ["memberId"],
      where: {
        tenantId: { in: [...new Set(dated.map((r) => r.tenantId))] },
        memberId: { in: [...new Set(dated.map((r) => r.memberId))] },
      },
      _max: { occurredAt: true },
    });
    for (const l of latest) if (l._max.occurredAt) latestByMember.set(l.memberId, l._max.occurredAt);
  }
  const now = new Date();
  const clampedByTenant = new Map<string, number>();
  const data = rows.map((input) => {
    if (!input.occurredAt) return eventData(input, undefined);
    const at = clampOccurredAt(input.occurredAt, latestByMember.get(input.memberId) ?? null, now);
    if (at.getTime() !== input.occurredAt.getTime()) {
      clampedByTenant.set(input.tenantId, (clampedByTenant.get(input.tenantId) ?? 0) + 1);
    }
    return eventData(input, at);
  });
  for (const [tenantId, count] of clampedByTenant) warnClamped(tenantId, count);
  const result = await tx.memberStatusEvent.createMany({ data });
  return result.count;
}
