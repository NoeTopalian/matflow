// Pre-Resend adversarial pass (W6, 28 Oct 2026): a class pack bought with a
// delayed payment method, through the real Stripe webhook route against the
// Neon TEST branch (both roles via db-tests.mjs).
//
//  - checkout.session.completed with payment_status "unpaid": nothing is
//    recorded (no MemberClassPack, no Payment), so nothing is spendable;
//  - checkout.session.async_payment_succeeded: the pack and a succeeded
//    Payment are written once; a replay (new event id, same session) and a
//    late paid completion for the same payment mint nothing more;
//  - checkout.session.async_payment_failed: nothing is minted.
//
// Events are signed locally with a synthetic secret (Stripe's test-header
// helper; no network). Email, audit, Sentry and the account-status refresh are
// stubbed. Synthetic club, torn down.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SECRET = "whsec_w6_async_pack_synthetic_local_only";
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!HAS_DB)("W6 pre-Resend: class pack bought with a delayed payment method (real database)", () => {
  let tenantId = "";
  let memberId = "";
  let productId = "";
  const account = `acct_w6ap_${STAMP}`;
  let seq = 0;

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_w6_async_pack_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `W6 async pack ${STAMP}`, slug: `w6-async-pack-${STAMP}`, stripeAccountId: account } })).id;
      memberId = (await tx.member.create({ data: { tenantId, name: "W6 Bacs Buyer", email: `w6-ap-${STAMP}@example.test` } })).id;
      productId = (await tx.classPack.create({ data: { tenantId, name: "Ten", totalCredits: 10, validityDays: 90, pricePence: 9000 } })).id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_w6ap_${STAMP}` } } });
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  async function deliver(type: string, session: string, paymentStatus: "paid" | "unpaid") {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" as never });
    const payload = JSON.stringify({
      id: `evt_w6ap_${STAMP}_${++seq}`, object: "event", type, account, livemode: false, created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: `cs_w6ap_${STAMP}_${session}`, object: "checkout.session", mode: "payment", payment_status: paymentStatus,
        payment_intent: `pi_w6ap_${STAMP}_${session}`, amount_total: 9000, currency: "gbp",
        metadata: { matflowKind: "class_pack", tenantId, memberId, packId: productId },
      } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
    const res = (await stripeWebhook(new Request("http://localhost/api/stripe/webhook", {
      method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload,
    }) as never)) as unknown as { status: number };
    return res.status;
  }
  const packs = (session: string) => withRlsBypass((tx) => tx.memberClassPack.findMany({ where: { tenantId, stripePaymentIntentId: `pi_w6ap_${STAMP}_${session}` } }));
  const payments = (session: string) => withRlsBypass((tx) => tx.payment.findMany({ where: { tenantId, stripePaymentIntentId: `pi_w6ap_${STAMP}_${session}` } }));

  it("an unpaid completion records nothing; async success mints once; a replay and a late paid completion mint nothing more", async () => {
    expect(await deliver("checkout.session.completed", "a", "unpaid")).toBe(200);
    expect(await packs("a")).toHaveLength(0);
    expect(await payments("a")).toHaveLength(0);

    expect(await deliver("checkout.session.async_payment_succeeded", "a", "paid")).toBe(200);
    const minted = await packs("a");
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ memberId, packId: productId, creditsRemaining: 10, status: "active" });
    const paid = await payments("a");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ status: "succeeded", amountPence: 9000 });

    expect(await deliver("checkout.session.async_payment_succeeded", "a", "paid")).toBe(200);
    expect(await deliver("checkout.session.completed", "a", "paid")).toBe(200);
    expect(await packs("a")).toHaveLength(1);
    expect(await payments("a")).toHaveLength(1);
  });

  it("an unpaid completion followed by async failure mints nothing, and the failure is audited", async () => {
    audit.calls.length = 0;
    expect(await deliver("checkout.session.completed", "b", "unpaid")).toBe(200);
    expect(await deliver("checkout.session.async_payment_failed", "b", "unpaid")).toBe(200);
    expect(await packs("b")).toHaveLength(0);
    expect(await payments("b")).toHaveLength(0);
    expect(audit.calls.find((c) => c.action === "stripe.checkout.class_pack_payment_failed")).toMatchObject({ tenantId });
  });
});
