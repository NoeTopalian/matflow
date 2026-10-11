// Payments lane PD (11 Oct 2026) — operator replay end to end through the REAL
// webhook processor (lane PC's prepareStripeEvent, lib/stripe/webhook/process.ts)
// on a REAL database (Neon TEST branch, both guarded runners).
//
// Real: POST /api/stripe/webhook (real constructEvent with a synthetic local
// signing secret), POST /api/admin/stripe/events/[id]/replay (operator MFA
// session, step-up grant, audit writer), lib/stripe/event-store.ts,
// lib/stripe/replay.ts with its production wiring (loadWebhookPrepare →
// prepareStripeEvent), the MemberSubscription mapping, Payment and AuditLog
// rows. Stubbed at the process boundary only: the cookie jar, rate limits,
// email delivery (counted, not sent), the NextAuth session, Sentry, the
// account-status refresh, the invoice → PaymentIntent resolver (a network
// call), and Stripe's events.retrieve (serves the event as Stripe would, "as
// the connected account" — the call's account is recorded).
//
// The scenario is the real race the store exists for: an invoice event arrives
// before the club's connect callback has stored the account id, so the handler
// cannot attribute it (retryable → recorded failed). The cause is then removed
// (the account is linked) and an operator replays it.
//
// Pinned: (1) the failed event replayed once → processed once, ONE Payment row,
// one handler audit row, status replayed; (2) Stripe's redelivery after the
// replay → 200 alreadyProcessed, still one Payment; (3) a forced replay of the
// processed event → no second Payment, no second handler audit row, the
// operator's replay audit row written; (4) a forced replay of a processed
// invoice.payment_failed (a branch that queues emails) → no email sent.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "pay-pd-replay-e2e-db-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    emails: [] as Array<{ templateId?: string; to?: string }>,
    payloads: new Map<string, unknown>(),
    retrieved: [] as Array<{ id: string; acct: string }>,
    pi: new Map<string, string>(),
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.31",
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (e: { templateId?: string; to?: string }) => {
    h.emails.push(e);
    return { ok: true, logId: "mail-test" };
  }),
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));
vi.mock("@/lib/stripe/invoice-payment", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/invoice-payment")>()),
  resolveInvoicePaymentIds: vi.fn(async (_s: unknown, invoiceId: string) => ({ paymentIntentId: h.pi.get(invoiceId) ?? null, chargeId: null })),
}));
vi.mock("stripe", async (orig) => {
  const Real = (await orig<{ default: new (k: string, o?: unknown) => Record<string, unknown> }>()).default;
  class StripeWithRecordedEvents extends Real {
    constructor(key: string, opts?: unknown) {
      super(key, opts);
      (this.events as Record<string, unknown>).retrieve = async (id: string, _p: unknown, o: { stripeAccount: string }) => {
        h.retrieved.push({ id, acct: o?.stripeAccount });
        const p = h.payloads.get(id);
        if (!p) throw Object.assign(new Error("No such event"), { code: "resource_missing", statusCode: 404 });
        return JSON.parse(JSON.stringify(p));
      };
    }
  }
  return { default: StripeWithRecordedEvents };
});

import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant, stepUpTarget } from "@/lib/operator-step-up";
import { POST as webhookRoute } from "@/app/api/stripe/webhook/route";
import { POST as replayRoute } from "@/app/api/admin/stripe/events/[id]/replay/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypde2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const S = STAMP.replace(/-/g, "");
const OP_ID = `${STAMP}-op`;
const TENANT = `${STAMP}-t`;
const ACCT = `acct_${S}`;
const MEMBER = `${STAMP}-m`;
const SUB = `sub_${S}`;
const CUS = `cus_${S}`;
const IN_PAID = `in_${S}_paid`;
const IN_FAILED = `in_${S}_failed`;
const EVT_PAID = `evt_${S}_paid`;
const EVT_FAILED = `evt_${S}_failed`;
const IN_OLD = `in_${S}_old`;
const IN_NEW = `in_${S}_new`;
const EVT_OLD_FAIL = `evt_${S}_oldfail`;
const EVT_NEW_PAID = `evt_${S}_newpaid`;
const ORIGIN = "http://localhost:3847";
const SECRET = "whsec_paypde2e_synthetic_local_only_0123456789";

const invoiceEvent = (id: string, type: string, invoiceId: string) => ({
  id,
  object: "event",
  type,
  account: ACCT,
  livemode: false,
  created: Math.floor(Date.now() / 1000) - 120,
  data: {
    object: {
      id: invoiceId,
      object: "invoice",
      customer: CUS,
      amount_paid: type === "invoice.payment_succeeded" ? 4500 : 0,
      amount_due: 4500,
      currency: "gbp",
      parent: { type: "subscription_details", subscription_details: { subscription: SUB } },
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) - 120 },
    },
  },
});

