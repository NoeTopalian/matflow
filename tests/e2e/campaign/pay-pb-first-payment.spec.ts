import { test, expect, type Page, type Browser, type Frame } from "@playwright/test";
import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import { sql } from "./helpers/db";

/**
 * Payments lane PB (11 Oct 2026), audit F1 — the first membership payment
 * taken IN THE PRODUCT, in a real browser, through real Stripe.js, on a
 * Standard test account in Stripe's test mode.
 *
 * Journeys (one test each, run serially):
 *   1. staff subscribes a member and pays with 4242 → mapping active, Payment
 *      succeeded, paymentStatus paid, Member.status untouched
 *   2. 3-D Secure card 4000 0025 0000 3155 → authentication modal → success
 *   3. decline 4000 0000 0000 0002 → Stripe's message → retry with 4242 on the
 *      SAME PaymentIntent → success
 *   4. abandonment: Pay later → member reads pending (no entitlement change),
 *      the member's own page offers Finish payment, staff Resume works
 *   5. a confirmed guardian pays for a child from the family page
 *   6. an adult member self-subscribes from /member/membership
 *
 * What is real: the production build, the browser, Stripe.js loaded from
 * js.stripe.com with { stripeAccount }, the Payment Element iframe, the 3-D
 * Secure challenge, the PaymentIntents and subscriptions on the connected
 * test account, the events Stripe generates.
 *
 * What is NOT real, said out loud: Stripe does not deliver webhooks to this
 * local server (no public URL). After Stripe confirms, the spec fetches the
 * REAL events for that subscription and invoice from Stripe (events.list with
 * Stripe-Account) and POSTs them to /api/stripe/webhook signed with the
 * server's scratch secret — the same pattern as stripe-webhooks.spec.ts. The
 * club's cached account status is written fresh with chargesEnabled=true by
 * this fixture: the Standard test account has requirements past due (ToS needs
 * a human), so lane PA's guard would otherwise refuse money-in. That guard's
 * refusal paths are proven by lane PA, not here.
 *
 * Arrange in SQL / the Stripe API, act in the browser, assert in both.
 */

const DB = process.env.DATABASE_URL ?? "";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const ACCT = process.env.PB_STRIPE_ACCOUNT ?? "";
const WEBHOOK_SECRET = process.env.PB_WEBHOOK_SECRET ?? "";
const READY = DB.includes("ep-hidden-salad") && !DB.includes("ep-bold-wave") && KEY.startsWith("sk_test_") && ACCT.startsWith("acct_") && WEBHOOK_SECRET.length > 20;

const STAMP = `paypb${Date.now().toString(36)}`;
const PASSWORD = `Pb-${randomBytes(9).toString("hex")}`;
const TENANT = `${STAMP}-club`;
const stripe = new Stripe(KEY || "sk_test_unset", { apiVersion: "2026-03-25.dahlia" as never });
const onAcct = () => ({ stripeAccount: ACCT });

type Fx = {
  ownerEmail: string;
  members: Record<"m1" | "m2" | "m3" | "m4" | "parent" | "kid" | "adult", { id: string; email: string; name: string }>;
  price: { adult: string; kids: string };
  product: string[];
  since: number;
};
const fx = {} as Fx;
const createdSubs: string[] = [];

test.describe.configure({ mode: "serial", timeout: 300_000 });
test.skip(!READY, "needs the TEST branch, a test-mode key, PB_STRIPE_ACCOUNT and PB_WEBHOOK_SECRET (pay/PB runner)");

