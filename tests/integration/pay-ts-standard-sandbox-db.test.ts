// Payments lane TS (11 Oct 2026) — the intended STANDARD-account integration,
// exercised against REAL Stripe TEST MODE, a REAL production build of the app
// running locally on the Neon TEST branch, and the REAL test database.
//
// Opt-in only: PAY_TS_STRIPE_TESTMODE=1, run through a guarded runner
// (att/run-engine.sh = owner role, q78/run-restricted.sh = matflow_app + RLS).
// Refuses unless .env.test holds a test-mode secret key (sk_test_). Never prints
// a key, a webhook secret, a client secret or card data — ids only.
//
// Inputs (environment):
//   PAY_TS_BASE_URL      the local production server (lane TS launcher)
//   PAY_TS_ACCOUNT       the platform-created Standard test account (acct_…)
//   PAY_TS_SECRETS_FILE  JSON with the server's scratch webhookSecret / cronSecret
//   PAY_TS_OUT           where the sanitised per-run results are written (JSON)
//
// What is NOT real here, and is said in every result:
//  - OAuth: NOT RUN. The account is connected to the club by writing the three
//    columns the OAuth callback writes (stripeAccountId, stripeConnected=true,
//    stripeAccountStatus=NULL).
//  - Webhook delivery: Stripe cannot reach a local server. Every event posted
//    here is a REAL test-mode event fetched with events.list AS the connected
//    account, POSTed to the local server signed with the server's local
//    scratch secret.
//  - Where Stripe reports the un-onboarded Standard account charges_enabled
//    false, the app's guard refuses money-in (recorded, run 2). Later runs
//    seed a FRESH cached status (chargesEnabled true) so the money paths can
//    be exercised; Stripe test mode itself accepts direct charges on the
//    account. Each such override is recorded in the results.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

// In-process only (the operator replay route of run 9). The HTTP server is untouched.
const h = vi.hoisted(() => ({ jar: new Map<string, string>() }));
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
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, logId: "mail-ts" })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { HANDLED_STRIPE_EVENT_TYPES } from "@/lib/stripe/handled-events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const RUN = process.env.PAY_TS_STRIPE_TESTMODE === "1" && !!process.env.DATABASE_URL;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const BASE = (process.env.PAY_TS_BASE_URL ?? "").replace(/\/+$/, "");
const ACCT = process.env.PAY_TS_ACCOUNT ?? "";
const OUT = process.env.PAY_TS_OUT ?? "";

