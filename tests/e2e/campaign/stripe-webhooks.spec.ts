import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";
import {
  RUN_STAMP,
  createMember,
  createOrder,
  createPayment,
  getMember,
  getOrder,
  getPayment,
  getTenantStripe,
  saveStripeConnection,
  seededTenantId,
  stripeEventClaimed,
  auditEntriesFor,
  cleanupRun,
  sql,
} from "./helpers/db";

/**
 * L3 — Stripe webhooks, driven with real signatures against the real route.
 *
 * ## Why this lane matters more than any other money lane
 *
 * **The card path in MatFlow has never worked. Not once, anywhere.** Production
 * holds a Stripe key with an EMPTY `STRIPE_WEBHOOK_SECRET`, and
 * `app/api/stripe/webhook/route.ts:31` answers a missing secret with a flat 400.
 * Every delivery Stripe has ever attempted was rejected at the door. No payment,
 * subscription, refund or dispute has ever been recorded by this product.
 *
 * So the handlers below have been written, reviewed, unit-tested and deployed
 * without a single real event ever reaching them. The unit suite
 * (`tests/unit/stripe-webhook-handlers.test.ts`) mocks Prisma and mocks
 * `constructEvent` — which means the two things most likely to be wrong on the
 * day the secret is finally set are precisely the two things it cannot see:
 * whether signature verification accepts a genuine signature, and whether the
 * handler's writes actually land in Postgres.
 *
 * This file closes both. It signs payloads with Stripe's documented scheme (see
 * `signPayload`), POSTs them at the running server, and asserts the consequence
 * in the database.
 *
 * ## What it proves, and what it cannot
 *
 * Proven here: signatures are verified for real (a forged one is refused and
 * changes nothing); a handled event moves the rows it claims to; a replay is
 * idempotent; an unattributable event is REFUSED rather than acked away; and an
 * unhandled type is acked without being claimed.
 *
 * NOT proven here, and deliberately said out loud: that the secret configured in
 * Vercel is the one Stripe is signing with. Both sides of this test share a
 * locally chosen secret, which is all a signing secret ever is — an HMAC key.
 * Only a real delivery from Stripe's dashboard settles that, and it stays on
 * `docs/runbooks/GO-LIVE-2026-09.md`.
 */

const WEBHOOK_PATH = "/api/stripe/webhook";

function secret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is not set. The lane that exists because an empty secret silently rejected every event cannot itself run without one — see .env.test.",
    );
  }
  return s;
}

/**
 * Sign a payload exactly the way Stripe does: `t={unix},v1={hex hmac-sha256}`
 * over the bytes `"{unix}.{payload}"`.
 *
 * Written out rather than calling `Stripe.webhooks.generateTestHeaderString`,
 * for two reasons. The library's own typings declare every option required
 * (`timestamp`, `scheme`, `signature`, `cryptoProvider`) when the runtime
 * defaults them, so the helper does not typecheck without a cast — and casting
 * past a wrong type to reach a correct function is the kind of thing that later
 * hides a real one. More usefully: signing here and verifying with Stripe's
 * real `constructEvent` in the route means the two halves are independent. If
 * the route's verification and this signing shared an implementation, they
 * could agree on a format Stripe does not use and every test would still pass.
 */
function signPayload(payload: string, signingSecret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", signingSecret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Unique per run AND per call, so a replay is something a test chooses, never an accident. */
function eventId(): string {
  return `evt_${RUN_STAMP}_${Math.random().toString(36).slice(2, 10)}`;
}

interface EventInit {
  type: string;
  object: Record<string, unknown>;
  account?: string | null;
  id?: string;
}

function buildEvent({ type, object, account, id }: EventInit) {
  return {
    id: id ?? eventId(),
    object: "event",
    api_version: "2026-03-25.dahlia",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    // Absent entirely when null — a platform event genuinely has no `account`,
    // and sending `account: null` would test a shape Stripe never emits.
    ...(account === null ? {} : { account }),
    data: { object },
  };
}

/**
 * POST a genuinely-signed event.
 *
 * The body is sent as a raw string, not as `data: object`. The route reads
 * `await req.text()` and hands those exact bytes to `constructEvent`, so any
 * re-serialisation between signing and sending changes the payload and the
 * signature legitimately fails — which would look like a broken product rather
 * than a broken test.
 */
async function postSigned(
  request: APIRequestContext,
  event: Record<string, unknown>,
  opts: { signature?: string; omitSignature?: boolean } = {},
) {
  const payload = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.omitSignature) {
    headers["stripe-signature"] = opts.signature ?? signPayload(payload, secret());
  }
  const res = await request.post(WEBHOOK_PATH, { headers, data: payload });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body };
}