let signer: Stripe;
async function deliver(evt: unknown) {
  const payload = JSON.stringify(evt);
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: SECRET } as Parameters<typeof signer.webhooks.generateTestHeaderString>[0]);
  const res = await webhookRoute(
    new Request(`${ORIGIN}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload }) as never,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function replay(eventId: string, body: Record<string, unknown>, grant: string) {
  const res = await replayRoute(
    new Request(`${ORIGIN}/api/admin/stripe/events/${eventId}/replay`, {
      method: "POST",
      headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", [STEP_UP_HEADER]: grant },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: eventId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const grantFor = async (eventId: string, force: boolean) =>
  (await issueStepUpGrant({ operatorId: OP_ID, action: "stripe.event_replay", targetId: stepUpTarget(TENANT, eventId), change: { force } })).grant;

const payments = (invoiceId: string) => withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT, stripeInvoiceId: invoiceId } }));
const audits = (action: string) => withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: TENANT, action } }));
const row = (eventId: string) =>
  withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId }, select: { status: true, attempts: true, tenantId: true, lastError: true } }));

describe.skipIf(!HAS_DB)("pay-pd: replay end to end through the real webhook processor", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXTAUTH_URL"]) saved[k] = process.env[k];
    process.env.STRIPE_SECRET_KEY = "sk_test_paypde2e_synthetic_never_used";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.NEXTAUTH_URL = ORIGIN;
    signer = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" as never });
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `${STAMP}@operator.test`,
        name: "payPD e2e synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "SYNTHETICSECRETNOTUSED",
      },
    });
    // The club exists, its member and the member's mapped subscription exist —
    // but the connect callback has NOT yet stored the account id on the club.
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT, name: `${STAMP} club`, slug: TENANT } });
      await tx.member.create({
        data: { id: MEMBER, tenantId: TENANT, email: `${STAMP}-member@example.test`, name: "PD e2e member", stripeCustomerId: CUS, stripeSubscriptionId: SUB, paymentStatus: "overdue" },
      });
      await tx.memberSubscription.create({
        data: { tenantId: TENANT, memberId: MEMBER, stripeAccountId: ACCT, stripeSubscriptionId: SUB, source: "app", status: "active" },
      });
    });
    h.pi.set(IN_PAID, `pi_${S}_paid`);
    h.pi.set(IN_FAILED, `pi_${S}_failed`);
    h.pi.set(IN_OLD, `pi_${S}_old`);
    h.pi.set(IN_NEW, `pi_${S}_new`);
    h.payloads.set(EVT_PAID, invoiceEvent(EVT_PAID, "invoice.payment_succeeded", IN_PAID));
    h.payloads.set(EVT_FAILED, invoiceEvent(EVT_FAILED, "invoice.payment_failed", IN_FAILED));
    h.payloads.set(EVT_OLD_FAIL, { ...invoiceEvent(EVT_OLD_FAIL, "invoice.payment_failed", IN_OLD), created: Math.floor(Date.now() / 1000) - 7200 });
    h.payloads.set(EVT_NEW_PAID, { ...invoiceEvent(EVT_NEW_PAID, "invoice.payment_succeeded", IN_NEW), created: Math.floor(Date.now() / 1000) - 60 });
    h.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 0));
  }, 180_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 750));
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${S}` } } });
      await tx.auditLog.deleteMany({ where: { tenantId: TENANT } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.memberSubscription.deleteMany({ where: { tenantId: TENANT } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: TENANT } });
      await tx.auditLog.deleteMany({ where: { tenantId: null, OR: [{ entityId: OP_ID }, { operatorId: OP_ID }] } });
    }, { timeout: 60_000 });
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 180_000);

  it("(1) a delivery before the account is linked is recorded failed; after linking, one replay processes it once: one Payment", async () => {
    const first = await deliver(h.payloads.get(EVT_PAID));
    expect(first.status).toBe(409);
    expect(await row(EVT_PAID)).toMatchObject({ status: "failed", attempts: 1, tenantId: null });
    expect((await row(EVT_PAID))?.lastError).toContain("not linked");
    expect(await payments(IN_PAID)).toBe(0);

    // The cause is removed: the connect callback lands.
    await withRlsBypass((tx) => tx.tenant.update({ where: { id: TENANT }, data: { stripeAccountId: ACCT, stripeConnected: true } }));

    const r = await replay(EVT_PAID, { reason: "account linked after the event arrived" }, await grantFor(EVT_PAID, false));
    console.log("[pay-pd e2e] replay(1) →", r.status, JSON.stringify(r.body));
    expect(r).toMatchObject({ status: 200, body: { ok: true, result: "processed", status: "replayed", forced: false } });
    expect(h.retrieved).toEqual([{ id: EVT_PAID, acct: ACCT }]);
    expect(await payments(IN_PAID)).toBe(1);
    expect(await audits("member.payment.succeeded")).toBe(1);
    expect(await audits("stripe.event.replayed")).toBe(1);
    expect(await row(EVT_PAID)).toMatchObject({ status: "replayed", lastError: null });
    const m = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: MEMBER }, select: { paymentStatus: true } }));
    expect(m?.paymentStatus).toBe("paid");
  });

  it("(2) Stripe's redelivery after the replay: 200 alreadyProcessed, still one Payment", async () => {
    const again = await deliver(h.payloads.get(EVT_PAID));
    console.log("[pay-pd e2e] redelivery →", again.status, JSON.stringify(again.body));
    expect(again).toEqual({ status: 200, body: { received: true, alreadyProcessed: true } });
    expect(await payments(IN_PAID)).toBe(1);
    expect(await audits("member.payment.succeeded")).toBe(1);
  });

  it("(3) a forced replay of the processed event: no second Payment, no second handler audit, the operator's row written", async () => {
    const r = await replay(EVT_PAID, { reason: "forced convergence check after the fix", force: true }, await grantFor(EVT_PAID, true));
    console.log("[pay-pd e2e] forced replay →", r.status, JSON.stringify(r.body));
    // Compare-only (review RP-8): the handler ran in a rolled-back transaction.
    expect(r).toMatchObject({ status: 200, body: { ok: true, result: "compared", status: "replayed", forced: true, wouldBe: "processed" } });
    expect(r.body.writesRolledBack).toEqual(expect.arrayContaining(["payment.upsert"]));
    expect(await row(EVT_PAID)).toMatchObject({ status: "replayed" });
    expect(await payments(IN_PAID)).toBe(1);
    expect(await audits("member.payment.succeeded")).toBe(1);
    expect(await audits("stripe.event.replayed")).toBe(2);
    const last = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: TENANT, action: "stripe.event.replayed" }, orderBy: { createdAt: "desc" }, select: { operatorId: true, metadata: true } }),
    );
    expect(last?.operatorId).toBe(OP_ID);
    expect(last?.metadata).toMatchObject({ eventId: EVT_PAID, previousStatus: "replayed", forced: true, result: "compared", wouldBe: "processed" });
  });

  it("(4) a forced replay of a processed invoice.payment_failed sends no email again", async () => {
    h.emails.length = 0;
    const first = await deliver(h.payloads.get(EVT_FAILED));
    expect(first.status).toBe(200);
    expect(await row(EVT_FAILED)).toMatchObject({ status: "processed" });
    const sentOnDelivery = h.emails.length;
    expect(sentOnDelivery).toBeGreaterThan(0); // the member is told once
    const failedAudits = await audits("member.payment.failed");
    expect(await payments(IN_FAILED)).toBe(1);

    const r = await replay(EVT_FAILED, { reason: "forced convergence check on a failure", force: true }, await grantFor(EVT_FAILED, true));
    console.log("[pay-pd e2e] forced replay of payment_failed →", r.status, JSON.stringify(r.body), "emails before/after", sentOnDelivery, h.emails.length);
    expect(r).toMatchObject({ status: 200, body: { ok: true, forced: true, result: "compared" } });
    expect(h.emails.length).toBe(sentOnDelivery);
    expect(await audits("member.payment.failed")).toBe(failedAudits);
    expect(await payments(IN_FAILED)).toBe(1);
  });

  it("(5) RP-8: a forced replay of an OLD payment_failed after a later paid invoice changes nothing; the member stays paid", async () => {
    expect((await deliver(h.payloads.get(EVT_OLD_FAIL))).status).toBe(200);
    expect((await deliver(h.payloads.get(EVT_NEW_PAID))).status).toBe(200);
    const member = () => withRlsBypass((tx) => tx.member.findUnique({ where: { id: MEMBER }, select: { paymentStatus: true, status: true } }));
    const before = await member();
    expect(before?.paymentStatus).toBe("paid");
    const paymentsBefore = await withRlsBypass((tx) =>
      tx.payment.findMany({ where: { tenantId: TENANT }, select: { id: true, status: true, stripeInvoiceId: true }, orderBy: { id: "asc" } }),
    );
    const failedAuditsBefore = await audits("member.payment.failed");
    const emailsBefore = h.emails.length;
    const rowBefore = await row(EVT_OLD_FAIL);

    const r = await replay(EVT_OLD_FAIL, { reason: "forced look at an old failure after the member paid", force: true }, await grantFor(EVT_OLD_FAIL, true));
    console.log("[pay-pd e2e] RP-8 forced compare of old payment_failed →", r.status, JSON.stringify(r.body));
    expect(r).toMatchObject({ status: 200, body: { ok: true, result: "compared", forced: true } });
    expect(Array.isArray(r.body.writesRolledBack)).toBe(true);

    expect(await member()).toEqual(before);
    const paymentsAfter = await withRlsBypass((tx) =>
      tx.payment.findMany({ where: { tenantId: TENANT }, select: { id: true, status: true, stripeInvoiceId: true }, orderBy: { id: "asc" } }),
    );
    expect(paymentsAfter).toEqual(paymentsBefore);
    expect(await audits("member.payment.failed")).toBe(failedAuditsBefore);
    expect(h.emails.length).toBe(emailsBefore);
    expect(await row(EVT_OLD_FAIL)).toEqual(rowBefore);
    const last = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: TENANT, action: "stripe.event.replayed", entityId: EVT_OLD_FAIL }, select: { operatorId: true, metadata: true } }),
    );
    expect(last?.operatorId).toBe(OP_ID);
    expect(last?.metadata).toMatchObject({ eventId: EVT_OLD_FAIL, forced: true, result: "compared" });
  });
});
