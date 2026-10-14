// Demo-account rotation — TEST DATABASE ONLY (security campaign iteration 2, lane M1 v2, SF-109).
//
// Authorised by Noe on 10 Oct 2026 22:13 Italy: "Approve building the demo-account rotation tool with dry-run support
// and synthetic TEST fixtures. Production execution is not authorized. The tool must identify exact account IDs,
// preserve unrelated accounts, and verify session revocation."
//
// THERE IS NO PRODUCTION MODE. The target guard (scripts/readiness/db-target.mjs) is called with expectHost fixed to
// the TEST endpoint id and never with allowProduction; no flag, variable or file changes that. For the production demo
// club Noe runs the equivalent steps by hand (docs/security/CONTAINMENT-CHECKLIST.md §4, step 9a).
//
// Usage:
//   node -- scripts/readiness/demo-accounts-rotate.mjs --slug <tenant-slug>                 (dry run: list, change nothing)
//   node -- scripts/readiness/demo-accounts-rotate.mjs --slug <tenant-slug> --confirm --ids <id,id,...>
//   options: --env-file <path> (default .env.test)  --var TEST_DATABASE_URL|RESTRICTED_DATABASE_URL (default TEST_…)
//   Use the `node -- ` form: Node (>=20) consumes `--env-file` anywhere in argv as its OWN flag and exits 9 on a missing file
//   before this script runs; `--` hands everything after it to the script.
//
// What it does, in ONE transaction (REPEATABLE READ, RLS bypass set transaction-locally, never on the session):
//  - lists the EXACT candidate rows: every User in that tenant whose e-mail ends with @demo.matflow — id, role, the
//    domain only (`***@demo.matflow`) and a 12-hex address TAG: HMAC-SHA256 under a random 32-byte key made for this
//    run, never printed or stored, so the tag links an output line to its audit row within one run and says nothing
//    guessable about the address (lane M2, SF-129: it used to print the local part's first character and an unsalted
//    SHA-256 of the address, which anyone can recompute for a guessable demo address);
//  - dry run (default): prints the list and "would rotate N accounts" and rolls back (READ ONLY);
//  - --confirm --ids <the ids the dry run printed>: per listed row, a fresh random password hashed with bcrypt(12)
//    (the password is never printed, stored or logged — it exists to make the old one irrelevant), sessionVersion + 1,
//    and one AuditLog row `admin.demo_account.rotated` with the user id, the run id and the address tag. --ids is
//    MANDATORY with --confirm (lane M2): a confirm is always bound to a prior dry run, and a different set aborts.
//    Before COMMIT it asserts that the candidate id set is unchanged, that each listed row moved exactly one
//    sessionVersion, and that EVERY other User row in the database (this tenant and all others) is byte-identical to
//    the transaction's own starting snapshot; any difference rolls the whole run back.
//  - prints the transaction id so a test can prove which rows this run wrote (xmin).
// The env file can never be the production `.env`: refused by name in any letter case (Windows opens `.ENV` as
// `.env`), by real path (a symlink to it) and by file identity (a hard link to the repo's .env under another name).
// It does not verify the old password; it makes it irrelevant. Exit codes: 0 done, 1 aborted (rolled back),
// 2 refused (target, arguments or environment), 3 no such tenant.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parse as parsePg } from "pg-connection-string";
import { resolveDbTarget, TargetRefused, TEST_ENDPOINT_ID, PRODUCTION_ENDPOINT_ID } from "./db-target.mjs";

export const DEMO_DOMAIN = "@demo.matflow";
export const AUDIT_ACTION = "admin.demo_account.rotated";
const ALLOWED_VARS = ["TEST_DATABASE_URL", "RESTRICTED_DATABASE_URL"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CUIDISH = /^[A-Za-z0-9_-]{1,64}$/;

export class Refused extends Error {}

/** Domain separation for the address tag's HMAC input (the key itself is random per run). */
const ADDRESS_TAG_LABEL = "matflow.demo-rotate.address-tag.v1:";

/**
 * True when a file NAME means `.env` to Windows: compared case-insensitively, with trailing dots and spaces dropped
 * (Win32 strips them) and an alternate-data-stream suffix (`.env::$DATA`) removed.
 */
function namesDotEnv(name) {
  const base = String(name).split(":")[0].replace(/[. ]+$/, "").toLowerCase();
  return base === ".env";
}

/** The production env files this tool must never read: the repo's `.env` and one in the working directory. */
function defaultProductionEnvPaths() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [...new Set([path.resolve(here, "..", "..", ".env"), path.resolve(".env")])];
}