function testKey(): string {
  const line = readFileSync(resolve(__dirname, "../../.env.test"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("STRIPE_SECRET_KEY="));
  const key = (line ?? "").slice("STRIPE_SECRET_KEY=".length).trim().replace(/^"|"$/g, "");
  if (!key.startsWith("sk_test_")) throw new Error("REFUSED: .env.test STRIPE_SECRET_KEY is not a test-mode secret key");
  return key;
}

const STAMP = `ts-${ROLE.slice(0, 1)}${Date.now().toString(36)}`;
const TENANT = `${STAMP}-club`;
const PASSWORD = randomBytes(18).toString("base64url");
const OWNER_EMAIL = `${STAMP}-owner@example.test`;
const memberEmail = (k: string) => `${STAMP}-${k}@example.test`;
const memberId = (k: string) => `${STAMP}-${k}`;
const PRODUCT = `${STAMP}-tee`;

const results: Record<string, J> = { role: ROLE, stamp: STAMP, account: ACCT, startedAt: new Date().toISOString(), runs: {} };
const rec = (run: string, data: Record<string, unknown>) => {
  results.runs[run] = { ...(results.runs[run] ?? {}), ...data };
};
const createdSubs: string[] = [];
const postedEvents = new Set<string>();
let stripe: J;
let secrets: { webhookSecret: string; cronSecret: string };
let priceId = "";
const reconcileRunIds: string[] = [];
const OP_ID = `${STAMP}-op`;

const redact = (s: unknown) =>
  String(s ?? "")
    .replace(/(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, "<client_secret>")
    .replace(/[sr]k_(test|live)_[*A-Za-z0-9]+/g, "<key>")
    .replace(/whsec_[A-Za-z0-9]+/g, "<whsec>")
    .slice(0, 400);
const errShape = (e: J) => ({ type: e?.type ?? null, code: e?.code ?? null, decline_code: e?.decline_code ?? null, statusCode: e?.statusCode ?? null, message: redact(e?.message) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const so = () => ({ stripeAccount: ACCT });

// ── HTTP with a cookie jar ───────────────────────────────────────────────────
class Jar {
  c = new Map<string, string>();
  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const kv = sc.split(";")[0];
      const i = kv.indexOf("=");
      const n = kv.slice(0, i).trim();
      const v = kv.slice(i + 1);
      if (!v || /max-age=0/i.test(sc)) this.c.delete(n);
      else this.c.set(n, v);
    }
  }
  header() {
    return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function http(jar: Jar | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      origin: BASE,
      ...(jar ? { cookie: jar.header() } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  jar?.absorb(res);
  const text = await res.text();
  let json: J = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { nonJson: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

async function login(email: string): Promise<Jar> {
  const jar = new Jar();
  const csrf = await http(jar, "GET", "/api/auth/csrf");
  const form = new URLSearchParams({ csrfToken: csrf.body.csrfToken, email, password: PASSWORD, tenantSlug: TENANT, json: "true" });
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    redirect: "manual",
    headers: { origin: BASE, cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  jar.absorb(res);
  await res.text();
  const s = await http(jar, "GET", "/api/auth/session");
  if (!s.body?.user) throw new Error(`login failed for ${email}: callback ${res.status}, session ${JSON.stringify(s.body).slice(0, 200)}`);
  return jar;
}

// ── Stripe events: fetched AS the account, posted signed with the local secret ─
type Delivery = { eventId: string; type: string; created: number; status: number; outcome: string | null; alreadyProcessed?: boolean; error?: string };

async function deliver(ev: J): Promise<Delivery> {
  const payload = JSON.stringify(ev);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: secrets.webhookSecret });
  const res = await fetch(BASE + "/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    body: payload,
  });
  const body = (await res.json().catch(() => ({}))) as J;
  postedEvents.add(ev.id);
  return {
    eventId: ev.id,
    type: ev.type,
    created: ev.created,
    status: res.status,
    outcome: body.outcome ?? body.status ?? (body.ignored ? "unhandled_type_acked" : null),
    ...(body.alreadyProcessed ? { alreadyProcessed: true } : {}),
    ...(body.error ? { error: redact(body.error) } : {}),
  };
}

async function eventsFor(match: (e: J) => boolean, since: number, wantTypes: string[], timeoutMs = 90_000): Promise<J[]> {
  const deadline = Date.now() + timeoutMs;
  let found: J[] = [];
  for (;;) {
    found = [];
    for await (const e of stripe.events.list({ created: { gte: since - 2 }, limit: 100 }, so())) {
      if (HANDLED_STRIPE_EVENT_TYPES.has(e.type) && match(e)) found.push(e);
    }
    const have = new Set(found.map((e) => e.type));
    if (wantTypes.every((t) => have.has(t)) || Date.now() > deadline) break;
    await sleep(3000);
  }
  // events.list is newest first; deliver oldest first (Stripe order within a second).
  return found.reverse();
}
const mentions = (needle: string) => (e: J) => JSON.stringify(e.data?.object ?? {}).includes(needle);
const now = () => Math.floor(Date.now() / 1000);

async function storeRows(ids: string[]) {
  return withRlsBypass((tx) =>
    tx.stripeEvent.findMany({ where: { eventId: { in: ids } }, select: { eventId: true, type: true, status: true, attempts: true, tenantId: true, reconcileFoundAt: true } }),
  );
}
async function memberState(k: string) {
  return withRlsBypass(async (tx) => {
    const m = await tx.member.findUnique({ where: { id: memberId(k) }, select: { status: true, paymentStatus: true, stripeSubscriptionId: true, stripeCustomerId: true } });
    const maps = await tx.memberSubscription.findMany({ where: { memberId: memberId(k) }, select: { stripeSubscriptionId: true, status: true, source: true } });
    const pays = await tx.payment.findMany({ where: { memberId: memberId(k) }, select: { id: true, status: true, stripeInvoiceId: true, stripePaymentIntentId: true, stripeChargeId: true, amountPence: true, refundedAmountPence: true } });
    return { member: m, mappings: maps, payments: pays };
  });
}
async function setStatus(status: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: TENANT }, data: { stripeAccountStatus: status === null ? Prisma.DbNull : (status as Prisma.InputJsonValue), ...extra } }),
  );
}
const freshChargeable = () => ({ chargesEnabled: true, payoutsEnabled: false, requirementsPastDue: [], disabledReason: null, refreshedAt: new Date().toISOString() });
async function tenantStatus() {
  return withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: TENANT }, select: { stripeAccountId: true, stripeConnected: true, stripeAccountStatus: true } }));
}

async function makeMember(k: string) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  await withRlsBypass((tx) =>
    tx.member.create({ data: { id: memberId(k), tenantId: TENANT, email: memberEmail(k), name: `TS ${k}`, passwordHash: hash, paymentStatus: "overdue", status: "active", waiverAccepted: true, waiverAcceptedAt: new Date() } }),
  );
}

let owner: Jar;

/** Staff subscription through the app route (lib/stripe/subscriptions.ts). Returns ids; the client secret never leaves this function except as the PI id. */
async function subscribeViaApp(k: string) {
  await setStatus(freshChargeable());
  const r = await http(owner, "POST", "/api/stripe/create-subscription", { memberId: memberId(k), priceId, paymentMethodType: "card", requestId: randomUUID() });
  if (r.status !== 200) throw new Error(`create-subscription ${r.status} ${redact(JSON.stringify(r.body))}`);
  const sub: string = r.body.subscriptionId;
  const pi: string = String(r.body.clientSecret).split("_secret_")[0];
  createdSubs.push(sub);
  return { sub, pi, httpStatus: r.status, clientSecretShape: typeof r.body.clientSecret === "string" && r.body.clientSecret.includes("_secret_") ? "pi_…_secret_…" : "unexpected" };
}

