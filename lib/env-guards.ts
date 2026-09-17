/**
 * Production env-var boot guards.
 *
 * `auth.ts` already throws at module load when NEXTAUTH_SECRET is missing.
 * This file extends that pattern to other env vars whose absence would
 * cause silent failures at request time (password resets that never send,
 * Stripe routes that 500, admin endpoints that always 401).
 *
 * Imported once from `instrumentation.ts` so it runs at server start, not
 * per-request. Skipped during `next build` page-data collection (NEXT_PHASE
 * !== 'phase-production-build') so deploys don't fail just because secrets
 * aren't yet set.
 *
 * In dev, missing values log a warning instead of throwing — keeps the
 * dev loop friction-free.
 */

type Severity = "error" | "warn";

const REQUIRED: { name: string; severity: Severity; reason: string }[] = [
  // Already enforced in auth.ts but listed here for completeness — if
  // either is missing, auth.ts throws first.
  { name: "DATABASE_URL", severity: "error", reason: "Postgres connection — every route needs it" },

  // Email delivery. Without this, password resets, magic links, and
  // member invites silently fail.
  { name: "RESEND_API_KEY", severity: "error", reason: "Password resets + magic links + invites won't send" },

  // Stripe. Without secret key, Connect health endpoint reports unready
  // and any checkout attempt 500s. Without webhook secret, signature
  // verification rejects every event.
  { name: "STRIPE_SECRET_KEY", severity: "error", reason: "Stripe Connect + checkout will fail" },
  { name: "STRIPE_WEBHOOK_SECRET", severity: "error", reason: "All Stripe webhook events will be rejected (signature mismatch)" },
  { name: "STRIPE_CLIENT_ID", severity: "error", reason: "Owner Stripe Connect OAuth start will fail" },

  // Admin tenant bootstrap. Without it, /api/admin/create-tenant always
  // returns 401 and you can't create new gym tenants.
  { name: "MATFLOW_ADMIN_SECRET", severity: "error", reason: "/api/admin/create-tenant will reject every request" },

  // Sentry. Warn-only — Sentry is optional infrastructure, but operating
  // production without it means errors land in Vercel logs only.
  { name: "SENTRY_DSN", severity: "warn", reason: "Server errors won't be reported to Sentry — Vercel logs only" },
  // The BROWSER half, and it was missing from this list entirely while the
  // client SDK was also never loaded — so nothing anywhere reported that no
  // client-side error had ever reached a human. instrumentation-client.ts now
  // loads the SDK; this variable is what switches it on.
  {
    name: "NEXT_PUBLIC_SENTRY_DSN",
    severity: "warn",
    reason: "Browser errors won't be reported — the error boundaries' captureException calls are inert without it",
  },

  // Cron + webhook secrets. Both routes have their own 503 fallback when
  // missing, so absence isn't fatal — but it means a deploy can quietly
  // break the cron run or the email-status pipeline. Warn at boot so
  // misconfiguration surfaces in deploy logs.
  // X-6 lane G (17 Sep 2026): CRON_SECRET had never been set in Vercel, and
  // this warn-level line was the only signal — a line in a build log nobody
  // reads. Every cron (class-instance horizon, GDPR retention, the Stripe
  // reconciliation that rides on it) answered 503 for the life of the
  // project. The severity stays "warn" for exactly one deploy: raising it to
  // "error" while the variable is still absent would throw at boot and take
  // every route down. Raise it the moment `vercel env ls production` shows it.
  { name: "CRON_SECRET", severity: "warn", reason: "EVERY cron (class-instances, retention + Stripe reconcile, monthly-reports) answers 503 and does nothing" },
  { name: "RESEND_WEBHOOK_SECRET", severity: "warn", reason: "Resend delivery/bounce webhooks will be rejected (503 in prod)" },
  { name: "ANTHROPIC_API_KEY", severity: "warn", reason: "Monthly reports (cron and the generate button) answer 503" },
];

export function runProductionEnvGuards(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const missing: typeof REQUIRED = [];
  const missingWarn: typeof REQUIRED = [];

  for (const v of REQUIRED) {
    const val = process.env[v.name];
    if (val && val.trim().length > 0) continue;
    if (v.severity === "error") missing.push(v);
    else missingWarn.push(v);
  }

  for (const v of missingWarn) {
    console.warn(`[env-guards] ${v.name} is unset — ${v.reason}`);
  }

  if (missing.length > 0) {
    const lines = missing.map((v) => `  - ${v.name}: ${v.reason}`).join("\n");
    throw new Error(
      `Missing required production env vars:\n${lines}\n\n` +
        `Set these in Vercel → Settings → Environment Variables, then redeploy. ` +
        `See .env.example for documentation.`,
    );
  }
}
