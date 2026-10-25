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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers (exported for tests/unit/maybe-migrate-preflight.test.ts; nothing here prints a value) ──
//
// 1. directNeonUrl: migrate on the DIRECT host, never through Neon's pgbouncer pooler.
//    `prisma migrate deploy` takes a SESSION-level advisory lock (`pg_advisory_lock(72707369)`). Through the pooler
//    (transaction mode) the lock lands on whichever server connection ran that statement and stays there: measured on
//    the TEST endpoint (docs/readiness/MIGRATION-SAFETY-2026-10-24.md), every pooled deploy left an idle pgbouncer
//    backend holding the exclusive lock afterwards, and a later deploy that reached a different backend failed with
//    P1002 ("Timed out trying to acquire a postgres advisory lock"). On the direct host the lock ends with the CLI's
//    session. Neon's direct host is the pooler host without the "-pooler" suffix (same credentials).
// 2. migrationPreflight: before any migration runs, refuse to start while another session has held a transaction open
//    longer than the migrations' own lock_timeout (5 s). Such a transaction can make a migration file fail part-way
//    through the deploy (earlier files committed, `_prisma_migrations` left with a failed row that blocks every later
//    deploy with P3009 until `prisma migrate resolve --rolled-back` is run). Refusing BEFORE the first file leaves
//    nothing to resolve: the build fails and is simply retried.

/** The same URL on Neon's direct host when it names a `-pooler` host; anything else is returned unchanged. */
export function directNeonUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".neon.tech")) return url;
  const [first, ...rest] = host.split(".");
  if (!first.endsWith("-pooler")) return url;
  u.hostname = [first.slice(0, -"-pooler".length), ...rest].join(".");
  u.searchParams.delete("pgbouncer");
  return u.toString();
}

/** Longest a foreign transaction may already have been open when migrations start: the migrations' lock_timeout. */
export const PREFLIGHT_MAX_TRANSACTION_SECONDS = 5;

/**
 * Pending migrations and the transactions that could block them. Read-only.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db a connected client on the migration URL
 * @param {string[]} migrationDirs the repository's migration directory names
 */
export async function migrationPreflight(db, migrationDirs, maxSeconds = PREFLIGHT_MAX_TRANSACTION_SECONDS) {
  const table = await db.query(`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`);
  const applied = new Set();
  if (table.rows[0]?.present) {
    const r = await db.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    for (const row of r.rows) applied.add(row.migration_name);
  }
  const pending = migrationDirs.filter((d) => !applied.has(d)).sort();
  if (pending.length === 0) return { pending, blockers: [], unseen: 0 };
  // Other sessions on this database with a transaction open longer than the bound. A role without pg_read_all_stats
  // sees NULL xact_start for other roles' sessions: those are counted as "unseen", never silently ignored.
  const r = await db.query(
    `SELECT pid, usename, application_name, state, extract(epoch FROM (clock_timestamp() - xact_start))::int AS age_s, xact_start IS NULL AND backend_type = 'client backend' AS unseen
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
        AND (xact_start IS NULL OR xact_start < clock_timestamp() - make_interval(secs => $1))`,
    [maxSeconds],
  );
  // pid, role name and application name identify the session to end; none is a credential.
  const blockers = r.rows
    .filter((x) => !x.unseen && x.age_s !== null)
    .map((x) => ({ state: x.state, ageS: x.age_s, pid: x.pid ?? null, role: x.usename ?? null, app: x.application_name || null }));
  const unseen = r.rows.filter((x) => x.unseen && x.state === null).length;
  return { pending, blockers, unseen };
}

