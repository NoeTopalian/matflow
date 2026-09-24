// Stripe TEST-MODE lifecycle end-to-end on a connected account (execution
// prompt §5, register R1-2): renewal that FAILS → overdue; a charge that is
// DISPUTED → payment disputed; a subscription CANCELLED at period end →
// member cancelled with a status event; a REFUND through the app's own route
// → payment refunded. Every Stripe-side effect is produced by Stripe itself
// (test cards, a test clock) and every application effect by replaying the
// real event, signed with the local webhook secret, into the local webhook.
//
// Guards and harness as scripts/stripe-migration-e2e.mjs: test branch only,
// sk_test_ only, stamped throwaway tenant torn down, account deleted on PASS.
// Deauthorisation (account.application.deauthorized) cannot be produced on a
// Custom test account by API and stays covered by the signed-event unit test.
//
// Usage (repo root, dev server on :3847 with .env.test):
//   node scripts/stripe-lifecycle-e2e.mjs <acct_id> <out.json> [--delete-account]
import fs from "node:fs";
import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const env = fs.readFileSync("./.env.test", "utf8");
const pick = (k) => env.match(new RegExp(`^${k}=["']?([^"'\\r\\n]+)`, "m"))?.[1];
const DB = pick("DATABASE_URL");
const KEY = pick("STRIPE_SECRET_KEY");
const WH = pick("STRIPE_WEBHOOK_SECRET");
if (!DB?.includes("ep-hidden-salad") || DB.includes("ep-bold-wave")) throw new Error("refusing: not the test branch");
if (!KEY?.startsWith("sk_test_")) throw new Error("refusing: not a test key");
if (!WH) throw new Error("no STRIPE_WEBHOOK_SECRET in .env.test");

