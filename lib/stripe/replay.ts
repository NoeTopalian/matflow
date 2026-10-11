/**
 * Operator-controlled replay of one Stripe event (payments lane PD, 11 Oct 2026).
 *
 * Only an operator reaches this (app/api/admin/stripe/events/[id]/replay: MFA
 * session, allowlist, step-up, reason). It never trusts anything stored: the
 * event is retrieved FRESH from Stripe as the club's connected account
 * (`Stripe-Account`), checked against the stored row (same id, same account,
 * same mode as the platform key), and handed to the same processing path a
 * webhook delivery takes (`runStripeEvent`, lib/stripe/event-store.ts).
 *
 *  - `received` / `failed` rows: processed once; status `replayed` on success.
 *  - terminal rows (`processed`, `ignored_*`, `replayed`): refused — there is
 *    nothing to do — unless `force` with a reason. A forced replay runs the
 *    processor with its emails and audit rows suppressed; the processor's own
 *    idempotency (unique Payment keys, mapping rules) must make it a no-op.
 *  - a club whose Stripe access was withdrawn (`stripeConnected: false`) is
 *    refused before any call: the platform can no longer act as that account.
 *
 * Every replay that reached Stripe writes ONE durable audit row
 * `stripe.event.replayed` (operator, event id, tenant, outcome) — including a
 * failed one. No secret, payload or personal data is written.
 */
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import {
  REPLAYABLE_STRIPE_EVENT_STATUSES,
  runStripeEvent,
  sanitiseEventError,
  type RunResult,
  type StoreEventInput,
  type StripeEventProcessor,
  type StripeEventStatus,
} from "@/lib/stripe/event-store";

export const REPLAY_AUDIT_ACTION = "stripe.event.replayed";
export const REPLAY_REASON_MIN = 5;
export const REPLAY_REASON_MAX = 500;

/** A fresh event from Stripe — the processor's input. */
export type FreshStripeEvent = StoreEventInput & {
  id: string;
  type: string;
  account?: string | null;
  livemode: boolean;
  created: number;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
};

/** The one Stripe call replay makes. */
export type StripeEventsClient = {
  events: {
    retrieve(id: string, params: Record<string, never>, options: { stripeAccount: string }): Promise<unknown>;
  };
};

export type ReplayRefusal =
  | "not_found"
  | "already_processed"
  | "reason_required"
  | "no_account"
  | "no_club"
  | "club_disconnected"
  | "mismatch"
  | "livemode_mismatch"
  | "stripe_unavailable"
  | "not_wired";

export type ReplayOutcome =
  | { ok: true; tenantId: string; result: RunResult; forced: boolean; previousStatus: StripeEventStatus }
  | { ok: false; refusal: ReplayRefusal; message: string };

export type ReplayRequest = {
  eventId: string;
  operatorId: string;
  reason: string;
  force?: boolean;
  /** The step-up grant's request id, carried onto the audit row. */
  requestId?: string | null;
  req?: Request;
};

export type ReplayDeps = {
  stripe: StripeEventsClient;
  /** null until lane PC exposes the webhook's processing function. */
  processor: StripeEventProcessor<FreshStripeEvent> | null;
  /** Mode of the platform key: an event must match it. */
  keyMode: "live" | "test" | "unknown";
};

const REFUSAL_MESSAGES: Record<ReplayRefusal, string> = {
  not_found: "No such event is on record.",
  already_processed: "This event was already processed. Nothing to replay.",
  reason_required: "Give a reason for replaying this event.",
  no_account: "This event has no connected account, so it cannot be fetched from Stripe.",
  no_club: "The connected account on this event is not linked to a club.",
  club_disconnected: "This club's Stripe access was withdrawn. The event cannot be fetched or replayed.",
  mismatch: "Stripe returned a different event from the one on record. Nothing was changed.",
  livemode_mismatch: "This event's mode (live or test) does not match the platform key. Nothing was changed.",
  stripe_unavailable: "Stripe could not be reached. Nothing was changed. Try again shortly.",
  not_wired: "Replay is not connected to the webhook processor yet. Nothing was changed.",
};

function refuse(refusal: ReplayRefusal): ReplayOutcome {
  return { ok: false, refusal, message: REFUSAL_MESSAGES[refusal] };
}

function isFreshEvent(v: unknown): v is FreshStripeEvent {
  const e = v as Partial<FreshStripeEvent> | null;
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.type === "string" &&
    typeof e.livemode === "boolean" &&
    typeof e.created === "number" &&
    !!e.data &&
    typeof e.data.object === "object" &&
    e.data.object !== null
  );
}

export async function replayStripeEvent(r: ReplayRequest, deps: ReplayDeps): Promise<ReplayOutcome> {
  const reason = r.reason.trim();
  if (reason.length < REPLAY_REASON_MIN || reason.length > REPLAY_REASON_MAX) return refuse("reason_required");

  const row = await withRlsBypass((tx) =>
    tx.stripeEvent.findUnique({
      where: { eventId: r.eventId },
      select: { eventId: true, type: true, status: true, tenantId: true, stripeAccountId: true, livemode: true },
    }),
  );
  if (!row) return refuse("not_found");
  const previousStatus = row.status as StripeEventStatus;
  const forced = !REPLAYABLE_STRIPE_EVENT_STATUSES.has(previousStatus);
  if (forced && r.force !== true) return refuse("already_processed");
  if (!row.stripeAccountId) return refuse("no_account");

  const club = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { stripeAccountId: row.stripeAccountId },
      select: { id: true, stripeConnected: true },
    }),
  );
  if (!club) return refuse("no_club");
  if (row.tenantId && row.tenantId !== club.id) return refuse("mismatch");
  if (!club.stripeConnected) return refuse("club_disconnected");
  if (!deps.processor) return refuse("not_wired");

  let fresh: unknown;
  try {
    fresh = await deps.stripe.events.retrieve(r.eventId, {}, { stripeAccount: row.stripeAccountId });
  } catch (err) {
    console.warn("[stripe-replay] retrieve failed", { eventId: r.eventId, error: sanitiseEventError(err) });
    return refuse("stripe_unavailable");
  }
  if (!isFreshEvent(fresh) || fresh.id !== row.eventId || fresh.type !== row.type) return refuse("mismatch");
  // Retrieved AS the connected account; an event that names another account is not this one.
  if (fresh.account && fresh.account !== row.stripeAccountId) return refuse("mismatch");
  const expectLive = deps.keyMode === "live" ? true : deps.keyMode === "test" ? false : null;
  if (expectLive === null || fresh.livemode !== expectLive) return refuse("livemode_mismatch");

  const event: FreshStripeEvent = { ...fresh, account: row.stripeAccountId };
  const result = await runStripeEvent(event, deps.processor, { mode: forced ? "replay_forced" : "replay" });

  await logAudit({
    durable: true,
    outcome: result.kind === "failed" ? "failed" : "succeeded",
    tenantId: club.id,
    userId: null,
    action: REPLAY_AUDIT_ACTION,
    entityType: "StripeEvent",
    entityId: row.eventId,
    metadata: {
      eventId: row.eventId,
      eventType: row.type,
      previousStatus,
      forced,
      reason,
      result: result.kind,
      ...(result.kind === "failed" ? { error: result.error } : {}),
    },
    actAsUserId: r.operatorId,
    operatorId: r.operatorId,
    requestId: r.requestId ?? undefined,
    req: r.req,
  });

  return { ok: true, tenantId: club.id, result, forced, previousStatus };
}
