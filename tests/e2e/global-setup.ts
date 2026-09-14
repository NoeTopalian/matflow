import { Client } from "pg";

/**
 * The one place that decides whether this machine is allowed to run e2e at all.
 *
 * **Why this exists.** The e2e specs do not merely read. They create members and
 * classes, record payments, reset TOTP secrets, clear lockouts and check people
 * into sessions — against whatever `DATABASE_URL` happens to be set. Until this
 * file existed, the only thing standing between a full suite run and the
 * PRODUCTION database was `playwright.config.ts` finding a `.env.test` file on
 * disk and quietly carrying on when it did not:
 *
 *     if (existsSync(TEST_ENV)) { loadDotenv({ path: TEST_ENV, override: true }); }
 *
 * `.env` points at `ep-bold-wave` — production. So renaming that file, checking
 * the repo out somewhere fresh, or running on a machine that never had it, and
 * the suite writes into the live database of a product with paying customers.
 * Silently, because the fallback was deliberate.
 *
 * The old defence was a hand-written `beforeAll` throw copied into individual
 * specs. **26 of 37 spec files did not have it** — including the ones that write
 * the most: `owner-roster-flow`, `dashboard/members`, `dashboard/checkin`,
 * `timetable-class-create`, `full-app-qa`, `member/shop`. A rule enforced by
 * remembering to copy it is not a rule.
 *
 * A `globalSetup` runs once, before any project, any worker and any spec. It
 * cannot be forgotten by a new file, and it cannot be skipped.
 *
 * **It fails CLOSED.** An unrecognised host is refused, not allowed. The cost of
 * a false refusal is a confused developer reading an error message; the cost of
 * a false pass is a corrupted production database days before a customer
 * meeting. Those are not comparable, so the default is no.
 */

/** Neon branch endpoint that holds real customer data. Never writable from here. */
const PRODUCTION_ENDPOINT = "ep-bold-wave";

/** The Neon branch the e2e suite is allowed to write to. */
const TEST_ENDPOINT = "ep-hidden-salad";

/**
 * The tenant `prisma/seed.ts` creates. Its absence means an unseeded database.
 *
 * Must match `prisma/seed.ts` exactly, and is asserted against that file in
 * tests/unit/e2e-database-guard.test.ts. The first version of this constant read
 * "total-bjj" while the seed writes "totalbjj", so the guard would have refused
 * a correctly-seeded database — and every test around it still passed, because
 * they MOCK the query result. Mocking the answer meant the one value this check
 * depends on was never compared against anything real. A reference value checked
 * only against a mock of itself is not checked at all.
 */
const SEEDED_TENANT_SLUG = "totalbjj";

function refuse(reason: string, detail: string): never {
  throw new Error(
    [
      "",
      "  ┌─────────────────────────────────────────────────────────────┐",
      "  │  E2E REFUSED TO START                                       │",
      "  └─────────────────────────────────────────────────────────────┘",
      "",
      `  ${reason}`,
      "",
      `  ${detail}`,
      "",
      "  The e2e suite WRITES: members, classes, payments, check-ins, TOTP",
      "  secrets, lockouts. It must only ever touch the test branch.",
      "",
      "  Fix: ensure .env.test exists and points at the test Neon branch, then",
      "  re-run. Never point this suite at production to 'just check something'.",
      "",
    ].join("\n"),
  );
}

/** Host of a Postgres URL, or null when it cannot be parsed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "postgres" // the service name inside a CI container network
  );
}

export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";

  if (!url) {
    refuse(
      "DATABASE_URL is not set.",
      "Nothing identifies which database this run would write to.",
    );
  }

  // 1. Production is refused before anything else, on the raw string, so a URL
  //    this file fails to parse still cannot slip through.
  if (url.includes(PRODUCTION_ENDPOINT)) {
    refuse(
      `DATABASE_URL points at PRODUCTION (${PRODUCTION_ENDPOINT}).`,
      "This is the live customer database. Refusing outright.",
    );
  }

  const host = hostOf(url);
  if (!host) {
    refuse("DATABASE_URL could not be parsed as a URL.", `Value starts: ${url.slice(0, 24)}…`);
  }

  // 2. Allow exactly two shapes: the known test branch, and a local/ephemeral
  //    Postgres (which is what CI provisions as a service container). Anything
  //    else is an unknown remote host and is refused — fail closed.
  const isTestBranch = url.includes(TEST_ENDPOINT);
  const isEphemeral = isLocalHost(host);

  if (!isTestBranch && !isEphemeral) {
    refuse(
      `DATABASE_URL points at an unrecognised host: ${host}`,
      `Only the test branch (${TEST_ENDPOINT}) or a local/ephemeral Postgres is permitted.`,
    );
  }

  // 3. Second belt: a correctly-pointed but UNSEEDED database produces dozens of
  //    baffling failures that look like product bugs. Ask once, here, and say so
  //    plainly instead.
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const { rows } = await client.query<{ slug: string }>(
      'SELECT slug FROM "Tenant" WHERE slug = $1 LIMIT 1',
      [SEEDED_TENANT_SLUG],
    );
    if (rows.length === 0) {
      refuse(
        `The database has no "${SEEDED_TENANT_SLUG}" tenant — it is not seeded.`,
        "Run `npm run seed` against the test branch first. Without it every spec fails on login and the failures look like product defects.",
      );
    }
  } catch (err) {
    // A refusal thrown above must propagate; a connection problem is its own
    // distinct message rather than being reported as "not seeded".
    if (err instanceof Error && err.message.includes("E2E REFUSED TO START")) throw err;
    refuse(
      "Could not reach the database to verify it is seeded.",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await client.end().catch(() => {});
  }

  // Say what was allowed and why, so a passing run is also evidence.
  console.log(
    `[e2e] database accepted: ${isTestBranch ? `test branch (${TEST_ENDPOINT})` : `ephemeral (${host})`}, seeded.`,
  );
}