// ── arrange ────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  fx.since = Math.floor(Date.now() / 1000) - 5;
  // Real prices on the connected account: the subscription is created with them.
  const product = await stripe.products.create({ name: `PB adult ${STAMP}`, metadata: { matflowLane: "PB" } }, onAcct());
  const kidsProduct = await stripe.products.create({ name: `PB kids ${STAMP}`, metadata: { matflowLane: "PB" } }, onAcct());
  const adult = await stripe.prices.create({ product: product.id, unit_amount: 6500, currency: "gbp", recurring: { interval: "month" } }, onAcct());
  const kids = await stripe.prices.create({ product: kidsProduct.id, unit_amount: 3000, currency: "gbp", recurring: { interval: "month" } }, onAcct());
  fx.price = { adult: adult.id, kids: kids.id };
  fx.product = [product.id, kidsProduct.id];

  const status = JSON.stringify({ chargesEnabled: true, payoutsEnabled: true, requirementsPastDue: [], disabledReason: null, refreshedAt: new Date().toISOString() });
  await sql(
    `INSERT INTO "Tenant" ("id", "name", "slug", "stripeAccountId", "stripeConnected", "stripeAccountStatus", "memberSelfBilling", "onboardingCompleted")
     VALUES ($1, $2, $3, $4, true, $5::jsonb, true, true)`,
    [TENANT, `PB Club ${STAMP}`, STAMP, ACCT, status],
  );
  const hash = bcrypt.hashSync(PASSWORD, 10);
  fx.ownerEmail = `${STAMP}-owner@example.test`;
  await sql(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'owner', now())`,
    [`${STAMP}-owner`, TENANT, fx.ownerEmail, `PB Owner`, hash],
  );
  await sql(
    `INSERT INTO "MembershipTier" ("id", "tenantId", "name", "pricePence", "billingCycle", "stripePriceId", "isKids", "isActive", "updatedAt")
     VALUES ($1, $2, 'PB Adult Monthly', 6500, 'monthly', $3, false, true, now()), ($4, $2, 'PB Kids Monthly', 3000, 'monthly', $5, true, true, now())`,
    [`${STAMP}-tier-a`, TENANT, fx.price.adult, `${STAMP}-tier-k`, fx.price.kids],
  );
  const mk = async (key: keyof Fx["members"], extra: { parent?: string } = {}) => {
    const id = `${STAMP}-${key}`;
    const email = `${STAMP}-${key}@example.test`;
    const name = `PB ${key} ${STAMP.slice(-4)}`;
    await sql(
      `INSERT INTO "Member" ("id", "tenantId", "email", "name", "passwordHash", "status", "paymentStatus", "onboardingCompleted", "waiverAccepted", "parentMemberId", "guardianConfirmedAt", "accountType", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'active', 'paid', true, true, $6, $7, $8, now())`,
      [id, TENANT, email, name, extra.parent ? null : hash, extra.parent ?? null, extra.parent ? new Date() : null, extra.parent ? "kids" : "adult"],
    );
    return { id, email, name };
  };
  fx.members = {
    m1: await mk("m1"),
    m2: await mk("m2"),
    m3: await mk("m3"),
    m4: await mk("m4"),
    parent: await mk("parent"),
    adult: await mk("adult"),
    kid: undefined as never,
  };
  fx.members.kid = await mk("kid", { parent: fx.members.parent.id });
});

test.afterAll(async () => {
  for (const id of createdSubs) {
    await stripe.subscriptions.cancel(id, {}, onAcct()).catch(() => {});
  }
  for (const p of [fx.price?.adult, fx.price?.kids].filter(Boolean) as string[]) {
    await stripe.prices.update(p, { active: false }, onAcct()).catch(() => {});
  }
  for (const p of fx.product ?? []) await stripe.products.update(p, { active: false }, onAcct()).catch(() => {});
  await sql(`DELETE FROM "StripeEvent" WHERE "tenantId" = $1`, [TENANT]).catch(() => {});
  await sql(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, [TENANT]);
  await sql(`DELETE FROM "EmailLog" WHERE "tenantId" = $1`, [TENANT]).catch(() => {});
  await sql(`DELETE FROM "LoginEvent" WHERE "tenantId" = $1`, [TENANT]).catch(() => {});
  await sql(`DELETE FROM "Payment" WHERE "tenantId" = $1`, [TENANT]);
  await sql(`DELETE FROM "MemberSubscription" WHERE "tenantId" = $1`, [TENANT]);
  await sql(`DELETE FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IS NOT NULL`, [TENANT]);
  await sql(`DELETE FROM "Member" WHERE "tenantId" = $1`, [TENANT]);
  await sql(`DELETE FROM "MembershipTier" WHERE "tenantId" = $1`, [TENANT]);
  await sql(`DELETE FROM "User" WHERE "tenantId" = $1`, [TENANT]);
  await sql(`DELETE FROM "Tenant" WHERE "id" = $1`, [TENANT]);
  const left = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "Member" WHERE "tenantId" = $1`, [TENANT]);
  console.log(`[pay-pb] cleanup: members left for ${TENANT} = ${left[0]?.n}; subscriptions cancelled = ${createdSubs.join(",")}`);
});

