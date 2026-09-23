// Stripe TEST-MODE end-to-end for the membership migration
// (lib/stripe/migrate-memberships.ts), against the TEST branch and the local
// dev server on :3847. Evidence of the 2026-09-24 PASS is in
// docs/runbooks/TEAMUP-MIGRATION.md.
//
// Guards: DATABASE_URL from .env.test must be the hidden-salad branch; the
// Stripe key from .env.test must be sk_test_. Everything created is stamped and
// torn down; the throwaway connected account is deleted on PASS (kept for
// inspection on FAIL unless --delete-account).
//
// The connected account: a CUSTOM test account created by API with Stripe's
// test identity (individual Jenny Rosen, DOB 1901-01-01, phone 0000000000,
// address line1 "address_full_match", GB test bank 108800/00012345,
// tos_acceptance) becomes charges_enabled within about a minute. A Standard
// account cannot be onboarded by API.
//
// Usage (from the repo root, dev server running on :3847 with .env.test):
//   node scripts/stripe-migration-e2e.mjs <acct_id> <out.json> [--delete-account]
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
if (!ACCT?.startsWith("acct_")) throw new Error("usage: node _migration-e2e.mjs <acct_id> <out.json>");
const BASE = "http://localhost:3847";
const STAMP = `mig-${Date.now().toString(36)}`;
const stripe = new Stripe(KEY, { apiVersion: "2026-03-25.dahlia" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
const opts = { stripeAccount: ACCT };
const ev = { stamp: STAMP, account: ACCT, steps: [] };
const log = (step, data) => { ev.steps.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── cookie jar for the NextAuth login ────────────────────────────────────────
const jar = new Map();
function absorb(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) { const [kv] = c.split(";"); const [k, v] = kv.split("="); jar.set(k.trim(), v); }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { cookie: cookieHeader(), origin: BASE, ...(init.headers ?? {}) }, redirect: "manual" });
  absorb(res);
  return res;
}

const OWNER_EMAIL = `${STAMP}-owner@example.test`;
const OWNER_PW = "MigrationTest2026!";
let tenantId, tierM, tier4w, m1, m2, m3, tc, c1, c2, c3, existingSub;

