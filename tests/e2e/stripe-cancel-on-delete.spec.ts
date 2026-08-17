/**
 * Live Stripe test-mode exercise for audit P1-8: hard-deleting a member with
 * an active subscription must cancel it at Stripe BEFORE the cascade runs.
 *
 * Opt-in: SKIPS unless STRIPE_TEST_KEY (sk_test_...) is set — it needs the
 * one-off fixture from the campaign's stripe-testmode-setup script (a test
 * connected account + trialing subscription wired to a seeded member).
 * Refuses non-test keys and the prod DB outright.
 */
import { test, expect } from "@playwright/test";

const STRIPE_TEST_KEY = process.env.STRIPE_TEST_KEY ?? "";
const HAS_STRIPE = STRIPE_TEST_KEY.startsWith("sk_test_");

test.skip(!HAS_STRIPE, "STRIPE_TEST_KEY (sk_test_) not set — live Stripe exercise is opt-in");

test.beforeAll(() => {
  if ((process.env.DATABASE_URL ?? "").includes("ep-bold-wave")) {
    throw new Error("Refusing to run: DATABASE_URL points at the PROD Neon branch.");
  }
});

test.use({ storageState: "tests/e2e/.auth/owner.json" });

test("deleting a subscribed member cancels the Stripe subscription first", async ({ request }) => {
  test.setTimeout(120_000);

  // Find the fixture member (sam@example.com carries the test-mode subscription).
  const list = await request.get("/api/members?search=sam");
  expect(list.ok()).toBeTruthy();
  const members = (await list.json()) as { members?: Array<{ id: string; email: string }> } | Array<{ id: string; email: string }>;
  const rows = Array.isArray(members) ? members : (members.members ?? []);
  const sam = rows.find((m) => m.email === "sam@example.com");
  expect(sam, "seeded sam@example.com with a wired subscription must exist").toBeTruthy();

  // Read the subscription id from the API detail before deletion.
  const detail = await request.get(`/api/members/${sam!.id}`);
  expect(detail.ok()).toBeTruthy();
  const subId = ((await detail.json()) as { stripeSubscriptionId?: string }).stripeSubscriptionId;
  expect(subId, "fixture member must carry stripeSubscriptionId").toBeTruthy();

  // The exercise: hard delete through the real route. The CSRF guard demands
  // a same-origin Origin header, which bare API contexts don't send.
  const del = await request.delete(`/api/members/${sam!.id}?confirm=1`, {
    headers: { origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847" },
  });
  const body = (await del.json()) as { stripeSubscriptionsCancelled?: number };
  expect(del.status(), JSON.stringify(body)).toBe(200);
  expect(body.stripeSubscriptionsCancelled).toBe(1);

  // Independent verification against Stripe's test API: the subscription is
  // flagged to close at period end on the CONNECTED account.
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(STRIPE_TEST_KEY, { apiVersion: "2026-03-25.dahlia" });
  const acctList = await stripe.accounts.list({ limit: 10 });
  let verified = false;
  for (const acct of acctList.data) {
    try {
      // stripeAccount is a REQUEST OPTION (3rd arg) — as the 2nd arg it is
      // sent as an API param and Stripe rejects the call.
      const sub = await stripe.subscriptions.retrieve(subId!, {}, { stripeAccount: acct.id });
      expect(sub.cancel_at_period_end).toBe(true);
      verified = true;
      break;
    } catch {
      /* subscription lives on a different connected account — keep looking */
    }
  }
  expect(verified, "subscription must be found and cancel_at_period_end=true on Stripe").toBe(true);
});
