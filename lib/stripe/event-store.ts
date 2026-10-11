/**
 * Durable Stripe event store (payments lane PD, 11 Oct 2026).
 *
 * The defect it closes (audit 11 Oct, section 13-14): the webhook claimed
 * `StripeEvent` INSIDE the handler transaction, so an event whose handler threw
 * left no row at all. It existed only as a Stripe retry and a log line; after
 * Stripe's three days of retries it was gone, and nothing in MatFlow could say
 * it had ever arrived.
 *
 * Two phases now:
 *
 *  1. `recordReceived(event)` writes (or touches) the row in its OWN short
 *     transaction BEFORE any processing: status `received`, attempts + 1. That
 *     commit survives whatever the handler does next.
 *  2. The handler runs in ONE transaction that first locks the row
 *     (`claimStripeEvent`: a conditional UPDATE of a received/failed row, whose
 *     row lock is held until that transaction ends) and, in the same
 *     commit as its effects, sets the terminal status (`markProcessed` /
 *     `markIgnored`). A crash or throw rolls the effects AND the terminal status
 *     back together; `markFailed` then records the error on the row in another
 *     short transaction, and the next delivery (Stripe retry or operator
 *     replay) processes it.
 *
 * Duplicate delivery: a row already processed/ignored/replayed answers
 * `already_processed` without running anything. Concurrent delivery: the row
 * lock means at most one transaction processes an id at a time. The second
 * waits on the lock; when the first commits it finds the row terminal
 * (`already_processed`), when the first rolls back it claims the row and
 * processes it. A wait past the lock timeout is `in_progress` (non-2xx, so
 * Stripe retries). No raw SQL: Prisma's conditional updateMany is the lock.
 *
 * `runStripeEvent` composes the two phases for a caller-supplied processor —
 * the webhook (lane PC wires its handler in) and operator replay
 * (lib/stripe/replay.ts) both go through it, so there is one processing path.
 */
