/**
 * Create / reconcile the MatFlow Stripe **Connect** event destination (webhook).
 *
 * MatFlow is multi-tenant: one webhook endpoint serves every club, and each
 * event is routed by `event.account` → Tenant.stripeAccountId. So the endpoint
 * MUST be a *connected-accounts* (Connect) endpoint, generated with the same
 * Stripe API version the app pins, and enabling exactly the event types the
 * handler in app/api/stripe/webhook/route.ts knows how to process.
 *
 * Usage:
 *   node scripts/setup-stripe-webhook.mjs                 # dry-run (default) — shows the diff, mutates nothing
 *   node scripts/setup-stripe-webhook.mjs --apply         # create or reconcile for real
 *   node scripts/setup-stripe-webhook.mjs --apply --prune # also remove enabled events NOT in the desired 15
 *   node scripts/setup-stripe-webhook.mjs --url=https://staging.example/api/stripe/webhook
 *   node scripts/setup-stripe-webhook.mjs --id=we_123     # target a specific endpoint (skip URL matching)
 *
 * Flags:
 *   --apply              actually create/update (otherwise dry-run)
 *   --prune              when reconciling, delete extra enabled_events not in the desired set
 *   --url=<url>          endpoint URL (default below)
 *   --api-version=<ver>  payload API version for CREATE (default below; create-only in Stripe)
 *   --id=<we_...>        operate on this endpoint id instead of matching by URL
 *
 * Reads STRIPE_SECRET_KEY from .env. On CREATE it prints the signing secret
 * (whsec_…) once — copy it into STRIPE_WEBHOOK_SECRET and redeploy. Reconcile
 * (update) does NOT change the secret. No other secrets are printed.
 *
 * Note on Stripe limits: `connect` and `api_version` are CREATE-ONLY. If an
 * existing endpoint has the wrong scope or api_version, this script cannot edit
 * those — it flags them and you must recreate (delete + create, or use --id on a
 * fresh create) to fix.
 */
import { config } from "dotenv";
config();

// ── Desired config ───────────────────────────────────────────────────────────
const DEFAULT_URL = "https://matflow.studio/api/stripe/webhook";
const DEFAULT_API_VERSION = "2026-03-25.dahlia"; // must match the apiVersion pinned across the app

// Keep in sync with HANDLED_EVENT_TYPES in app/api/stripe/webhook/route.ts (lines ~32-48).
const DESIRED_EVENTS = [
  "account.updated",
  "checkout.session.completed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "customer.deleted",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.voided",
  "mandate.updated",
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_method.detached",
].sort();

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : dflt;
};
const APPLY = has("--apply");
const PRUNE = has("--prune");
const URL = val("--url", DEFAULT_URL);
const API_VERSION = val("--api-version", DEFAULT_API_VERSION);
const TARGET_ID = val("--id", null);

// ── Stripe client ────────────────────────────────────────────────────────────
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("✗ STRIPE_SECRET_KEY is not set. Set it in .env (or the prod env) and re-run.");
  process.exit(1);
}
const mode = /_live_/.test(key) ? "LIVE" : /_test_/.test(key) ? "TEST" : "UNKNOWN";
const restricted = key.startsWith("rk_");
const Stripe = (await import("stripe")).default;
const stripe = new Stripe(key, { apiVersion: API_VERSION });

const line = "──────────────────────────────────────────────";
console.log(`\nStripe Connect webhook setup  (${APPLY ? "APPLY" : "DRY-RUN"})`);
console.log(line);
console.log(`Mode:        ${mode}${restricted ? "  (restricted key — may lack Webhook Endpoints write scope)" : ""}`);
console.log(`URL:         ${URL}`);
console.log(`API version: ${API_VERSION}   (create-only)`);
console.log(`Events:      ${DESIRED_EVENTS.length} desired`);
console.log(line);

const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const diff = (have) => ({
  missing: DESIRED_EVENTS.filter((e) => !have.includes(e)),
  extra: have.filter((e) => !DESIRED_EVENTS.includes(e)),
});

function reportDiff(have) {
  if (have.includes("*")) {
    console.log("  enabled_events = ['*'] (all events). Handler ignores unknown types, but explicit is preferred.");
    return { missing: [], extra: ["*"] };
  }
  const d = diff(have);
  if (d.missing.length === 0 && d.extra.length === 0) {
    console.log("  ✓ enabled_events already match the desired 15 exactly.");
  } else {
    if (d.missing.length) console.log(`  + missing (${d.missing.length}): ${d.missing.join(", ")}`);
    if (d.extra.length) console.log(`  ~ extra (${d.extra.length}, kept unless --prune): ${d.extra.join(", ")}`);
  }
  return d;
}

