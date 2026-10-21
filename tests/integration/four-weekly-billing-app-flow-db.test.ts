// Four-week recurring billing through MatFlow's OWN subscription flow
// (review gap 3, 21 Oct 2026), against Stripe's TEST environment and a
// connected test account: ensureTierPrice mints the tier's week × 4 price on
// the club's connected account; createSubscriptionForMember creates the
// subscription as the member checkout does (default_incomplete + a
// confirmation secret); the first invoice is paid by confirming that intent
// with a test card (what Stripe Elements does in the browser); a test clock
// advances 28 days for the renewal; both real invoices are delivered to the
// webhook as locally signed events and the member's records are read back.
//
// What this does NOT demonstrate: the browser card-entry step, and Stripe's
// own webhook delivery to a public endpoint (no tunnel). Skips without a
// database URL, a sk_test_ key, or a connected test account id
// (STRIPE_CONNECT_TEST_ACCOUNT); refuses a live key.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { ensureTierPrice } from "@/lib/stripe/tier-price";
import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const HAS_TEST_KEY = KEY.startsWith("sk_test_");
if (KEY.startsWith("sk_live_")) throw new Error("refusing: STRIPE_SECRET_KEY is a LIVE key");
const ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";
const STAMP = Date.now();
const SECRET = "whsec_four_weekly_app_flow_synthetic_local_only_0123456789";
const DAY = 86_400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_DB || !HAS_TEST_KEY || !ACCOUNT.startsWith("acct_"))("four-weekly billing through MatFlow's subscription flow (Stripe test environment, connected account)", () => {
  let stripe: Stripe;
  let tenantId = "";
  let tierId = "";
  let memberId = "";
  let clockId = "";
  let customerId = "";
  let subscriptionId = "";
  let priceId = "";
  const PRICE_PENCE = 5000;
  const opts = { stripeAccount: ACCOUNT };

  beforeAll(async () => {
    stripe = new Stripe(KEY, { apiVersion: "2026-03-25.dahlia" as never });
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `Four weekly app ${STAMP}`, slug: `four-weekly-app-${STAMP}`, stripeAccountId: ACCOUNT } })).id;
      tierId = (await tx.membershipTier.create({
        data: { tenantId, name: `Adult four-weekly app ${STAMP}`, pricePence: PRICE_PENCE, currency: "GBP", billingCycle: "four_weekly" },
      })).id;
      memberId = (await tx.member.create({
        data: { tenantId, name: "Four Weekly App", email: `four-weekly-app-${STAMP}@test.local`, membershipTierId: tierId, paymentStatus: "pending" },
      })).id;
    });
  }, 60_000);

  afterAll(async () => {
    if (clockId) await stripe.testHelpers.testClocks.del(clockId, opts).catch(() => {});
    if (priceId) await stripe.prices.update(priceId, { active: false }, opts).catch(() => {});
    if (tenantId) {
      await withRlsBypass(async (tx) => {
        await tx.payment.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_fwa_${STAMP}_` } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
        await tx.tenant.deleteMany({ where: { id: tenantId } });
      });
    }
  }, 60_000);

  it("ensureTierPrice mints the tier's week × 4 price on the connected account", async () => {
    const tier = await withRlsBypass((tx) => tx.membershipTier.findUniqueOrThrow({ where: { id: tierId } }));
    priceId = await ensureTierPrice(stripe, { id: tenantId, stripeAccountId: ACCOUNT }, tier);
    const price = await stripe.prices.retrieve(priceId, {}, opts);
    expect(price.recurring).toMatchObject({ interval: "week", interval_count: 4 });
    expect(price.unit_amount).toBe(PRICE_PENCE);
    const saved = await withRlsBypass((tx) => tx.membershipTier.findUniqueOrThrow({ where: { id: tierId }, select: { stripePriceId: true, stripeProductId: true } }));
    expect(saved.stripePriceId).toBe(priceId);
    expect(saved.stripeProductId).toBeTruthy();
  }, 120_000);

  it("createSubscriptionForMember creates the subscription as the member checkout does; confirming its intent with a test card pays the first invoice", async () => {
    // The customer is created on a test clock first (so the renewal can be
    // brought forward); the function reuses a member's existing customer id.
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `matflow app flow ${STAMP}` }, opts);
    clockId = clock.id;
    const customer = await stripe.customers.create({ email: `four-weekly-app-${STAMP}@test.local`, name: "Four Weekly App", test_clock: clockId }, opts);
    customerId = customer.id;
    await withRlsBypass((tx) => tx.member.update({ where: { id: memberId }, data: { stripeCustomerId: customerId } }));

    const outcome = await createSubscriptionForMember({
      tenant: { id: tenantId, stripeAccountId: ACCOUNT, acceptsBacs: false } as never,
      member: { id: memberId, email: `four-weekly-app-${STAMP}@test.local`, name: "Four Weekly App", stripeCustomerId: customerId } as never,
      priceId,
      paymentMethodType: "card",
      requestId: `req_${STAMP}`,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    subscriptionId = outcome.subscriptionId;
    expect(outcome.customerId).toBe(customerId);
    expect(outcome.clientSecret).toMatch(/_secret_/);

    // What the browser does with the confirmation secret: confirm the first invoice's payment with a card.
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice.confirmation_secret", "latest_invoice.payments"] }, opts);
    const invoice = sub.latest_invoice as Stripe.Invoice;
    const paymentIntentId = (invoice.payments?.data?.[0]?.payment as { payment_intent?: string } | undefined)?.payment_intent;
    expect(typeof paymentIntentId).toBe("string");
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customerId }, opts);
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } }, opts);
    const confirmed = await stripe.paymentIntents.confirm(paymentIntentId as string, { payment_method: pm.id }, opts);
    expect(confirmed.status).toBe("succeeded");
    for (let i = 0; i < 20; i += 1) {
      const s = await stripe.subscriptions.retrieve(subscriptionId, {}, opts);
      if (s.status === "active") break;
      await sleep(1500);
    }
    expect((await stripe.subscriptions.retrieve(subscriptionId, {}, opts)).status).toBe("active");
    const saved = await withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { stripeSubscriptionId: true } }));
    expect(saved.stripeSubscriptionId).toBe(subscriptionId);
  }, 180_000);

  it("the test clock brings the renewal forward 28 days: a second paid invoice whose period starts where the first ended", async () => {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId, {}, opts);
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: clock.frozen_time + 28 * DAY + 3600 }, opts);
    for (let i = 0; i < 90; i += 1) {
      const c = await stripe.testHelpers.testClocks.retrieve(clockId, {}, opts);
      if (c.status === "ready") break;
      await sleep(2000);
    }
    let invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 }, opts);
    for (let i = 0; i < 30 && invoices.data.filter((inv) => inv.status === "paid").length < 2; i += 1) {
      await sleep(2000);
      invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 }, opts);
    }
    const paid = invoices.data.filter((inv) => inv.status === "paid");
    expect(paid).toHaveLength(2);
    const [second, first] = paid;
    expect(second.lines.data[0].period.start).toBe(first.lines.data[0].period.end);
    expect(second.lines.data[0].period.end - second.lines.data[0].period.start).toBe(28 * DAY);
  }, 300_000);

  it("both real invoices delivered to the webhook (locally signed) record the charges and the member's billing period", async () => {
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 }, opts);
    const paid = invoices.data.filter((inv) => inv.status === "paid");
    for (const invoice of [...paid].reverse()) {
      const payload = JSON.stringify({
        id: `evt_fwa_${STAMP}_${invoice.id}`, object: "event", type: "invoice.payment_succeeded", account: ACCOUNT, livemode: false,
        created: Math.floor(Date.now() / 1000), data: { object: invoice },
      });
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
      const res = (await stripeWebhook(
        new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload }) as never,
      )) as unknown as { status: number };
      expect(res.status).toBe(200);
    }
    const after = await withRlsBypass(async (tx) => ({
      member: await tx.member.findUnique({ where: { id: memberId }, select: { paymentStatus: true, billingPeriodStart: true, billingPeriodEnd: true } }),
      payments: await tx.payment.findMany({ where: { memberId }, select: { stripeInvoiceId: true, stripePaymentIntentId: true, amountPence: true, status: true } }),
    }));
    expect(after.member?.paymentStatus).toBe("paid");
    expect(after.payments).toHaveLength(2);
    expect(after.payments.every((p) => p.status === "succeeded" && p.amountPence === PRICE_PENCE)).toBe(true);
    // On a real connected account the webhook resolves the real payment intent ids.
    expect(after.payments.every((p) => typeof p.stripePaymentIntentId === "string" && p.stripePaymentIntentId.startsWith("pi_"))).toBe(true);
    const renewal = paid[0].lines.data[0].period;
    expect(after.member?.billingPeriodStart?.getTime()).toBe(renewal.start * 1000);
    expect(after.member?.billingPeriodEnd?.getTime()).toBe(renewal.end * 1000);
  }, 120_000);
});
