// POST /api/admin/stripe/events/[id]/replay — operator replay of one Stripe
// event (payments lane PD, 11 Oct 2026). Body: { reason, force? }.
//
// Gate, in order: same-origin; operator authority (MFA session + allowlist,
// lib/admin-auth.ts); a support session is refused; rate limit; a harmless
// preflight (the event exists, belongs to a connected club, is replayable or
// `force` is set); then a fresh step-up grant bound to
// THIS event, its current status and the force flag ("stripe.event_replay",
// lib/operator-step-up.ts).
//
// ORDER (as the soft-delete route): 1. one transaction spends the grant and
// writes the durable "requested" audit row; 2. lib/stripe/replay.ts fetches the
// event fresh from Stripe as the connected account and runs it through the
// webhook's own processing path (lib/stripe/event-store.ts runStripeEvent),
// then writes the outcome row `stripe.event.replayed` with the grant's request
// id. A replay of the same grant echoes the recorded outcome and never runs
// twice. Nothing here edits a member or a payment directly.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { refuseSupportSession } from "@/lib/support-session";
import { classifyStripeKey } from "@/lib/stripe/key-mode";
import { REPLAYABLE_STRIPE_EVENT_STATUSES, type StripeEventStatus } from "@/lib/stripe/event-store";
import {
  REPLAY_AUDIT_ACTION,
  REPLAY_REASON_MAX,
  REPLAY_REASON_MIN,
  loadWebhookPrepare,
  replayStripeEvent,
  type ReplayRefusal,
  type StripeEventsClient,
} from "@/lib/stripe/replay";
import {
  STEP_UP_HEADER,
  StepUpRefusedError,
  consumeStepUpGrant,
  findAppliedGrant,
  refuseStepUp,
  requireStepUp,
  stepUpTarget,
} from "@/lib/operator-step-up";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z
  .object({
    reason: z.string().trim().min(REPLAY_REASON_MIN).max(REPLAY_REASON_MAX),
    force: z.boolean().optional(),
  })
  .strict();

const ALREADY_PROCESSED = "This event was already processed. Nothing to replay.";
const RL_MAX = 30;
const RL_WINDOW_MS = 60 * 60 * 1000;


const REFUSAL_STATUS: Record<ReplayRefusal, number> = {
  not_found: 404,
  already_processed: 409,
  reason_required: 400,
  no_account: 409,
  no_club: 409,
  club_disconnected: 409,
  mismatch: 409,
  livemode_mismatch: 409,
  stripe_unavailable: 502,
  // Unreachable from this route (it always passes the webhook processor).
  not_wired: 500,
};

async function stripeClient(): Promise<StripeEventsClient> {
  const Stripe = (await import("stripe")).default;
  return new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" }) as unknown as StripeEventsClient;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const support = refuseSupportSession(await auth().catch(() => null));
  if (support) return support;

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:stripe-replay:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many replays. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id: eventId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Give a reason (${REPLAY_REASON_MIN}–${REPLAY_REASON_MAX} characters).` }, { status: 400 });
  }
  const force = parsed.data.force === true;
  const reason = parsed.data.reason;

  // Harmless preflight: nothing is spent or written on a refusal here.
  const row = await withRlsBypass((tx) =>
    tx.stripeEvent.findUnique({ where: { eventId }, select: { eventId: true, status: true, tenantId: true, stripeAccountId: true } }),
  );
  if (!row) return NextResponse.json({ error: "No such event is on record." }, { status: 404 });
  const club = row.stripeAccountId
    ? await withRlsBypass((tx) =>
        tx.tenant.findFirst({ where: { stripeAccountId: row.stripeAccountId }, select: { id: true, stripeConnected: true } }),
      )
    : null;
  const tenantId = row.tenantId ?? club?.id ?? null;
  if (!club || !tenantId || club.id !== tenantId) {
    return NextResponse.json({ error: "This event's account is not linked to a club, so it cannot be replayed." }, { status: 409 });
  }
  if (!club.stripeConnected) {
    return NextResponse.json({ error: "This club's Stripe access was withdrawn. The event cannot be fetched or replayed." }, { status: 409 });
  }
  // A settled event needs no code to be told so. With a grant attached, a
  // retry of an applied grant echoes its recorded outcome (below); anything
  // else is refused without spending the grant.
  const settled = !REPLAYABLE_STRIPE_EVENT_STATUSES.has(row.status as StripeEventStatus) && !force;
  if (settled && !req.headers.get(STEP_UP_HEADER)) {
    return NextResponse.json({ error: ALREADY_PROCESSED }, { status: 409 });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
  }

  const stepUp = await requireStepUp(req, ctx, "stripe.event_replay", stepUpTarget(tenantId, eventId), { change: { force } });
  if (stepUp instanceof Response) return stepUp;
  if (settled) {
    const applied = await withRlsBypass((tx) =>
      findAppliedGrant(tx, { tenantId, actions: [REPLAY_AUDIT_ACTION], requestId: stepUp.requestId }),
    );
    if (applied) return NextResponse.json({ ok: true, alreadyApplied: true, outcome: applied });
    return NextResponse.json({ error: ALREADY_PROCESSED }, { status: 409 });
  }

  let echoed: Record<string, unknown> | null = null;
  try {
    echoed = await withRlsBypass(async (tx) => {
      const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: [REPLAY_AUDIT_ACTION] });
      if (spend.kind === "replay") return spend.outcome;
      await logAudit({
        tx,
        outcome: "requested",
        tenantId,
        userId: null,
        action: "stripe.event.replay.requested",
        entityType: "StripeEvent",
        entityId: eventId,
        metadata: { eventId, previousStatus: row.status, forced: force, reason },
        actAsUserId: ctx.operatorId,
        operatorId: stepUp.operatorId,
        requestId: stepUp.requestId,
        req,
      });
      return null;
    });
  } catch (err) {
    if (err instanceof StepUpRefusedError) return refuseStepUp(err, req);
    console.error("[admin/stripe/replay] audit write failed; refusing to replay", err);
    return NextResponse.json(
      { error: "The replay could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }
  if (echoed) return NextResponse.json({ ok: true, alreadyApplied: true, outcome: echoed });

  const outcome = await replayStripeEvent(
    { eventId, operatorId: stepUp.operatorId, reason, force, requestId: stepUp.requestId, req },
    { stripe: await stripeClient(), prepare: await loadWebhookPrepare(), keyMode: classifyStripeKey(process.env.STRIPE_SECRET_KEY).mode },
  );
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.message, refusal: outcome.refusal }, { status: REFUSAL_STATUS[outcome.refusal] });
  }
  const r = outcome.result;
  const failed = r.kind === "failed" || r.kind === "missing" || r.kind === "in_progress";
  return NextResponse.json(
    {
      ok: !failed,
      result: r.kind,
      status: "status" in r ? r.status : null,
      forced: outcome.forced,
      // Compare-only (forced): what the handler would do today; every write rolled back.
      ...(r.kind === "compared" ? { wouldBe: r.wouldBe, writesRolledBack: r.writes } : {}),
      ...(r.kind === "failed" ? { error: r.error } : r.kind === "in_progress" ? { error: "The event is being processed. Try again shortly." } : r.kind === "missing" ? { error: "No such event is on record." } : {}),
    },
    { status: r.kind === "in_progress" ? 409 : failed ? 502 : 200 },
  );
}
