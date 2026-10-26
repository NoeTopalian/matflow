// Four-week recurring billing, demonstrated against Stripe's TEST environment
// (review gap 1, 21 Oct 2026). A MatFlow tier with billingCycle "four_weekly"
// becomes a Stripe price of `week` × 4 (lib/billing-cycle.ts stripeRecurring);
// a subscription on it is charged at creation and again 28 days later. Stripe
// test clocks make the renewal happen now instead of in four weeks. The two
// real invoices Stripe produced are then delivered to MatFlow's webhook as
// signed invoice.payment_succeeded events, and the member's payment records
// on the TEST database branch are read back.
//
// Skips without a database URL or without a Stripe TEST key (sk_test_…). Never
// a live key: refused outright. Creates and deletes its own Stripe objects
// (deleting the test clock removes the customer and subscription with it).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { stripeRecurring } from "@/lib/billing-cycle";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const HAS_TEST_KEY = KEY.startsWith("sk_test_");
if (KEY.startsWith("sk_live_")) throw new Error("refusing: STRIPE_SECRET_KEY is a LIVE key");
const STAMP = Date.now();
const SECRET = "whsec_four_weekly_synthetic_local_only_0123456789";
const DAY = 86_400;

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!HAS_DB || !HAS_TEST_KEY)("four-weekly recurring billing — Stripe test environment + MatFlow webhook", () => {
  // Constructed lazily: the describe body runs even when skipped, and an empty key throws.
  let stripe: Stripe;
  let tenantId = "";
  let memberId = "";
  let clockId = "";
  let customerId = "";
  let priceId = "";
  let subscriptionId = "";
  let productId = "";
  const account = `acct_fw_${STAMP}`;
  const PRICE_PENCE = 5000;

  beforeAll(async () => {
    stripe = new Stripe(KEY, { apiVersion: "2026-03-25.dahlia" as never });
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({
        data: { name: `Four weekly ${STAMP}`, slug: `four-weekly-${STAMP}`, stripeAccountId: account },
      })).id;
      const tierId = (await tx.membershipTier.create({
        data: { tenantId, name: "Adult four-weekly", pricePence: PRICE_PENCE, currency: "GBP", billingCycle: "four_weekly" },
      })).id;
      memberId = (await tx.member.create({
        data: { tenantId, name: "Four Weekly", email: `four-weekly-${STAMP}@test.local`, membershipTierId: tierId, paymentStatus: "pending" },
      })).id;
    });
  }, 60_000);

  afterAll(async () => {
    if (clockId) await stripe.testHelpers.testClocks.del(clockId).catch(() => {});
    if (productId) {
      await stripe.prices.update(priceId, { active: false }).catch(() => {});
      await stripe.products.update(productId, { active: false }).catch(() => {});
    }
    if (tenantId) {
      await withRlsBypass(async (tx) => {
        await tx.payment.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_fw_${STAMP}_` } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
        await tx.tenant.deleteMany({ where: { id: tenantId } });
      });
    }
  }, 60_000);

  it("a four-weekly tier is a Stripe price of week × 4, charged at creation", async () => {
    const recurring = stripeRecurring("four_weekly");
    expect(recurring).toEqual({ interval: "week", interval_count: 4 });

    const frozen = Math.floor(Date.now() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozen, name: `matflow four-weekly ${STAMP}` });
    clockId = clock.id;
    const customer = await stripe.customers.create({ email: `four-weekly-${STAMP}@test.local`, name: "Four Weekly", test_clock: clockId });
    customerId = customer.id;
    // Attaching the test token mints a real payment method id; that id is the default.
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customerId });
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
    const product = await stripe.products.create({ name: `Adult four-weekly ${STAMP}` });
    productId = product.id;
    const price = await stripe.prices.create({ product: productId, unit_amount: PRICE_PENCE, currency: "gbp", recurring: recurring! });
    priceId = price.id;
    expect(price.recurring).toMatchObject({ interval: "week", interval_count: 4 });

    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    subscriptionId = sub.id;
    expect(sub.status).toBe("active");
    await withRlsBypass((tx) => tx.member.update({ where: { id: memberId }, data: { stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId } }));

    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
    expect(invoices.data).toHaveLength(1);
    expect(invoices.data[0].status).toBe("paid");
    expect(invoices.data[0].amount_paid).toBe(PRICE_PENCE);
  }, 120_000);

  it("Stripe renews it 28 days later: a second paid invoice whose period starts where the first ended", async () => {
    expect(subscriptionId, "the subscription from the first case").not.toBe("");
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    const target = clock.frozen_time + 28 * DAY + 3600;
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: target });
    for (let i = 0; i < 90; i += 1) {
      const c = await stripe.testHelpers.testClocks.retrieve(clockId);
      if (c.status === "ready") break;
      await sleep(2000);
    }
    let invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
    for (let i = 0; i < 30 && invoices.data.length < 2; i += 1) {
      await sleep(2000);
      invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
    }
    expect(invoices.data).toHaveLength(2);
    const [second, first] = invoices.data; // newest first
    expect(first.status).toBe("paid");
    expect(second.status).toBe("paid");
    expect(second.amount_paid).toBe(PRICE_PENCE);
    const p1 = first.lines.data[0].period;
    const p2 = second.lines.data[0].period;
    expect(p1.end - p1.start).toBe(28 * DAY);
    expect(p2.start).toBe(p1.end);
    expect(p2.end - p2.start).toBe(28 * DAY);
  }, 300_000);

  it("MatFlow records both charges from the real invoices delivered as signed webhook events", async () => {
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
    expect(invoices.data).toHaveLength(2);
    for (const invoice of [...invoices.data].reverse()) {
      const payload = JSON.stringify({
        id: `evt_fw_${STAMP}_${invoice.id}`, object: "event", type: "invoice.payment_succeeded", account, livemode: false,
        created: Math.floor(Date.now() / 1000), data: { object: invoice },
      });
      const signature = stripe.webhooks.generateTestHeaderString({
        payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000),
      } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
      const res = (await stripeWebhook(
        new Request("http://localhost/api/stripe/webhook", {
          method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload,
        }) as never,
      )) as unknown as { status: number };
      expect(res.status).toBe(200);
    }
    const after = await withRlsBypass(async (tx) => ({
      member: await tx.member.findUnique({ where: { id: memberId }, select: { paymentStatus: true, billingPeriodStart: true, billingPeriodEnd: true } }),
      payments: await tx.payment.findMany({ where: { memberId }, select: { stripeInvoiceId: true, amountPence: true, status: true }, orderBy: { paidAt: "asc" } }),
    }));
    expect(after.member?.paymentStatus).toBe("paid");
    // The member's authoritative billing period is the renewal invoice's paid period (the "billing" allowance basis counts against it).
    const renewal = invoices.data[0].lines.data[0].period;
    expect(after.member?.billingPeriodStart?.getTime()).toBe(renewal.start * 1000);
    expect(after.member?.billingPeriodEnd?.getTime()).toBe(renewal.end * 1000);
    expect(after.payments).toHaveLength(2);
    expect(after.payments.map((p) => p.amountPence)).toEqual([PRICE_PENCE, PRICE_PENCE]);
    expect(new Set(after.payments.map((p) => p.stripeInvoiceId)).size).toBe(2);
    expect(after.payments.every((p) => p.status === "succeeded")).toBe(true);
  }, 120_000);
});
