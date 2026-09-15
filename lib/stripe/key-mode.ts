/**
 * What kind of Stripe key is this, and does it belong in this deployment?
 *
 * ## Why this is its own file with its own tests
 *
 * `GET /api/stripe/connect/health` is the endpoint `docs/runbooks/GO-LIVE-2026-09.md`
 * tells the operator to trust: *"Do not treat Stripe as set up until this
 * endpoint says `ready: true`."* It existed precisely so the question stopped
 * being a matter of opinion.
 *
 * It could not answer the question. Its mode detection knew only `sk_live_` and
 * `sk_test_`, so two things went past it:
 *
 *  * **the key production actually holds.** It is `rk_live_` — a RESTRICTED live
 *    key — which matched neither branch and was reported as `mode: "unknown"`.
 *    A live key, in production, described as "unknown";
 *  * **a test key in production.** Nothing compared the key's mode against the
 *    deployment it was running in, so a production deploy configured with
 *    `sk_test_…` reported `ready: true` while being structurally incapable of
 *    taking a single real payment. Every card would "work" in testing and no
 *    money would ever arrive.
 *
 * The second is the expensive one, and it is the exact failure this product has
 * already had twice in a different costume: a webhook endpoint with no signing
 * secret, and a Sentry DSN behind a CSP that blocked it. Configured, deployed,
 * reported healthy, doing nothing.
 */

export type StripeKeyMode = "live" | "test" | "unknown";

/**
 * Which kind of credential this is. `restricted` matters on its own: an `rk_`
 * key carries a scope list, so it can authenticate perfectly and still lack the
 * Connect permission the platform needs. The health route's live probe is what
 * settles that; this only says which questions to ask.
 */
export type StripeKeyKind = "secret" | "restricted" | "publishable" | "unrecognised";

export interface StripeKeyClassification {
  mode: StripeKeyMode;
  kind: StripeKeyKind;
  /** False when the value cannot serve as the platform's server-side key at all. */
  usableAsSecret: boolean;
}

const PREFIXES: Array<{ prefix: string; mode: StripeKeyMode; kind: StripeKeyKind }> = [
  { prefix: "sk_live_", mode: "live", kind: "secret" },
  { prefix: "sk_test_", mode: "test", kind: "secret" },
  // Restricted keys. Production holds one of these today, and the old two-branch
  // check reported it as "unknown".
  { prefix: "rk_live_", mode: "live", kind: "restricted" },
  { prefix: "rk_test_", mode: "test", kind: "restricted" },
  // A publishable key pasted into the secret slot is a specific, common mistake
  // worth naming rather than lumping into "unknown" — it is safe to expose, so
  // the fix is "paste the other one", not "rotate everything".
  { prefix: "pk_live_", mode: "live", kind: "publishable" },
  { prefix: "pk_test_", mode: "test", kind: "publishable" },
];

export function classifyStripeKey(key: string | undefined | null): StripeKeyClassification {
  if (!key) return { mode: "unknown", kind: "unrecognised", usableAsSecret: false };
  const match = PREFIXES.find((p) => key.startsWith(p.prefix));
  if (!match) return { mode: "unknown", kind: "unrecognised", usableAsSecret: false };
  return {
    mode: match.mode,
    kind: match.kind,
    usableAsSecret: match.kind === "secret" || match.kind === "restricted",
  };
}

/** Where this code is running, as far as the platform will say. */
export type DeploymentEnvironment = "production" | "preview" | "development";

export function deploymentEnvironment(
  env: Record<string, string | undefined> = process.env,
): DeploymentEnvironment {
  // Vercel's own label is the authority where it exists — NODE_ENV is
  // "production" for a preview build too, so trusting it alone would call every
  // preview deployment production and refuse its test keys.
  const vercel = env.VERCEL_ENV;
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel;
  return env.NODE_ENV === "production" ? "production" : "development";
}

export interface ModeVerdict {
  /** False blocks `ready` — the configuration cannot do the job asked of it. */
  ok: boolean;
  /** Operator-facing sentence, or null when there is nothing to say. */
  message: string | null;
}

/**
 * Does a key of this mode belong in this deployment?
 *
 * Both directions are refusals, for different reasons:
 *
 *  * a TEST key in production takes no money, ever, while looking entirely
 *    healthy — the silent-failure shape this codebase keeps producing;
 *  * a LIVE key outside production charges real cards from a preview branch or
 *    a laptop. The e2e suite records payments, so that is not hypothetical.
 */
export function assessKeyForEnvironment(
  mode: StripeKeyMode,
  environment: DeploymentEnvironment,
): ModeVerdict {
  if (mode === "unknown") {
    return {
      ok: false,
      message:
        "STRIPE_SECRET_KEY is set but is not a recognised Stripe key (expected sk_live_, sk_test_, rk_live_ or rk_test_). Check the value was copied whole.",
    };
  }
  if (environment === "production" && mode === "test") {
    return {
      ok: false,
      message:
        "This is the PRODUCTION deployment and STRIPE_SECRET_KEY is a TEST key. Cards will appear to work and no money will ever arrive. Replace it with the live key.",
    };
  }
  if (environment !== "production" && mode === "live") {
    return {
      ok: false,
      message: `This is the ${environment} environment and STRIPE_SECRET_KEY is a LIVE key. Charges made here are real. Replace it with the test key.`,
    };
  }
  return { ok: true, message: null };
}
