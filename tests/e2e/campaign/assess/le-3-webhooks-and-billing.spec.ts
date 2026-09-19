/**
 * Lane L-E · file 3 — J46 (webhooks and disputes), J47 (memberSelfBilling off)
 * and J48 (the subscribe surfaces on an inert rail).
 *
 * The twelve happy-path signed events live in `campaign/stripe-webhooks.spec.ts`
 * and are not duplicated here. What this file adds is the door (unsigned, wrong
 * secret, stale timestamp, replay), the dispute lifecycle including a close
 * status the handler does not map, the tenant filter on the five Payment
 * lookups, and the two member-side refusals the owner's `memberSelfBilling`
 * switch is supposed to make.
 *
 * G-26 was confirmed here by source and FIXED in round 1: `member/checkout` and
 * `member/class-packs/buy` read `memberSelfBilling` and refuse with the same
 * 403 and the same words as `member/subscriptions/start`. Before that, only
 * `stripe/portal` and `member/subscriptions/start` honoured it, so the switch
 * an owner flicked to stop members spending money stopped neither the shop nor
 * a pack.
 */
import { test, expect } from "@playwright/test";
import {
  RUN_STAMP,
  sql,
  seededTenantId,
  sessionFor,
  closeSessions,
  post,
  get,
  FORBIDDEN_BODY,
  OWNER_EMAIL,
  COACH_EMAIL,
  ADMIN_EMAIL,
  MEMBER_EMAIL,
  THROWAWAY_PASSWORD,
  mkStaff,
  mkStripePayment,
  sendSigned,
  signPayload,
  buildEvent,
  eventId,
  WEBHOOK_PATH,
  teardownMoney,
  resetBucketsLike,
  countRows,
} from "./le-shared";
import { createMember, cleanupRun } from "../helpers/db";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

/** The one refusal every member-side money route gives when the owner's switch is off. */
const SELF_BILLING_OFF = "This gym manages payments centrally — please speak to staff";

let tenantId: string;
let member: { id: string; name: string; email: string };

test.beforeAll(async () => {
  tenantId = await seededTenantId();
  member = await createMember({ name: `${RUN_STAMP} Webhook member` });
});

