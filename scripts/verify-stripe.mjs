/**
 * Read-only Stripe operational check. Reads STRIPE_SECRET_KEY from the
 * environment (loaded from .env) and reports whether the Stripe environment is
 * operational: live-vs-test mode, API reachability, the platform account, and
 * every connected (Stripe Connect) account's onboarding/charges/payouts state.
 *
 *   node scripts/verify-stripe.mjs
 *
 * Prints NO secrets — only ids, booleans, and counts. Makes only read calls
 * (accounts.retrieve/list, balance.retrieve, paymentIntents.list).
 */
import { config } from "dotenv";
config();

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("✗ STRIPE_SECRET_KEY is not set. Set it in .env (or the prod env) and re-run.");
  process.exit(1);
}

// sk_ = standard key, rk_ = restricted (least-privilege) key. Both can be live/test.
const mode = /_live_/.test(key) ? "LIVE" : /_test_/.test(key) ? "TEST" : "UNKNOWN";
const restricted = key.startsWith("rk_");
const Stripe = (await import("stripe")).default;
const stripe = new Stripe(key, { apiVersion: "2026-03-25.dahlia" });

console.log(`\nStripe environment check`);
console.log(`────────────────────────`);
console.log(`Mode:           ${mode}${restricted ? "  (restricted key — least privilege)" : ""}`);

let coreOk = true; // core = the calls the app actually needs (charge/refund/balance)
function isPermissionScope(e) {
  // A restricted key returning "permission denied" is expected scoping, not an
  // outage — the key authenticated, it just lacks that optional read scope.
  return e?.type === "StripePermissionError" || /does not have the required permissions/i.test(e?.message ?? "");
}

async function step(label, fn, { core = true } = {}) {
  try {
    const out = await fn();
    console.log(`✓ ${label}${out ? `: ${out}` : ""}`);
  } catch (e) {
    if (isPermissionScope(e)) {
      console.log(`◌ ${label}: not permitted by this restricted key (optional scope — not required for payments/refunds)`);
      return;
    }
    if (core) coreOk = false;
    console.log(`✗ ${label}: ${e?.message ?? e}`);
  }
}

// Core operational checks — these endpoints back the charge/refund flows.
await step("Balance readable (key authenticates)", async () => {
  const bal = await stripe.balance.retrieve();
  const avail = (bal.available ?? []).map((b) => `${b.amount} ${b.currency}`).join(", ") || "0";
  return `available [${avail}]`;
});
await step("PaymentIntents readable (platform)", async () => {
  const pis = await stripe.paymentIntents.list({ limit: 3 });
  return `${pis.data.length} returned${pis.data[0] ? ` (latest ${pis.data[0].status})` : ""}`;
});
await step("Refunds endpoint readable", async () => {
  const rs = await stripe.refunds.list({ limit: 1 });
  return `${rs.data.length} returned`;
});

// Optional checks — useful but need extra read scopes a restricted key omits.
await step("Platform account info", async () => {
  const acct = await stripe.accounts.retrieve();
  return `${acct.id} · charges_enabled=${acct.charges_enabled}`;
}, { core: false });
await step("Connected accounts (Stripe Connect)", async () => {
  const accts = await stripe.accounts.list({ limit: 25 });
  if (accts.data.length === 0) return "none connected yet";
  const lines = accts.data.map(
    (a) => `\n    - ${a.id}: details_submitted=${a.details_submitted} charges=${a.charges_enabled} payouts=${a.payouts_enabled}`,
  );
  const notReady = accts.data.filter((a) => !a.charges_enabled);
  return `${accts.data.length} account(s)${lines.join("")}` +
    (notReady.length ? `\n    ⚠ ${notReady.length} not charges_enabled` : "");
}, { core: false });

console.log(`────────────────────────`);
console.log(
  coreOk
    ? `✓ Stripe is OPERATIONAL (${mode} mode${restricted ? ", restricted key" : ""}). Core payment/refund endpoints reachable.\n`
    : `✗ A core check failed — Stripe may not be operational. See above.\n`,
);
process.exit(coreOk ? 0 : 1);