/** Parse argv strictly: unknown options are refused (there is no production flag to find). */
export function parseArgs(argv) {
  const out = { slug: null, confirm: false, ids: null, envFile: ".env.test", varName: "TEST_DATABASE_URL" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Refused(`REFUSED: ${a} needs a value`);
      return v;
    };
    if (a === "--slug") out.slug = val();
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--ids") out.ids = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--env-file") out.envFile = val();
    else if (a === "--var") out.varName = val();
    else throw new Refused(`REFUSED: unknown option ${a} (this tool has no production mode)`);
  }
  if (!out.slug || !SLUG.test(out.slug)) throw new Refused("REFUSED: --slug <tenant-slug> is required (lower-case letters, digits, hyphens)");
  if (!ALLOWED_VARS.includes(out.varName)) throw new Refused(`REFUSED: --var must be one of ${ALLOWED_VARS.join(", ")}`);
  if (namesDotEnv(path.basename(out.envFile))) throw new Refused("REFUSED: .env holds the production credentials; use .env.test");
  if (out.ids && (out.ids.length === 0 || !out.ids.every((s) => CUIDISH.test(s)))) throw new Refused("REFUSED: --ids must be a comma list of user ids");
  if (out.ids && !out.confirm) throw new Refused("REFUSED: --ids only makes sense with --confirm");
  if (out.confirm && !out.ids) {
    throw new Refused("REFUSED: --confirm requires --ids <the ids a dry run printed>; nothing changed");
  }
  return out;
}

/**
 * The env file, vetted before it is read: not `.env` by name (any case), not `.env` by real path (a symlink), and
 * not the same file as the production `.env` (a hard link under another name). Returns the real path to read.
 * `realpath`, `stat` and `productionEnvPaths` are injectable for tests; stat reads metadata only, never content.
 * @param {string} file
 * @param {{ realpath?: (p: string) => string, stat?: typeof fs.statSync, productionEnvPaths?: string[] }} [opts]
 * @returns {string}
 */
export function refuseProductionEnvFile(
  file,
  { realpath = fs.realpathSync.native, stat = fs.statSync, productionEnvPaths = defaultProductionEnvPaths() } = {},
) {
  if (namesDotEnv(path.basename(file))) throw new Refused("REFUSED: .env holds the production credentials; use .env.test");
  let real;
  try {
    real = realpath(file);
  } catch {
    throw new Refused("REFUSED: the env file does not exist");
  }
  if (namesDotEnv(path.basename(real))) throw new Refused("REFUSED: the env file resolves to .env (production credentials)");
  const mine = stat(real, { bigint: true });
  for (const p of productionEnvPaths) {
    let prod;
    try {
      prod = stat(p, { bigint: true });
    } catch {
      continue;
    }
    if (prod.ino !== 0n && prod.ino === mine.ino && prod.dev === mine.dev) {
      throw new Refused("REFUSED: the env file is the same file as .env (a link); use .env.test");
    }
  }
  return real;
}

/**
 * Any libpq environment variable can redirect or reconfigure a connection; all are refused. Case-insensitive
 * (lane M2): Windows environment names are case-insensitive, so `pgoptions` IS PGOPTIONS to every reader there.
 */
export function refusePgEnvironment(env = process.env) {
  const set = Object.keys(env).filter((k) => /^PG[A-Z]/i.test(k) && env[k]);
  if (set.length) throw new Refused(`REFUSED: libpq environment variable(s) set: ${set.join(", ")}`);
}

/**
 * The target guard: the TEST endpoint and nothing else. expectHost is the TEST endpoint's whole id and
 * allowProduction is never passed, so db-target refuses production; the explicit check below is belt and braces.
 */
