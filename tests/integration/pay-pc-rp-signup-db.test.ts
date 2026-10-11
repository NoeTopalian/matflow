// Review RP (11 Oct 2026), adopted by lane PC as the RP-2 acceptance test: entitlement follows payment, not
// sign-up. Copied from <scratchpad>/pay/RP/tests/rp-signup-db.test.ts; the reviewer's observations are kept
// and turned into assertions (S1, S2), the drawer's early tier PATCH that S2 simulated is removed (lane PB
// removed it from SubscribeDrawer), and S3 pays the first invoice.
// What an unpaid or abandoned recurring sign-up does to a member's payment state and
// to the door's coverage rule. REAL start routes (member self start, staff create-subscription), REAL webhook route
// (incomplete_expired through the real processor and store), REAL performCheckin with requireCoverage (the member
// self check-in path). Stripe is a recording fake. TEST branch only, RP guarded runners. Prefix rpsign.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(init?.headers),
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
// The recording fake has no invoices API: the invoice payment-id lookup is stubbed (no PI on record).
vi.mock("@/lib/stripe/invoice-payment", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/invoice-payment")>()),
  resolveInvoicePaymentIds: vi.fn(async () => ({ paymentIntentId: null, chargeId: null })),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
type Who = { tenantId: string; userId: string; role: "owner" | "member"; memberId?: string };
const gate = vi.hoisted(() => ({ current: null as null | Who }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () =>
    gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: gate.current.role, memberId: gate.current.memberId } } : null,
  ),
  signIn: vi.fn(), signOut: vi.fn(), handlers: {},
}));
const rec = vi.hoisted(() => ({ n: 0, calls: [] as { method: string; opts: unknown }[] }));
vi.mock("stripe", () => {
  class FakeStripe {
    accounts = { retrieve: async (id: string) => ({ id, charges_enabled: true, payouts_enabled: true, requirements: { past_due: [], disabled_reason: null } }) };
    customers = { create: async (_p: unknown, o: unknown) => { rec.calls.push({ method: "customers.create", opts: o }); return { id: `cus_rpsign_${++rec.n}` }; } };
    subscriptions = {
      create: async (_p: unknown, o: unknown) => {
        rec.calls.push({ method: "subscriptions.create", opts: o });
        const id = `sub_rpsign${Date.now().toString(36)}${++rec.n}`;
        return { id, status: "incomplete", items: { data: [] }, latest_invoice: { id: `in_${id}`, confirmation_secret: { client_secret: `pi_${id}_secret_x` } } };
      },
      // Lane PC: an app-created mapping has no lastEventCreated yet, so its first subscription event is
      // decided by a FRESH retrieve (RP-7: a failed retrieve is now a 409, never the payload). The
      // recording fake answers with the state Stripe would hold after the expiry.
      retrieve: async (id: string) => { rec.calls.push({ method: "subscriptions.retrieve", opts: { stripeAccount: ACCT } }); return { id, status: "incomplete_expired", pause_collection: null, items: { data: [] } }; },
    };
    webhooks = { constructEvent: (raw: string) => JSON.parse(raw) };
  }
  return { default: FakeStripe };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as selfStartPOST } from "@/app/api/member/subscriptions/start/route";
import { POST as staffCreatePOST } from "@/app/api/stripe/create-subscription/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { performCheckin } from "@/lib/checkin";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `rpsign${Date.now().toString(36)}`;
const ACCT = `acct_${STAMP}`;
let tenantId = "", ownerId = "", deskTier = "", planTier = "", X = "", Y = "", Z = "", instanceId = "";
let seq = 0;
const fresh = () => ({ chargesEnabled: true, payoutsEnabled: true, requirementsPastDue: [], disabledReason: null, refreshedAt: new Date().toISOString() });
const PRICE = `price_${STAMP}`;

const req = (url: string, body: unknown) => ({
  method: "POST", url, nextUrl: { origin: "https://test.local" },
  headers: new Headers({ origin: "https://test.local", host: "test.local", "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Request;
async function call(fn: (r: never) => Promise<unknown>, r: Request) {
  const res = (await fn(r as never)) as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}
async function deliver(type: string, object: Record<string, unknown>) {
  const id = `evt_${STAMP}_${++seq}`;
  const payload = JSON.stringify({ id, object: "event", type, account: ACCT, livemode: false, created: Math.floor(Date.now() / 1000) + seq, data: { object } });
  const res = (await webhookPOST(new Request("https://test.local/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: payload }) as never)) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}
const expire = (sub: string) => deliver("customer.subscription.updated", { id: sub, object: "subscription", status: "incomplete_expired", items: { data: [] } });
const payFirstInvoice = (sub: string) => deliver("invoice.payment_succeeded", {
  id: `in_${sub}`, object: "invoice", amount_paid: 5000, amount_due: 5000, currency: "gbp", billing_reason: "subscription_create",
  parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: {} } },
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
});
const memberRow = (id: string) => withRlsBypass((tx) => tx.member.findUnique({ where: { id }, select: { status: true, paymentStatus: true, stripeSubscriptionId: true, membershipTierId: true, membershipType: true } }));
const selfCheckin = async (memberId: string) => {
  const r = await performCheckin({ tenantId, memberId, classInstanceId: instanceId, method: "self", enforceRankGate: false, enforceRosterGate: false, enforceTimeWindow: false, requireCoverage: true, enforceCapacity: false, enforceWaiverGate: false });
  if (r.kind === "success") await withRlsBypass((tx) => tx.attendanceRecord.deleteMany({ where: { id: r.record.id } }));
  return r.kind === "success" ? `success:${r.coverage.kind}` : r.kind;
};

describe.skipIf(!HAS_DB)("RP - unpaid / abandoned sign-up: payment state and door coverage", () => {
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_rpsign_fixture_only";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_rpsign_fixture_only";
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    process.stderr.write(`[rpsign] role=${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "unset"}\n`);
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, timezone: "Europe/London", onboardingCompleted: true, memberSelfBilling: true, currency: "GBP", stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh() } });
      tenantId = t.id;
      ownerId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-o@example.test`, name: "RP Owner", role: "owner", passwordHash: "x" } })).id;
      deskTier = (await tx.membershipTier.create({ data: { tenantId, name: "Desk adult", pricePence: 4000, billingCycle: "monthly" } })).id;
      planTier = (await tx.membershipTier.create({ data: { tenantId, name: "App adult", pricePence: 5000, billingCycle: "monthly", stripePriceId: PRICE, isActive: true } })).id;
      X = (await tx.member.create({ data: { tenantId, name: "RP Desk payer", email: `${STAMP}-x@example.test`, membershipTierId: deskTier, membershipType: "Desk adult", paymentStatus: "paid", waiverAccepted: true } })).id;
      Y = (await tx.member.create({ data: { tenantId, name: "RP New", email: `${STAMP}-y@example.test`, paymentStatus: "pending", waiverAccepted: true } })).id;
      Z = (await tx.member.create({ data: { tenantId, name: "RP Payer", email: `${STAMP}-z@example.test`, paymentStatus: "pending", waiverAccepted: true } })).id;
      const c = await tx.class.create({ data: { tenantId, name: "RP open mat" } });
      instanceId = (await tx.classInstance.create({ data: { classId: c.id, date: new Date(), startTime: "12:00", endTime: "13:00" } })).id;
    });
  }, 120_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${STAMP}_` } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.memberSubscription.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { slug: STAMP } }));
    expect(left).toBe(0);
  }, 120_000);

  it("S1 a desk-paid member starts a self sign-up and abandons it: observe paymentStatus and coverage at each step", async () => {
    const trail: Record<string, unknown> = { before: await memberRow(X), doorBefore: await selfCheckin(X) };
    gate.current = { tenantId, userId: X, role: "member", memberId: X };
    const r = await call(selfStartPOST as never, req("https://test.local/api/member/subscriptions/start", { priceId: PRICE, requestId: `${STAMP}-req-x` }));
    expect([200, 201]).toContain(r.status);
    const sub = String(r.body.subscriptionId);
    trail.started = await memberRow(X);
    trail.doorWhileUnpaid = await selfCheckin(X);
    const e = await expire(sub);
    trail.expire = [e.status, e.body.outcome];
    trail.afterExpiry = await memberRow(X);
    trail.doorAfterExpiry = await selfCheckin(X);
    process.stderr.write(`[rpsign] S1 ${JSON.stringify(trail)}\n`);
    for (const c of rec.calls) expect((c.opts as { stripeAccount?: string }).stripeAccount).toBe(ACCT);
    expect((trail.afterExpiry as { stripeSubscriptionId: unknown }).stripeSubscriptionId).toBeNull();
    // RP-2: the sign-up never touched the desk tier, and its expiry put the desk payer back to paid.
    expect(trail.before).toMatchObject({ paymentStatus: "paid", membershipTierId: deskTier });
    expect(trail.started).toMatchObject({ membershipTierId: deskTier, stripeSubscriptionId: sub });
    expect(trail.afterExpiry).toMatchObject({ paymentStatus: "paid", membershipTierId: deskTier, membershipType: "Desk adult", status: "active" });
    expect(trail.doorAfterExpiry).toBe("success:manual");
    expect(e.status).toBe(200);
    expect(e.body.outcome).toBe("processed");
    const m = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: sub }, select: { priorPaymentStatus: true, membershipTierId: true, firstPaidAt: true, status: true } }));
    expect(m).toEqual({ priorPaymentStatus: "paid", membershipTierId: planTier, firstPaidAt: null, status: "incomplete_expired" });
  });

  it("S2 staff start for a new member + the drawer's tier write, then abandonment: observe coverage before any payment", async () => {
    gate.current = { tenantId, userId: ownerId, role: "owner" };
    const trail: Record<string, unknown> = { before: await memberRow(Y), doorBefore: await selfCheckin(Y) };
    const r = await call(staffCreatePOST as never, req("https://test.local/api/stripe/create-subscription", { memberId: Y, priceId: PRICE, requestId: `${STAMP}-req-y` }));
    expect(r.status).toBe(200);
    const sub = String(r.body.subscriptionId);
    // The drawer's early tier PATCH that the reviewer simulated here was removed by lane PB (RP-2), and the
    // create itself no longer writes a tier: nothing grants coverage before the first payment.
    trail.startedNotPaid = await memberRow(Y);
    trail.doorBeforeAnyPayment = await selfCheckin(Y);
    const e = await expire(sub);
    trail.expire = [e.status, e.body.outcome];
    trail.afterExpiry = await memberRow(Y);
    trail.doorAfterExpiry = await selfCheckin(Y);
    process.stderr.write(`[rpsign] S2 ${JSON.stringify(trail)}\n`);
    expect(e.status).toBe(200);
    expect(trail.doorBefore).toBe("no_coverage");
    expect(trail.startedNotPaid).toMatchObject({ paymentStatus: "pending", membershipTierId: null, stripeSubscriptionId: sub });
    expect(trail.doorBeforeAnyPayment).toBe("no_coverage");
    expect(trail.afterExpiry).toMatchObject({ paymentStatus: "pending", membershipTierId: null, stripeSubscriptionId: null, status: "active" });
    expect(trail.doorAfterExpiry).toBe("no_coverage");
  });

  it("S3 a new member's FIRST paid invoice grants the tier and coverage (entitlement follows payment)", async () => {
    gate.current = { tenantId, userId: ownerId, role: "owner" };
    const r = await call(staffCreatePOST as never, req("https://test.local/api/stripe/create-subscription", { memberId: Z, priceId: PRICE, requestId: `${STAMP}-req-z` }));
    expect(r.status).toBe(200);
    const sub = String(r.body.subscriptionId);
    expect(await memberRow(Z)).toMatchObject({ membershipTierId: null, paymentStatus: "pending" });
    expect(await selfCheckin(Z)).toBe("no_coverage");
    const paid = await payFirstInvoice(sub);
    expect(paid.status).toBe(200);
    expect(paid.body.outcome).toBe("processed");
    expect(await memberRow(Z)).toMatchObject({ membershipTierId: planTier, membershipType: "App adult", paymentStatus: "paid", stripeSubscriptionId: sub });
    expect(await selfCheckin(Z)).toBe("success:subscription");
    const m = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: sub }, select: { firstPaidAt: true } }));
    expect(m?.firstPaidAt).toBeInstanceOf(Date);
  });
});