// ── helpers ────────────────────────────────────────────────────────────────

async function login(browser: Browser, email: string, expectUrl: RegExp): Promise<Page> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  // Browser-side errors (including the payment step's Payment Element load
  // errors) go to the run log so a failure says why.
  const who = email.split("@")[0].split("-").pop();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[browser:${who}] ${m.text().slice(0, 400)}`);
  });
  page.on("pageerror", (e) => console.log(`[pageerror:${who}] ${e.message.slice(0, 400)}`));
  page.on("requestfailed", (r) => {
    if (/stripe/.test(r.url())) console.log(`[requestfailed:${who}] ${r.url().split("?")[0]} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (/api\.stripe\.com/.test(r.url())) console.log(`[stripe-api:${who}] ${r.status()} ${r.url().split("?")[0]}`);
  });
  await page.goto(`/login?club=${STAMP}`);
  await page.waitForSelector("input[type='email']", { timeout: 60_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", PASSWORD);
  await page.click("button[type='submit']");
  await page.waitForURL(expectUrl, { timeout: 60_000 });
  return page;
}

/** The Payment Element's card iframe (Stripe renders it from js.stripe.com). */
function cardFrame(page: Page) {
  return page.frameLocator('iframe[name^="__privateStripeFrame"][title*="payment input"]').first();
}

async function fillCard(page: Page, number: string) {
  const f = cardFrame(page);
  const num = f.locator('input[name="number"]');
  await expect(num).toBeVisible({ timeout: 60_000 });
  await num.fill("");
  await num.fill(number);
  await f.locator('input[name="expiry"]').fill("12 / 34");
  await f.locator('input[name="cvc"]').fill("123");
  const postal = f.locator('input[name="postalCode"]');
  if (await postal.count()) await postal.fill("SW1A 1AA");
}

/** Click "Complete" inside Stripe's 3-D Secure test challenge, wherever it is nested. */
async function completeThreeDS(page: Page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames() as Frame[]) {
      // Stripe's "3D Secure 2 Test Page" (COMPLETE / FAIL); older pages used #test-source-authorize-3ds.
      for (const btn of [frame.locator("#test-source-authorize-3ds"), frame.getByRole("button", { name: /^complete$/i })]) {
        if (await btn.count().catch(() => 0)) {
          await btn.first().click();
          return;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("3-D Secure challenge never appeared");
}

function sign(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex")}`;
}

/**
 * Fetch the REAL events Stripe generated for this subscription and its first
 * invoice on the connected account and POST them, signed, to the local server
 * in creation order. Waits until Stripe has produced both the subscription's
 * move to `active` and the invoice's payment.
 */
async function deliverRealEvents(page: Page, subscriptionId: string, until: "paid" | "failed" = "paid"): Promise<string[]> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {}, onAcct());
  const invoiceId = typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id;
  const wanted = new Set(["customer.subscription.created", "customer.subscription.updated", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.payment_action_required"]);
  let events: Stripe.Event[] = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const list = await stripe.events.list({ created: { gte: fx.since }, limit: 100 }, onAcct());
    events = list.data.filter((e) => {
      const o = e.data.object as { id?: string };
      return wanted.has(e.type) && (o.id === subscriptionId || o.id === invoiceId);
    });
    const active = events.some((e) => e.type === "customer.subscription.updated" && (e.data.object as { status?: string }).status === "active");
    const paid = events.some((e) => e.type === "invoice.payment_succeeded");
    if (until === "paid" && active && paid) break;
    if (until === "failed" && events.some((e) => e.type === "invoice.payment_failed")) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  events.sort((a, b) => a.created - b.created);
  const delivered: string[] = [];
  for (const e of events) {
    // Events read back through the API carry no `account`; a Connect endpoint
    // receives it on every event, so it is set here (and only here).
    const payload = JSON.stringify({ ...e, account: (e as { account?: string }).account ?? ACCT });
    const res = await page.request.post("/api/stripe/webhook", {
      headers: { "content-type": "application/json", "stripe-signature": sign(payload) },
      data: payload,
    });
    delivered.push(`${e.type}:${e.id}:${res.status()}`);
    expect(res.status(), `${e.type} ${e.id}`).toBe(200);
  }
  console.log(`[pay-pb] delivered for ${subscriptionId}: ${delivered.join(" ")}`);
  return delivered;
}

async function memberRow(id: string) {
  const r = await sql<{ status: string; paymentStatus: string; stripeSubscriptionId: string | null }>(
    `SELECT status, "paymentStatus", "stripeSubscriptionId" FROM "Member" WHERE id = $1`,
    [id],
  );
  return r[0];
}
async function mappingRow(sub: string) {
  const r = await sql<{ status: string; endedAt: Date | null; stripeAccountId: string; memberId: string }>(
    `SELECT status, "endedAt", "stripeAccountId", "memberId" FROM "MemberSubscription" WHERE "stripeSubscriptionId" = $1`,
    [sub],
  );
  return r[0];
}
async function paymentFor(memberId: string) {
  return sql<{ status: string; amountPence: number; stripeInvoiceId: string | null }>(
    `SELECT status, "amountPence", "stripeInvoiceId" FROM "Payment" WHERE "memberId" = $1 ORDER BY "createdAt" DESC`,
    [memberId],
  );
}

async function staffStart(page: Page, memberId: string): Promise<string> {
  await page.goto(`/dashboard/members/${memberId}`);
  await page.getByRole("button", { name: /start membership/i }).first().click();
  const sheet = page.getByRole("dialog");
  const tierValue = await sheet.locator("option", { hasText: "PB Adult Monthly" }).getAttribute("value");
  await sheet.getByLabel(/membership tier/i).selectOption(tierValue!);
  await sheet.locator("button[type='submit']").click();
  await expect(page.getByTestId("confirm-subscription-payment")).toBeVisible({ timeout: 60_000 });
  const row = await memberRow(memberId);
  expect(row.stripeSubscriptionId).toMatch(/^sub_/);
  createdSubs.push(row.stripeSubscriptionId!);
  return row.stripeSubscriptionId!;
}

async function expectPaid(memberId: string, sub: string) {
  const m = await mappingRow(sub);
  expect(m).toMatchObject({ status: "active", stripeAccountId: ACCT, memberId });
  expect(m.endedAt).toBeNull();
  const pays = await paymentFor(memberId);
  expect(pays[0]).toMatchObject({ status: "succeeded", amountPence: expect.any(Number) });
  const row = await memberRow(memberId);
  expect(row).toMatchObject({ status: "active", paymentStatus: "paid", stripeSubscriptionId: sub });
  // Paid on the club's connected account, never the platform.
  const live = await stripe.subscriptions.retrieve(sub, {}, onAcct());
  expect(live.status).toBe("active");
}

// ── journeys ───────────────────────────────────────────────────────────────

test("1. staff subscribes a member and takes the first payment with 4242", async ({ browser }) => {
  const page = await login(browser, fx.ownerEmail, /dashboard/);
  const sub = await staffStart(page, fx.members.m1.id);
  // Before paying: pending, not active, Member.status untouched.
  expect(await memberRow(fx.members.m1.id)).toMatchObject({ status: "active", paymentStatus: "pending" });
  expect((await mappingRow(sub)).status).toBe("incomplete");

  await fillCard(page, "4242 4242 4242 4242");
  await page.getByRole("button", { name: /^pay £/i }).click();
  await expect(page.getByTestId("confirm-subscription-payment")).toHaveAttribute("data-stage", /recording|paid|unrecorded/, { timeout: 90_000 });
  await deliverRealEvents(page, sub);
  // The drawer announces success only once MatFlow has the payment, then closes.
  await expect(page.getByText(/first payment received/i)).toBeVisible({ timeout: 60_000 });
  await expectPaid(fx.members.m1.id, sub);
});

test("2. 3-D Secure card: the authentication modal completes and the payment succeeds", async ({ browser }) => {
  const page = await login(browser, fx.ownerEmail, /dashboard/);
  const sub = await staffStart(page, fx.members.m2.id);
  await fillCard(page, "4000 0025 0000 3155");
  await page.getByRole("button", { name: /^pay £/i }).click();
  await completeThreeDS(page);
  await expect(page.getByTestId("confirm-subscription-payment")).toHaveAttribute("data-stage", /recording|paid|unrecorded/, { timeout: 90_000 });
  await deliverRealEvents(page, sub);
  await expect(page.getByText(/first payment received/i)).toBeVisible({ timeout: 60_000 });
  await expectPaid(fx.members.m2.id, sub);
});

test("3. decline shows Stripe's message; retry with 4242 succeeds on the same PaymentIntent", async ({ browser }) => {
  const page = await login(browser, fx.ownerEmail, /dashboard/);
  const sub = await staffStart(page, fx.members.m3.id);
  const before = await stripe.subscriptions.retrieve(sub, { expand: ["latest_invoice.payments"] }, onAcct());
  const piBefore = (before.latest_invoice as Stripe.Invoice).payments?.data?.[0]?.payment?.payment_intent;

  await fillCard(page, "4000 0000 0000 0002");
  await page.getByRole("button", { name: /^pay £/i }).click();
  const alert = page.getByTestId("confirm-subscription-payment").getByRole("alert");
  await expect(alert).toContainText(/declined/i, { timeout: 60_000 });
  expect((await memberRow(fx.members.m3.id)).paymentStatus).toBe("pending");
  // What MatFlow records when Stripe reports the declined FIRST payment (the
  // real invoice.payment_failed, delivered now rather than after the retry).
  // Observed and logged, not asserted: the rule belongs to lane PC's handler.
  await deliverRealEvents(page, sub, "failed");
  const afterDecline = await memberRow(fx.members.m3.id);
  const mails = await sql<{ templateId: string; status: string }>(
    `SELECT "templateId", status FROM "EmailLog" WHERE "tenantId" = $1 ORDER BY "createdAt"`,
    [TENANT],
  ).catch(() => []);
  const failedRows = await paymentFor(fx.members.m3.id);
  console.log(`[pay-pb] after a declined first payment: member=${JSON.stringify(afterDecline)} payments=${JSON.stringify(failedRows)} emails=${JSON.stringify(mails)}`);
  expect(afterDecline.status).toBe("active");

  await fillCard(page, "4242 4242 4242 4242");
  await page.getByRole("button", { name: /try again/i }).click();
  await expect(page.getByTestId("confirm-subscription-payment")).toHaveAttribute("data-stage", /recording|paid|unrecorded/, { timeout: 90_000 });
  const after = await stripe.subscriptions.retrieve(sub, { expand: ["latest_invoice.payments"] }, onAcct());
  const piAfter = (after.latest_invoice as Stripe.Invoice).payments?.data?.find((p) => p.status === "paid")?.payment?.payment_intent;
  // The retry confirmed the SAME PaymentIntent the decline was on.
  expect(piAfter).toBeTruthy();
  expect(typeof piAfter === "string" ? piAfter : (piAfter as { id: string }).id).toBe(
    typeof piBefore === "string" ? piBefore : (piBefore as { id: string } | undefined)?.id,
  );
  await deliverRealEvents(page, sub);
  await expect(page.getByText(/first payment received/i)).toBeVisible({ timeout: 60_000 });
  await expectPaid(fx.members.m3.id, sub);
});

test("4. abandonment: Pay later leaves it pending with no entitlement; the member sees it; Resume pays it", async ({ browser }) => {
  const staff = await login(browser, fx.ownerEmail, /dashboard/);
  const sub = await staffStart(staff, fx.members.m4.id);
  await expect(cardFrame(staff).locator('input[name="number"]')).toBeVisible({ timeout: 60_000 });
  await staff.getByRole("button", { name: /pay later/i }).click();
  await expect(staff.getByText(/first payment has not been taken/i)).toBeVisible();
  // Close the drawer altogether (Escape: in test mode Stripe's developer-tools
  // badge sits over the footer's Close button).
  await staff.keyboard.press("Escape");
  await expect(staff.getByRole("dialog")).toHaveCount(0);

  // Nothing was taken; the person's record is untouched; Stripe still waits.
  expect(await memberRow(fx.members.m4.id)).toMatchObject({ status: "active", paymentStatus: "pending", stripeSubscriptionId: sub });
  expect((await mappingRow(sub)).status).toBe("incomplete");
  expect(await paymentFor(fx.members.m4.id)).toEqual([]);
  expect((await stripe.subscriptions.retrieve(sub, {}, onAcct())).status).toBe("incomplete");

  // The member reads it as pending and is offered to finish it.
  const member = await login(browser, fx.members.m4.email, /member/);
  await member.goto("/member/membership");
  await expect(member.getByText(/first payment has not been completed/i)).toBeVisible({ timeout: 60_000 });
  await expect(member.getByRole("button", { name: /finish payment/i })).toBeVisible();

  // Staff reopen the drawer: the unpaid subscription is offered its first payment, not a second subscription.
  await staff.reload();
  await staff.getByRole("button", { name: /start membership/i }).first().click();
  await staff.getByRole("button", { name: /take the first payment/i }).click();
  await fillCard(staff, "4242 4242 4242 4242");
  await staff.getByRole("button", { name: /^pay £/i }).click();
  await expect(staff.getByTestId("confirm-subscription-payment")).toHaveAttribute("data-stage", /recording|paid|unrecorded/, { timeout: 90_000 });
  await deliverRealEvents(staff, sub);
  await expect(staff.getByText(/first payment received/i)).toBeVisible({ timeout: 60_000 });
  await expectPaid(fx.members.m4.id, sub);
  // Still exactly one subscription for this member.
  const maps = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "MemberSubscription" WHERE "memberId" = $1`, [fx.members.m4.id]);
  expect(maps[0].n).toBe("1");
});

test("5. a confirmed guardian subscribes their child and pays the first invoice", async ({ browser }) => {
  const page = await login(browser, fx.members.parent.email, /member/);
  await page.goto(`/member/family/${fx.members.kid.id}`);
  await page.getByText("PB Kids Monthly").click();
  await page.getByRole("button", { name: /subscribe and pay/i }).click();
  await expect(page.getByTestId("confirm-subscription-payment")).toBeVisible({ timeout: 60_000 });
  const kid = await memberRow(fx.members.kid.id);
  expect(kid.stripeSubscriptionId).toMatch(/^sub_/);
  const sub = kid.stripeSubscriptionId!;
  createdSubs.push(sub);
  await fillCard(page, "4242 4242 4242 4242");
  await page.getByRole("button", { name: /^pay £/i }).click();
  await expect(page.getByTestId("confirm-subscription-payment")).toHaveAttribute("data-stage", /recording|paid|unrecorded/, { timeout: 90_000 });
  await deliverRealEvents(page, sub);
  await expect(page.getByText(/first payment received/i)).toBeVisible({ timeout: 60_000 });
  await expectPaid(fx.members.kid.id, sub);
  // The parent's own record is not touched by the child's payment.
  expect(await memberRow(fx.members.parent.id)).toMatchObject({ status: "active", paymentStatus: "paid", stripeSubscriptionId: null });
});

test("6. an adult member self-subscribes from the member portal and pays", async ({ browser }) => {
  const page = await login(browser, fx.members.adult.email, /member/);
  await page.goto("/member/billing");
  await page.getByRole("link", { name: /membership plans/i }).click();
  await page.waitForURL(/\/member\/membership/);
  await page.getByRole("button", { name: /PB Adult Monthly/i }).click();
  await page.getByRole("button", { name: /continue to payment/i }).click();
  await expect(page.getByTestId("confirm-subscription-payment")).toBeVisible({ timeout: 60_000 });
  const row = await memberRow(fx.members.adult.id);
  const sub = row.stripeSubscriptionId!;
  expect(sub).toMatch(/^sub_/);
  createdSubs.push(sub);
  await fillCard(page, "4242 4242 4242 4242");
  await page.getByRole("button", { name: /^pay £/i }).click();
  await expect(page.getByTestId("confirm-subscription-payment")).toHaveAttribute("data-stage", /recording|paid|unrecorded/, { timeout: 90_000 });
  await deliverRealEvents(page, sub);
  await expect(page.getByText(/payment received/i)).toBeVisible({ timeout: 60_000 });
  await expectPaid(fx.members.adult.id, sub);
});
