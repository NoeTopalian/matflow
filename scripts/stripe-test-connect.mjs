#!/usr/bin/env node
/**
 * Give the test-branch club a Stripe connected account that can actually take a
 * card, so the money specs have something to charge.
 *
 * ## Why this exists
 *
 * The card path in MatFlow has never completed once, anywhere. Production holds
 * a live key with no webhook secret, so every delivery 400s; locally there was
 * no key at all. "The handlers are correct" is a claim about unit tests, not
 * about money moving. Phase 5 of the campaign turns that into a real charge —
 * and a real charge needs a connected account with `charges_enabled: true`.
 *
 * The test branch already carries `acct_1U5GYIJnyjViQoWL`: a **Standard**
 * account created by a genuine OAuth handshake at some point, whose onboarding
 * was never completed. `details_submitted: false`, six requirements past due,
 * charges off. Stripe will not let the API finish a Standard account's
 * onboarding — `tos_acceptance` is settable only where the platform collects
 * requirements — so that account cannot be rescued from here.
 *
 * ## Use `--link`. The account-creation path is closed by DECISION.
 *
 * The obvious shortcut is to create an account whose requirements the PLATFORM
 * collects (`requirement_collection: "application"`) and fill them with Stripe's
 * test values. Stripe will not allow that until the platform accepts
 * responsibilities at `dashboard.stripe.com/settings/connect/platform-profile`,
 * and on **17 September 2026 Noe reviewed both of those screens and declined
 * both**:
 *
 *   - the heavy one carries onboarding review, **risk underwriting**, risk
 *     monitoring, and **loss liability plus Radar fees**;
 *   - the lighter one carries seller communication, remediation and "ongoing
 *     seller compliance" — no financial liability, declined for consistency.
 *
 * That is the correct call, and it is not a configuration gap. MatFlow uses
 * **Standard** Connect via OAuth: the gym is merchant of record, Stripe collects
 * onboarding, the gym bears its own losses, MatFlow never holds funds and takes
 * no application fee. Accepting platform loss liability would contradict the
 * product's design and its strongest sales line in one stroke — *"we take zero
 * cut of your members' money, and it isn't even our processor"*.
 *
 * So `--link` is the route: it completes the EXISTING Standard account's
 * onboarding through Stripe's own hosted flow. No agreement needed, and a
 * **better** test than the shortcut, because it is the path a real gym walks on
 * day one — the onboarding half that the shortcut explicitly could not prove.
 *
 * Usage:
 *   node --env-file=.env.test scripts/stripe-test-connect.mjs --link     <-- start here
 *   node --env-file=.env.test scripts/stripe-test-connect.mjs --status
 *   node --env-file=.env.test scripts/stripe-test-connect.mjs [--tenant totalbjj]
 */

import Stripe from "stripe";
import pg from "pg";

const PRODUCTION_ENDPOINT = "ep-bold-wave";
const LIVE_PREFIXES = ["sk_live_", "rk_live_", "pk_live_"];