/** The connected account the seeded club is mapped to. Events must carry it. */
async function connectedAccountId(): Promise<string> {
  const { stripeAccountId } = await getTenantStripe();
  if (!stripeAccountId) {
    throw new Error(
      'The seeded club has no stripeAccountId, so no event can be attributed to it. Run scripts/stripe-test-connect.mjs, or set one directly on the test branch.',
    );
  }
  return stripeAccountId;
}

test.afterAll(async () => {
  await cleanupRun();
});

// ── The gate itself ──────────────────────────────────────────────────────────

test.describe("signature verification", () => {
  test("a forged signature is refused, and nothing moves", async ({ request }) => {
    // The single most important assertion in this file. If this ever passes a
    // forged signature, anyone on the internet can post a
    // `payment_intent.succeeded` and mark themselves paid at every club on the
    // platform. Every other test here assumes this one holds.
    const account = await connectedAccountId();
    const id = eventId();
    const event = buildEvent({
      id,
      type: "account.application.deauthorized",
      account,
      object: { id: account, object: "application" },
    });

    const before = await getTenantStripe();
    const { status } = await postSigned(request, event, {
      signature: "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    expect(status, "a forged signature must be rejected").toBe(400);
    expect(await stripeEventClaimed(id), "a rejected event must not be claimed").toBe(false);
    const after = await getTenantStripe();
    expect(
      after.stripeConnected,
      "a rejected event must not have disconnected the club",
    ).toBe(before.stripeConnected);
  });

  test("a missing signature header is refused", async ({ request }) => {
    // This is the production failure verbatim: no signature (or no secret) means
    // a flat 400 before anything is read.
    const account = await connectedAccountId();
    const { status } = await postSigned(
      request,
      buildEvent({ type: "payment_intent.succeeded", account, object: { id: "pi_x" } }),
      { omitSignature: true },
    );
    expect(status).toBe(400);
  });

  test("a genuine signature over a TAMPERED body is refused", async ({ request }) => {
    // Signing one payload and sending another is the realistic attack, and the
    // one a naive "does the header look right" check would wave through.
    const account = await connectedAccountId();
    const honest = buildEvent({ type: "payment_intent.succeeded", account, object: { id: "pi_honest" } });
    const signature = signPayload(JSON.stringify(honest), secret());
    const tampered = { ...honest, data: { object: { id: "pi_tampered", amount: 999999 } } };

    const res = await request.post(WEBHOOK_PATH, {
      headers: { "content-type": "application/json", "stripe-signature": signature },
      data: JSON.stringify(tampered),
    });
    expect(res.status()).toBe(400);
  });
});

// ── Attribution: the difference between retrying and losing money ────────────

test.describe("attribution", () => {
  test("an event for an unknown connected account gets 409, not 200", async ({ request }) => {
    // 409 asks Stripe to redeliver. A 200 here would be the expensive bug: money
    // taken at Stripe, the event acked, the retry never scheduled, and nothing
    // in MatFlow ever recording it. "Ack and drop" is indistinguishable from
    // success in every dashboard.
    const id = eventId();
    const { status } = await postSigned(
      request,
      buildEvent({
        id,
        type: "payment_intent.succeeded",
        account: "acct_notaclubweknow",
        object: { id: "pi_orphan", amount: 5000 },
      }),
    );

    expect(status, "an unattributable event must be retried, never acked").toBe(409);
    expect(
      await stripeEventClaimed(id),
      "a retryable event must leave no claim, or the redelivery would be skipped as a duplicate",
    ).toBe(false);
  });

  test("a platform event with no connected account gets 409 too", async ({ request }) => {
    const id = eventId();
    const { status } = await postSigned(
      request,
      buildEvent({ id, type: "payment_intent.succeeded", account: null, object: { id: "pi_noacct" } }),
    );
    expect(status).toBe(409);
    expect(await stripeEventClaimed(id)).toBe(false);
  });
});

// ── The claim ledger ─────────────────────────────────────────────────────────

test.describe("idempotency and the claim", () => {
  test("an unhandled type is acked but NOT claimed", async ({ request }) => {
    // Claiming an unhandled type is a trap the route documents: a future deploy
    // that adds the handler would find the id already claimed and skip the event
    // for ever, because Stripe stopped retrying after our 200.
    const account = await connectedAccountId();
    const id = eventId();
    const { status, body } = await postSigned(
      request,
      buildEvent({ id, type: "invoice.created", account, object: { id: "in_ignored" } }),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ received: true, ignored: true });
    expect(
      await stripeEventClaimed(id),
      "an ignored type must stay unclaimed so a future handler can still receive it",
    ).toBe(false);
  });

  test("a redelivered event is processed exactly once", async ({ request }) => {
    const account = await connectedAccountId();
    const member = await createMember();
    const pi = `pi_${RUN_STAMP}_dup`;
    const payment = await createPayment({
      memberId: member.id,
      status: "pending",
      amountPence: 1500,
      stripePaymentIntentId: pi,
    });

    const event = buildEvent({
      type: "payment_intent.payment_failed",
      account,
      object: { id: pi, last_payment_error: { message: "Your card was declined." } },
    });

    const first = await postSigned(request, event);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true });
    expect((await getPayment(payment.id))?.status).toBe("failed");

    // Byte-for-byte the same event, as a Stripe retry would be.
    const second = await postSigned(request, event);
    expect(second.status).toBe(200);
    expect(
      second.body,
      "the second delivery must be recognised as a duplicate, not reprocessed",
    ).toMatchObject({ alreadyProcessed: true });

    const audits = await auditEntriesFor("stripe.payment_intent.failed", payment.id);
    expect(audits.length, "a redelivery must not double-write the audit trail").toBe(1);
  });
});

