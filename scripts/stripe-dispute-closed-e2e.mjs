// Stripe TEST-MODE dispute CLOSED legs on a connected account (ten-club audit
// 2026-09-25, section 7): a chargeback the club WINS and one it LOSES, each
// produced by Stripe itself (pm_card_createDispute raises the dispute on the
// first invoice; submitting the documented test evidence strings closes it)
// and each applied to the application by replaying the real, signed event
// into the local webhook. Asserts the Payment, the Member payment state, the
// Dispute row and the audit trail after `charge.dispute.closed`, then replays
// the same closure and asserts nothing moves twice.
//
// Guards and harness as scripts/stripe-lifecycle-e2e.mjs: test branch only,
// sk_test_ only, stamped throwaway tenant torn down, account deleted on PASS.
//
// Usage (repo root, dev server on :3847 with .env.test):
//   node scripts/stripe-dispute-closed-e2e.mjs <acct_id> <out.json> [--delete-account]
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
if (!ACCT?.startsWith("acct_")) throw new Error("usage: node scripts/stripe-dispute-closed-e2e.mjs <acct_id> <out.json>");
const BASE = "http://localhost:3847";
const STAMP = `dc${Date.now().toString(36)}`;
const stripe = new Stripe(KEY, { apiVersion: "2026-03-25.dahlia" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
const opts = { stripeAccount: ACCT };
const ev = { stamp: STAMP, account: ACCT, steps: [] };
const log = (step, data) => { ev.steps.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };

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
      return { eventId: hit.id, objectId: hit.data.object.id, objectStatus: hit.data.object.status, webhookStatus: res.status, body: (await res.text()).slice(0, 200) };
    }
    await sleep(5000);
  }
  return null;
}

let tenantId, tier, price;
const people = {};

