// Run `prisma migrate deploy` only when a database URL is set.
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
//
// Which URL migrates (6 Oct 2026, docs/runbooks/RUNTIME-DB-ROLE-CHECK.md §3.3):
// MIGRATION_DATABASE_URL when it is set, otherwise DATABASE_URL. Migrations
// need DDL, which the restricted runtime role (matflow_app) must not have, so
// moving the app to that role needs a separate owner URL for this step. Until
// MIGRATION_DATABASE_URL exists in Vercel nothing changes: DATABASE_URL is used
// exactly as before. Neither value is ever printed — only the variable NAME.

import { execSync } from "node:child_process";

const source = process.env.MIGRATION_DATABASE_URL
  ? "MIGRATION_DATABASE_URL"
  : process.env.DATABASE_URL
    ? "DATABASE_URL"
    : null;

if (!source) {
  console.warn("[build] Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set — skipping `prisma migrate deploy`");
  console.warn("[build] If this is production, fix the env var. If preview, this is fine.");
  process.exit(0);
}

const migrationUrl = process.env[source];

// Storage-audit hardening (2026-08-16): the presence check above is not an
// environment check. If the Preview scope in Vercel ever holds the PROD
// connection string, a preview build would migrate production. Only the
// production deployment may migrate the prod database; anything else pointed
// at the prod endpoint skips with a loud warning. Endpoint id mirrors
// tests/setup-test-db.ts's prod guard. Applied to the URL that will actually
// be migrated.
const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";
const isProdDb = migrationUrl.includes(PROD_NEON_ENDPOINT);
// Only a real Vercel production deployment sets VERCEL_ENV === "production".
// A local `npm run build` has no VERCEL_ENV at all — and the repo `.env` points
// at the prod endpoint, so treating "unset" as production meant every local
// build migrated production (CLAUDE.md forbids exactly that).
const isProdDeploy = process.env.VERCEL_ENV === "production";
if (isProdDb && !isProdDeploy) {
  console.warn(
    `[build] REFUSING to run migrations: ${source} points at the prod Neon endpoint ` +
      `but VERCEL_ENV is "${process.env.VERCEL_ENV ?? "unset (local build)"}". Scope the Preview ` +
      `${source} to a Neon branch, or leave it unset so non-production builds skip migrate.`,
  );
  process.exit(0);
}

// When both are set they must name the same Neon endpoint (6 Oct 2026,
// review of the MIGRATION_DATABASE_URL change): a mis-set variable would
// migrate one database and deploy the app against another, unmigrated one.
// Compared on the endpoint id only (pooler suffix stripped); neither value is
// printed.
if (process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL) {
  const endpointOf = (url) => {
    const m = url.match(/@([^./:?]+)/);
    return m ? m[1].replace(/-pooler$/, "") : null;
  };
  const a = endpointOf(process.env.MIGRATION_DATABASE_URL);
  const b = endpointOf(process.env.DATABASE_URL);
  if (!a || !b || a !== b) {
    console.error(
      "[build] REFUSING to migrate: MIGRATION_DATABASE_URL and DATABASE_URL do not name the same database endpoint. " +
        "Fix the variables in Vercel so both point at the same Neon endpoint.",
    );
    process.exit(1);
  }
}

if (source === "DATABASE_URL" && isProdDeploy) {
  // Not an error: this is today's configuration. It is the reminder that the
  // runtime URL is also the DDL URL, i.e. the runtime role can run migrations.
  console.warn("[build] MIGRATION_DATABASE_URL not set — migrating with DATABASE_URL (the runtime URL)");
}

console.log(`[build] ${source} set — running \`prisma migrate deploy\``);
try {
  // prisma.config.ts reads DATABASE_URL, and `dotenv/config` there never
  // overrides a variable already present, so the child migrates exactly
  // `migrationUrl`. The app's own runtime environment is not touched.
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: migrationUrl },
  });
} catch (err) {
  // `err.message` from execSync names the command only, not the environment.
  console.error("[build] prisma migrate deploy failed:", err?.message ?? err);
  process.exit(1);
}
