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

console.log("[build] DATABASE_URL set — running `prisma migrate deploy`");
try {
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
} catch (err) {
  console.error("[build] prisma migrate deploy failed:", err?.message ?? err);
  process.exit(1);
}
