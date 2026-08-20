// Run `prisma migrate deploy` only when DATABASE_URL is set.
//
// Why: Vercel preview deployments scope env vars per environment. If a
// preview build doesn't get DATABASE_URL (because it's only on Production
// scope, or the build doesn't need DB access), `prisma migrate deploy` would
// fail at the config-validation step and abort the entire build.
//
// Production builds have DATABASE_URL set, so migrate runs normally.
// Preview builds without DATABASE_URL skip migrate gracefully — they can
// still produce a deploy, and migrations remain unapplied for that build.
// (Migrations are also applied via the local `prisma migrate deploy` we run
// from dev, so this is safe.)

import { execSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.warn("[build] DATABASE_URL not set — skipping `prisma migrate deploy`");
  console.warn("[build] If this is production, fix the env var. If preview, this is fine.");
  process.exit(0);
}

// Storage-audit hardening (2026-08-16): the presence check above is not an
// environment check. If the Preview scope in Vercel ever holds the PROD
// connection string, a preview build would migrate production. Only the
// production deployment may migrate the prod database; anything else pointed
// at the prod endpoint skips with a loud warning. Endpoint id mirrors
// tests/setup-test-db.ts's prod guard.
const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";
const isProdDb = process.env.DATABASE_URL.includes(PROD_NEON_ENDPOINT);
// A production deploy is a Vercel production deploy, nothing else. This was
// `!process.env.VERCEL_ENV || VERCEL_ENV === "production"`, which treated the
// ABSENCE of VERCEL_ENV as production — and VERCEL_ENV is absent on every
// developer laptop. `npm run build`, the command CLAUDE.md tells you to run
// before claiming a change is done, therefore ran `prisma migrate deploy`
// against the production database from local, which the same file explicitly
// forbids. Vercel always sets VERCEL_ENV on its own builds, so requiring it
// costs nothing there and closes the hole everywhere else.
const isProdDeploy = process.env.VERCEL_ENV === "production";
if (isProdDb && !isProdDeploy) {
  console.warn(
    `[build] REFUSING to run migrations: DATABASE_URL points at the prod Neon endpoint ` +
      `but VERCEL_ENV is "${process.env.VERCEL_ENV}". Scope the Preview DATABASE_URL to a ` +
      `Neon branch, or leave it unset so preview builds skip migrate.`,
  );
  process.exit(0);
}

console.log("[build] DATABASE_URL set — running `prisma migrate deploy`");
try {
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
} catch (err) {
  console.error("[build] prisma migrate deploy failed:", err?.message ?? err);
  process.exit(1);
}
