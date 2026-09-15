// The e2e suite must never run against a LIVE Stripe key.
//
// tests/e2e/global-setup.ts already refuses the production database. That guard
// is complete for the database and worth nothing for money: the campaign money
// specs create customers, start subscriptions, record payments and issue
// refunds through whatever key the environment supplies. Point them at a live
// key and a green run is a real charge, in a real account, with real fees —
// and no Neon branch, RLS policy or tenant filter sits anywhere near that path.
//
// The refusal is therefore its own check, and this file is what proves it
// refuses. A guard that has never refused anything is not a guard.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { assertNoLiveStripeKeys } from "../e2e/global-setup";

const SANDBOX = {
  STRIPE_SECRET_KEY: "sk_test_51ABCdef",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_51ABCdef",
  STRIPE_CLIENT_ID: "ca_UQjg8IIm9jUVnjEN9wYIttkaIiJcLrBy",
};

describe("e2e Stripe key guard", () => {
  it("refuses a live SECRET key — the one that can charge a card", () => {
    expect(() =>
      assertNoLiveStripeKeys({ ...SANDBOX, STRIPE_SECRET_KEY: "sk_live_51ABCdef" }),
    ).toThrow(/E2E REFUSED TO START/);
  });

  it("refuses a live RESTRICTED key, which production is currently using", () => {
    // The production account holds an `rk_live_` rather than an `sk_live_`. A
    // check that only knew the `sk_` shape would wave through the exact key
    // this repo actually possesses.
    expect(() =>
      assertNoLiveStripeKeys({ ...SANDBOX, STRIPE_SECRET_KEY: "rk_live_51ABCdef" }),
    ).toThrow(/LIVE Stripe key/);
  });

  it("refuses a live PUBLISHABLE key, because the secret is never far behind", () => {
    expect(() =>
      assertNoLiveStripeKeys({
        ...SANDBOX,
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_51ABCdef",
      }),
    ).toThrow(/E2E REFUSED TO START/);
  });

  it("names the offending variable, so the fix is obvious from the message", () => {
    expect(() =>
      assertNoLiveStripeKeys({ ...SANDBOX, STRIPE_SECRET_KEY: "sk_live_x" }),
    ).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("allows the sandbox key set", () => {
    expect(() => assertNoLiveStripeKeys(SANDBOX)).not.toThrow();
  });

  it("allows an environment with no Stripe configured at all", () => {
    // Most specs do not touch Stripe. Absent keys must not block them.
    expect(() => assertNoLiveStripeKeys({})).not.toThrow();
    expect(() => assertNoLiveStripeKeys({ STRIPE_SECRET_KEY: undefined })).not.toThrow();
  });

  it("does not match `live` appearing anywhere but the prefix", () => {
    // Guard against a substring check, which would refuse legitimate values.
    expect(() =>
      assertNoLiveStripeKeys({ STRIPE_SECRET_KEY: "sk_test_deliveryKey_live_x" }),
    ).not.toThrow();
  });
});

describe(".env.test on this machine", () => {
  const ENV_TEST = ".env.test";

  it("assigns no live Stripe key", () => {
    // Belt to the guard's braces: the guard fires when the suite starts, this
    // fires on every `npm test`, which is the gate that actually runs before a
    // commit. If a live key ever lands in that file, one of these says so
    // within seconds rather than at the next e2e run.
    //
    // It reads ASSIGNMENTS, not the raw text. The first version searched the
    // whole file and failed immediately — on the comment in .env.test that
    // *names* the forbidden prefixes. A guard that cannot tell a warning about
    // a key from a key would have to be silenced, and a silenced guard is
    // worse than none. Commented-out lines are excluded for the same reason:
    // dotenv does not load them, so they cannot reach Stripe.
    if (!existsSync(ENV_TEST)) return; // legitimately absent in CI

    const assignments = readFileSync(ENV_TEST, "utf8")
      .split("\n")
      .map((line) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(([, name, raw]) => ({ name, value: raw.trim().replace(/^["']|["']$/g, "") }));

    const live = assignments.filter(({ value }) =>
      ["sk_live_", "rk_live_", "pk_live_"].some((p) => value.startsWith(p)),
    );

    expect(
      live.map((a) => a.name),
      "these .env.test variables hold LIVE Stripe keys — the e2e suite records payments and would move real money",
    ).toEqual([]);
  });

  it("parses the assignments it claims to check", () => {
    // Without this, an .env.test whose format the regex did not understand
    // would yield zero assignments and the test above would pass vacuously —
    // reporting a clean bill of health for a file it never read.
    if (!existsSync(ENV_TEST)) return;
    const names = readFileSync(ENV_TEST, "utf8")
      .split("\n")
      .map((line) => /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1])
      .filter(Boolean);
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("STRIPE_SECRET_KEY");
  });
});
