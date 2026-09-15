// `GET /api/stripe/connect/health` is the endpoint the go-live runbook tells the
// operator to trust — "do not treat Stripe as set up until this says ready:true".
// It could not tell a live key from a test one in the two cases that matter, so
// the classification is now a testable unit and this is what holds it honest.

import { describe, it, expect } from "vitest";
import {
  classifyStripeKey,
  deploymentEnvironment,
  assessKeyForEnvironment,
} from "@/lib/stripe/key-mode";

describe("classifyStripeKey", () => {
  it("recognises the RESTRICTED live key production actually holds", () => {
    // The whole reason this file exists. The previous inline check knew only
    // sk_live_/sk_test_, so the key in production reported mode "unknown" —
    // a live key, in production, described as unknown.
    const k = classifyStripeKey("rk_live_51T87S7J74LmUlLwB");
    expect(k.mode).toBe("live");
    expect(k.kind).toBe("restricted");
    expect(k.usableAsSecret).toBe(true);
  });

  it("recognises standard secret keys in both modes", () => {
    expect(classifyStripeKey("sk_live_abc").mode).toBe("live");
    expect(classifyStripeKey("sk_test_abc").mode).toBe("test");
    expect(classifyStripeKey("sk_test_abc").kind).toBe("secret");
  });

  it("recognises restricted test keys", () => {
    expect(classifyStripeKey("rk_test_abc")).toEqual({
      mode: "test",
      kind: "restricted",
      usableAsSecret: true,
    });
  });

  it("names a publishable key pasted into the secret slot", () => {
    // Worth distinguishing from "unknown": a pk_ is safe to expose, so the fix
    // is "paste the other one", not "rotate everything".
    const k = classifyStripeKey("pk_live_51T87S7J74LmUlLwB");
    expect(k.kind).toBe("publishable");
    expect(k.mode).toBe("live");
    expect(k.usableAsSecret, "a publishable key cannot authenticate server-side").toBe(false);
  });

  it("refuses to guess at anything else", () => {
    for (const value of ["whsec_abc", "ca_abc", "mk_abc", "garbage", "", undefined, null]) {
      const k = classifyStripeKey(value);
      expect(k.mode, `${String(value)} should not be classified`).toBe("unknown");
      expect(k.usableAsSecret).toBe(false);
    }
  });
});

describe("deploymentEnvironment", () => {
  it("trusts Vercel's own label over NODE_ENV", () => {
    // NODE_ENV is "production" for a PREVIEW build too. Trusting it alone would
    // call every preview deployment production and then refuse its test key.
    expect(deploymentEnvironment({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("preview");
    expect(deploymentEnvironment({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe("production");
    expect(deploymentEnvironment({ VERCEL_ENV: "development", NODE_ENV: "production" })).toBe("development");
  });

  it("falls back to NODE_ENV off Vercel", () => {
    expect(deploymentEnvironment({ NODE_ENV: "production" })).toBe("production");
    expect(deploymentEnvironment({ NODE_ENV: "test" })).toBe("development");
    expect(deploymentEnvironment({})).toBe("development");
  });

  it("ignores an unrecognised VERCEL_ENV rather than trusting it", () => {
    expect(deploymentEnvironment({ VERCEL_ENV: "staging", NODE_ENV: "production" })).toBe("production");
  });
});

describe("assessKeyForEnvironment", () => {
  it("REFUSES a test key in production — the silent-no-money case", () => {
    // This is the defect that mattered. Before it, a production deploy holding
    // sk_test_ reported ready:true: every card "works" in testing and not one
    // penny ever arrives. Same shape as the webhook with no signing secret.
    const v = assessKeyForEnvironment("test", "production");
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/PRODUCTION/);
    expect(v.message).toMatch(/no money will ever arrive/i);
  });

  it("REFUSES a live key outside production — the real-charges case", () => {
    // Not hypothetical: the e2e suite records payments.
    expect(assessKeyForEnvironment("live", "preview").ok).toBe(false);
    expect(assessKeyForEnvironment("live", "development").ok).toBe(false);
    expect(assessKeyForEnvironment("live", "development").message).toMatch(/LIVE key/);
  });

  it("REFUSES an unrecognised key rather than assuming it is fine", () => {
    expect(assessKeyForEnvironment("unknown", "production").ok).toBe(false);
    expect(assessKeyForEnvironment("unknown", "development").ok).toBe(false);
  });

  it("accepts the two combinations that are actually correct", () => {
    expect(assessKeyForEnvironment("live", "production")).toEqual({ ok: true, message: null });
    expect(assessKeyForEnvironment("test", "development")).toEqual({ ok: true, message: null });
    expect(assessKeyForEnvironment("test", "preview")).toEqual({ ok: true, message: null });
  });

  it("passes the restricted live key production holds, in production", () => {
    // End to end through both functions, because the two are only useful together.
    const k = classifyStripeKey("rk_live_51T87S7J74LmUlLwB");
    expect(assessKeyForEnvironment(k.mode, "production").ok).toBe(true);
  });
});