const ACCT = process.argv[2];
const OUT = process.argv[3];
if (!ACCT?.startsWith("acct_")) throw new Error("usage: node scripts/stripe-lifecycle-e2e.mjs <acct_id> <out.json>");
const BASE = "http://localhost:3847";
const STAMP = `lc${Date.now().toString(36)}`;
const stripe = new Stripe(KEY, { apiVersion: "2026-03-25.dahlia" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
const opts = { stripeAccount: ACCT };
const ev = { stamp: STAMP, account: ACCT, steps: [] };
const log = (step, data) => { ev.steps.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };

const jar = new Map();
function absorb(res) { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); } }
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie: cookieHeader(), origin: BASE, ...(init.headers ?? {}) }, redirect: "manual" });
  absorb(res);
  return res;
}
async function bypass(fn) {
  return prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`; return fn(tx); });
}
async function replay(type, predicate, polls = 12) {
  for (let i = 0; i < polls; i += 1) {
    const events = await stripe.events.list({ type, limit: 50 }, opts);
    const hit = events.data.find(predicate);
    if (hit) {
      const payload = JSON.stringify({ ...hit, account: ACCT });
      const ts = Math.floor(Date.now() / 1000);
      const sig = `t=${ts},v1=${createHmac("sha256", WH).update(`${ts}.${payload}`).digest("hex")}`;
      const res = await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: payload });
      return { eventId: hit.id, objectId: hit.data.object.id, webhookStatus: res.status, body: (await res.text()).slice(0, 200) };
    }
    await sleep(5000);
  }
  return null;
}
async function waitClock(id) {
  let clock;
  for (let i = 0; i < 36; i += 1) { clock = await stripe.testHelpers.testClocks.retrieve(id, {}, opts); if (clock.status === "ready") return clock; await sleep(5000); }
  throw new Error(`test clock not ready: ${clock?.status}`);
}

const OWNER_EMAIL = `${STAMP}-owner@example.test`;
const OWNER_PW = "LifecycleTest2026x";
let tenantId, tier, tc, price;
const people = {};

try {
  // ── 1. Tenant, owner, tier ────────────────────────────────────────────────
  await bypass(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: `Lifecycle E2E ${STAMP}`, slug: STAMP, stripeAccountId: ACCT, stripeConnected: true, currency: "GBP", onboardingCompleted: true, paymentRail: "stripe" } });
    tenantId = tenant.id;
    await tx.user.create({ data: { tenantId, email: OWNER_EMAIL, passwordHash: await bcrypt.hash(OWNER_PW, 12), name: "Lifecycle Owner", role: "owner" } });
    tier = await tx.membershipTier.create({ data: { tenantId, name: "Adult 4-weekly", pricePence: 3800, currency: "GBP", billingCycle: "four_weekly" } });
  });
  const product = await stripe.products.create({ name: `Adult 4-weekly ${STAMP}` }, opts);
  price = await stripe.prices.create({ product: product.id, unit_amount: 3800, currency: "gbp", recurring: { interval: "week", interval_count: 4 } }, opts);
  await bypass((tx) => tx.membershipTier.update({ where: { id: tier.id }, data: { stripePriceId: price.id, stripeProductId: product.id } }));
  log("tenant", { tenantId, slug: STAMP, tier: tier.id, price: price.id });

  // ── 2. One test clock, three clocked customers, three subscriptions ───────
  tc = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: STAMP }, opts);
  const mk = async (key, name, pmToken) => {
    const c = await stripe.customers.create({ email: `${STAMP}-${key}@example.test`, name, test_clock: tc.id }, opts);
    const pm = await stripe.paymentMethods.attach(pmToken, { customer: c.id }, opts);
    await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: pm.id } }, opts);
    const sub = await stripe.subscriptions.create({ customer: c.id, items: [{ price: price.id }], default_payment_method: pm.id, off_session: true, expand: ["latest_invoice"] }, opts);
    const m = await bypass((tx) => tx.member.create({ data: { tenantId, name, email: `${STAMP}-${key}@example.test`, status: "active", membershipTierId: tier.id, membershipType: tier.name, stripeCustomerId: c.id, stripeSubscriptionId: sub.id, paymentStatus: "paid", nextDueAt: new Date(sub.items.data[0].current_period_end * 1000) } }));
    people[key] = { c, sub, m, invoice: sub.latest_invoice };
    log(`sub-${key}`, { customer: c.id, sub: sub.id, status: sub.status, invoice: sub.latest_invoice?.id, invoiceStatus: sub.latest_invoice?.status, amountPaid: sub.latest_invoice?.amount_paid, periodEnd: new Date(sub.items.data[0].current_period_end * 1000).toISOString() });
  };
  await mk("fails", "Fay Fails", "pm_card_visa");
  await mk("disputes", "Dee Disputes", "pm_card_createDispute");
  await mk("cancels", "Cal Cancels", "pm_card_visa");
  await waitClock(tc.id);

  // ── 3. The first invoices land as payments through the real webhook ───────
  for (const key of ["fails", "disputes", "cancels"]) {
    const r = await replay("invoice.payment_succeeded", (e) => e.data.object.customer === people[key].c.id && e.data.object.amount_paid === 3800);
    log(`webhook-first-invoice-${key}`, r);
    assert(r?.webhookStatus === 200, `first invoice for ${key} acked`);
  }
  const firstPayments = await bypass((tx) => tx.payment.findMany({ where: { tenantId }, select: { id: true, memberId: true, amountPence: true, status: true, stripeChargeId: true, stripePaymentIntentId: true, stripeInvoiceId: true } }));
  log("payments-after-first-invoices", { payments: firstPayments });
  assert(firstPayments.length === 3 && firstPayments.every((p) => p.status === "succeeded" && p.amountPence === 3800), "three succeeded GBP 38 payments");

  // ── 4. Dispute: Stripe raised it itself on the createDispute card ─────────
  const disputed = await replay("charge.dispute.created", (e) => {
    const p = firstPayments.find((x) => x.memberId === people.disputes.m.id);
    return e.data.object.charge === p?.stripeChargeId || e.data.object.payment_intent === p?.stripePaymentIntentId;
  });
  log("webhook-dispute-created", disputed);
  assert(disputed?.webhookStatus === 200, "dispute event acked");
  const disputedRow = await bypass((tx) => tx.payment.findFirst({ where: { tenantId, memberId: people.disputes.m.id }, select: { status: true } }));
  assert(disputedRow?.status === "disputed", `disputed payment reads disputed (got ${disputedRow?.status})`);

  // ── 5. Refund through the app's own route (owner session) ─────────────────
  const csrf = await (await api("/api/auth/csrf")).json();
  const login = await api("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: OWNER_EMAIL, password: OWNER_PW, tenantSlug: STAMP, json: "true" }) });
  assert(login.status < 400, `owner login ${login.status}`);
  const cancelsPayment = firstPayments.find((p) => p.memberId === people.cancels.m.id);
  // A subscription invoice cannot be refunded without saying what happens to
  // the subscription (the route refuses otherwise — run 1 proved it). Use the
  // app's own cancel-at-period-end so the cancellation leg below is driven by
  // the product, not by a direct Stripe call.
  const refundRes = await api(`/api/payments/${cancelsPayment.id}/refund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "lifecycle e2e", subscriptionAction: "cancel_at_period_end" }) });
  const refundBody = await refundRes.json().catch(() => ({}));
  log("refund-route", { status: refundRes.status, body: refundBody });
  assert(refundRes.status === 200, "refund route 200");
  const refundedEvt = await replay("charge.refunded", (e) => e.data.object.id === cancelsPayment.stripeChargeId || e.data.object.payment_intent === cancelsPayment.stripePaymentIntentId);
  log("webhook-charge-refunded", refundedEvt);
  const refundedRow = await bypass((tx) => tx.payment.findUnique({ where: { id: cancelsPayment.id }, select: { status: true, refundedAmountPence: true, refundedAt: true } }));
  log("payment-after-refund", refundedRow);
  assert(refundedRow?.status === "refunded" && refundedRow.refundedAmountPence === 3800, "payment reads refunded in full");
  const stripeRefunds = await stripe.refunds.list({ payment_intent: cancelsPayment.stripePaymentIntentId ?? undefined, charge: cancelsPayment.stripePaymentIntentId ? undefined : cancelsPayment.stripeChargeId, limit: 5 }, opts);
  assert(stripeRefunds.data.length === 1 && stripeRefunds.data[0].amount === 3800, "exactly one GBP 38 refund on Stripe");

  // ── 6. Arrange the next period: a declining card, a cancel at period end ──
  // pm_card_chargeCustomerFail: attaching succeeds, every later charge fails — the
  // documented token for a renewal that bounces (pm_card_chargeDeclined refuses
  // at attach time, which run 2 proved).
  const bad = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: people.fails.c.id }, opts);
  await stripe.subscriptions.update(people.fails.sub.id, { default_payment_method: bad.id }, opts);
  const cancelsSubNow = await stripe.subscriptions.retrieve(people.cancels.sub.id, {}, opts);
  log("cancels-sub-after-refund-route", { cancel_at_period_end: cancelsSubNow.cancel_at_period_end, status: cancelsSubNow.status });
  assert(cancelsSubNow.cancel_at_period_end === true && cancelsSubNow.status === "active", "the refund route set cancel_at_period_end on Stripe and the member keeps access until then");
  const periodEnd = people.cancels.sub.items.data[0].current_period_end;
  await stripe.testHelpers.testClocks.advance(tc.id, { frozen_time: periodEnd + 3600 }, opts);
  const clock = await waitClock(tc.id);
  log("test-clock", { status: clock.status, frozen_time: new Date(clock.frozen_time * 1000).toISOString() });

  // ── 7. Failed renewal → overdue ───────────────────────────────────────────
  const failedEvt = await replay("invoice.payment_failed", (e) => e.data.object.customer === people.fails.c.id, 24);
  log("webhook-payment-failed", failedEvt);
  assert(failedEvt?.webhookStatus === 200, "payment_failed acked");
  const failsRow = await bypass((tx) => tx.member.findUnique({ where: { id: people.fails.m.id }, select: { paymentStatus: true, status: true, stripeSubscriptionId: true } }));
  log("member-after-failed", failsRow);
  assert(failsRow.paymentStatus === "overdue" && failsRow.status === "active" && failsRow.stripeSubscriptionId === people.fails.sub.id, "failed renewal reads overdue, still active, still linked");
  const failedPayments = await bypass((tx) => tx.payment.findMany({ where: { tenantId, memberId: people.fails.m.id }, select: { status: true, amountPence: true } }));
  log("payments-fails", { payments: failedPayments });
  assert(failedPayments.some((p) => p.status === "failed"), "a failed payment row exists");

  // ── 8. Cancelled at period end → deleted → member cancelled with a status event
  const deletedEvt = await replay("customer.subscription.deleted", (e) => e.data.object.id === people.cancels.sub.id, 24);
  log("webhook-subscription-deleted", deletedEvt);
  assert(deletedEvt?.webhookStatus === 200, "subscription.deleted acked");
  const cancelsRow = await bypass(async (tx) => ({
    member: await tx.member.findUnique({ where: { id: people.cancels.m.id }, select: { status: true, paymentStatus: true, stripeSubscriptionId: true, cancelledAt: true } }),
    events: await tx.memberStatusEvent.findMany({ where: { tenantId, memberId: people.cancels.m.id }, select: { fromStatus: true, toStatus: true, reason: true } }),
  }));
  log("member-after-deleted", cancelsRow);
  assert(cancelsRow.member.status === "cancelled" && cancelsRow.member.paymentStatus === "cancelled" && cancelsRow.member.stripeSubscriptionId === null && cancelsRow.member.cancelledAt, "member cancelled, unlinked, dated");
  assert(cancelsRow.events.some((e) => e.fromStatus === "active" && e.toStatus === "cancelled" && e.reason === "stripe_webhook"), "active→cancelled status event with reason stripe_webhook");

  // ── 9. Replay the same deletion again: nothing changes twice ──────────────
  const again = await replay("customer.subscription.deleted", (e) => e.data.object.id === people.cancels.sub.id, 1);
  const eventsAfter = await bypass((tx) => tx.memberStatusEvent.count({ where: { tenantId, memberId: people.cancels.m.id } }));
  log("webhook-deleted-replayed", { status: again?.webhookStatus, body: again?.body, statusEvents: eventsAfter });
  assert(eventsAfter === cancelsRow.events.length, "a redelivered deletion writes no second status event");

  // The renewing member on the disputes card keeps paying (and disputing) — not asserted.
  ev.result = "PASS";
} catch (e) {
  ev.result = "FAIL";
  ev.error = String(e?.message ?? e);
  console.error("FAIL", ev.error);
} finally {
  try {
    if (tenantId) {
      await bypass(async (tx) => {
        await tx.payment.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
        await tx.rateLimitHit.deleteMany({ where: { bucket: { contains: tenantId } } }).catch(() => {});
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      });
      ev.teardownDb = "ok";
    }
  } catch (e) { ev.teardownDb = String(e?.message ?? e); }
  try { if (ev.result === "PASS" || process.argv.includes("--delete-account")) { await stripe.accounts.del(ACCT); ev.teardownStripe = "account deleted"; } else { ev.teardownStripe = "account kept for inspection"; } } catch (e) { ev.teardownStripe = String(e?.message ?? e); }
  await prisma.$disconnect();
  fs.writeFileSync(OUT, JSON.stringify(ev, null, 2));
  console.log("RESULT", ev.result, "→", OUT);
}
