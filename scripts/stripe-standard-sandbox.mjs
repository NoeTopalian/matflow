#!/usr/bin/env node
// Payments lane TS (11 Oct 2026) — Stripe TEST-MODE sandbox for the Standard
// connected-account integration MatFlow actually ships.
//
//   node scripts/stripe-standard-sandbox.mjs create-account <outJson>
//   node scripts/stripe-standard-sandbox.mjs status <acct_id> [outJson]
//   node scripts/stripe-standard-sandbox.mjs cleanup <acct_id> [outJson]
//
// Rules this script enforces on itself:
//  - reads STRIPE_SECRET_KEY from .env.test only (never the production .env);
//  - refuses unless the key starts with sk_test_ (test mode only);
//  - never prints a key, a client secret or card data — ids and booleans only;
//  - creates at most ONE Standard account per `create-account` call, tagged
//    metadata.matflowLane = "TS";
//  - every call after account creation is made AS that account
//    ({ stripeAccount }) — direct charges, as the product does.
//
// What it cannot do: the OAuth browser handshake (a human signed in to Stripe
// and a registered redirect are required). A platform-created Standard account
// is connected to a club by writing the same three columns the OAuth callback
// writes (see tests/integration/pay-ts-standard-sandbox-db.test.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(ROOT + "/package.json");
const StripeMod = require("stripe");
const Stripe = StripeMod.default ?? StripeMod;

function testKey() {
  const line = readFileSync(resolve(ROOT, ".env.test"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("STRIPE_SECRET_KEY="));
  const key = (line ?? "").slice("STRIPE_SECRET_KEY=".length).trim().replace(/^"|"$/g, "");
  if (!key.startsWith("sk_test_")) {
    console.log("REFUSED: .env.test STRIPE_SECRET_KEY is not a test-mode secret key (sk_test_)");
    process.exit(2);
  }
  return key;
}

const stripe = new Stripe(testKey(), { apiVersion: "2026-03-25.dahlia", maxNetworkRetries: 1, timeout: 30000 });
const redact = (s) =>
  String(s ?? "")
    .replace(/[sr]k_(test|live)_[*A-Za-z0-9]+/g, "<key>")
    .replace(/(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, "<client_secret>")
    .replace(/whsec_[A-Za-z0-9]+/g, "<whsec>")
    .slice(0, 300);
const errShape = (e) => ({ type: e?.type ?? null, code: e?.code ?? null, statusCode: e?.statusCode ?? null, message: redact(e?.message) });

function accountShape(a) {
  return {
    id: a.id,
    type: a.type ?? null,
    controller: a.controller
      ? { type: a.controller.type ?? null, is_controller: a.controller.is_controller ?? null, stripe_dashboard: a.controller.stripe_dashboard?.type ?? null, losses: a.controller.losses?.payments ?? null, fees: a.controller.fees?.payer ?? null }
      : null,
    livemode: a.livemode ?? null,
    country: a.country ?? null,
    default_currency: a.default_currency ?? null,
    charges_enabled: a.charges_enabled ?? null,
    payouts_enabled: a.payouts_enabled ?? null,
    details_submitted: a.details_submitted ?? null,
    disabled_reason: a.requirements?.disabled_reason ?? null,
    currently_due_count: a.requirements?.currently_due?.length ?? null,
    past_due_count: a.requirements?.past_due?.length ?? null,
    capabilities: a.capabilities ?? null,
    metadata_lane: a.metadata?.matflowLane ?? null,
  };
}

function out(obj, file) {
  const text = JSON.stringify(obj, null, 2);
  console.log(text);
  if (file) writeFileSync(file, text + "\n");
}

const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === "create-account") {
  const createdAt = new Date().toISOString();
  const email = `ts-standard-${Date.now().toString(36)}@example.test`;
  try {
    const a = await stripe.accounts.create({ type: "standard", email, metadata: { matflowLane: "TS", createdAt } });
    out({ ok: true, createdAt, account: accountShape(a) }, arg1);
  } catch (e) {
    out({ ok: false, error: errShape(e) }, arg1);
    process.exit(1);
  }
} else if (cmd === "status") {
  if (!/^acct_[A-Za-z0-9]+$/.test(arg1 ?? "")) { console.log("usage: status <acct_id>"); process.exit(2); }
  try {
    const a = await stripe.accounts.retrieve(arg1);
    out({ ok: true, account: accountShape(a) }, arg2);
  } catch (e) {
    out({ ok: false, error: errShape(e) }, arg2);
    process.exit(1);
  }
} else if (cmd === "cleanup") {
  // Cancels every not-yet-ended subscription on the account (all were created
  // by this lane: the account is the lane's own), then lists what is left.
  if (!/^acct_[A-Za-z0-9]+$/.test(arg1 ?? "")) { console.log("usage: cleanup <acct_id>"); process.exit(2); }
  const opts = { stripeAccount: arg1 };
  const a = await stripe.accounts.retrieve(arg1);
  if (a.metadata?.matflowLane !== "TS") { console.log("REFUSED: account is not tagged matflowLane=TS"); process.exit(2); }
  const cancelled = [];
  const failed = [];
  for await (const s of stripe.subscriptions.list({ status: "all", limit: 100 }, opts)) {
    if (["canceled", "incomplete_expired"].includes(s.status)) continue;
    try {
      const c = await stripe.subscriptions.cancel(s.id, {}, opts);
      cancelled.push({ id: s.id, from: s.status, to: c.status });
    } catch (e) {
      failed.push({ id: s.id, status: s.status, error: errShape(e) });
    }
  }
  const left = [];
  for await (const s of stripe.subscriptions.list({ status: "all", limit: 100 }, opts)) left.push({ id: s.id, status: s.status });
  const customers = [];
  for await (const c of stripe.customers.list({ limit: 100 }, opts)) customers.push(c.id);
  out({ ok: failed.length === 0, account: arg1, cancelled, failed, subscriptionsNow: left, customersLeft: customers.length }, arg2);
  if (failed.length) process.exit(1);
} else {
  console.log("usage: create-account <outJson> | status <acct_id> [outJson] | cleanup <acct_id> [outJson]");
  process.exit(2);
}