try {
  // ── 1. Tenant + owner + tiers + members on the TEST branch ────────────────
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenant = await tx.tenant.create({ data: { name: `Migration E2E ${STAMP}`, slug: STAMP, stripeAccountId: ACCT, stripeConnected: true, currency: "GBP", onboardingCompleted: true, paymentRail: "stripe" } });
    tenantId = tenant.id;
    await tx.user.create({ data: { tenantId, email: OWNER_EMAIL, passwordHash: await bcrypt.hash(OWNER_PW, 12), name: "Migration Owner", role: "owner" } });
    tier4w = await tx.membershipTier.create({ data: { tenantId, name: "Adult 4-weekly", pricePence: 3800, currency: "GBP", billingCycle: "four_weekly" } });
    tierM = await tx.membershipTier.create({ data: { tenantId, name: "Adult Monthly", pricePence: 6500, currency: "GBP", billingCycle: "monthly" } });
  });
  log("tenant", { tenantId, slug: STAMP, tier4w: tier4w.id, tierM: tierM.id });

  // ── 2. Stripe side: a test clock, three customers ─────────────────────────
  tc = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: STAMP }, opts);
  const frozenNow = new Date(tc.frozen_time * 1000);
  const anchor = new Date(frozenNow.getTime() + 2 * 24 * 60 * 60 * 1000);
  anchor.setUTCHours(6, 0, 0, 0);

  // C1: saved card, NO subscription → the CREATE path. NOT on the test clock:
  // Stripe's customers.list omits test-clock customers unless the list is
  // filtered by that clock, so a clocked C1 is invisible to the engine (run 1
  // proved it: "no_customer"). Real clubs have no test clocks. The time-travel
  // leg runs on a separate clocked customer in step 8.
  c1 = await stripe.customers.create({ email: `${STAMP}-m1@example.test`, name: "Sam Create" }, opts);
  const pm1 = await stripe.paymentMethods.attach("pm_card_visa", { customer: c1.id }, opts);
  await stripe.customers.update(c1.id, { invoice_settings: { default_payment_method: pm1.id } }, opts);

  // C2: an EXISTING subscription on a price the club has not modelled by id → ADOPT by amount+cycle.
  c2 = await stripe.customers.create({ email: `${STAMP}-m2@example.test`, name: "Alex Adopt" }, opts);
  const pm2 = await stripe.paymentMethods.attach("pm_card_visa", { customer: c2.id }, opts);
  await stripe.customers.update(c2.id, { invoice_settings: { default_payment_method: pm2.id } }, opts);
  const oldProduct = await stripe.products.create({ name: "Old platform monthly" }, opts);
  const oldPrice = await stripe.prices.create({ product: oldProduct.id, unit_amount: 6500, currency: "gbp", recurring: { interval: "month" } }, opts);
  existingSub = await stripe.subscriptions.create({ customer: c2.id, items: [{ price: oldPrice.id }], default_payment_method: pm2.id }, opts);

  // C3: no payment method → must be reported, never created.
  c3 = await stripe.customers.create({ email: `${STAMP}-m3@example.test`, name: "Nobody Nocard" }, opts);
  log("stripe-fixtures", { testClock: tc.id, c1: c1.id, c2: c2.id, c3: c3.id, existingSub: existingSub.id, existingSubStatus: existingSub.status, oldPrice: oldPrice.id, anchor: anchor.toISOString() });

  // Members: m1 → create on tier4w at anchor; m2 → adopt; m3 → no_payment_method.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    m1 = await tx.member.create({ data: { tenantId, name: "Sam Create", email: `${STAMP}-m1@example.test`, status: "active", membershipTierId: tier4w.id, membershipType: tier4w.name, nextDueAt: anchor } });
    m2 = await tx.member.create({ data: { tenantId, name: "Alex Adopt", email: `${STAMP}-m2@example.test`, status: "active" } });
    m3 = await tx.member.create({ data: { tenantId, name: "Nobody Nocard", email: `${STAMP}-m3@example.test`, status: "active", membershipTierId: tier4w.id, membershipType: tier4w.name, nextDueAt: anchor } });
  });
  log("members", { m1: m1.id, m2: m2.id, m3: m3.id });

  // ── 3. Sign in as the owner through NextAuth ──────────────────────────────
  const csrfRes = await api("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const login = await api("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: OWNER_EMAIL, password: OWNER_PW, tenantSlug: STAMP, json: "true" }),
  });
  log("login", { status: login.status, hasSession: [...jar.keys()].some((k) => k.includes("session-token")) });
  if (login.status >= 400) throw new Error(`login failed ${login.status}`);

  // ── 4. Preview through the real route ─────────────────────────────────────
  const prevRes = await api("/api/stripe/migrate-memberships");
  const preview = await prevRes.json();
  log("preview", { status: prevRes.status, summary: preview.summary, rows: preview.rows?.map((r) => ({ member: r.memberName, action: r.action, reason: r.reason, tier: r.tierName, by: r.tierMatchedBy, sub: r.subscriptionId, pm: r.paymentMethod?.label, first: r.firstChargeAt })) });
  if (prevRes.status !== 200) throw new Error("preview failed");
  const byName = Object.fromEntries(preview.rows.map((r) => [r.memberName, r]));
  const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };
  assert(byName["Sam Create"].action === "create" && byName["Sam Create"].paymentMethod?.type === "card", "m1 should be create-on-card");
  assert(byName["Alex Adopt"].action === "adopt" && byName["Alex Adopt"].tierMatchedBy === "amount" && byName["Alex Adopt"].subscriptionId === existingSub.id, "m2 should adopt by amount");
  assert(byName["Nobody Nocard"].action === "skip" && byName["Nobody Nocard"].reason === "no_payment_method", "m3 should be no_payment_method");

  // ── 5. Dry run, then apply ────────────────────────────────────────────────
  const dry = await (await api("/api/stripe/migrate-memberships", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberIds: [m1.id, m2.id, m3.id], dryRun: true }) })).json();
  log("dry-run", dry);
  const applyRes = await api("/api/stripe/migrate-memberships", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberIds: [m1.id, m2.id, m3.id] }) });
  const applied = await applyRes.json();
  log("apply", { status: applyRes.status, outcomes: applied.outcomes });
  assert(applyRes.status === 200, "apply 200");
  const o = Object.fromEntries(applied.outcomes.map((x) => [x.memberId, x]));
  assert(o[m1.id].outcome === "created", "m1 created");
  assert(o[m2.id].outcome === "adopted" && o[m2.id].subscriptionId === existingSub.id, "m2 adopted");
  assert(o[m3.id].outcome === "skipped", "m3 skipped");

  // Idempotency: apply again → m1 and m2 are already_linked, nothing new in Stripe.
  const again = await (await api("/api/stripe/migrate-memberships", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberIds: [m1.id, m2.id] }) })).json();
  log("apply-again", again);
  assert(again.outcomes.every((x) => x.outcome === "skipped" && x.reason === "already_linked"), "second apply is a no-op");

  // ── 6. Stripe truth for the created subscription ──────────────────────────
  const newSubId = o[m1.id].subscriptionId;
  const newSub = await stripe.subscriptions.retrieve(newSubId, { expand: ["latest_invoice"] }, opts);
  const subsOnC1 = await stripe.subscriptions.list({ customer: c1.id, status: "all" }, opts);
  log("created-sub", { id: newSub.id, status: newSub.status, billing_cycle_anchor: new Date(newSub.billing_cycle_anchor * 1000).toISOString(), expectedAnchor: anchor.toISOString(), price: newSub.items.data[0].price.id, recurring: newSub.items.data[0].price.recurring, unit_amount: newSub.items.data[0].price.unit_amount, latestInvoiceAmountPaid: newSub.latest_invoice?.amount_paid, latestInvoiceStatus: newSub.latest_invoice?.status, subscriptionsOnCustomer: subsOnC1.data.length });
  assert(newSub.billing_cycle_anchor === Math.floor(anchor.getTime() / 1000), "anchor matches nextDueAt");
  assert(newSub.items.data[0].price.recurring.interval === "week" && newSub.items.data[0].price.recurring.interval_count === 4, "4-weekly price");
  assert(newSub.items.data[0].price.unit_amount === 3800, "amount 3800");
  // Observed on 2026-03-25.dahlia: a future anchor with no proration creates
  // NO invoice at all at creation (latest_invoice null) — nothing to pay until
  // the anchor. Older versions issued a GBP 0 invoice; either is acceptable.
  assert(newSub.latest_invoice == null || newSub.latest_invoice.amount_paid === 0, "nothing charged at creation");
  assert(subsOnC1.data.length === 1, "exactly one subscription on the customer");

  const dbAfter = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.member.findMany({ where: { tenantId }, select: { name: true, stripeCustomerId: true, stripeSubscriptionId: true, membershipTierId: true, nextDueAt: true, paymentStatus: true, preferredPaymentMethod: true }, orderBy: { name: "asc" } });
  });
  log("db-after-apply", { members: dbAfter });
  const t4 = await prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`; return tx.membershipTier.findMany({ where: { tenantId }, select: { name: true, stripePriceId: true } }); });
  log("tiers-after-apply", { tiers: t4 });
  assert(t4.find((t) => t.name === "Adult Monthly").stripePriceId === oldPrice.id, "amount-matched tier learnt the old price id");

  // ── 7. Replay the real GBP 0 invoice event into the local webhook ─────────
  async function replay(type, predicate, polls = 12) {
    for (let i = 0; i < polls; i += 1) {
      const events = await stripe.events.list({ type, limit: 20 }, opts);
      const hit = events.data.find(predicate);
      if (hit) {
        const payload = JSON.stringify({ ...hit, account: ACCT });
        const ts = Math.floor(Date.now() / 1000);
        const sig = `t=${ts},v1=${createHmac("sha256", WH).update(`${ts}.${payload}`).digest("hex")}`;
        const res = await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: payload });
        return { eventId: hit.id, amount_paid: hit.data.object.amount_paid, webhookStatus: res.status, body: await res.text() };
      }
      await sleep(5000);
    }
    return null;
  }
  const zero = await replay("invoice.payment_succeeded", (e) => e.data.object.customer === c1.id && e.data.object.amount_paid === 0, 2);
  log("webhook-zero-invoice", zero ?? { note: "no GBP 0 invoice was issued at creation on this API version" });
  if (zero) assert(zero.webhookStatus === 200, "GBP 0 invoice acked");
  const paymentsAfterZero = await prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`; return tx.payment.findMany({ where: { tenantId }, select: { amountPence: true, status: true, stripeInvoiceId: true } }); });
  log("payments-after-zero", { payments: paymentsAfterZero });
  assert(paymentsAfterZero.length === 0, "no GBP 0 payment row recorded");

  // ── 8. Time-travel leg on a CLOCKED customer: the same subscription shape
  // the engine just created (same minted price, same anchor, same params —
  // pinned by tests/unit/migrate-memberships.test.ts), advanced past the anchor
  // so Stripe actually takes the first charge. A member row is linked to it
  // by hand so the webhook replay below has someone to credit.
  const mintedPrice = newSub.items.data[0].price.id;
  const c4 = await stripe.customers.create({ email: `${STAMP}-m4@example.test`, name: "Tim Clocked", test_clock: tc.id }, opts);
  const pm4 = await stripe.paymentMethods.attach("pm_card_visa", { customer: c4.id }, opts);
  await stripe.customers.update(c4.id, { invoice_settings: { default_payment_method: pm4.id } }, opts);
  const clockedSub = await stripe.subscriptions.create(
    {
      customer: c4.id,
      items: [{ price: mintedPrice }],
      default_payment_method: pm4.id,
      billing_cycle_anchor: Math.floor(anchor.getTime() / 1000),
      proration_behavior: "none",
      collection_method: "charge_automatically",
      off_session: true,
      payment_settings: { payment_method_types: ["card"], save_default_payment_method: "on_subscription" },
      metadata: { matflowMigration: "1", matflowE2E: STAMP },
    },
    { ...opts, idempotencyKey: `matflow_migrate_e2e_${STAMP}` },
  );
  const m4 = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.member.create({ data: { tenantId, name: "Tim Clocked", email: `${STAMP}-m4@example.test`, status: "active", membershipTierId: tier4w.id, membershipType: tier4w.name, nextDueAt: anchor, stripeCustomerId: c4.id, stripeSubscriptionId: clockedSub.id, paymentStatus: "paid" } });
  });
  log("clocked-sub", { customer: c4.id, sub: clockedSub.id, status: clockedSub.status, anchor: new Date(clockedSub.billing_cycle_anchor * 1000).toISOString(), member: m4.id });

  await stripe.testHelpers.testClocks.advance(tc.id, { frozen_time: Math.floor(anchor.getTime() / 1000) + 3600 }, opts);
  let clock;
  for (let i = 0; i < 24; i += 1) { await sleep(5000); clock = await stripe.testHelpers.testClocks.retrieve(tc.id, {}, opts); if (clock.status === "ready") break; }
  log("test-clock", { status: clock.status, frozen_time: new Date(clock.frozen_time * 1000).toISOString() });
  const invoices = await stripe.invoices.list({ subscription: clockedSub.id, limit: 10 }, opts);
  log("invoices", { invoices: invoices.data.map((i) => ({ id: i.id, status: i.status, amount_paid: i.amount_paid, period_start: new Date(i.period_start * 1000).toISOString() })) });
  const charged = invoices.data.find((i) => i.amount_paid === 3800 && i.status === "paid");
  assert(charged, "a GBP 38.00 invoice was paid on the anchor");
  assert(invoices.data.filter((i) => i.amount_paid > 0).length === 1, "exactly one real charge — nothing before the anchor");

  // ── 9. Replay the real GBP 38 event into the local webhook ────────────────
  // On 2026-03-25.dahlia the Invoice has no top-level `subscription`; match the
  // invoice id Stripe just paid instead.
  const paid = await replay("invoice.payment_succeeded", (e) => e.data.object.id === charged.id && e.data.object.amount_paid === 3800);
  log("webhook-paid-invoice", paid);
  assert(paid?.webhookStatus === 200, "paid invoice acked");
  const final = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const member = await tx.member.findUnique({ where: { id: m4.id }, select: { paymentStatus: true, stripeSubscriptionId: true } });
    const m1row = await tx.member.findUnique({ where: { id: m1.id }, select: { paymentStatus: true, stripeSubscriptionId: true, nextDueAt: true } });
    const payments = await tx.payment.findMany({ where: { tenantId }, select: { memberId: true, amountPence: true, status: true, stripeInvoiceId: true, paidAt: true } });
    const audit = await tx.auditLog.findMany({ where: { tenantId, action: "member.subscription.migrated" }, select: { entityId: true, metadata: true } });
    return { member, m1row, payments, audit };
  });
  log("db-final", final);
  assert(final.payments.length === 1 && final.payments[0].amountPence === 3800 && final.payments[0].status === "succeeded" && final.payments[0].memberId === m4.id, "one GBP 38 succeeded payment on the clocked member");
  assert(final.member.paymentStatus === "paid", "clocked member paid");
  assert(final.m1row.stripeSubscriptionId === newSubId && final.m1row.paymentStatus === "paid", "m1 linked and paid");
  assert(final.audit.length === 2, "two migration audit rows (m1 create, m2 adopt)");
  ev.result = "PASS";
} catch (e) {
  ev.result = "FAIL";
  ev.error = String(e?.message ?? e);
  console.error("FAIL", ev.error);
} finally {
  // ── Teardown: DB rows, then the throwaway account ─────────────────────────
  try {
    if (tenantId) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
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