// ── The three journeys the plan names ────────────────────────────────────────

test.describe("payment_intent.payment_failed", () => {
  test("resolves a stuck pending charge without branding the member overdue", async ({ request }) => {
    // Two assertions that pull in opposite directions, which is the whole point.
    // The Payment must leave `pending` — it is the only event that can resolve a
    // failed ad-hoc charge, and without it the ledger shows money that might
    // still arrive, for ever. The MEMBER must NOT be marked overdue: a declined
    // £10 seminar fee says nothing about their membership standing, and putting
    // them on the club's chase list is a debt they do not owe.
    const account = await connectedAccountId();
    const member = await createMember({ paymentStatus: "paid" });
    const pi = `pi_${RUN_STAMP}_adhoc`;
    const payment = await createPayment({
      memberId: member.id,
      status: "pending",
      amountPence: 1000,
      stripePaymentIntentId: pi,
    });

    const { status } = await postSigned(
      request,
      buildEvent({
        type: "payment_intent.payment_failed",
        account,
        object: { id: pi, last_payment_error: { message: "insufficient_funds" } },
      }),
    );
    expect(status).toBe(200);

    expect(
      (await getPayment(payment.id))?.status,
      "a failed charge must not stay pending — nothing else ever resolves it",
    ).toBe("failed");

    expect(
      (await getMember(member.id))?.paymentStatus,
      "a one-off charge failing must not put the member on the club's chase list",
    ).toBe("paid");
  });

  test("a payment already succeeded is not dragged back to failed", async ({ request }) => {
    // A late or out-of-order delivery must not overwrite a settled outcome.
    const account = await connectedAccountId();
    const member = await createMember();
    const pi = `pi_${RUN_STAMP}_settled`;
    const payment = await createPayment({
      memberId: member.id,
      status: "succeeded",
      amountPence: 2000,
      stripePaymentIntentId: pi,
    });

    await postSigned(
      request,
      buildEvent({ type: "payment_intent.payment_failed", account, object: { id: pi } }),
    );

    expect((await getPayment(payment.id))?.status).toBe("succeeded");
  });
});