describe.skipIf(!RUN)(`pay-ts: Standard account in Stripe test mode (${ROLE} role)`, () => {
  beforeAll(async () => {
    expect(BASE, "PAY_TS_BASE_URL").toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
    expect(ACCT, "PAY_TS_ACCOUNT").toMatch(/^acct_[A-Za-z0-9]+$/);
    process.env.STRIPE_SECRET_KEY = testKey();
    secrets = JSON.parse(readFileSync(process.env.PAY_TS_SECRETS_FILE!, "utf8"));
    const Stripe = (await import("stripe")).default;
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia", maxNetworkRetries: 1 });
    const acct = await stripe.accounts.retrieve(ACCT);
    expect(acct.type).toBe("standard");
    expect(acct.metadata?.matflowLane).toBe("TS");
    results.accountAtStart = { type: acct.type, charges_enabled: acct.charges_enabled, details_submitted: acct.details_submitted, disabled_reason: acct.requirements?.disabled_reason ?? null };

    const hash = await bcrypt.hash(PASSWORD, 4);
    await withRlsBypass(async (tx) => {
      // As the OAuth callback writes it: id, flag true, status cleared (NULL).
      await tx.tenant.create({
        data: { id: TENANT, name: `TS sandbox ${STAMP}`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: Prisma.DbNull, memberSelfBilling: true, currency: "GBP" },
      });
      await tx.user.create({ data: { tenantId: TENANT, email: OWNER_EMAIL, name: "TS Owner", passwordHash: hash, role: "owner" } });
      await tx.product.create({ data: { id: PRODUCT, tenantId: TENANT, name: "TS tee", pricePence: 1500 } });
    });
    for (const k of ["shop", "sub", "fail", "wrong", "abandon", "dup", "dispute"]) await makeMember(k);
    owner = await login(OWNER_EMAIL);

    const product = await stripe.products.create({ name: `TS membership ${STAMP}` }, so());
    const price = await stripe.prices.create({ product: product.id, unit_amount: 4500, currency: "gbp", recurring: { interval: "month" } }, so());
    priceId = price.id;
    results.fixtures = { tenant: TENANT, product: product.id, price: price.id, oauth: "NOT RUN — account connected by the callback's three-column write" };
  }, 300_000);

  afterAll(async () => {
    // Run 11 — cleanup: cancel every subscription this run created, delete the club's rows (count-checked).
    const cancelled: J[] = [];
    for (const s of createdSubs) {
      try {
        const cur = await stripe.subscriptions.retrieve(s, {}, so());
        if (["canceled", "incomplete_expired"].includes(cur.status)) cancelled.push({ id: s, already: cur.status });
        else cancelled.push({ id: s, from: cur.status, to: (await stripe.subscriptions.cancel(s, {}, so())).status });
      } catch (e) {
        cancelled.push({ id: s, error: errShape(e) });
      }
    }
    const counts: Record<string, number> = {};
    await withRlsBypass(
      async (tx) => {
        counts.stripeEvent = (await tx.stripeEvent.deleteMany({ where: { OR: [{ tenantId: TENANT }, { eventId: { in: [...postedEvents] } }] } })).count;
        if (reconcileRunIds.length) counts.stripeReconcileRun = (await tx.stripeReconcileRun.deleteMany({ where: { id: { in: reconcileRunIds } } })).count;
        counts.auditLog = (await tx.auditLog.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.payment = (await tx.payment.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.memberSubscription = (await tx.memberSubscription.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.order = (await tx.order.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.product = (await tx.product.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.loginEvent = (await tx.loginEvent.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.member = (await tx.member.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.user = (await tx.user.deleteMany({ where: { tenantId: TENANT } })).count;
        counts.tenant = (await tx.tenant.deleteMany({ where: { id: TENANT } })).count;
        counts.operatorAudit = (await tx.auditLog.deleteMany({ where: { tenantId: null, OR: [{ entityId: OP_ID }, { operatorId: OP_ID }] } })).count;
      },
      { timeout: 120_000 },
    ).catch((e) => {
      counts.error = 1;
      rec("11_cleanup", { deleteError: redact(e?.message) });
    });
    await prisma.operator.deleteMany({ where: { id: OP_ID } }).catch(() => {});
    const left = await withRlsBypass((tx) =>
      Promise.all([
        tx.tenant.count({ where: { id: TENANT } }),
        tx.member.count({ where: { tenantId: TENANT } }),
        tx.payment.count({ where: { tenantId: TENANT } }),
        tx.memberSubscription.count({ where: { tenantId: TENANT } }),
        tx.stripeEvent.count({ where: { tenantId: TENANT } }),
      ]),
    );
    rec("11_cleanup", { subscriptions: cancelled, deleted: counts, leftAfter: { tenant: left[0], member: left[1], payment: left[2], memberSubscription: left[3], stripeEvent: left[4] }, accountKept: ACCT });
    results.finishedAt = new Date().toISOString();
    if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
    expect(left).toEqual([0, 0, 0, 0, 0]);
  }, 300_000);

  it("run 1: the Standard account connected the way the callback writes it; owner health reports readiness", async () => {
    const r = await http(owner, "GET", "/api/stripe/connect/health");
    const b = r.body ?? {};
    rec("1_health", {
      oauth: "NOT RUN",
      httpStatus: r.status,
      ready: b.ready,
      platformAccountOk: b.platformAccount?.ok ?? null,
      keyMode: b.env?.STRIPE_SECRET_KEY?.mode ?? null,
      keyBelongsHere: b.env?.STRIPE_SECRET_KEY?.belongsInThisEnvironment ?? null,
      clientIdPresent: b.env?.STRIPE_CLIENT_ID?.present ?? null,
      webhookSecretPresent: b.env?.STRIPE_WEBHOOK_SECRET?.present ?? null,
      thisTenant: { stripeConnected: b.thisTenant?.stripeConnected ?? null, stripeAccountStatus: b.thisTenant?.stripeAccountStatus ?? null },
      nextSteps: (b.nextSteps ?? []).map((s: string) => redact(s).slice(0, 160)),
    });
    expect(r.status).toBe(200);
    expect(b.thisTenant?.stripeConnected).toBe(true);
  }, 120_000);

  it("run 2: lane PA's guard on the real Standard account — refresh, session on the connected account, deauthorisation, stale cache, unreadable account", async () => {
    const member = await login(memberEmail("shop"));
    const cart = { items: [{ id: PRODUCT, name: "TS tee", price: 15, quantity: 1 }] };

    // 2a: status NULL (as after OAuth) → the guard refreshes from Stripe → real Standard answer.
    await setStatus(null);
    const a = await http(member, "POST", "/api/member/checkout", cart);
    const afterA = await tenantStatus();
    rec("2a_refresh_from_null", { httpStatus: a.status, body: { error: redact(a.body?.error), reason: a.body?.reason ?? null }, statusStoredByRefresh: afterA?.stripeAccountStatus });

    // 2b: fresh cached status chargesEnabled:true (OVERRIDE — Stripe says false) → session on the connected account.
    await setStatus(freshChargeable());
    const b = await http(member, "POST", "/api/member/checkout", cart);
    const order = await withRlsBypass((tx) => tx.order.findFirst({ where: { tenantId: TENANT, status: "pending", stripeSessionId: { not: null } }, orderBy: { createdAt: "desc" }, select: { orderRef: true, stripeSessionId: true } }));
    let session: J = null;
    let withoutHeader: J = null;
    if (order?.stripeSessionId) {
      session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, {}, so());
      withoutHeader = await stripe.checkout.sessions.retrieve(order.stripeSessionId).then(() => "FOUND ON PLATFORM", (e: J) => errShape(e));
      await stripe.checkout.sessions.expire(order.stripeSessionId, {}, so()).catch(() => {});
    }
    rec("2b_checkout_on_connected_account", {
      override: "cached status seeded fresh with chargesEnabled:true (Stripe reports charges_enabled:false for this un-onboarded account)",
      httpStatus: b.status,
      sessionId: order?.stripeSessionId ?? null,
      onBehalfOf: session?.on_behalf_of ?? null,
      sessionMetadataKind: session?.metadata?.matflowKind ?? null,
      retrieveWithoutStripeAccount: withoutHeader,
    });
    expect(b.status).toBe(200);
    expect(session?.id).toBe(order?.stripeSessionId);
    expect(session?.on_behalf_of ?? null).toBeNull();
    expect(withoutHeader?.code).toBe("resource_missing");

    // 2c: deauthorisation as the webhook records it (flag false, id kept, stamp) → refused.
    const stamp = { chargesEnabled: false, payoutsEnabled: false, requirementsPastDue: [], disabledReason: "deauthorized", refreshedAt: new Date().toISOString() };
    await setStatus(stamp, { stripeConnected: false });
    const ordersBefore = await withRlsBypass((tx) => tx.order.count({ where: { tenantId: TENANT } }));
    const c = await http(member, "POST", "/api/member/checkout", cart);
    const ordersAfter = await withRlsBypass((tx) => tx.order.count({ where: { tenantId: TENANT } }));
    rec("2c_deauthorised_refused", { httpStatus: c.status, reason: c.body?.reason ?? null, error: redact(c.body?.error), ordersWritten: ordersAfter - ordersBefore });
    expect(c.status).toBe(409);
    expect(ordersAfter).toBe(ordersBefore);

    // 2d: the same stamp aged 25 h — age never clears a deauthorisation, and no refresh happens.
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await setStatus({ ...stamp, refreshedAt: old }, { stripeConnected: false });
    const d = await http(member, "POST", "/api/member/checkout", cart);
    const afterD = await tenantStatus();
    rec("2d_deauthorised_aged_refused", { httpStatus: d.status, reason: d.body?.reason ?? null, statusUntouched: (afterD?.stripeAccountStatus as J)?.refreshedAt === old });
    expect(d.status).toBe(409);

    // 2e: reconnected (callback shape) with a status aged 25 h → the app path calls accounts.retrieve on the real Standard account.
    await setStatus({ ...freshChargeable(), refreshedAt: old }, { stripeConnected: true });
    const e = await http(member, "POST", "/api/member/checkout", cart);
    const afterE = await tenantStatus();
    const direct = await stripe.accounts.retrieve(ACCT);
    rec("2e_stale_cache_refreshed_from_stripe", {
      httpStatus: e.status,
      reason: e.body?.reason ?? null,
      statusStoredByRefresh: afterE?.stripeAccountStatus,
      stripeSays: { charges_enabled: direct.charges_enabled, payouts_enabled: direct.payouts_enabled, disabled_reason: direct.requirements?.disabled_reason ?? null, details_submitted: direct.details_submitted },
    });

    // 2f: a club pointed at an account the platform cannot read (non-existent id), stale cache → fail closed.
    const ghost = `acct_1TSghost${Date.now().toString(36)}`;
    await setStatus({ ...freshChargeable(), refreshedAt: old }, { stripeAccountId: ghost, stripeConnected: true });
    const f = await http(member, "POST", "/api/member/checkout", cart);
    const afterF = await tenantStatus();
    rec("2f_unreadable_account_fails_closed", { ghostAccount: "acct_1TSghost… (never existed)", httpStatus: f.status, reason: f.body?.reason ?? null, statusStoredByRefresh: afterF?.stripeAccountStatus });
    expect(f.status).toBe(503);

    rec("2g_restricted_key_without_scope", { result: "UNKNOWN", why: "restricted keys cannot be created through the API; creating one needs the Stripe dashboard (a human). Not attempted." });
    rec("2h_platform_lost_standard_account", { result: "NOT RUN", why: "a platform-created Standard account has no OAuth grant to revoke: oauth.deauthorize applies only to OAuth-connected accounts, and the club-side 'disconnect platform' needs a human in the account's dashboard. 2f is the closest real proxy (Stripe refuses the platform key for the account)." });

    // Restore for the money runs.
    await setStatus(freshChargeable(), { stripeAccountId: ACCT, stripeConnected: true });
  }, 300_000);

  let sub1 = "";
  let cus1 = "";
  it("run 3: subscription through the app (lib/stripe/subscriptions.ts) on the Standard account; first invoice confirmed server-side; real events posted", async () => {
    const t0 = now();
    const s = await subscribeViaApp("sub");
    sub1 = s.sub;
    const before = await memberState("sub");
    cus1 = before.member!.stripeCustomerId!;
    const live = await stripe.subscriptions.retrieve(sub1, {}, so());
    const pi = await stripe.paymentIntents.confirm(s.pi, { payment_method: "pm_card_visa" }, so());
    const evs = await eventsFor(mentions(cus1), t0, ["invoice.payment_succeeded", "customer.subscription.updated", "payment_intent.succeeded"]);
    const deliveries: Delivery[] = [];
    for (const ev of evs) deliveries.push(await deliver(ev));
    const after = await memberState("sub");
    const rows = await storeRows(evs.map((e) => e.id));
    rec("3_subscription_paid", {
      subscription: sub1,
      customer: cus1,
      paymentIntent: s.pi,
      createRoute: { httpStatus: s.httpStatus, clientSecret: s.clientSecretShape },
      stripeMetadata: live.metadata,
      stripeStatusAtCreate: live.status,
      piStatusAfterConfirm: pi.status,
      before: { paymentStatus: before.member?.paymentStatus, status: before.member?.status, pointer: before.member?.stripeSubscriptionId, mappings: before.mappings },
      deliveries,
      storeRows: rows,
      after,
    });
    expect(live.metadata).toMatchObject({ matflowTenantId: TENANT, matflowMemberId: memberId("sub"), matflowSource: "app" });
    expect(before.mappings).toEqual([expect.objectContaining({ stripeSubscriptionId: sub1, source: "app" })]);
    expect(before.member?.paymentStatus).toBe("pending");
    expect(pi.status).toBe("succeeded");
    expect(after.mappings.find((m) => m.stripeSubscriptionId === sub1)?.status).toBe("active");
    expect(after.payments.some((p) => p.status === "succeeded")).toBe(true);
    expect(after.member?.paymentStatus).toBe("paid");
    expect(after.member?.status).toBe("active");
  }, 300_000);

  it("run 4: a second, foreign subscription on the same customer (no metadata), paid then cancelled — ignored", async () => {
    expect(sub1).not.toBe("");
    const t0 = now();
    const s1 = await stripe.subscriptions.retrieve(sub1, {}, so());
    const pm = typeof s1.default_payment_method === "string" ? s1.default_payment_method : s1.default_payment_method?.id;
    const before = await memberState("sub");
    const foreign = await stripe.subscriptions.create({ customer: cus1, items: [{ price: priceId }], default_payment_method: pm }, so());
    createdSubs.push(foreign.id);
    const cancelled = await stripe.subscriptions.cancel(foreign.id, {}, so());
    const evs = await eventsFor((e) => mentions(cus1)(e) && !mentions(sub1)(e), t0, ["invoice.payment_succeeded", "customer.subscription.deleted"]);
    const deliveries: Delivery[] = [];
    for (const ev of evs) deliveries.push(await deliver(ev));
    const after = await memberState("sub");
    const rows = await storeRows(evs.map((e) => e.id));
    rec("4_foreign_subscription", { foreignSubscription: foreign.id, statusAtCreate: foreign.status, statusAfterCancel: cancelled.status, foreignMetadata: foreign.metadata, deliveries, storeRows: rows, before: { paymentStatus: before.member?.paymentStatus, pointer: before.member?.stripeSubscriptionId, payments: before.payments.length }, after: { paymentStatus: after.member?.paymentStatus, pointer: after.member?.stripeSubscriptionId, mappings: after.mappings, payments: after.payments.length } });
    expect(after.member?.paymentStatus).toBe(before.member?.paymentStatus);
    expect(after.member?.stripeSubscriptionId).toBe(sub1);
    expect(after.mappings.map((m) => m.stripeSubscriptionId)).toEqual([sub1]);
    expect(after.payments.length).toBe(before.payments.length);
    for (const r of rows.filter((x) => ["invoice.payment_succeeded", "customer.subscription.deleted"].includes(x.type))) expect(r.status).toBe("ignored_foreign");
  }, 300_000);

  it("run 5: an older customer.subscription.updated delivered after a newer one — ignored_stale", async () => {
    expect(sub1).not.toBe("");
    const t0 = now();
    await stripe.subscriptions.update(sub1, { metadata: { tsStep: "older" } }, so());
    await sleep(2200);
    await stripe.subscriptions.update(sub1, { metadata: { tsStep: "newer" } }, so());
    let evs: J[] = [];
    for (let i = 0; i < 30; i++) {
      evs = (await eventsFor((e) => e.data?.object?.id === sub1, t0, ["customer.subscription.updated"])).filter((e) => e.type === "customer.subscription.updated");
      if (evs.length >= 2) break;
      await sleep(3000);
    }
    expect(evs.length).toBeGreaterThanOrEqual(2);
    const older = evs[0];
    const newer = evs[evs.length - 1];
    const dNewer = await deliver(newer);
    const dOlder = await deliver(older);
    const rows = await storeRows([older.id, newer.id]);
    const after = await memberState("sub");
    rec("5_out_of_order", { older: { id: older.id, created: older.created }, newer: { id: newer.id, created: newer.created }, deliveries: [dNewer, dOlder], storeRows: rows, after: { paymentStatus: after.member?.paymentStatus, mappings: after.mappings } });
    expect(newer.created).toBeGreaterThan(older.created);
    expect(rows.find((r) => r.eventId === older.id)?.status).toBe("ignored_stale");
    expect(after.member?.paymentStatus).toBe("paid");
  }, 300_000);

  async function declinedThenPaid(k: string) {
    const t0 = now();
    const s = await subscribeViaApp(k);
    const st = await memberState(k);
    const cus = st.member!.stripeCustomerId!;
    let declined: J = null;
    try {
      await stripe.paymentIntents.confirm(s.pi, { payment_method: "pm_card_chargeDeclined" }, so());
      declined = { unexpected: "confirm succeeded" };
    } catch (e) {
      declined = errShape(e);
    }
    const failEvents = await eventsFor(mentions(cus), t0, ["invoice.payment_failed"], 60_000);
    const t1 = now();
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: cus }, so());
    const live = await stripe.subscriptions.retrieve(s.sub, {}, so());
    const invoiceId = typeof live.latest_invoice === "string" ? live.latest_invoice : live.latest_invoice?.id;
    const paid = await stripe.invoices.pay(invoiceId, { payment_method: pm.id }, so());
    const allEvents = await eventsFor(mentions(cus), t0, ["invoice.payment_failed", "invoice.payment_succeeded", "customer.subscription.updated"]);
    return { s, cus, declined, failEvents, allEvents, t1, invoiceId, invoiceStatus: paid.status };
  }

  it("run 6a: declined first payment → overdue; then a new card pays the invoice → paid (events in Stripe order)", async () => {
    const x = await declinedThenPaid("fail");
    const failIds = new Set(x.failEvents.map((e: J) => e.id));
    const deliveries: Delivery[] = [];
    for (const ev of x.failEvents) deliveries.push(await deliver(ev));
    const mid = await memberState("fail");
    for (const ev of x.allEvents.filter((e: J) => !failIds.has(e.id))) deliveries.push(await deliver(ev));
    const after = await memberState("fail");
    rec("6a_decline_then_pay", { subscription: x.s.sub, invoice: x.invoiceId, declined: x.declined, invoiceStatusAfterPay: x.invoiceStatus, deliveries, afterFailure: { paymentStatus: mid.member?.paymentStatus, payments: mid.payments }, after: { paymentStatus: after.member?.paymentStatus, status: after.member?.status, mappings: after.mappings, payments: after.payments } });
    expect(x.declined?.code).toBe("card_declined");
    expect(mid.member?.paymentStatus).toBe("overdue");
    expect(after.member?.paymentStatus).toBe("paid");
    expect(after.member?.status).toBe("active");
  }, 400_000);

  it("run 6b: the same sequence delivered in the WRONG order (success first, then the failure)", async () => {
    const x = await declinedThenPaid("wrong");
    const failTypes = new Set(["invoice.payment_failed", "payment_intent.payment_failed"]);
    const success = x.allEvents.filter((e: J) => !failTypes.has(e.type));
    const failures = x.allEvents.filter((e: J) => failTypes.has(e.type));
    const deliveries: Delivery[] = [];
    for (const ev of success) deliveries.push(await deliver(ev));
    const mid = await memberState("wrong");
    for (const ev of failures) deliveries.push(await deliver(ev));
    const after = await memberState("wrong");
    const rows = await storeRows(failures.map((e: J) => e.id));
    rec("6b_wrong_order", { subscription: x.s.sub, deliveries, storeRowsForFailures: rows, afterSuccess: { paymentStatus: mid.member?.paymentStatus }, after: { paymentStatus: after.member?.paymentStatus, mappings: after.mappings, payments: after.payments } });
    expect(mid.member?.paymentStatus).toBe("paid");
    expect(after.member?.paymentStatus).toBe("paid");
  }, 400_000);

  it("run 7: abandoned first payment — the incomplete subscription is cancelled (stands in for incomplete_expired)", async () => {
    const t0 = now();
    const s = await subscribeViaApp("abandon");
    const before = await memberState("abandon");
    const cus = before.member!.stripeCustomerId!;
    const cancelled = await stripe.subscriptions.cancel(s.sub, {}, so());
    const evs = await eventsFor(mentions(cus), t0, ["customer.subscription.deleted"]);
    const deliveries: Delivery[] = [];
    for (const ev of evs) deliveries.push(await deliver(ev));
    const after = await memberState("abandon");
    rec("7_abandoned", { limit: "Stripe expires an unpaid default_incomplete subscription after ~23 h (status incomplete_expired); not waited for. Cancelling it produces status 'canceled', not 'incomplete_expired'.", subscription: s.sub, statusAfterCancel: cancelled.status, deliveries, before: { paymentStatus: before.member?.paymentStatus, pointer: before.member?.stripeSubscriptionId, mappings: before.mappings }, after: { paymentStatus: after.member?.paymentStatus, status: after.member?.status, pointer: after.member?.stripeSubscriptionId, mappings: after.mappings } });
    expect(after.member?.status).toBe("active");
    expect(after.member?.stripeSubscriptionId).toBeNull();
  }, 300_000);

  it("run 8: duplicate delivery (sequential and concurrent) and a crash on first delivery (lane PD store)", async () => {
    const t0 = now();
    const s = await subscribeViaApp("dup");
    const st = await memberState("dup");
    const cus = st.member!.stripeCustomerId!;
    await stripe.paymentIntents.confirm(s.pi, { payment_method: "pm_card_visa" }, so());
    const evs = await eventsFor(mentions(cus), t0, ["invoice.payment_succeeded", "customer.subscription.updated", "payment_intent.succeeded"]);
    const inv = evs.find((e) => e.type === "invoice.payment_succeeded")!;
    const piEv = evs.find((e) => e.type === "payment_intent.succeeded")!;
    const others = evs.filter((e) => e !== inv && e !== piEv);
    const out: Record<string, unknown> = { subscription: s.sub };

    // Crash: the real processor runs, then the transaction is killed before commit (in-process; PD's store + PC's processor).
    let crash: J = { result: "NOT RUN", why: "lib/stripe/webhook/process.ts (lane PC) not present" };
    try {
      const mod: J = await import("@/lib/stripe/webhook/process");
      const store: J = await import("@/lib/stripe/event-store");
      const real = await mod.prepareStripeEvent(inv, { baseUrl: BASE });
      const crashing = async (e: J, ctx: J) => {
        const r = await real(e, ctx);
        throw new Error(`TS injected crash after the processor ran (outcome ${r?.outcome})`);
      };
      const r = await store.runStripeEvent(inv, crashing);
      const row = (await storeRows([inv.id]))[0];
      const pays = (await memberState("dup")).payments.length;
      crash = { kind: r.kind, retryable: r.retryable ?? null, rowAfterCrash: row, paymentsAfterCrash: pays };
      postedEvents.add(inv.id);
    } catch (e) {
      crash = { result: "ERROR", error: errShape(e) };
    }
    out.crash = crash;

    const deliveries: Delivery[] = [];
    for (const ev of others) deliveries.push(await deliver(ev));
    const first = await deliver(inv); // retry after the crash
    const second = await deliver(inv); // sequential duplicate
    const [c1, c2] = await Promise.all([deliver(piEv), deliver(piEv)]); // concurrent duplicate
    const third = await deliver(piEv);
    const rows = await storeRows([inv.id, piEv.id]);
    const after = await memberState("dup");
    const audits = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: TENANT, entityId: memberId("dup") }, select: { action: true } }));
    Object.assign(out, { deliveries, invoiceRetry: first, invoiceDuplicate: second, concurrentPi: [c1, c2], piThird: third, storeRows: rows, payments: after.payments, auditActions: audits.map((a) => a.action), paymentStatus: after.member?.paymentStatus });
    rec("8_duplicates_and_crash", out);
    if (crash.kind) {
      expect(crash.kind).toBe("failed");
      expect(crash.rowAfterCrash?.status).toBe("failed");
      expect(crash.paymentsAfterCrash).toBe(0);
    }
    expect(first.status).toBe(200);
    expect(second.alreadyProcessed).toBe(true);
    expect(after.payments.length).toBe(1);
    expect(audits.filter((a) => a.action === "member.payment.succeeded").length).toBe(1);
    expect(rows.find((r) => r.eventId === inv.id)?.status).toBe("processed");
    const concurrentStatuses = [c1, c2].map((d) => (d.alreadyProcessed ? "already" : d.status === 409 ? "in_progress" : d.status === 200 ? "applied" : `http_${d.status}`)).sort();
    expect(concurrentStatuses.filter((x) => x === "applied")).toHaveLength(1);
  }, 400_000);

  it("run 9: reconcile reports a deleted store row without processing it; replay through the operator route", async () => {
    const dupEvents = [...postedEvents];
    const target = (await storeRows(dupEvents)).find((r) => r.type === "customer.subscription.updated" && r.status === "processed" && r.tenantId === TENANT);
    expect(target, "a processed customer.subscription.updated row to delete").toBeTruthy();
    const before = await memberState("dup");
    await withRlsBypass((tx) => tx.stripeEvent.deleteMany({ where: { eventId: target!.eventId } }));
    const r = await http(null, "GET", "/api/cron/stripe-reconcile?dryRun=1", undefined, { authorization: `Bearer ${secrets.cronSecret}` });
    if (r.body?.runId) reconcileRunIds.push(r.body.runId);
    const missing = (r.body?.missing ?? []) as J[];
    const mine = missing.filter((m) => JSON.stringify(m).includes(target!.eventId));
    const row = (await storeRows([target!.eventId]))[0] ?? null;
    const after = await memberState("dup");
    rec("9a_reconcile", {
      dryRunParam: "dryRun=1 sent; the route has no such parameter — reconcile only ever records and reports",
      httpStatus: r.status,
      ok: r.body?.ok ?? null,
      runId: r.body?.runId ?? null,
      tenantsChecked: r.body?.tenantsChecked ?? null,
      tenantsSkipped: r.body?.tenantsSkipped ?? null,
      eventsScanned: r.body?.eventsScanned ?? null,
      missingCount: r.body?.missingCount ?? null,
      deletedEventId: target!.eventId,
      reportedMissing: mine.length > 0,
      errors: (r.body?.errors ?? []).map((e: J) => redact(JSON.stringify(e)).slice(0, 200)),
      rowAfter: row,
      memberUnchanged: JSON.stringify(after) === JSON.stringify(before),
    });
    expect(mine.length).toBeGreaterThan(0);
    expect(row?.status).toBe("received");
    expect(row?.attempts).toBe(0);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // 9b: replay through the operator route (in-process; real Stripe events.retrieve AS the account).
    const { issueOperatorSession, OP_SESSION_COOKIE } = await import("@/lib/operator-auth");
    const { STEP_UP_HEADER, issueStepUpGrant, stepUpTarget } = await import("@/lib/operator-step-up");
    const { POST: replayRoute } = await import("@/app/api/admin/stripe/events/[id]/replay/route");
    await prisma.operator.create({ data: { id: OP_ID, email: `${STAMP}@operator.test`, name: "TS synthetic operator", passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a", totpEnabled: true, totpSecret: "SYNTHETICSECRETNOTUSED" } });
    h.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 0));
    const prevAllow = process.env.OPERATOR_ALLOWED_IDS;
    process.env.OPERATOR_ALLOWED_IDS = [prevAllow, OP_ID].filter(Boolean).join(",");
    const call = async (grant?: string) => {
      const res = await replayRoute(
        new Request(`http://localhost:3847/api/admin/stripe/events/${target!.eventId}/replay`, {
          method: "POST",
          headers: { origin: "http://localhost:3847", host: "localhost:3847", "content-type": "application/json", ...(grant ? { [STEP_UP_HEADER]: grant } : {}) },
          body: JSON.stringify({ reason: "TS sandbox: reconcile found a missing event", force: false }),
        }) as never,
        { params: Promise.resolve({ id: target!.eventId }) },
      );
      return { status: res.status, body: (await res.json()) as J };
    };
    const noGrant = await call();
    let withGrant: J = null;
    try {
      const g = (await issueStepUpGrant({ operatorId: OP_ID, action: "stripe.event_replay", targetId: stepUpTarget(TENANT, target!.eventId), change: { force: false } })).grant;
      withGrant = await call(g);
    } catch (e) {
      withGrant = { error: errShape(e) };
    }
    const rowAfterReplay = (await storeRows([target!.eventId]))[0] ?? null;
    process.env.OPERATOR_ALLOWED_IDS = prevAllow;
    rec("9b_operator_replay", {
      stepUp: "grant issued directly with issueStepUpGrant (the operator's TOTP step-up is not driven)",
      withoutGrant: { status: noGrant.status, body: redact(JSON.stringify(noGrant.body)) },
      withGrant: withGrant?.status !== undefined ? { status: withGrant.status, body: redact(JSON.stringify(withGrant.body)) } : withGrant,
      rowAfterReplay,
    });
  }, 400_000);

  it("run 10: refund through the app's refund route; a real test-mode dispute", async () => {
    // 10a refund of run 3's payment
    const st = await memberState("sub");
    const pay = st.payments.find((p) => p.status === "succeeded");
    expect(pay, "run 3 payment").toBeTruthy();
    const t0 = now();
    await setStatus(freshChargeable());
    const r = await http(owner, "POST", `/api/payments/${pay!.id}/refund`, { reason: "TS sandbox refund", subscriptionAction: "refund_only" });
    const evs = await eventsFor((e) => e.type === "charge.refunded" && mentions(cus1)(e), t0, ["charge.refunded"], 60_000);
    const deliveries: Delivery[] = [];
    for (const ev of evs) deliveries.push(await deliver(ev));
    const after = await memberState("sub");
    const refunds = await stripe.refunds.list({ payment_intent: pay!.stripePaymentIntentId ?? undefined, limit: 5 }, so()).then((x: J) => x.data.map((f: J) => ({ id: f.id, status: f.status, amount: f.amount })), (e: J) => errShape(e));
    rec("10a_refund", { paymentRow: pay!.id, httpStatus: r.status, body: redact(JSON.stringify(r.body)).slice(0, 300), stripeRefunds: refunds, deliveries, paymentAfter: after.payments.find((p) => p.id === pay!.id), memberAfter: { paymentStatus: after.member?.paymentStatus, status: after.member?.status } });
    expect(r.status).toBe(200);
    expect(["refunded"]).toContain(after.payments.find((p) => p.id === pay!.id)?.status);

    // 10b dispute: first invoice paid with the dispute test card (4000000000000259 = pm_card_createDispute)
    const t1 = now();
    const s = await subscribeViaApp("dispute");
    const ds = await memberState("dispute");
    const cus = ds.member!.stripeCustomerId!;
    const pi = await stripe.paymentIntents.confirm(s.pi, { payment_method: "pm_card_createDispute" }, so());
    const payEvents = await eventsFor(mentions(cus), t1, ["invoice.payment_succeeded", "customer.subscription.updated", "payment_intent.succeeded"]);
    const dd: Delivery[] = [];
    for (const ev of payEvents) dd.push(await deliver(ev));
    const disputeEvents = await eventsFor((e) => e.type === "charge.dispute.created" && mentions(s.pi)(e), t1, ["charge.dispute.created"], 120_000);
    for (const ev of disputeEvents) dd.push(await deliver(ev));
    const after2 = await memberState("dispute");
    rec("10b_dispute", { subscription: s.sub, paymentIntent: s.pi, piStatus: pi.status, disputeEvent: disputeEvents.map((e) => ({ id: e.id, dispute: e.data.object.id, status: e.data.object.status, reason: e.data.object.reason })), deliveries: dd, after: { paymentStatus: after2.member?.paymentStatus, payments: after2.payments } });
    expect(disputeEvents.length).toBeGreaterThan(0);
    expect(after2.payments.some((p) => p.status === "disputed")).toBe(true);
  }, 400_000);
});