export function vetTarget(url) {
  let host;
  try {
    host = resolveDbTarget(url, { expectHost: TEST_ENDPOINT_ID });
  } catch (e) {
    throw new Refused(e instanceof TargetRefused ? e.message : "REFUSED: target could not be vetted");
  }
  if (host.includes(PRODUCTION_ENDPOINT_ID) || !host.startsWith(`${TEST_ENDPOINT_ID}`)) {
    throw new Refused("REFUSED: not the TEST endpoint");
  }
  return host;
}

/** Explicit pg config (as db-role-inspect.mjs builds it): never a connection string; TLS verification forced. */
export function clientConfig(url) {
  const p = parsePg(url);
  return {
    host: p.host, port: p.port ? Number(p.port) : 5432, user: p.user, password: p.password, database: p.database,
    ssl: { rejectUnauthorized: true }, application_name: "matflow-demo-rotate-test",
  };
}

/**
 * A 12-hex tag of the address, keyed: HMAC-SHA256 under `key` (the run's random key) over a labelled, normalised
 * address. Without the key — which is never printed or stored — nobody can test a guessed address against it.
 * There is no unkeyed form: calling it without a key throws.
 */
export function emailDigest(email, key) {
  if (!key || key.length < 32) throw new Error("emailDigest needs the run's 32-byte key");
  return crypto
    .createHmac("sha256", key)
    .update(`${ADDRESS_TAG_LABEL}${String(email).trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
}

/** The domain only: no character of the local part is shown. */
export function maskEmail(email) {
  const e = String(email);
  const at = e.lastIndexOf("@");
  return `***${at >= 0 ? e.slice(at).toLowerCase() : ""}`;
}

function readEnvFile(file) {
  const text = fs.readFileSync(file, "utf8");
  return Object.fromEntries(
    text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
  );
}

const CANDIDATES_SQL = `SELECT id, role, email, "sessionVersion" FROM "User"
  WHERE "tenantId" = $1 AND right(lower(email), ${DEMO_DOMAIN.length}) = '${DEMO_DOMAIN}' ORDER BY id`;

async function snapshotUsers(client) {
  const r = await client.query(`SELECT id, md5(u::text) AS h FROM "User" u`);
  return new Map(r.rows.map((x) => [x.id, x.h]));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  refusePgEnvironment();
  const env = readEnvFile(refuseProductionEnvFile(opts.envFile));
  // The address-tag key: random, this run only, never printed or stored. The run id is printed and audited instead.
  const run = { id: crypto.randomBytes(8).toString("hex"), key: crypto.randomBytes(32) };
  const url = env[opts.varName];
  if (!url) throw new Refused(`REFUSED: no ${opts.varName} in the env file`);
  const host = vetTarget(url);
  const { default: pg } = await import("pg");
  const { default: bcrypt } = await import("bcryptjs");

  const client = new pg.Client(clientConfig(url));
  await client.connect();
  let committed = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${opts.confirm ? "" : " READ ONLY"}`);
    await client.query("SET LOCAL statement_timeout = '60s'");
    // Transaction-local only: a session-level setting through the pooler leaks to other clients.
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    const who = (await client.query("SELECT current_user AS role")).rows[0];
    console.log(`target: TEST ${TEST_ENDPOINT_ID} (${host.includes("-pooler") ? "pooled" : "direct"}) role=${who.role}`);
    console.log(`run: ${run.id} (address tags are keyed for this run only; the key is never shown or stored)`);

    const t = (await client.query(`SELECT id FROM "Tenant" WHERE slug = $1`, [opts.slug])).rows[0];
    if (!t) {
      console.log(`tenant: ${opts.slug} not found`);
      await client.query("ROLLBACK");
      return 3;
    }
    console.log(`tenant: ${opts.slug} id=${t.id}`);

    const before = await snapshotUsers(client);
    const cands = (await client.query(`${CANDIDATES_SQL}${opts.confirm ? " FOR UPDATE" : ""}`, [t.id])).rows;
    console.log(`candidates (${cands.length}):`);
    for (const c of cands) {
      console.log(`  ${c.id}  role=${c.role}  local=${maskEmail(c.email)}  tag=${emailDigest(c.email, run.key)}`);
    }
    const ids = cands.map((c) => c.id);

    if (!opts.confirm) {
      console.log(`mode: dry run — would rotate ${cands.length} accounts (nothing changed)`);
      await client.query("ROLLBACK");
      return 0;
    }
    // parseArgs already refuses --confirm without --ids; checked again here so the write path can never run unbound.
    if (!opts.ids) throw new Refused("ABORTED: --confirm without --ids; nothing changed");
    const want = [...opts.ids].sort();
    if (want.length !== ids.length || want.some((id, i) => id !== ids[i])) {
      throw new Refused("ABORTED: --ids does not match the candidate set exactly; nothing changed");
    }
    if (cands.length === 0) {
      console.log("mode: confirm — nothing to rotate");
      await client.query("ROLLBACK");
      return 0;
    }

    for (const c of cands) {
      // A fresh random password per account. It is hashed and dropped: never printed, stored or logged.
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 12);
      const u = await client.query(
        `UPDATE "User" SET "passwordHash" = $1, "sessionVersion" = "sessionVersion" + 1, "updatedAt" = now()
          WHERE id = $2 AND "tenantId" = $3 AND right(lower(email), ${DEMO_DOMAIN.length}) = '${DEMO_DOMAIN}'`,
        [hash, c.id, t.id],
      );
      if (u.rowCount !== 1) throw new Refused(`ABORTED: update of ${c.id} touched ${u.rowCount} rows`);
      const a = await client.query(
        `INSERT INTO "AuditLog" (id, "tenantId", "userId", action, "entityType", "entityId", metadata, "createdAt")
          VALUES ($1, $2, $3, $4, 'User', $3, $5::jsonb, now())`,
        [
          `rot_${crypto.randomUUID()}`, t.id, c.id, AUDIT_ACTION,
          JSON.stringify({ runId: run.id, addressTag: emailDigest(c.email, run.key), sessionVersionBumped: true, tool: "scripts/readiness/demo-accounts-rotate.mjs", target: "test" }),
        ],
      );
      if (a.rowCount !== 1) throw new Refused(`ABORTED: audit row for ${c.id} not written`);
    }

    // The transaction id (low 32 bits, as xmin shows it) so a test can prove exactly which rows this run wrote.
    const xid = (await client.query("SELECT (txid_current() % 4294967296)::text AS xid")).rows[0].xid;
    console.log(`xid=${xid}`);

    // Assertions before COMMIT — any failure rolls everything back.
    const afterCands = (await client.query(CANDIDATES_SQL, [t.id])).rows;
    if (afterCands.length !== cands.length || afterCands.some((c, i) => c.id !== ids[i])) {
      throw new Refused("ABORTED: the candidate id set changed during the run");
    }
    for (const c of afterCands) {
      const was = cands.find((x) => x.id === c.id);
      if (c.sessionVersion !== was.sessionVersion + 1) throw new Refused(`ABORTED: ${c.id} sessionVersion did not move by exactly 1`);
    }
    const after = await snapshotUsers(client);
    if (after.size !== before.size) throw new Refused("ABORTED: the number of User rows changed");
    const idSet = new Set(ids);
    let unchanged = 0;
    for (const [id, h] of before) {
      if (idSet.has(id)) {
        if (after.get(id) === h) throw new Refused(`ABORTED: ${id} was not changed`);
        continue;
      }
      if (after.get(id) !== h) throw new Refused("ABORTED: a User row outside the listed ids changed");
      unchanged++;
    }
    await client.query("COMMIT");
    committed = true;
    console.log(`rotated ${ids.length} accounts: fresh random password (not shown, not stored), sessionVersion +1, ${ids.length} audit rows ${AUDIT_ACTION}`);
    console.log(`assert: candidate id set unchanged (${ids.length}); other User rows byte-identical: ${unchanged} (all tenants, same snapshot)`);
    return 0;
  } catch (e) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof Refused) {
        console.error(e.message);
        process.exit(e.message.startsWith("ABORTED") ? 1 : 2);
      }
      // Never echo a driver error verbatim: it can carry connection details. Code and class only.
      const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
      console.error(`ABORTED: ${e?.constructor?.name ?? "Error"}${code ? ` ${code}` : ""}; rolled back`);
      process.exit(1);
    },
  );
}