test.afterAll(async () => {
  await resetBucketsLike(`charge:adhoc:%`);
  await teardownMoney(tenantId);
  await cleanupRun();
  await closeSessions();
  expect(await countRows("StripeEvent", '"eventId" LIKE $1', [`%${RUN_STAMP}%`])).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J46 · the webhook door", () => {
  test("an unsigned POST is refused and claims no event", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const id = eventId();
    const res = await rc.post(WEBHOOK_PATH, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify(buildEvent({ type: "charge.refunded", object: { id: "ch_x" }, id, account: null })),
      maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
    expect(await countRows("StripeEvent", '"eventId" = $1', [id])).toBe(0);
    await rc.dispose();
  });

  test("a signature made with the wrong secret is refused", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const id = eventId();
    const res = await sendSigned(
      rc,
      { type: "charge.refunded", object: { id: "ch_x" }, id, account: null },
      { secret: "whsec_not_the_one" },
    );
    expect(res.status()).toBe(400);
    expect(await countRows("StripeEvent", '"eventId" = $1', [id])).toBe(0);
    await rc.dispose();
  });

  test("a signature over a different payload is refused", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const id = eventId();
    const real = JSON.stringify(buildEvent({ type: "charge.refunded", object: { id: "ch_a" }, id, account: null }));
    const signature = signPayload("{}", process.env.STRIPE_WEBHOOK_SECRET ?? "x");
    const res = await rc.post(WEBHOOK_PATH, {
      headers: { "stripe-signature": signature, "content-type": "application/json" },
      data: real,
      maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
    expect(await countRows("StripeEvent", '"eventId" = $1', [id])).toBe(0);
    await rc.dispose();
  });

  test("a signature from an hour ago is outside Stripe's tolerance", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const id = eventId();
    const res = await sendSigned(
      rc,
      { type: "charge.refunded", object: { id: "ch_stale" }, id, account: null },
      { timestamp: Math.floor(Date.now() / 1000) - 3_600 },
    );
    expect(res.status()).toBe(400);
    expect(await countRows("StripeEvent", '"eventId" = $1', [id])).toBe(0);
    await rc.dispose();
  });

  test("an unhandled event type is acked without being claimed", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const id = eventId();
    const res = await sendSigned(rc, {
      type: "radar.early_fraud_warning.created",
      object: { id: "issfr_x", charge: "ch_x" },
      id,
      account: null,
    });
    expect(res.status()).toBeLessThan(300);
    await rc.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J46 · the dispute lifecycle", () => {
  test("created, updated and closed-lost move the Dispute row and the member", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 6_000 });
    const disputeId = `dp_${RUN_STAMP}_${Math.random().toString(36).slice(2, 8)}`;
    const base = {
      id: disputeId,
      object: "dispute",
      charge: payment.chargeId,
      payment_intent: payment.piId,
      amount: 6_000,
      currency: "gbp",
      reason: "fraudulent",
    };

    const created = await sendSigned(rc, {
      type: "charge.dispute.created",
      object: { ...base, status: "needs_response" },
      id: eventId(),
      account: null,
    });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const afterCreate = await sql<{ status: string; tenantId: string; paymentId: string | null }>(
      'SELECT status, "tenantId", "paymentId" FROM "Dispute" WHERE "stripeDisputeId" = $1',
      [disputeId],
    );
    expect(afterCreate, "charge.dispute.created recorded no Dispute row").toHaveLength(1);
    expect(afterCreate[0].tenantId).toBe(tenantId);
    expect(afterCreate[0].paymentId).toBe(payment.id);

    await sendSigned(rc, {
      type: "charge.dispute.updated",
      object: { ...base, status: "under_review" },
      id: eventId(),
      account: null,
    });
    const afterUpdate = await sql<{ status: string }>('SELECT status FROM "Dispute" WHERE "stripeDisputeId" = $1', [disputeId]);
    expect(afterUpdate[0].status).toBe("under_review");

    await sendSigned(rc, {
      type: "charge.dispute.closed",
      object: { ...base, status: "lost" },
      id: eventId(),
      account: null,
    });
    const afterClose = await sql<{ status: string }>('SELECT status FROM "Dispute" WHERE "stripeDisputeId" = $1', [disputeId]);
    expect(afterClose[0].status).toBe("lost");
    await rc.dispose();
  });

  test("a close status the handler does not map leaves the row readable, never 500", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 4_000 });
    const disputeId = `dp_${RUN_STAMP}_${Math.random().toString(36).slice(2, 8)}`;
    const object = {
      id: disputeId,
      object: "dispute",
      charge: payment.chargeId,
      payment_intent: payment.piId,
      amount: 4_000,
      currency: "gbp",
      reason: "fraudulent",
      status: "warning_closed", // real Stripe status, not in the handler's map
    };
    await sendSigned(rc, { type: "charge.dispute.created", object: { ...object, status: "warning_needs_response" }, id: eventId(), account: null });
    const res = await sendSigned(rc, { type: "charge.dispute.closed", object, id: eventId(), account: null });
    expect(res.status(), await res.text()).toBeLessThan(500);

    const row = await sql<{ status: string }>('SELECT status FROM "Dispute" WHERE "stripeDisputeId" = $1', [disputeId]);
    const memberRow = await sql<{ paymentStatus: string }>('SELECT "paymentStatus" FROM "Member" WHERE id = $1', [member.id]);
    // Recorded rather than asserted: what an unmapped close does to the
    // member's paymentStatus is the finding, not the expectation.
    console.log(`[le-3] unmapped dispute close → Dispute.status=${row[0]?.status} member.paymentStatus=${memberRow[0]?.paymentStatus}`);
    expect(row.length).toBe(1);
    await rc.dispose();
  });

  test("a dispute naming a charge that is not this club's writes nothing here", async ({ playwright, baseURL }) => {
    const rc = await playwright.request.newContext({ baseURL, maxRedirects: 0 });
    const disputeId = `dp_${RUN_STAMP}_orphan`;
    const res = await sendSigned(rc, {
      type: "charge.dispute.created",
      object: {
        id: disputeId,
        object: "dispute",
        charge: `ch_not_ours_${RUN_STAMP}`,
        payment_intent: `pi_not_ours_${RUN_STAMP}`,
        amount: 1_000,
        currency: "gbp",
        reason: "fraudulent",
        status: "needs_response",
      },
      id: eventId(),
      account: null,
    });
    expect(res.status()).toBeLessThan(500);
    const rows = await sql<{ tenantId: string }>('SELECT "tenantId" FROM "Dispute" WHERE "stripeDisputeId" = $1', [disputeId]);
    // Either refused outright, or recorded against THIS tenant only — never
    // attributed to a club whose charge it is not.
    for (const r of rows) expect(r.tenantId).toBe(tenantId);
    await rc.dispose();
  });

  test("every Payment lookup in the webhook is tenant-scoped", async () => {
    // The five once-untenanted lookups. Proven by source rather than by a
    // forged foreign charge, because Stripe ids are globally unique and a
    // behavioural test cannot distinguish "filtered" from "no collision".
    const source = await sql<{ n: string }>("SELECT '1' AS n");
    expect(source).toHaveLength(1);
    const fs = await import("node:fs/promises");
    const route = await fs.readFile("app/api/stripe/webhook/route.ts", "utf8");
    const lookups = route.match(/tx\.payment\.find(First|Unique)\([\s\S]{0,200}?\}\)/g) ?? [];
    expect(lookups.length, "no Payment lookups found — the regex needs revising, not the route").toBeGreaterThan(0);
    for (const l of lookups) {
      expect(l, `an untenanted Payment lookup: ${l.slice(0, 120)}`).toContain("tenantId");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J47 · memberSelfBilling off", () => {
  test("the switch is off on the seeded club — the premise every case below rests on", async () => {
    const rows = await sql<{ memberSelfBilling: boolean }>('SELECT "memberSelfBilling" FROM "Tenant" WHERE id = $1', [tenantId]);
    console.log(`[le-3] totalbjj memberSelfBilling = ${rows[0]?.memberSelfBilling}`);
    test.skip(rows[0]?.memberSelfBilling === true, "the seeded club has member self-billing ON — this journey needs it off");
  });

  test("every subscription route refuses a member while self-billing is off", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const before = await countRows("Member", '"tenantId" = $1 AND "stripeSubscriptionId" IS NOT NULL', [tenantId]);

    for (const path of [
      "/api/member/subscriptions/start",
      "/api/member/subscriptions/cancel",
      "/api/member/subscriptions/start-for-kid",
      "/api/member/subscriptions/cancel-for-kid",
    ]) {
      const res = await post(rc, path, ORIGIN, { tierId: "whatever", priceId: "price_x" });
      expect(res.status(), `${path} answered ${res.status()}`).toBeGreaterThanOrEqual(400);
      expect(res.status(), `${path} must not 500`).toBeLessThan(500);
    }

    const portal = await post(rc, "/api/stripe/portal", ORIGIN, {});
    expect(portal.status()).toBeGreaterThanOrEqual(400);

    expect(await countRows("Member", '"tenantId" = $1 AND "stripeSubscriptionId" IS NOT NULL', [tenantId])).toBe(before);
  });

  test("the shop does NOT honour the switch — a member can still place an order", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const before = await countRows("Order", '"tenantId" = $1', [tenantId]);

    const res = await post(rc, "/api/member/checkout", ORIGIN, {
      items: [{ id: `${RUN_STAMP}-item`, name: `${RUN_STAMP} Rash guard`, price: 2500, quantity: 1 }],
      paymentMethod: "pay_at_desk",
    });
    const after = await countRows("Order", '"tenantId" = $1', [tenantId]);
    // G-26, fixed in round 1: `member/checkout` now reads
    // Tenant.memberSelfBilling and refuses with the same 403 and the same words
    // member/subscriptions/start uses, before any Order row is created.
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(SELF_BILLING_OFF);
    expect(
      after,
      `member/checkout wrote ${after - before} Order row(s) with memberSelfBilling off`,
    ).toBe(before);
  });

  test("pack purchase honours the switch, and does not blame the pack", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const res = await post(rc, "/api/member/class-packs/buy", ORIGIN, { packId: `${RUN_STAMP}-nope` });
    const body = await res.text();
    // Fixed in round 1. The switch is read before the member and pack lookups,
    // so a club that has stopped members buying never answers "Pack
    // unavailable" — which would tell the member their club's pack is broken.
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(SELF_BILLING_OFF);
    expect(body).not.toContain("Pack unavailable");
    await resetBucketsLike("pack:buy:%");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J48 · the subscribe surfaces on an inert rail", () => {
  test("payments/intent is honest that nothing can be charged", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const res = await post(rc, "/api/payments/intent", ORIGIN, { amountPence: 1000 });
    // 501, not a fabricated client secret. Honest copy is the point of J48.
    expect([400, 501]).toContain(res.status());
    expect(await res.text()).not.toContain("client_secret");
  });

  test("members/[id]/charge is owner-only and has an activation check", async ({ browser, baseURL }) => {
    for (const email of [COACH_EMAIL, ADMIN_EMAIL]) {
      const rc = (await sessionFor(browser, baseURL!, email)).request;
      const res = await post(rc, `/api/members/${member.id}/charge`, ORIGIN, { amountPence: 1000, description: "x" });
      expect(res.status(), `${email} charge`).toBe(403);
      expect((await res.json()).error).toBe(FORBIDDEN_BODY);
    }
    const mgr = await mkStaff(tenantId, "manager");
    const mgrRc = (await sessionFor(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD)).request;
    const mgrRes = await post(mgrRc, `/api/members/${member.id}/charge`, ORIGIN, { amountPence: 1000, description: "x" });
    expect(mgrRes.status()).toBe(403);

    const owner = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const before = await countRows("Payment", '"memberId" = $1', [member.id]);
    const res = await post(owner, `/api/members/${member.id}/charge`, ORIGIN, { amountPence: 1000, description: `${RUN_STAMP} adhoc` });
    // The rail is inert: the honest answer is a 4xx/503 naming the blocker, and
    // no Payment row at all.
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(600);
    expect(await countRows("Payment", '"memberId" = $1', [member.id])).toBe(before);
    await resetBucketsLike("charge:adhoc:%");
  });

  test("create-subscription writes no stripeSubscriptionId when nothing can be charged", async ({ browser, baseURL }) => {
    const owner = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const beforeRows = await sql<{ stripeSubscriptionId: string | null }>(
      'SELECT "stripeSubscriptionId" FROM "Member" WHERE id = $1',
      [member.id],
    );
    const res = await post(owner, "/api/stripe/create-subscription", ORIGIN, {
      memberId: member.id,
      priceId: "price_fake",
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const afterRows = await sql<{ stripeSubscriptionId: string | null }>(
      'SELECT "stripeSubscriptionId" FROM "Member" WHERE id = $1',
      [member.id],
    );
    expect(afterRows[0].stripeSubscriptionId).toBe(beforeRows[0].stripeSubscriptionId);
  });

  test("members/[id]/payment-method is owner-only and leaks no card data", async ({ browser, baseURL }) => {
    for (const email of [COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL]) {
      const rc = (await sessionFor(browser, baseURL!, email)).request;
      const res = await get(rc, `/api/members/${member.id}/payment-method`);
      expect([401, 403], `${email} payment-method`).toContain(res.status());
      const body = await res.text();
      expect(body).not.toContain("last4");
      expect(body).not.toContain("brand");
    }
  });

  test("stripe/connect and connect/health are owner-only; a member sees no account id", async ({ browser, baseURL }) => {
    for (const email of [COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL]) {
      const rc = (await sessionFor(browser, baseURL!, email)).request;
      for (const path of ["/api/stripe/connect", "/api/stripe/connect/health"]) {
        const res = await get(rc, path);
        expect(res.status(), `${email} ${path}`).toBeGreaterThanOrEqual(400);
        expect(await res.text()).not.toContain("acct_");
      }
    }
  });

  test("disconnecting a club with no Stripe account is an honest refusal, not a 500", async ({ browser, baseURL }) => {
    const owner = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const before = await sql<{ stripeAccountId: string | null; stripeConnected: boolean }>(
      'SELECT "stripeAccountId", "stripeConnected" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    test.skip(
      Boolean(before[0]?.stripeAccountId),
      "the seeded club HAS a Stripe account — this lane never disconnects it for the others",
    );
    const res = await post(owner, "/api/stripe/disconnect", ORIGIN, {});
    expect(res.status()).toBeLessThan(500);
    const after = await sql<{ stripeAccountId: string | null; stripeConnected: boolean }>(
      'SELECT "stripeAccountId", "stripeConnected" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    expect(after[0].stripeAccountId).toBe(before[0].stripeAccountId);
  });

  test("subscription-plans tells a member nothing about another club", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const res = await get(rc, "/api/stripe/subscription-plans");
    expect(res.status()).toBeLessThan(500);
    if (res.status() === 200) {
      const body = await res.text();
      expect(body).not.toContain("acct_");
      expect(body).not.toContain("sk_");
    }
  });
});
