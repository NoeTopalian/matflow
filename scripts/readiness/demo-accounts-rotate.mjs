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
//   node scripts/readiness/demo-accounts-rotate.mjs --slug <tenant-slug>                 (dry run: list, change nothing)
//   node scripts/readiness/demo-accounts-rotate.mjs --slug <tenant-slug> --confirm [--ids <id,id,...>]
//   options: --env-file <path> (default .env.test)  --var TEST_DATABASE_URL|RESTRICTED_DATABASE_URL (default TEST_…)
//
// What it does, in ONE transaction (REPEATABLE READ, RLS bypass set transaction-locally, never on the session):
//  - lists the EXACT candidate rows: every User in that tenant whose e-mail ends with @demo.matflow — id, role, masked
//    local part and a 12-hex SHA-256 digest of the address; never the address in full;
//  - dry run (default): prints the list and "would rotate N accounts" and rolls back (READ ONLY);
//  - --confirm: per listed row, a fresh random password hashed with bcrypt(12) (the password is never printed, stored
//    or logged — it exists to make the old one irrelevant), sessionVersion + 1, and one AuditLog row
//    `admin.demo_account.rotated` with the user id and the e-mail digest. Before COMMIT it asserts that the candidate
//    id set is unchanged, that each listed row moved exactly one sessionVersion, and that EVERY other User row in the
//    database (this tenant and all others) is byte-identical to the transaction's own starting snapshot; any
//    difference rolls the whole run back. `--ids` binds the run to the ids a dry run printed: a different set aborts.
//  - prints the transaction id so a test can prove which rows this run wrote (xmin).
// It does not verify the old password; it makes it irrelevant. Exit codes: 0 done, 1 aborted (rolled back),
// 2 refused (target, arguments or environment), 3 no such tenant.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse as parsePg } from "pg-connection-string";
import { resolveDbTarget, TargetRefused, TEST_ENDPOINT_ID, PRODUCTION_ENDPOINT_ID } from "./db-target.mjs";

export const DEMO_DOMAIN = "@demo.matflow";
export const AUDIT_ACTION = "admin.demo_account.rotated";
const ALLOWED_VARS = ["TEST_DATABASE_URL", "RESTRICTED_DATABASE_URL"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CUIDISH = /^[A-Za-z0-9_-]{1,64}$/;

export class Refused extends Error {}

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
  if (path.basename(out.envFile) === ".env") throw new Refused("REFUSED: .env holds the production credentials; use .env.test");
  if (out.ids && (out.ids.length === 0 || !out.ids.every((s) => CUIDISH.test(s)))) throw new Refused("REFUSED: --ids must be a comma list of user ids");
  if (out.ids && !out.confirm) throw new Refused("REFUSED: --ids only makes sense with --confirm");
  return out;
}

/** Any libpq environment variable can redirect or reconfigure a connection; all are refused. */
export function refusePgEnvironment(env = process.env) {
  const set = Object.keys(env).filter((k) => /^PG[A-Z]/.test(k) && env[k]);
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

export function emailDigest(email) {
  return crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 12);
}

/** The local part masked to its first character and a fixed-width tail; addresses of one or two characters show none. */
export function maskEmail(email) {
  const e = String(email);
  const at = e.lastIndexOf("@");
  const local = at >= 0 ? e.slice(0, at) : e;
  const domain = at >= 0 ? e.slice(at) : "";
  return `${local.length > 2 ? local[0] : ""}***${domain.toLowerCase()}`;
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
  const env = readEnvFile(opts.envFile);
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
      console.log(`  ${c.id}  role=${c.role}  local=${maskEmail(c.email)}  digest=${emailDigest(c.email)}`);
    }
    const ids = cands.map((c) => c.id);

    if (!opts.confirm) {
      console.log(`mode: dry run — would rotate ${cands.length} accounts (nothing changed)`);
      await client.query("ROLLBACK");
      return 0;
    }
    if (opts.ids) {
      const want = [...opts.ids].sort();
      if (want.length !== ids.length || want.some((id, i) => id !== ids[i])) {
        throw new Refused("ABORTED: --ids does not match the candidate set exactly; nothing changed");
      }
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
          JSON.stringify({ emailDigest: emailDigest(c.email), sessionVersionBumped: true, tool: "scripts/readiness/demo-accounts-rotate.mjs", target: "test" }),
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