import type { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import * as Sentry from "@sentry/nextjs";

type Tx = Prisma.TransactionClient;

export const STRIPE_EVENT_STATUSES = [
  "received",
  "processed",
  "failed",
  "ignored_foreign",
  "ignored_stale",
  // Lane PC (11 Oct 2026): a verified event whose livemode differs from the
  // platform key's mode (a test-mode event on the live Connect endpoint).
  // Acknowledged and recorded, never applied.
  "ignored_mode",
  "replayed",
] as const;
export type StripeEventStatus = (typeof STRIPE_EVENT_STATUSES)[number];

/** Statuses after which a delivery has nothing left to do. */
export const TERMINAL_STRIPE_EVENT_STATUSES: ReadonlySet<StripeEventStatus> = new Set([
  "processed",
  "ignored_foreign",
  "ignored_stale",
  "ignored_mode",
  "replayed",
]);

/** Statuses an operator replay (or a Stripe retry) may still process. */
export const REPLAYABLE_STRIPE_EVENT_STATUSES: ReadonlySet<StripeEventStatus> = new Set(["received", "failed"]);

export type IgnoredKind = "ignored_foreign" | "ignored_stale" | "ignored_mode";

/** The parts of a Stripe event the store keeps. Never the payload. */
export type StoreEventInput = {
  id: string;
  type: string;
  account?: string | null;
  livemode?: boolean | null;
  created?: number | null;
  data?: { object?: { id?: unknown } | Record<string, unknown> | null } | null;
};

/** Longest error text kept on a row. */
export const LAST_ERROR_MAX = 300;

/**
 * An error message fit to store and show an operator: one line, addresses
 * masked, truncated. Stripe and Prisma messages can quote a value; the admin
 * page must never become a place where a member's address is displayed.
 */
export function sanitiseEventError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message}`
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err) ?? "unknown error";
            } catch {
              return "unknown error";
            }
          })();
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const masked = oneLine
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/g, "[email]")
    // Stripe's authentication errors quote the key (partly masked): never keep any of it.
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9*]+/g, "$1_$2_[masked]")
    .replace(/\bwhsec_[A-Za-z0-9*]+/g, "whsec_[masked]");
  return masked.length > LAST_ERROR_MAX ? `${masked.slice(0, LAST_ERROR_MAX - 1)}…` : masked || "unknown error";
}

function objectIdOf(event: StoreEventInput): string | null {
  const id = (event.data?.object as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id.slice(0, 255) : null;
}

export type RecordReceivedResult = {
  eventId: string;
  status: StripeEventStatus;
  attempts: number;
  tenantId: string | null;
  /** True when the row is already terminal: nothing to run. */
  alreadyProcessed: boolean;
};

/**
 * Phase 1. Upsert the row in its own transaction, before any processing.
 *
 * New id: inserted as `received`, attempts 1. Known id still `received` or
 * `failed`: attempts + 1, lastAttemptAt now. Known id already terminal: left
 * untouched and reported `alreadyProcessed`. The club is resolved from
 * `event.account` here (when it maps to one) so the failed-event list can be
 * shown per club even when the handler never got that far.
 *
 * `opts.reconcileFound` records an event the reconcile job found missing:
 * attempts stay 0 (nothing tried to process it) and reconcileFoundAt is set.
 */
export async function recordReceived(
  event: StoreEventInput,
  opts: { reconcileFound?: boolean; tenantId?: string | null } = {},
): Promise<RecordReceivedResult> {
  const account = typeof event.account === "string" && event.account.length > 0 ? event.account : null;
  const objectId = objectIdOf(event);
  const created = Number.isFinite(event.created) ? Math.trunc(event.created as number) : 0;
  const livemode = event.livemode === true;
  const found = opts.reconcileFound === true;

  return withRlsBypass(async (tx) => {
    let tenantId = opts.tenantId ?? null;
    if (!tenantId && account) {
      const t = await tx.tenant.findFirst({ where: { stripeAccountId: account }, select: { id: true } });
      tenantId = t?.id ?? null;
    }
    const now = new Date();
    // INSERT … ON CONFLICT DO NOTHING: never an error inside the transaction.
    const inserted = await tx.stripeEvent.createMany({
      data: [
        {
          eventId: event.id,
          type: event.type,
          tenantId,
          stripeAccountId: account,
          livemode,
          objectId,
          created,
          status: "received",
          attempts: found ? 0 : 1,
          firstSeenAt: now,
          lastAttemptAt: found ? null : now,
          processedAt: now,
          reconcileFoundAt: found ? now : null,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      // Known id. A delivery counts as an attempt only while the row is still
      // open; a terminal row is left exactly as it is.
      if (!found) {
        await tx.stripeEvent.updateMany({
          where: { eventId: event.id, status: { in: ["received", "failed"] } },
          data: { attempts: { increment: 1 }, lastAttemptAt: now, livemode },
        });
      }
      // Fill what an earlier sighting did not know; never overwrite it.
      if (tenantId) await tx.stripeEvent.updateMany({ where: { eventId: event.id, tenantId: null }, data: { tenantId } });
      if (account) await tx.stripeEvent.updateMany({ where: { eventId: event.id, stripeAccountId: null }, data: { stripeAccountId: account } });
      if (objectId) await tx.stripeEvent.updateMany({ where: { eventId: event.id, objectId: null }, data: { objectId } });
      if (created) await tx.stripeEvent.updateMany({ where: { eventId: event.id, created: 0 }, data: { created } });
    }
    const row = await tx.stripeEvent.findUnique({
      where: { eventId: event.id },
      select: { status: true, attempts: true, tenantId: true },
    });
    if (!row) throw new Error(`stripe event ${event.id} neither inserted nor found`);
    const status = row.status as StripeEventStatus;
    return {
      eventId: event.id,
      status,
      attempts: row.attempts,
      tenantId: row.tenantId,
      alreadyProcessed: TERMINAL_STRIPE_EVENT_STATUSES.has(status),
    };
  });
}

export type ClaimResult =
  | { kind: "claimed"; status: StripeEventStatus }
  | { kind: "done"; status: StripeEventStatus }
  | { kind: "missing" };

/** A lock wait that ran past the transaction's lock_timeout (Postgres 55P03). */
export function isLockTimeout(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (err.code === "55P03" || err.meta?.code === "55P03") return true;
  return /lock timeout|could not obtain lock/i.test(typeof err.message === "string" ? err.message : "");
}

/**
 * Phase 2, first statement of the handler transaction: lock the row.
 *
 * The conditional UPDATE matches only an open (received/failed) row and takes
 * its row lock until this transaction ends. A second delivery's UPDATE waits on
 * that lock and then re-evaluates its WHERE against the committed row: the
 * first committed a terminal status → it matches nothing → `done`; the first
 * rolled back → it matches → `claimed`. So two deliveries never both process.
 */
export async function claimStripeEvent(tx: Tx, eventId: string): Promise<ClaimResult> {
  const claimed = await tx.stripeEvent.updateMany({
    where: { eventId, status: { in: ["received", "failed"] } },
    data: { lastAttemptAt: new Date() },
  });
  const row = await tx.stripeEvent.findUnique({ where: { eventId }, select: { status: true } });
  if (!row) return { kind: "missing" };
  const status = row.status as StripeEventStatus;
  return claimed.count === 1 ? { kind: "claimed", status } : { kind: "done", status };
}

/** Terminal success, inside the handler transaction (same commit as the effects). */
export async function markProcessed(
  tx: Tx,
  eventId: string,
  opts: { tenantId?: string | null; status?: "processed" | "replayed" } = {},
): Promise<void> {
  await tx.stripeEvent.update({
    where: { eventId },
    data: {
      status: opts.status ?? "processed",
      processedAt: new Date(),
      lastError: null,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
  });
}

/** Acknowledged but deliberately not applied (lane PC's foreign / stale rules). */
export async function markIgnored(
  tx: Tx,
  eventId: string,
  kind: IgnoredKind,
  opts: { tenantId?: string | null } = {},
): Promise<void> {
  await tx.stripeEvent.update({
    where: { eventId },
    data: {
      status: kind,
      processedAt: new Date(),
      lastError: null,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
  });
}

/**
 * Record a failed attempt, in its own transaction, AFTER the handler
 * transaction rolled back. Never downgrades a terminal row (a concurrent
 * delivery may have processed it in the meantime).
 */
export async function markFailed(eventId: string, error: unknown): Promise<void> {
  const lastError = sanitiseEventError(error);
  await withRlsBypass((tx) =>
    tx.stripeEvent.updateMany({
      where: { eventId, status: { in: ["received", "failed"] } },
      data: { status: "failed", lastError, lastAttemptAt: new Date() },
    }),
  );
}

// ─── One processing path ────────────────────────────────────────────────────

/** A queued email; dispatched after commit (an email cannot be transactional). */
export type QueuedEmail = Parameters<typeof sendEmail>[0];

/** A queued audit row; written INSIDE the processing transaction (durable). */
export type QueuedAudit = {
  tenantId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
};

export type RunMode = "delivery" | "replay" | "replay_forced";

export type ProcessorContext = {
  tx: Tx;
  mode: RunMode;
  /** The store's view of the club, when event.account resolved to one. */
  tenantId: string | null;
};

export type ProcessorResult = {
  outcome: "processed" | IgnoredKind;
  tenantId?: string | null;
  emails?: QueuedEmail[];
  audits?: QueuedAudit[];
  /** Post-commit work that needs no durability (e.g. refreshing a cached status). */
  after?: Array<() => Promise<unknown>>;
};

/**
 * The function lane PC exposes from the webhook handler. It must do ALL its
 * database work through `ctx.tx`, must not call Stripe inside it (resolve
 * network lookups before `runStripeEvent`, as the route already does), and must
 * RETURN its emails and audit rows rather than dispatching them.
 */
export type StripeEventProcessor<E extends StoreEventInput = StoreEventInput> = (
  event: E,
  ctx: ProcessorContext,
) => Promise<ProcessorResult>;

/** Thrown by a processor for "not attributable yet": recorded as failed, answered 409. */
export class StripeEventRetryableError extends Error {
  readonly retryable = true;
}

class EventBusyError extends Error {}
class EventDoneError extends Error {
  constructor(readonly status: StripeEventStatus) {
    super("already processed");
  }
}

export type RunResult =
  | {
      kind: "processed" | IgnoredKind;
      status: StripeEventStatus;
      tenantId: string | null;
      emailsSent: number;
      auditsWritten: number;
    }
  | { kind: "already_processed"; status: StripeEventStatus }
  | { kind: "in_progress" }
  | { kind: "failed"; retryable: boolean; error: string };

/**
 * Record → claim → process → mark, with failure recorded durably.
 *
 * Modes:
 *  - `delivery`: a webhook delivery. A terminal row answers already_processed.
 *  - `replay`: operator replay of a received/failed row. Success is `replayed`.
 *  - `replay_forced`: operator replay of a TERMINAL row, with a reason. The
 *    processor runs (its own idempotency — unique Payment keys, mapping rules —
 *    must make it a no-op), and its queued emails and audit rows are
 *    SUPPRESSED: the member and the club were already told the first time, and
 *    the operator's own `stripe.event.replayed` audit row is the record.
 *
 * `opts.recorded`: the caller already ran `recordReceived` for THIS delivery
 * (the webhook records before its pre-transaction lookups, so a lookup failure
 * still leaves the row `received` with the attempt counted). Passing it skips
 * runStripeEvent's own recordReceived, so one delivery is one attempt; every
 * other behaviour is identical. Callers that pass nothing are unchanged.
 *
 * Return codes for the webhook: processed / ignored_* / already_processed →
 * 200; in_progress → 409 (Stripe retries); failed → 409 when retryable, else
 * 500. Every failure is on the row (status failed, lastError).
 */
export async function runStripeEvent<E extends StoreEventInput>(
  event: E,
  processor: StripeEventProcessor<E>,
  opts: { mode?: RunMode; recorded?: RecordReceivedResult } = {},
): Promise<RunResult> {
  const mode = opts.mode ?? "delivery";
  const recorded = opts.recorded && opts.recorded.eventId === event.id ? opts.recorded : await recordReceived(event);
  if (recorded.alreadyProcessed && mode !== "replay_forced") {
    return { kind: "already_processed", status: recorded.status };
  }
  const suppressSideEffects = mode === "replay_forced";

  let result: ProcessorResult;
  let finalStatus: StripeEventStatus;
  let auditsWritten = 0;
  try {
    ({ result, finalStatus, auditsWritten } = await withRlsBypass(async (tx) => {
      let claim: ClaimResult;
      try {
        claim = await claimStripeEvent(tx, event.id);
      } catch (e) {
        if (isLockTimeout(e)) throw new EventBusyError("event is being processed by another delivery");
        throw e;
      }
      if (claim.kind === "missing") throw new Error(`stripe event ${event.id} has no store row`);
      if (claim.kind === "done" && mode !== "replay_forced") throw new EventDoneError(claim.status);
      // A forced replay of a settled row still takes the row lock, so two
      // forced replays of one id run one after the other, never together.
      if (claim.kind === "done") await tx.stripeEvent.update({ where: { eventId: event.id }, data: { lastAttemptAt: new Date() } });

      const out = await processor(event, { tx, mode, tenantId: recorded.tenantId });
      const tenantId = out.tenantId ?? recorded.tenantId ?? null;

      let written = 0;
      if (!suppressSideEffects) {
        for (const a of out.audits ?? []) {
          await logAudit({ ...a, tx });
          written++;
        }
      }
      let status: StripeEventStatus;
      if (out.outcome === "processed") {
        status = mode === "delivery" ? "processed" : "replayed";
        await markProcessed(tx, event.id, { tenantId, status });
      } else {
        status = out.outcome;
        await markIgnored(tx, event.id, out.outcome, { tenantId });
      }
      return { result: { ...out, tenantId }, finalStatus: status, auditsWritten: written };
    }));
  } catch (err) {
    if (err instanceof EventDoneError) return { kind: "already_processed", status: err.status };
    if (err instanceof EventBusyError) return { kind: "in_progress" };
    await markFailed(event.id, err).catch((e: unknown) => {
      // The row could not be updated (database down): the delivery still fails
      // non-2xx, so Stripe retries; the row keeps its earlier state.
      console.error("[stripe-event-store] could not record the failure", { eventId: event.id, error: (e as Error)?.message });
    });
    const retryable = err instanceof StripeEventRetryableError || (err as { retryable?: unknown })?.retryable === true;
    if (!retryable) {
      Sentry.captureException(err, { tags: { area: "stripe-event-store", eventType: event.type }, extra: { eventId: event.id, mode } });
    }
    return { kind: "failed", retryable, error: sanitiseEventError(err) };
  }

  let emailsSent = 0;
  if (!suppressSideEffects) {
    for (const email of result.emails ?? []) {
      emailsSent++;
      sendEmail(email).catch((e: unknown) => {
        console.warn("[stripe-event-store] post-commit email failed", { eventId: event.id, error: (e as Error)?.message });
      });
    }
  }
  for (const job of result.after ?? []) {
    await job().catch(() => {});
  }
  return {
    kind: result.outcome,
    status: finalStatus,
    tenantId: result.tenantId ?? null,
    emailsSent,
    auditsWritten,
  };
}