function die(msg) {
  console.error(`\n  REFUSED: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Guards. This script writes to a database AND creates Stripe objects, so it
// carries both brakes — the same pair tests/e2e/global-setup.ts applies.
// ---------------------------------------------------------------------------
const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl) die("DATABASE_URL is not set.");
if (dbUrl.includes(PRODUCTION_ENDPOINT)) {
  die(`DATABASE_URL points at PRODUCTION (${PRODUCTION_ENDPOINT}).`);
}

const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
if (!secretKey) die("STRIPE_SECRET_KEY is not set. Put the SANDBOX key in .env.test.");
const livePrefix = LIVE_PREFIXES.find((p) => secretKey.startsWith(p));
if (livePrefix) {
  die(
    `STRIPE_SECRET_KEY is a LIVE key (${livePrefix}…). This script creates a connected account and would do it in your real business.`,
  );
}

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const linkOnly = args.includes("--link");
const tenantSlug = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : "totalbjj";

const stripe = new Stripe(secretKey, { apiVersion: "2026-03-25.dahlia" });

/** Belt to the prefix check: ask Stripe itself which mode this key is in. */
async function assertSandbox() {
  const balance = await stripe.balance.retrieve();
  if (balance.livemode) {
    die("Stripe reports livemode:true for this key. Refusing to touch a live account.");
  }
}

async function describe(accountId) {
  const a = await stripe.accounts.retrieve(accountId);
  return {
    id: a.id,
    type: a.type ?? "(controller-based)",
    charges_enabled: a.charges_enabled,
    payouts_enabled: a.payouts_enabled,
    details_submitted: a.details_submitted,
    disabled_reason: a.requirements?.disabled_reason ?? null,
    currently_due: a.requirements?.currently_due ?? [],
  };
}

/**
 * A GB sole trader, filled with Stripe's documented test values.
 *
 * `address.line1: "address_full_match"` is a magic string Stripe's test mode
 * treats as a verified address; a plausible-looking real street would leave the
 * account pending verification and charges off, which is the failure this whole
 * script exists to avoid.
 */
async function createChargeableAccount() {
  const account = await stripe.accounts.create({
    country: "GB",
    email: "e2e-club@matflow.test",
    controller: {
      // The platform collects requirements — the one thing a Standard account
      // does not allow, and the only reason this script can finish onboarding
      // without a browser.
      requirement_collection: "application",
      fees: { payer: "application" },
      losses: { payments: "application" },
      stripe_dashboard: { type: "none" },
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: "individual",
    business_profile: {
      mcc: "7997", // membership clubs (sports, recreation, athletic)
      url: "https://matflow.studio",
      product_description: "Brazilian jiu-jitsu class memberships and drop-ins",
      support_phone: "+447700900000",
    },
    individual: {
      first_name: "E2E",
      last_name: "Testclub",
      email: "e2e-club@matflow.test",
      phone: "+447700900000",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "address_full_match",
        city: "London",
        postal_code: "WC2N 5DU",
        country: "GB",
      },
    },
    external_account: {
      object: "bank_account",
      country: "GB",
      currency: "gbp",
      account_number: "00012345",
      routing_number: "108800",
    },
    tos_acceptance: {
      date: Math.floor(Date.now() / 1000),
      ip: "127.0.0.1",
    },
    metadata: { created_by: "matflow scripts/stripe-test-connect.mjs", purpose: "e2e" },
  });
  return account;
}

async function main() {
  await assertSandbox();

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, slug, name, "stripeAccountId", "stripeConnected", currency FROM "Tenant" WHERE slug = $1',
      [tenantSlug],
    );
    if (rows.length === 0) die(`No tenant with slug "${tenantSlug}" on this database.`);
    const tenant = rows[0];

    console.log(`tenant           : ${tenant.name} (${tenant.slug}) — ${tenant.currency}`);
    console.log(`stripeAccountId  : ${tenant.stripeAccountId ?? "(none)"}`);
    console.log(`stripeConnected  : ${tenant.stripeConnected}`);

    // ── --link: the route actually in use ──────────────────────────────────
    //
    // Completes the EXISTING Standard account's onboarding through Stripe's own
    // hosted flow. No platform responsibilities to accept, and a better test
    // than creating one: it is the path a real gym walks on day one.
    if (linkOnly) {
      if (!tenant.stripeAccountId) {
        die(
          `${tenantSlug} has no stripeAccountId, so there is nothing to onboard. Connect one through the app first: Settings → Revenue → Connect Stripe.`,
        );
      }
      const state = await describe(tenant.stripeAccountId);
      if (state.charges_enabled) {
        console.log("");
        console.log("  Already chargeable — no onboarding needed.");
        if (!tenant.stripeConnected) {
          await client.query('UPDATE "Tenant" SET "stripeConnected" = true WHERE id = $1', [
            tenant.id,
          ]);
          console.log("  (flipped stripeConnected → true)");
        }
        console.log("");
        return;
      }

      // Account links are SINGLE USE and expire, so one is minted on demand
      // rather than stored anywhere. Re-run this command for a fresh one.
      const link = await stripe.accountLinks.create({
        account: tenant.stripeAccountId,
        refresh_url: "http://localhost:3847/dashboard/settings?tab=revenue",
        return_url: "http://localhost:3847/dashboard/settings?tab=revenue&connected=true",
        type: "account_onboarding",
      });

      console.log("");
      console.log("  Open this and click through with Stripe's TEST data:");
      console.log("");
      console.log(`    ${link.url}`);
      console.log("");
      console.log("  Single use, and it expires — re-run this command for a fresh one.");
      console.log(`  Still outstanding: ${state.currently_due.join(", ") || "(none listed)"}`);
      console.log("");
      console.log("  When you are through, run:");
      console.log("    node --env-file=.env.test scripts/stripe-test-connect.mjs --status");
      console.log("");
      return;
    }

    if (tenant.stripeAccountId) {
      const existing = await describe(tenant.stripeAccountId).catch((e) => ({ error: e.message }));
      console.log(`existing account : ${JSON.stringify(existing)}`);
      if (existing.charges_enabled) {
        if (!tenant.stripeConnected) {
          await client.query('UPDATE "Tenant" SET "stripeConnected" = true WHERE id = $1', [
            tenant.id,
          ]);
          console.log("\n  Account can already take charges. Flipped stripeConnected → true.\n");
        } else {
          console.log("\n  Already connected and chargeable. Nothing to do.\n");
        }
        return;
      }
    }

    if (statusOnly) {
      console.log("\n  --status given: reporting only, nothing created.\n");
      return;
    }

    console.log("\ncreating a chargeable test connected account…");
    const account = await createChargeableAccount();
    const state = await describe(account.id);
    console.log(`created          : ${JSON.stringify(state)}`);

    if (!state.charges_enabled) {
      die(
        `The new account still cannot take charges (${state.disabled_reason}). Outstanding: ${state.currently_due.join(", ")}`,
      );
    }

    await client.query(
      'UPDATE "Tenant" SET "stripeAccountId" = $1, "stripeConnected" = true WHERE id = $2',
      [account.id, tenant.id],
    );
    console.log(`\n  ${tenant.slug} → ${account.id}, charges enabled, stripeConnected = true.\n`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("\n  FAILED:", e.message, "\n");
  process.exit(1);
});