try {
  // ── 1. Tenant, owner, tier, price ─────────────────────────────────────────
  await bypass(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: `Dispute E2E ${STAMP}`, slug: STAMP, stripeAccountId: ACCT, stripeConnected: true, currency: "GBP", onboardingCompleted: true, paymentRail: "stripe" } });
    tenantId = tenant.id;
    await tx.user.create({ data: { tenantId, email: `${STAMP}-owner@example.test`, passwordHash: await bcrypt.hash("DisputeTest2026x", 12), name: "Dispute Owner", role: "owner" } });
    tier = await tx.membershipTier.create({ data: { tenantId, name: "Adult 4-weekly", pricePence: 3800, currency: "GBP", billingCycle: "four_weekly" } });
  });
  const product = await stripe.products.create({ name: `Adult 4-weekly ${STAMP}` }, opts);
  price = await stripe.prices.create({ product: product.id, unit_amount: 3800, currency: "gbp", recurring: { interval: "week", interval_count: 4 } }, opts);
  await bypass((tx) => tx.membershipTier.update({ where: { id: tier.id }, data: { stripePriceId: price.id, stripeProductId: product.id } }));
  log("tenant", { tenantId, slug: STAMP, tier: tier.id, price: price.id });

  // ── 2. Two customers on the dispute card, two subscriptions ──────────────
  const mk = async (key, name) => {
    const c = await stripe.customers.create({ email: `${STAMP}-${key}@example.test`, name }, opts);
    const pm = await stripe.paymentMethods.attach("pm_card_createDispute", { customer: c.id }, opts);
    await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: pm.id } }, opts);
    const sub = await stripe.subscriptions.create({ customer: c.id, items: [{ price: price.id }], default_payment_method: pm.id, off_session: true, expand: ["latest_invoice"] }, opts);
    const m = await bypass((tx) => tx.member.create({ data: { tenantId, name, email: `${STAMP}-${key}@example.test`, status: "active", membershipTierId: tier.id, membershipType: tier.name, stripeCustomerId: c.id, stripeSubscriptionId: sub.id, paymentStatus: "paid", nextDueAt: new Date(sub.items.data[0].current_period_end * 1000) } }));
    people[key] = { c, sub, m };
    log(`sub-${key}`, { customer: c.id, sub: sub.id, status: sub.status, invoice: sub.latest_invoice?.id, amountPaid: sub.latest_invoice?.amount_paid });
  };
  await mk("wins", "Wendy Wins");
  await mk("loses", "Lou Loses");

  // ── 3. First invoices → payments; disputes raised by Stripe → disputed ────
  for (const key of ["wins", "loses"]) {
    const r = await replay("invoice.payment_succeeded", (e) => e.data.object.customer === people[key].c.id && e.data.object.amount_paid === 3800);
    log(`webhook-first-invoice-${key}`, r);
    assert(r?.webhookStatus === 200, `first invoice for ${key} acked`);
  }
  const payments = await bypass((tx) => tx.payment.findMany({ where: { tenantId }, select: { id: true, memberId: true, amountPence: true, status: true, stripeChargeId: true, stripePaymentIntentId: true } }));
  assert(payments.length === 2 && payments.every((p) => p.status === "succeeded"), "two succeeded payments");
  const payFor = (key) => payments.find((p) => p.memberId === people[key].m.id);
  const disputeIds = {};
  for (const key of ["wins", "loses"]) {
    const p = payFor(key);
    const r = await replay("charge.dispute.created", (e) => e.data.object.charge === p.stripeChargeId || e.data.object.payment_intent === p.stripePaymentIntentId);
    log(`webhook-dispute-created-${key}`, r);
    assert(r?.webhookStatus === 200, `dispute created for ${key} acked`);
    disputeIds[key] = r.objectId;
    const row = await bypass(async (tx) => ({
      payment: await tx.payment.findUnique({ where: { id: p.id }, select: { status: true } }),
      member: await tx.member.findUnique({ where: { id: people[key].m.id }, select: { paymentStatus: true } }),
      dispute: await tx.dispute.findUnique({ where: { stripeDisputeId: r.objectId }, select: { status: true, paymentId: true, amountPence: true } }),
    }));
    log(`state-after-dispute-created-${key}`, row);
    assert(row.payment.status === "disputed" && row.member.paymentStatus === "overdue" && row.dispute?.status === "needs_response" && row.dispute.paymentId === p.id, `${key}: payment disputed, member overdue, Dispute row needs_response and linked`);
  }

  // ── 4. Evidence: the documented test strings close the dispute won / lost ─
  await stripe.disputes.update(disputeIds.wins, { evidence: { uncategorized_text: "winning_evidence" }, submit: true }, opts);
  await stripe.disputes.update(disputeIds.loses, { evidence: { uncategorized_text: "losing_evidence" }, submit: true }, opts);
  log("evidence-submitted", { wins: disputeIds.wins, loses: disputeIds.loses });

  // ── 5. charge.dispute.closed → won: payment back to succeeded, member paid
  const closedWon = await replay("charge.dispute.closed", (e) => e.data.object.id === disputeIds.wins, 24);
  log("webhook-dispute-closed-won", closedWon);
  assert(closedWon?.webhookStatus === 200 && closedWon.objectStatus === "won", "closed event for the won dispute acked with status won");
  const wonState = await bypass(async (tx) => ({
    payment: await tx.payment.findUnique({ where: { id: payFor("wins").id }, select: { status: true, refundedAmountPence: true } }),
    member: await tx.member.findUnique({ where: { id: people.wins.m.id }, select: { paymentStatus: true, status: true } }),
    dispute: await tx.dispute.findUnique({ where: { stripeDisputeId: disputeIds.wins }, select: { status: true } }),
    audit: await tx.auditLog.count({ where: { tenantId, action: "stripe.dispute.won" } }),
  }));
  log("state-after-won", wonState);
  assert(wonState.payment.status === "succeeded" && wonState.member.paymentStatus === "paid" && wonState.member.status === "active" && wonState.dispute.status === "won" && wonState.audit === 1, "won: payment succeeded again, member paid, Dispute won, one audit row");

  // ── 6. charge.dispute.closed → lost: funds clawed back, member overdue ────
  const closedLost = await replay("charge.dispute.closed", (e) => e.data.object.id === disputeIds.loses, 24);
  log("webhook-dispute-closed-lost", closedLost);
  assert(closedLost?.webhookStatus === 200 && closedLost.objectStatus === "lost", "closed event for the lost dispute acked with status lost");
  const lostState = await bypass(async (tx) => ({
    payment: await tx.payment.findUnique({ where: { id: payFor("loses").id }, select: { status: true } }),
    member: await tx.member.findUnique({ where: { id: people.loses.m.id }, select: { paymentStatus: true, status: true } }),
    dispute: await tx.dispute.findUnique({ where: { stripeDisputeId: disputeIds.loses }, select: { status: true } }),
    audit: await tx.auditLog.count({ where: { tenantId, action: "stripe.dispute.lost" } }),
  }));
  log("state-after-lost", lostState);
  assert(lostState.payment.status === "refunded" && lostState.member.paymentStatus === "overdue" && lostState.member.status === "active" && lostState.dispute.status === "lost" && lostState.audit === 1, "lost: payment written off as refunded, member overdue (still a member), Dispute lost, one audit row");

  // ── 7. Replay both closures: nothing moves twice ──────────────────────────
  const againWon = await replay("charge.dispute.closed", (e) => e.data.object.id === disputeIds.wins, 1);
  const againLost = await replay("charge.dispute.closed", (e) => e.data.object.id === disputeIds.loses, 1);
  const auditAfter = await bypass((tx) => tx.auditLog.count({ where: { tenantId, action: { in: ["stripe.dispute.won", "stripe.dispute.lost"] } } }));
  log("webhook-closed-replayed", { won: againWon?.body, lost: againLost?.body, auditRows: auditAfter });
  assert(auditAfter === 2, "a redelivered closure writes no second audit row");
  const wonAgain = await bypass((tx) => tx.payment.findUnique({ where: { id: payFor("wins").id }, select: { status: true } }));
  assert(wonAgain.status === "succeeded", "won payment unchanged by the replay");

  ev.result = "PASS";
} catch (e) {
  ev.result = "FAIL";
  ev.error = String(e?.message ?? e);
  console.error("FAIL", ev.error);
} finally {
  try {
    if (tenantId) {
      await bypass(async (tx) => {
        await tx.dispute.deleteMany({ where: { tenantId } });
        await tx.payment.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.emailLog.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId } });
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
