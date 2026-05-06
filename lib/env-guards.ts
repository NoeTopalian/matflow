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
  { name: "SENTRY_DSN", severity: "warn", reason: "Errors won't be reported to Sentry — Vercel logs only" },

  // Cron + webhook secrets. Both routes have their own 503 fallback when
  // missing, so absence isn't fatal — but it means a deploy can quietly
  // break the cron run or the email-status pipeline. Warn at boot so
  // misconfiguration surfaces in deploy logs.
  { name: "CRON_SECRET", severity: "warn", reason: "Monthly-report cron will reject Vercel's bearer token (503)" },
  { name: "RESEND_WEBHOOK_SECRET", severity: "warn", reason: "Resend delivery/bounce webhooks will be rejected (503 in prod)" },
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
