// Pre-Resend adversarial pass (W6, 28 Oct 2026): a partial refund of a class
// pack racing the member spending a credit of the same pack.
//
// The refund legs (app/api/payments/[id]/refund and the charge.refunded
// webhook leg) read the pack, count its redemptions, compute what is left
// (lib/pack-refund.ts) and write that number back as an absolute value. A
// check-in that spends a credit between the read and the write is
// overwritten: the member keeps the credit they just used (a lost update, a
// free class per race).
//
// Parking technique as in checkin-allowance-review-db.test.ts: a GATE
// transaction holds the pack row; the check-in (holding Class and Member,
// waiting to decrement the pack) and the webhook (waiting to write the pack)
// are observed queued in pg_stat_activity, then the GATE is released.
//
// Real Postgres (Neon TEST branch, both roles via db-tests.mjs). The webhook
// is signed locally with a synthetic secret (Stripe's own test-header
// helper, no network). Email, audit, Sentry and the account-status refresh
// are stubbed. Synthetic club, torn down.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const SECRET = "whsec_w6_refund_race_synthetic_local_only_0123456789";
vi.setConfig({ testTimeout: 240_000 });

async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE ${pattern}
    `;
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${n} backend(s) blocked on ${pattern}`);
}

function holdLock(take: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });
  const done = withRlsBypass(async (tx) => {
    await take(tx);
    ready();
    await released;
  }, { timeout: 60_000 });
  return { isReady, release, done };
}

describe.skipIf(!HAS_DB)("W6 pre-Resend: partial pack refund racing a check-in (real database)", () => {
  let tenantId = "";
  let classId = "";
  let productId = "";
  const account = `acct_w6rr_${STAMP}`;

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_w6_refund_race_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `W6 refund race ${STAMP}`, slug: `w6-refund-race-${STAMP}`, stripeAccountId: account, timezone: "UTC" } })).id;
      classId = (await tx.class.create({ data: { tenantId, name: "W6 Race", duration: 60, maxCapacity: 50 } })).id;
      productId = (await tx.classPack.create({ data: { tenantId, name: "Ten", totalCredits: 10, validityDays: 90, pricePence: 10000 } })).id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_w6rr_${STAMP}` } } });
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  async function refundEvent(key: string, chargeId: string, pi: string, amountRefunded: number) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" as never });
    const payload = JSON.stringify({
      id: `evt_w6rr_${STAMP}_${key}`, object: "event", type: "charge.refunded", account, livemode: false, created: Math.floor(Date.now() / 1000),
      data: { object: { id: chargeId, object: "charge", payment_intent: pi, amount: 10000, amount_refunded: amountRefunded, refunded: false, currency: "gbp" } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
    return stripeWebhook(new Request("http://localhost/api/stripe/webhook", {
      method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload,
    }) as never) as unknown as Promise<{ status: number }>;
  }

  it("a £25 refund on a £100 ten-class pack while the member spends a credit leaves 7, never 8", async () => {
    const pi = `pi_w6rr_${STAMP}_a`;
    const charge = `ch_w6rr_${STAMP}_a`;
    const { memberId, packId, instanceId } = await withRlsBypass(async (tx) => {
      // Not on a plan: the member app's check-in is paid by the pack.
      const m = await tx.member.create({ data: { tenantId, name: "W6 Racer", email: `w6-rr-${STAMP}@example.test`, waiverAccepted: true, paymentStatus: "pending" } });
      const p = await tx.memberClassPack.create({
        data: { tenantId, memberId: m.id, packId: productId, creditsRemaining: 10, status: "active", expiresAt: null, stripePaymentIntentId: pi },
      });
      await tx.payment.create({
        data: { tenantId, memberId: m.id, amountPence: 10000, currency: "GBP", status: "succeeded", stripePaymentIntentId: pi, stripeChargeId: charge, paidAt: new Date() },
      });
      const day = new Date(Date.UTC(2031, 2, 3));
      const i = await tx.classInstance.create({ data: { classId, date: day, startTime: "18:00", endTime: "19:00" } });
      return { memberId: m.id, packId: p.id, instanceId: i.id };
    });

    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "MemberClassPack" WHERE "id" = ${packId} FOR UPDATE`);
    await gate.isReady;
    const checkin = performCheckin({
      tenantId, memberId, classInstanceId: instanceId, method: "self",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: true, enforceCapacity: true,
      enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true, allowanceGate: "refuse",
    });
    await waitForLockWaiters('%"MemberClassPack"%', 1); // the check-in's decrement, queued behind the GATE
    const refund = refundEvent("a", charge, pi, 2500);
    await waitForLockWaiters('%"MemberClassPack"%', 2);
    gate.release();
    await gate.done;
    const [c, r] = await Promise.all([checkin, refund]);
    expect(c.kind).toBe("success");
    expect(r.status).toBe(200);

    const pack = await withRlsBypass((tx) => tx.memberClassPack.findUniqueOrThrow({ where: { id: packId } }));
    const redeemed = await withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: packId } }));
    expect(redeemed).toBe(1);
    // 10 sold - 1 attended - 2 refunded (£25 of £100 buys back two whole classes).
    expect(pack.creditsRemaining).toBe(7);
  });
});