function permissionHint(e) {
  if (e?.type === "StripePermissionError" || /does not have the required permissions/i.test(e?.message ?? "")) {
    console.error(
      "\n✗ This key lacks the Webhook Endpoints scope. Re-run with a full sk_" +
        (mode === "LIVE" ? "live" : "test") +
        "_ key, or grant the restricted key 'Webhook Endpoints — write' in the Stripe Dashboard.",
    );
    return true;
  }
  return false;
}

try {
  // ── Find the target endpoint ───────────────────────────────────────────────
  let endpoint = null;
  if (TARGET_ID) {
    endpoint = await stripe.webhookEndpoints.retrieve(TARGET_ID);
  } else {
    const all = await stripe.webhookEndpoints.list({ limit: 100 });
    const matches = all.data.filter((e) => e.url === URL);
    if (matches.length > 1) {
      console.error(`✗ ${matches.length} endpoints share this URL — pass --id=we_... to disambiguate:`);
      for (const m of matches) console.error(`    ${m.id}  status=${m.status}  api_version=${m.api_version}`);
      process.exit(1);
    }
    endpoint = matches[0] ?? null;
  }

  // ── CREATE path ────────────────────────────────────────────────────────────
  if (!endpoint) {
    console.log("No existing endpoint for this URL → would CREATE a connected-accounts endpoint.");
    reportDiff([]);
    if (!APPLY) {
      console.log(`\n(dry-run) Re-run with --apply to create it. The signing secret prints once on create.`);
      process.exit(0);
    }
    const created = await stripe.webhookEndpoints.create({
      url: URL,
      enabled_events: DESIRED_EVENTS,
      connect: true, // ← connected-accounts scope (create-only)
      api_version: API_VERSION, // ← create-only
      description: "MatFlow multi-club Connect webhook (managed by scripts/setup-stripe-webhook.mjs)",
    });
    console.log(`\n✓ Created ${created.id}  (status=${created.status}, connect=true, api_version=${API_VERSION})`);
    console.log(line);
    console.log("ACTION REQUIRED — set this in your prod env, then redeploy:");
    console.log(`  STRIPE_WEBHOOK_SECRET=${created.secret}`);
    console.log(line);
    process.exit(0);
  }

  // ── RECONCILE path ─────────────────────────────────────────────────────────
  console.log(`Found ${endpoint.id}  status=${endpoint.status}  api_version=${endpoint.api_version}  livemode=${endpoint.livemode}`);

  // Flag create-only mismatches we cannot fix via update.
  if (endpoint.api_version && endpoint.api_version !== API_VERSION) {
    console.log(
      `  ⚠ api_version is ${endpoint.api_version}, desired ${API_VERSION}. This is create-only — to change it, ` +
        `delete + recreate (the handler reads invoice payment_intent/charge + dispute due_by, so payload shape matters).`,
    );
  }
  console.log("  ⚠ Scope (connect true/false) is NOT returned by the API — confirm in the Dashboard that this is a 'Connected accounts' destination.");

  const have = (endpoint.enabled_events ?? []).slice().sort();
  const d = reportDiff(have);

  const target = PRUNE
    ? DESIRED_EVENTS
    : Array.from(new Set([...have.filter((e) => e !== "*"), ...DESIRED_EVENTS])).sort();

  if (have.includes("*") ? false : setEq(have, target)) {
    console.log("\n✓ Nothing to change for enabled_events.");
  } else if (!APPLY) {
    console.log(`\n(dry-run) Would update enabled_events to ${target.length} types${PRUNE ? " (pruned to exactly the desired set)" : " (additive)"}.`);
    console.log("Re-run with --apply to write. Secret is unchanged on update.");
  } else {
    const updated = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: target });
    console.log(`\n✓ Updated ${updated.id} → ${updated.enabled_events.length} enabled events. Signing secret unchanged.`);
  }
  console.log("");
  process.exit(0);
} catch (e) {
  if (permissionHint(e)) process.exit(2);
  console.error(`\n✗ Failed: ${e?.message ?? e}`);
  process.exit(1);
}
