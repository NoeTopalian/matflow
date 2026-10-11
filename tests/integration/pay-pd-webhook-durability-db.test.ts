// Payments lane PD (11 Oct 2026) — the defect, reproduced at the REAL webhook
// route against a REAL database (Neon TEST branch, guarded runners only).
//
// Defect 4 (audit §13–§14): the route claims StripeEvent inside the handler
// transaction, so an event whose handler fails leaves NO row — nothing in
// MatFlow records that it ever arrived. Worse, the route reads ANY unique
// violation (P2002) as "duplicate delivery" and acks it 200, so a handler
// statement that collides on a unique key is silently dropped for good.
//
// Scenario (a real sequence on a retried invoice): the club has a FAILED
// Payment row for invoice I (written by invoice.payment_failed), and a
// SUCCEEDED row for PaymentIntent P written by payment_intent.succeeded before
// the invoice event arrived. invoice.payment_succeeded then resolves P, keys
// its upsert on P, and stamps stripeInvoiceId = I on that row — which
// collides with the failed row's unique stripeInvoiceId.
//
// This file is the acceptance test for lane PC's wiring of lib/stripe/
// event-store.ts into app/api/stripe/webhook/route.ts. It is RED on the code
// as it stands (recorded in the lane PD report) and turns green only when the
// route records the failure durably and stops acking a handler's P2002.
// Real: the route, constructEvent with a synthetic local secret, Prisma rows.
// Stubbed: the Stripe invoice-id resolver (no network), email, Sentry.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const PI = vi.hoisted(() => `pi_paypdwh${Date.now().toString(36)}`);
vi.mock("@/lib/stripe/invoice-payment", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/invoice-payment")>()),
  resolveInvoicePaymentIds: vi.fn(async () => ({ paymentIntentId: PI, chargeId: null })),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, logId: "mail-test" })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypdwh-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `${STAMP}-t`;
const ACCT = `acct_${STAMP.replace(/-/g, "")}`;
const CUS = `cus_${STAMP.replace(/-/g, "")}`;
const MEMBER = `${STAMP}-m`;
const INVOICE = `in_${STAMP.replace(/-/g, "")}`;
const EVENT = `evt_${STAMP.replace(/-/g, "")}_ok`;

const SECRET = "whsec_paypd_synthetic_local_only_0123456789";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_paypd_synthetic_never_used";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" as never });

async function deliver(payload: string) {
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
  const headers = new Headers({ "content-type": "application/json", "stripe-signature": sig });
  const res = await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers, body: payload }) as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe.skipIf(!HAS_DB)("pay-pd: a failed webhook handler leaves a durable record and is never acked as a duplicate", () => {
  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT, name: `${STAMP} club`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true } });
      await tx.member.create({ data: { id: MEMBER, tenantId: TENANT, email: `${STAMP}@example.test`, name: "PD webhook member", stripeCustomerId: CUS, paymentStatus: "overdue" } });
      await tx.payment.create({ data: { tenantId: TENANT, memberId: MEMBER, stripeInvoiceId: INVOICE, amountPence: 4500, currency: "GBP", status: "failed" } });
      await tx.payment.create({ data: { tenantId: TENANT, memberId: MEMBER, stripePaymentIntentId: PI, amountPence: 4500, currency: "GBP", status: "succeeded", paidAt: new Date() } });
    });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: EVENT } });
      await tx.auditLog.deleteMany({ where: { tenantId: TENANT } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: TENANT } });
    });
  }, 120_000);

  it("invoice.payment_succeeded whose upsert collides: non-2xx, and the store row says failed with the error", async () => {
    const payload = JSON.stringify({
      id: EVENT, object: "event", type: "invoice.payment_succeeded", account: ACCT, livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: INVOICE, object: "invoice", customer: CUS, amount_paid: 4500, amount_due: 4500, currency: "gbp", status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } },
    });
    const first = await deliver(payload);
    // The defect: 200 { alreadyProcessed: true } for an event that was never processed.
    expect(first.body.alreadyProcessed).not.toBe(true);
    expect(first.status).toBeGreaterThanOrEqual(400);
    const row = await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: EVENT } }));
    expect(row, "a failed event must leave a durable StripeEvent row").not.toBeNull();
    expect(row).toMatchObject({ status: "failed", tenantId: TENANT, stripeAccountId: ACCT, objectId: INVOICE, attempts: 1 });
    expect(row?.lastError ?? "").not.toBe("");
    // Stripe's redelivery is still eligible (not acked as already processed).
    const second = await deliver(payload);
    expect(second.body.alreadyProcessed).not.toBe(true);
    const after = await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: EVENT } }));
    expect(after).toMatchObject({ status: "failed", attempts: 2 });
  });
});
