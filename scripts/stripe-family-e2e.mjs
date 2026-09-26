// Stripe TEST-MODE family billing end-to-end on a throwaway Custom connected
// account (Package B, catalogue C6.08, register R6-4): WHICH membership flips
// when a payer's card fails?
//
// The product's model today (app/api/member/subscriptions/start-for-kid): every
// membership — the parent's own and each child's — has its OWN Stripe customer
// and subscription; a "shared payer" is the same card attached to more than one
// customer. So an invoice that fails flips exactly the membership it was for,
// one webhook event per membership. This script proves that with three
// people on one test clock:
//
//   parent  — adult tier, its own customer, card A
//   kidA    — kids tier, its own customer, card A' (the parent's card, separate
//             attachment; will FAIL at renewal)
//   kidB    — kids tier, its own customer, card B (keeps paying)
//
// Period 1: kidA's renewal fails → kidA overdue; parent and kidB stay paid.
// Period 2: the parent's card is switched to the failing token AND attached to
//           kidB as well (a genuinely shared failing card) → parent AND kidB
//           each go overdue through their own invoice.payment_failed; kidA is
//           still overdue; nothing flips that was not invoiced.
//
// Every Stripe effect is produced by Stripe (test tokens, a test clock); every
// application effect by replaying the real event, signed with the local
// webhook secret, into the local webhook. Guards as the sibling scripts: test
// branch only, sk_test_ only, stamped throwaway tenant torn down, the Custom
// account minted here is deleted on PASS (or with --delete-account).
//
// Usage (repo root, dev server on :3847 with .env.test):
//   node scripts/stripe-family-e2e.mjs <out.json> [--delete-account]
import fs from "node:fs";
import { createHmac } from "node:crypto";
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

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node scripts/stripe-family-e2e.mjs <out.json> [--delete-account]");
const BASE = "http://localhost:3847";
const STAMP = `fam${Date.now().toString(36)}`;
const stripe = new Stripe(KEY, { apiVersion: "2026-03-25.dahlia" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
const ev = { stamp: STAMP, steps: [] };
const log = (step, data) => { ev.steps.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };

let ACCT = null;
let opts = {};
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
async function memberState(id) {
  return bypass((tx) => tx.member.findUnique({ where: { id }, select: { name: true, paymentStatus: true, status: true, stripeSubscriptionId: true } }));
}

let tenantId, tc;
const tiers = {};
const prices = {};
const people = {};

try {
  // ── 0. A throwaway Custom test account the platform can finish onboarding for
  const account = await stripe.accounts.create({
    country: "GB",
    email: `${STAMP}-club@matflow.test`,
    controller: { requirement_collection: "application", fees: { payer: "application" }, losses: { payments: "application" }, stripe_dashboard: { type: "none" } },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_type: "individual",
    business_profile: { mcc: "7997", url: "https://matflow.studio", product_description: "BJJ memberships (family e2e)", support_phone: "+447700900000" },
    // dob 1901-01-01 is Stripe's documented test-mode value for a PASSING
    // identity check; 1990 came back `verification_failed_keyed_identity` on
    // 26 Sep 2026 and the account never enabled charges.
    individual: { first_name: "Family", last_name: "Testclub", email: `${STAMP}-club@matflow.test`, phone: "+447700900000", dob: { day: 1, month: 1, year: 1901 }, address: { line1: "address_full_match", city: "London", postal_code: "WC2N 5DU", country: "GB" } },
    external_account: { object: "bank_account", country: "GB", currency: "gbp", account_number: "00012345", routing_number: "108800" },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { created_by: "matflow scripts/stripe-family-e2e.mjs", purpose: "e2e" },
  });
  ACCT = account.id;
  opts = { stripeAccount: ACCT };
  ev.account = ACCT;
  for (let i = 0; i < 36; i += 1) {
    const a = await stripe.accounts.retrieve(ACCT);
    if (a.charges_enabled) break;
    await sleep(5000);
  }
  const ready = await stripe.accounts.retrieve(ACCT);
  log("account", { id: ACCT, charges_enabled: ready.charges_enabled, due: ready.requirements?.currently_due, errors: (ready.requirements?.errors ?? []).map((e) => e.code) });
  assert(ready.charges_enabled, "the Custom test account can take charges");

  // ── 1. Tenant, tiers, prices ──────────────────────────────────────────────
  await bypass(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: `Family E2E ${STAMP}`, slug: STAMP, stripeAccountId: ACCT, stripeConnected: true, currency: "GBP", onboardingCompleted: true, paymentRail: "stripe" } });
    tenantId = tenant.id;
    tiers.adult = await tx.membershipTier.create({ data: { tenantId, name: "Adult 4-weekly", pricePence: 3800, currency: "GBP", billingCycle: "four_weekly" } });
    tiers.kids = await tx.membershipTier.create({ data: { tenantId, name: "Kids 4-weekly", pricePence: 2400, currency: "GBP", billingCycle: "four_weekly", isKids: true } });
  });
  for (const key of ["adult", "kids"]) {
    const product = await stripe.products.create({ name: `${tiers[key].name} ${STAMP}` }, opts);
    prices[key] = await stripe.prices.create({ product: product.id, unit_amount: tiers[key].pricePence, currency: "gbp", recurring: { interval: "week", interval_count: 4 } }, opts);
    await bypass((tx) => tx.membershipTier.update({ where: { id: tiers[key].id }, data: { stripePriceId: prices[key].id, stripeProductId: product.id } }));
  }
  log("tenant", { tenantId, slug: STAMP, tiers: { adult: tiers.adult.id, kids: tiers.kids.id } });

  // ── 2. One clock; parent + two kids, each with their OWN customer and sub ─
  tc = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: STAMP }, opts);
  const mk = async (key, name, tierKey, pmToken, extra = {}) => {
    const c = await stripe.customers.create({ email: `${STAMP}-${key}@example.test`, name, test_clock: tc.id }, opts);
    const pm = await stripe.paymentMethods.attach(pmToken, { customer: c.id }, opts);
    await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: pm.id } }, opts);
    const sub = await stripe.subscriptions.create({ customer: c.id, items: [{ price: prices[tierKey].id }], default_payment_method: pm.id, off_session: true, expand: ["latest_invoice"] }, opts);
    const m = await bypass((tx) => tx.member.create({ data: {
      tenantId, name, email: extra.parentMemberId ? `kid-${STAMP}-${key}@no-login.matflow.local` : `${STAMP}-${key}@example.test`,
      status: "active", membershipTierId: tiers[tierKey].id, membershipType: tiers[tierKey].name,
      stripeCustomerId: c.id, stripeSubscriptionId: sub.id, paymentStatus: "paid",
      nextDueAt: new Date(sub.items.data[0].current_period_end * 1000), ...extra,
    } }));
    people[key] = { c, sub, m, pm };
    log(`sub-${key}`, { customer: c.id, sub: sub.id, status: sub.status, invoiceStatus: sub.latest_invoice?.status, amountPaid: sub.latest_invoice?.amount_paid, periodEnd: new Date(sub.items.data[0].current_period_end * 1000).toISOString() });
  };
  await mk("parent", "Pat Parent", "adult", "pm_card_visa", { accountType: "parent" });
  // kidA starts on a good card: pm_card_chargeCustomerFail declines the FIRST
  // charge too (the subscription came up `incomplete` on 26 Sep), so the
  // failing card is attached after the first invoice, before period 1.
  await mk("kidA", "Ada Kid", "kids", "pm_card_visa", { accountType: "kids", parentMemberId: people.parent.m.id, dateOfBirth: new Date("2017-05-04") });
  await mk("kidB", "Ben Kid", "kids", "pm_card_visa", { accountType: "kids", parentMemberId: people.parent.m.id, dateOfBirth: new Date("2015-02-03") });
  await waitClock(tc.id);

  // ── 3. First invoices land through the real webhook ───────────────────────
  for (const key of ["parent", "kidA", "kidB"]) {
    const amount = key === "parent" ? 3800 : 2400;
    const r = await replay("invoice.payment_succeeded", (e) => e.data.object.customer === people[key].c.id && e.data.object.amount_paid === amount);
    log(`webhook-first-invoice-${key}`, r);
    assert(r?.webhookStatus === 200, `first invoice for ${key} acked`);
  }
  const firstPayments = await bypass((tx) => tx.payment.findMany({ where: { tenantId }, select: { memberId: true, amountPence: true, status: true } }));
  assert(firstPayments.length === 3 && firstPayments.every((p) => p.status === "succeeded"), "three succeeded first payments");
  // chargeCustomerFail: attach succeeds, the FIRST charge succeeds too (the
  // subscription's first invoice is paid at creation) — later charges fail.
  // That is why kidA's first invoice above is a success and the renewal is not.

  // ── 4. Period 1: kidA's card fails at renewal ─────────────────────────────
  const badKidA = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: people.kidA.c.id }, opts);
  await stripe.subscriptions.update(people.kidA.sub.id, { default_payment_method: badKidA.id }, opts);
  const periodEnd1 = people.kidA.sub.items.data[0].current_period_end;
  await stripe.testHelpers.testClocks.advance(tc.id, { frozen_time: periodEnd1 + 3600 }, opts);
  let clock = await waitClock(tc.id);
  log("test-clock-1", { frozen_time: new Date(clock.frozen_time * 1000).toISOString() });

  const kidAFailed = await replay("invoice.payment_failed", (e) => e.data.object.customer === people.kidA.c.id, 24);
  log("webhook-kidA-failed", kidAFailed);
  assert(kidAFailed?.webhookStatus === 200, "kidA payment_failed acked");
  // The parent's and kidB's renewals succeed in the same period.
  for (const key of ["parent", "kidB"]) {
    const amount = key === "parent" ? 3800 : 2400;
    const r = await replay("invoice.payment_succeeded", (e) => e.data.object.customer === people[key].c.id && e.data.object.amount_paid === amount && e.data.object.billing_reason === "subscription_cycle", 24);
    log(`webhook-renewal-${key}`, r);
    assert(r?.webhookStatus === 200, `renewal for ${key} acked`);
  }
  const after1 = { parent: await memberState(people.parent.m.id), kidA: await memberState(people.kidA.m.id), kidB: await memberState(people.kidB.m.id) };
  log("members-after-period-1", after1);
  assert(after1.kidA.paymentStatus === "overdue" && after1.kidA.status === "active", "kidA (the failing card) reads overdue and still active");
  assert(after1.parent.paymentStatus === "paid", "the parent's own membership is untouched by the child's failed invoice");
  assert(after1.kidB.paymentStatus === "paid", "the sibling on a good card is untouched");
  const kidAFailedRows = await bypass((tx) => tx.payment.count({ where: { tenantId, memberId: people.kidA.m.id, status: "failed" } }));
  const othersFailedRows = await bypass((tx) => tx.payment.count({ where: { tenantId, memberId: { in: [people.parent.m.id, people.kidB.m.id] }, status: "failed" } }));
  assert(kidAFailedRows >= 1 && othersFailedRows === 0, "exactly the failed invoice has a failed Payment row");

  // ── 5. Period 2: a genuinely SHARED failing card — the parent and kidB ─────
  const badParent = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: people.parent.c.id }, opts);
  await stripe.subscriptions.update(people.parent.sub.id, { default_payment_method: badParent.id }, opts);
  const badKidB = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: people.kidB.c.id }, opts);
  await stripe.subscriptions.update(people.kidB.sub.id, { default_payment_method: badKidB.id }, opts);
  const parentSub = await stripe.subscriptions.retrieve(people.parent.sub.id, {}, opts);
  const periodEnd2 = parentSub.items.data[0].current_period_end;
  await stripe.testHelpers.testClocks.advance(tc.id, { frozen_time: periodEnd2 + 3600 }, opts);
  clock = await waitClock(tc.id);
  log("test-clock-2", { frozen_time: new Date(clock.frozen_time * 1000).toISOString() });

  const parentFailed = await replay("invoice.payment_failed", (e) => e.data.object.customer === people.parent.c.id, 24);
  const kidBFailed = await replay("invoice.payment_failed", (e) => e.data.object.customer === people.kidB.c.id, 24);
  log("webhook-period-2-failed", { parent: parentFailed, kidB: kidBFailed });
  assert(parentFailed?.webhookStatus === 200 && kidBFailed?.webhookStatus === 200, "two separate payment_failed events, one per membership, both acked");
  assert(parentFailed.eventId !== kidBFailed.eventId, "the shared card produced one event per invoice, not one event for the family");
  const after2 = { parent: await memberState(people.parent.m.id), kidA: await memberState(people.kidA.m.id), kidB: await memberState(people.kidB.m.id) };
  log("members-after-period-2", after2);
  assert(after2.parent.paymentStatus === "overdue" && after2.kidB.paymentStatus === "overdue", "the shared failing card flips each membership it funds, separately");
  assert(after2.kidA.paymentStatus === "overdue", "kidA is still overdue from period 1 (Stripe keeps retrying; nothing here resurrects it)");
  assert([after2.parent, after2.kidA, after2.kidB].every((m) => m.status === "active" && m.stripeSubscriptionId), "nobody is cancelled or unlinked by a failed renewal");

  ev.answer = "Each membership (parent's own, each child's) has its own Stripe customer and subscription; a failed invoice flips exactly that membership to overdue (one invoice.payment_failed per membership), leaves it active and linked, and never touches a sibling or the parent. A card shared across memberships fails each of them through its own event.";
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
        await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
        await tx.rateLimitHit.deleteMany({ where: { bucket: { contains: tenantId } } }).catch(() => {});
        await tx.tenant.delete({ where: { id: tenantId } });
      });
      ev.teardownDb = "ok";
    }
  } catch (e) { ev.teardownDb = String(e?.message ?? e); }
  try {
    if (ACCT && (ev.result === "PASS" || process.argv.includes("--delete-account"))) { await stripe.accounts.del(ACCT); ev.teardownStripe = "account deleted"; }
    else if (ACCT) { ev.teardownStripe = "account kept for inspection"; }
  } catch (e) { ev.teardownStripe = String(e?.message ?? e); }
  await prisma.$disconnect();
  fs.writeFileSync(OUT, JSON.stringify(ev, null, 2));
  console.log("RESULT", ev.result, "→", OUT);
}
