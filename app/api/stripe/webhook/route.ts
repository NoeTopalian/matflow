import { NextRequest, NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env-url";
import { HANDLED_STRIPE_EVENT_TYPES } from "@/lib/stripe/handled-events";
import { classifyStripeKey } from "@/lib/stripe/key-mode";
import { runStripeEvent } from "@/lib/stripe/event-store";
import { livemodeMatchesKey } from "@/lib/stripe/webhook/mapping";
import { prepareStripeEvent, type WebhookEvent } from "@/lib/stripe/webhook/process";

export const runtime = "nodejs";
// Explicit rather than inherited: P0-1 added up to two Stripe round-trips to
// this handler on invoice events. Stripe gives a webhook 20s to ack before it
// treats the delivery as failed and retries, so the ceiling must be well
// inside that. Eight other routes in this repo set theirs; this one did not.
export const maxDuration = 15;

// The Stripe Connect webhook. This file verifies the delivery and answers
// Stripe; WHAT an event does is in lib/stripe/webhook/process.ts
// (prepareStripeEvent), shared with the operator replay (lib/stripe/replay.ts),
// and the durable record of every event is lane PD's store
// (lib/stripe/event-store.ts).
//
// "Not attributable yet" (no connected account, or the account isn't linked to
// a tenant) is thrown by the processor as StripeEventRetryableError: the
// processing transaction rolls back, the event's store row is recorded failed
// with the reason, and the answer is a 409 so Stripe RETRIES rather than us
// acking-and-dropping (which would take money but never deliver the goods).

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: WebhookEvent;
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret) as unknown as WebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Only claim the eventId for event types we actually handle. Claiming for
  // unknown types is a footgun: if a future deploy adds a handler for that type,
  // it would be permanently skipped because we already recorded the claim and
  // Stripe stops retrying after our 200 ack.
  const HANDLED_EVENT_TYPES = HANDLED_STRIPE_EVENT_TYPES;
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    // Ack but don't claim — preserves the option to handle this type later.
    return NextResponse.json({ received: true, ignored: true, type: event.type });
  }

  // F8 (audit §12): a production Connect endpoint receives BOTH live and test
  // events, and Stripe recommends checking `livemode`. A test-mode event must
  // never move a live club's members (and the reverse).
  //
  // A key whose mode cannot be read is a deployment fault, not a foreign
  // event: refuse with 500, record nothing, and let Stripe retry until the key
  // is fixed — the events are real and must not be written off.
  const keyMode = classifyStripeKey(process.env.STRIPE_SECRET_KEY).mode;
  if (keyMode === "unknown") {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY mode cannot be determined — refusing until it is fixed", {
      eventId: event.id,
      type: event.type,
    });
    return NextResponse.json({ error: "Stripe key mode cannot be determined" }, { status: 500 });
  }
  // An event of the OTHER mode is acknowledged (200) and recorded in the store
  // as "ignored_mode", with nothing else read or written: refusing it (it was
  // a 400 until 11 Oct 2026) made Stripe retry it for three days and risked
  // the live endpoint being disabled for persistent failures. The processor
  // below is not prepared for it: no Stripe call, no member or payment read.
  if (!livemodeMatchesKey(event.livemode, keyMode)) {
    const recorded = await runStripeEvent(event, async () => ({ outcome: "ignored_mode" as const }));
    console.warn("[stripe-webhook] event mode does not match the key mode — acknowledged and recorded, not applied", {
      eventId: event.id,
      type: event.type,
      livemode: typeof event.livemode === "boolean" ? event.livemode : null,
      keyMode,
      result: recorded.kind,
    });
    if (recorded.kind === "failed") {
      // The store could not write the row (database fault): non-2xx so Stripe
      // retries, as for any other failed delivery.
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
    if (recorded.kind === "in_progress") {
      return NextResponse.json({ error: "Event is being processed" }, { status: 409 });
    }
    return NextResponse.json({ received: true, outcome: "ignored_mode" });
  }

  const processor = await prepareStripeEvent(event, { baseUrl: getBaseUrl(req) });

  // Durable processing (lane PD's store, wired by lane PC, 11 Oct 2026).
  // runStripeEvent records the event in its OWN transaction first (so a failed
  // handler still leaves a row: status failed, lastError), then opens the
  // processing transaction and claims the row with a conditional update (a
  // second concurrent delivery waits on the row lock or finds it terminal —
  // never processes twice), runs the processor, writes its audit rows and the
  // terminal status (processed / ignored_*) in the SAME commit as its effects,
  // and only then sends emails and runs the post-commit jobs. A duplicate is
  // recognised by the row's status, never by a unique violation.
  const run = await runStripeEvent(event, processor);

  switch (run.kind) {
    case "processed":
    case "ignored_foreign":
    case "ignored_stale":
    case "ignored_mode":
      // Lane PC: an acknowledged event that changed nothing is said out loud,
      // and recorded on its StripeEvent row with the same status.
      if (run.kind !== "processed") {
        const objectId = (event.data.object as { id?: unknown }).id;
        console.info("[stripe-webhook] event acknowledged without effect", {
          eventId: event.id,
          type: event.type,
          outcome: run.kind,
          objectId: typeof objectId === "string" ? objectId : null,
        });
      }
      return NextResponse.json({ received: true, outcome: run.kind, status: run.status });
    case "already_processed":
      return NextResponse.json({ received: true, alreadyProcessed: true });
    case "in_progress":
      // Another delivery of this id holds the row: Stripe's retry will find it
      // terminal (that delivery committed) or claimable (it rolled back).
      return NextResponse.json({ error: "Event is being processed" }, { status: 409 });
    case "failed":
      if (run.retryable) {
        // Tier 2.4: not attributable yet — recorded failed; 409 so Stripe retries.
        console.warn("[stripe-webhook] retryable — asking Stripe to redeliver", {
          eventId: event.id,
          type: event.type,
          reason: run.error,
        });
        return NextResponse.json({ error: run.error }, { status: 409 });
      }
      // Real processing failure: rolled back, recorded failed on the row, sent
      // to Sentry by the store (Tier 1.3), and Stripe retries on the 500.
      console.error("[stripe-webhook] processing failed", {
        eventId: event.id,
        type: event.type,
        error: run.error,
      });
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