async function main() {
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

  // Migrate on Neon's DIRECT host, never through the pgbouncer pooler (24 Oct 2026, directNeonUrl above):
  // Prisma's session-level advisory lock leaks onto a pooled server connection, blocks later deploys (P1002) and would
  // make lib/migration-lock.ts refuse imports for as long as it lingers. Only the host kind is printed.
  const deployUrl = directNeonUrl(migrationUrl);
  if (deployUrl !== migrationUrl) console.log(`[build] ${source} names the Neon pooler — migrating on its direct host`);

  // Preflight (24 Oct 2026): with migrations pending, refuse to START while another session has had a transaction open
  // longer than the migrations' 5 s lock_timeout — such a transaction could fail a file part-way through the deploy and
  // leave a failed `_prisma_migrations` row that blocks every later deploy (P3009). Refused here, nothing is recorded:
  // the build fails and is simply retried. Prints counts and ages only.
  {
    const pg = (await import("pg")).default;
    const db = new pg.Client({ connectionString: deployUrl, application_name: "maybe-migrate-preflight", connectionTimeoutMillis: 20_000 });
    db.on("error", () => {});
    let pf;
    try {
      await db.connect();
      const dirs = fs.readdirSync(path.join(process.cwd(), "prisma", "migrations")).filter((d) => /^\d{14}_/.test(d));
      pf = await migrationPreflight(db, dirs);
    } catch (err) {
      console.error("[build] REFUSING to migrate: the migration preflight could not read the database:", err?.code ?? "error");
      process.exit(1);
    } finally {
      await db.end().catch(() => {});
    }
    if (pf.pending.length === 0) {
      console.log("[build] preflight: no pending migrations");
    } else {
      console.log(`[build] preflight: ${pf.pending.length} pending migration(s)`);
      if (pf.unseen > 0) {
        console.warn(`[build] preflight: ${pf.unseen} other session(s) are not visible to this role (no pg_read_all_stats); their transactions were not checked`);
      }
      if (pf.blockers.length > 0) {
        const oldest = Math.max(...pf.blockers.map((b) => b.ageS));
        console.error(
          `[build] REFUSING to migrate: ${pf.blockers.length} other transaction(s) open longer than ${PREFLIGHT_MAX_TRANSACTION_SECONDS} s (oldest ${oldest} s; states ${[...new Set(pf.blockers.map((b) => b.state))].join(", ")}). ` +
            `Sessions: ${pf.blockers.map((b) => `pid ${b.pid} (${b.role ?? "?"}, ${b.app ?? "no application name"}, ${b.ageS} s)`).join("; ")}. ` +
            "Nothing was migrated. Redeploy in a few minutes, or end the named session if it is stuck.",
        );
        process.exit(1);
      }
    }
  }

  console.log(`[build] ${source} set — running \`prisma migrate deploy\``);
  try {
    // prisma.config.ts reads DATABASE_URL, and `dotenv/config` there never
    // overrides a variable already present, so the child migrates exactly
    // `deployUrl`. The app's own runtime environment is not touched.
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: deployUrl },
    });
  } catch (err) {
    // `err.message` from execSync names the command only, not the environment.
    console.error("[build] prisma migrate deploy failed:", err?.message ?? err);
    console.error(
      "[build] Reading the error above: P1002 (advisory lock timeout) = another migration or an import held the lock; nothing was applied, redeploy. " +
        "'current transaction is aborted' = a statement of the migration file named above failed (often its 5 s lock_timeout) and Prisma could not record why; " +
        "that file applied nothing (every file is one transaction), earlier files may have committed, and the next deploy fails P3009 until " +
        "`prisma migrate resolve --rolled-back <that migration>` is run (docs/readiness/MIGRATION-SAFETY-2026-10-24.md, Recovery).",
    );
    process.exit(1);
  }
}

// Run only when executed (`node scripts/maybe-migrate.mjs`), never when a test imports the helpers.
// `import.meta.main` (Node >= 24.2) is true for the entry module however it was reached. Comparing
// paths instead skipped migrating silently when run through a symlinked directory (the module URL
// is realpath'd, argv[1] is not), and `next build` then shipped against an unmigrated schema.
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const isEntry =
  import.meta.main ??
  Boolean(process.argv[1] && same(fs.realpathSync(fileURLToPath(import.meta.url)), fs.realpathSync(path.resolve(process.argv[1]))));
if (isEntry) await main();