test.describe("checkout.session.expired", () => {
  test("cancels the abandoned order, which is what makes mark-paid refuse it", async ({ request }) => {
    // An abandoned cart used to sit `pending` for ever, and `mark-paid` would
    // accept it — so staff could take cash against an order the member started,
    // walked away from and never meant to complete. mark-paid already refuses
    // `cancelled`; flipping the row here is what makes that refusal reachable.
    const account = await connectedAccountId();
    const tenantId = await seededTenantId();
    const member = await createMember();
    const order = await createOrder({ memberId: member.id, status: "pending", paymentMethod: "stripe" });

    const { status } = await postSigned(
      request,
      buildEvent({
        type: "checkout.session.expired",
        account,
        object: {
          id: `cs_${RUN_STAMP}_expired`,
          object: "checkout.session",
          status: "expired",
          metadata: { matflowKind: "shop_order", tenantId, orderRef: order.orderRef },
        },
      }),
    );
    expect(status).toBe(200);

    expect(
      (await getOrder(order.id))?.status,
      "an expired checkout must cancel its order, or staff can still be told to take cash for it",
    ).toBe("cancelled");
  });

  test("leaves another club's order alone even with a matching reference", async ({ request }) => {
    // The metadata is attacker-adjacent: it arrives on the event rather than
    // being looked up. A handler that trusted `orderRef` alone would let one
    // club's expiry cancel another club's order.
    const account = await connectedAccountId();
    const order = await createOrder({ status: "pending", paymentMethod: "stripe" });

    await postSigned(
      request,
      buildEvent({
        type: "checkout.session.expired",
        account,
        object: {
          id: `cs_${RUN_STAMP}_wrongtenant`,
          object: "checkout.session",
          metadata: {
            matflowKind: "shop_order",
            tenantId: "some-other-tenant-id",
            orderRef: order.orderRef,
          },
        },
      }),
    );

    expect(
      (await getOrder(order.id))?.status,
      "an expiry naming a different tenant must not touch this club's order",
    ).toBe("pending");
  });
});

test.describe("account.application.deauthorized", () => {
  test("marks the club disconnected and stamps the status disabled", async ({ request }) => {
    // The gym revoked MatFlow from their own Stripe dashboard. Nothing else ever
    // tells us — `account.updated` stops arriving too — so without this the
    // product goes on claiming it is connected while every checkout dies at the
    // last step with a raw Stripe error.
    const restore = await saveStripeConnection();
    try {
      const account = await connectedAccountId();
      await sql('UPDATE "Tenant" SET "stripeConnected" = true WHERE id = $1', [await seededTenantId()]);

      const { status } = await postSigned(
        request,
        buildEvent({
          type: "account.application.deauthorized",
          account,
          object: { id: "ca_matflow", object: "application", name: "MatFlow" },
        }),
      );
      expect(status).toBe(200);

      const after = await getTenantStripe();
      expect(after.stripeConnected, "the club must no longer read as connected").toBe(false);

      // Keeping the account id is deliberate and load-bearing: it is the only
      // thing that maps a later in-flight event back to this tenant.
      expect(
        after.stripeAccountId,
        "the account id must be KEPT, or any in-flight webhook becomes permanently unattributable",
      ).toBe(account);

      // And the cached status must say "disabled", not "unknown". Clearing it
      // would look like "never checked", and the stale-cache refresh then calls
      // an account we no longer have access to — which fails OPEN with
      // chargesEnabled: true, reopening every checkout gate on a gym that has
      // just cut us off.
      expect(after.stripeAccountStatus?.chargesEnabled).toBe(false);
      expect(after.stripeAccountStatus?.disabledReason).toBe("deauthorized");
    } finally {
      await restore();
    }
  });
});
