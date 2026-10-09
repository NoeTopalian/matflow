// Isolated restore drill (security campaign, iteration 2, lane F2, SF-19 / SEC-086): restores an export made by
// backup-export.mjs into a FRESH, PRIVATE, IN-PROCESS Postgres (PGlite, Postgres 17 compiled to WebAssembly — the
// only Postgres available on this machine: no pg_dump/psql/server, no Docker, no WSL, no Neon CLI or API token),
// verifies it with restore-verify against the baseline fingerprint taken in the export's own snapshot, inventories
// what could activate, applies the post-restore revocation and verifies that too. Nothing listens beyond 127.0.0.1;
// with no --data-dir the database lives in memory and disappears when the process exits.
//
//   node scripts/readiness/backup-restore.mjs <export-dir> [--port=55432] [--data-dir=<dir>] [--out=<dir>]
//        [--serve-seconds=N] [--no-revoke]
//
// Steps (each timed): 1 verify the export's sha256s; 2 create the roles and memberships the manifest names
// (flags copied; never passwords — the copy has no login path besides this process); 3 replay every finished
// migration from prisma/migrations IN THE SOURCE'S ORDER as the source table owner, after checking each file's
// sha256 against the source's _prisma_migrations checksum (a file edited after it ran is replayed in the committed
// version whose checksum matches, and reported; no matching version — FAIL; the line-ending variant that matched —
// as checked out, LF or CRLF — is the one replayed and is reported, SF-95); 4 load rows with session_replication_role = replica (FK and user triggers off, as pg_restore
// --disable-triggers does; orphans are counted afterwards); 5 re-apply table/function/schema grants from the
// manifest, then (5b, F3) column grants, the database ACL, role/database settings and default privileges; 6 fingerprint the copy over a 127.0.0.1 socket as the table owner and compare with the baseline
// (restore-verify compareFingerprints: identical security state required); 7 hazard inventory; 8 revoke every
// session/link/code (backup-post-restore.mjs) and compare again with --expect-revoked.
// Writes <out>/restored-fingerprint.json, <out>/restored-revoked-fingerprint.json and prints one JSON summary line.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { takeFingerprint, compareFingerprints } from "./restore-verify.mjs";
import { restoredHazards, revokeAllAfterRestore } from "./backup-post-restore.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const args = process.argv.slice(2);
const exportDir = args.find((a) => !a.startsWith("--"));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d ?? ""}`).split("=").slice(1).join("=");
if (!exportDir) die("usage: backup-restore.mjs <export-dir> [--port=55432] [--data-dir=<dir>] [--out=<dir>] [--serve-seconds=N] [--no-revoke]");
const port = Number(opt("port", "55432"));
const outDir = path.resolve(opt("out", exportDir));
const dataDir = opt("data-dir", "");
if (dataDir && (path.resolve(dataDir) + path.sep).toLowerCase().startsWith((REPO + path.sep).toLowerCase())) die("REFUSED: --data-dir inside the repository");
const ident = (s) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unexpected identifier ${s}`); return `"${s}"`; };

const timings = {};
const T = async (name, fn) => { const t = Date.now(); const r = await fn(); timings[name] = Date.now() - t; return r; };
const t0 = Date.now();
const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
const baseline = JSON.parse(fs.readFileSync(path.join(exportDir, "baseline-fingerprint.json"), "utf8"));

// 1. Integrity of the export itself.
await T("verifyExport", async () => {
  const fpHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(exportDir, "baseline-fingerprint.json"))).digest("hex");
  if (fpHash !== manifest.baselineFingerprintSha256) die("FAIL: baseline fingerprint hash mismatch", 1);
  for (const [t, m] of Object.entries(manifest.tables)) {
    const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(exportDir, "data", `${t}.ndjson`))).digest("hex");
    if (h !== m.sha256) die(`FAIL: export file for ${t} does not match its manifest hash`, 1);
  }
});

const db = dataDir ? new PGlite(dataDir) : new PGlite();
await db.waitReady;
const ownerRole = baseline.tables.AuditLog?.owner ?? manifest.role;

// 2. Roles (flags only).
await T("roles", async () => {
  const names = new Set(Object.keys(manifest.roles));
  for (const r of Object.values(manifest.roles)) for (const m of String(r.memberof).split(",").filter(Boolean)) names.add(m);
  for (const name of names) {
    if (name.startsWith("pg_") || name === "postgres") continue;
    const r = manifest.roles[name];
    const exists = (await db.query(`select 1 from pg_roles where rolname = $1`, [name])).rows.length > 0;
    if (exists) continue;
    const f = r
      ? [r.rolcanlogin ? "LOGIN" : "NOLOGIN", r.rolbypassrls ? "BYPASSRLS" : "NOBYPASSRLS", r.rolcreaterole ? "CREATEROLE" : "NOCREATEROLE",
         r.rolcreatedb ? "CREATEDB" : "NOCREATEDB", r.rolreplication ? "REPLICATION" : "NOREPLICATION", r.rolinherit ? "INHERIT" : "NOINHERIT", "NOSUPERUSER"]
      : ["NOLOGIN"];
    await db.exec(`CREATE ROLE ${ident(name)} ${f.join(" ")}`);
  }
  for (const [name, r] of Object.entries(manifest.roles)) {
    if (name.startsWith("pg_")) continue;
    for (const m of String(r.memberof).split(",").filter(Boolean)) await db.exec(`GRANT ${ident(m)} TO ${ident(name)}`);
  }
  // The source's public schema is owned by pg_database_owner (Neon: the database owner). Make the source table
  // owner the database owner here, so it holds CREATE on public exactly as on the source.
  const dbname = (await db.query(`select current_database() d`)).rows[0].d;
  await db.exec(`ALTER DATABASE ${ident(dbname)} OWNER TO ${ident(ownerRole)}`);
});

// 3. Schema: replay the source's migrations from the repository, checksum-checked, as the source table owner.
const migRows = fs.readFileSync(path.join(exportDir, "data", "_prisma_migrations.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((m) => m.finished_at && !m.rolled_back_at).sort((a, b) => a.migration_name.localeCompare(b.migration_name));
const editedAfterApply = [];
// SF-95 (lane F3): the checksum the source recorded is over the bytes IT ran, with whatever line endings that
// checkout had. A git checkout may hold the same file with the other ending (core.autocrlf), and a function body
// replayed with different line endings has a different prosrc, so the verifier then (rightly) reports the function
// as changed. Try the file as checked out, then LF-normalised, then CRLF, and replay EXACTLY the variant whose sha256
// matched the source's checksum — never the raw bytes after matching a normalised text. The variant is reported.
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
function lineEndingVariants(text) {
  const lf = text.replace(/\r\n/g, "\n");
  return [["as-checked-out", text], ["lf", lf], ["crlf", lf.replace(/\n/g, "\r\n")]];
}
function matchChecksumVariant(text, sum) {
  const hit = lineEndingVariants(text).find(([, t]) => sha256(t) === sum);
  return hit ? { variant: hit[0], text: hit[1] } : null;
}
const replayedVariant = {};
await T("migrations", async () => {
  await db.exec(`SET ROLE ${ident(ownerRole)}`);
  await db.exec(`CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
  for (const m of migRows) {
    const file = path.join(REPO, "prisma", "migrations", m.migration_name, "migration.sql");
    if (!fs.existsSync(file)) die(`FAIL: migration ${m.migration_name} applied on the source is missing from the repository`, 1);
    let match = matchChecksumVariant(fs.readFileSync(file, "utf8"), m.checksum);
    if (!match) {
      // Edited after it ran on the source. Replay the text the source actually ran, if git history has it, and record
      // the edit; otherwise FAIL (the repository cannot reproduce the source's schema history).
      const rel = `prisma/migrations/${m.migration_name}/migration.sql`;
      const shas = execFileSync("git", ["log", "--format=%H", "--", rel], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
      let hitSha = null;
      for (const h of shas) {
        match = matchChecksumVariant(execFileSync("git", ["show", `${h}:${rel}`], { cwd: REPO, encoding: "utf8" }), m.checksum);
        if (match) { hitSha = h; break; }
      }
      if (!match) die(`FAIL: checksum of ${m.migration_name} differs from the source's record and no committed version matches (any line ending)`, 1);
      editedAfterApply.push({ migration: m.migration_name, sourceRanCommit: hitSha.slice(0, 7), headCommit: shas[0].slice(0, 7), variant: match.variant });
    }
    replayedVariant[m.migration_name] = match.variant;
    try { await db.exec(match.text); } catch (e) { die(`FAIL: migration ${m.migration_name} did not replay: ${e.message}`, 1); }
  }
  await db.exec(`RESET ROLE`);
});

// 4. Data, triggers and FK checks off for the load (superuser), exactly the exported rows.
const loaded = {};
await T("data", async () => {
  await db.exec(`SET session_replication_role = replica`);
  for (const t of Object.keys(manifest.tables)) {
    const cols = (await db.query(`select a.attname n, format_type(a.atttypid, a.atttypmod) ty from pg_attribute a
                                   where a.attrelid = ('public.' || quote_ident($1))::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [t])).rows
      .map((c) => `${c.n}:${c.ty}`);
    if (JSON.stringify(cols) !== JSON.stringify(manifest.tables[t].columns)) die(`FAIL: column definitions of ${t} differ between the source and the replayed schema`, 1);
    const lines = fs.readFileSync(path.join(exportDir, "data", `${t}.ndjson`), "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i += 1000) {
      await db.query(`INSERT INTO public.${ident(t)} SELECT * FROM json_populate_recordset(null::public.${ident(t)}, $1::json)`, [`[${lines.slice(i, i + 1000).join(",")}]`]);
    }
    loaded[t] = lines.length;
  }
  // JSON null was exported as a sentinel string (backup-export.mjs); turn it back and check the count.
  for (const [t, m] of Object.entries(manifest.tables)) {
    for (const [c, n] of Object.entries(m.jsonNulls ?? {})) {
      const r = await db.query(`UPDATE public.${ident(t)} SET ${ident(c)} = 'null'::jsonb WHERE ${ident(c)}::jsonb = to_jsonb($1::text)`, [manifest.jsonNullSentinel]);
      if (r.affectedRows !== n) die(`FAIL: ${t}.${c}: ${r.affectedRows} JSON nulls restored, manifest says ${n}`, 1);
    }
  }
  for (const s of manifest.sequences ?? []) await db.query(`select setval($1::regclass, $2::bigint, $3)`, [`public.${ident(s.seq)}`, s.lastValue, s.isCalled]);
  await db.exec(`RESET session_replication_role`);
});

// 5. Grants (the part a --no-owner --no-privileges dump drops).
await T("grants", async () => {
  for (const g of manifest.tableGrants) await db.exec(`GRANT ${g.priv} ON ${g.kind === "S" ? "SEQUENCE" : "TABLE"} public.${ident(g.obj)} TO ${ident(g.grantee)}`);
  for (const g of manifest.functionGrants) await db.exec(`GRANT ${g.priv} ON FUNCTION ${g.obj} TO ${g.grantee === "PUBLIC" ? "PUBLIC" : ident(g.grantee)}`);
  const acl = (await db.query(`select (aclexplode($1::aclitem[])).* `, [manifest.schemaPublic.acl])).rows;
  for (const a of acl) {
    const who = a.grantee === 0 ? "PUBLIC" : (await db.query(`select rolname from pg_roles where oid = $1`, [a.grantee])).rows[0].rolname;
    if (who === "pg_database_owner") continue;
    await db.exec(`GRANT ${a.privilege_type} ON SCHEMA public TO ${who === "PUBLIC" ? "PUBLIC" : ident(who)}`);
  }
});

// 5b. Globals the SF-96 fingerprint compares (lane F3): column grants, database ACL, role/database settings and —
// last, so they never touch the objects replayed above, as pg_dump orders them — default privileges. An export
// from before F3 has none of these keys and its baseline none of the sections: compare then reports the version
// mismatch instead of passing. Roles named only here (e.g. a platform role that holds default privileges on Neon)
// are created NOLOGIN; the restore reports which.
const placeholderRoles = [];
const PRIV = /^[A-Z ]+$/;
const who = (g) => (g === "PUBLIC" ? "PUBLIC" : ident(g));
const needRole = async (name) => {
  if (!name || name === "PUBLIC" || name.startsWith("pg_")) return;
  if ((await db.query(`select 1 from pg_roles where rolname = $1`, [name])).rows.length) return;
  await db.exec(`CREATE ROLE ${ident(name)} NOLOGIN`);
  placeholderRoles.push(name);
};
const settingValue = (name, value) => (name.toLowerCase() === "search_path"
  // a list GUC: each element its own literal, exactly as pg_dump writes it
  ? value.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1")).map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")
  : `'${value.replace(/'/g, "''")}'`);
await T("globals", async () => {
  for (const g of manifest.columnGrants ?? []) {
    if (!PRIV.test(g.priv)) die(`FAIL: unexpected privilege in manifest: ${g.priv}`, 1);
    await needRole(g.grantee);
    await db.exec(`GRANT ${g.priv} (${ident(g.col)}) ON TABLE public.${ident(g.obj)} TO ${who(g.grantee)}${g.grantable ? " WITH GRANT OPTION" : ""}`);
  }
  const dbname = (await db.query(`select current_database() d`)).rows[0].d;
  if (manifest.databaseAcl) {
    // Reproduce the effective ACL exactly: start from nothing for PUBLIC, then grant what the source had.
    await db.exec(`REVOKE ALL ON DATABASE ${ident(dbname)} FROM PUBLIC`);
    for (const g of manifest.databaseAcl) {
      if (!PRIV.test(g.priv)) die(`FAIL: unexpected privilege in manifest: ${g.priv}`, 1);
      await needRole(g.grantee);
      await db.exec(`GRANT ${g.priv} ON DATABASE ${ident(dbname)} TO ${who(g.grantee)}${g.grantable ? " WITH GRANT OPTION" : ""}`);
    }
  }
  for (const s of manifest.roleSettings ?? []) {
    await needRole(s.role);
    for (const kv of s.config ?? []) {
      const i = kv.indexOf("=");
      const name = kv.slice(0, i);
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) die(`FAIL: unexpected setting name in manifest: ${name}`, 1);
      const target = s.role ? `ROLE ${ident(s.role)}${s.scope === "this" ? ` IN DATABASE ${ident(dbname)}` : ""}`
        : s.scope === "this" ? `DATABASE ${ident(dbname)}` : "ROLE ALL";
      await db.exec(`ALTER ${target} SET ${name} = ${settingValue(name, kv.slice(i + 1))}`);
    }
  }
  const OBJ = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };
  for (const g of manifest.defaultPrivileges ?? []) {
    if (!PRIV.test(g.priv) || !OBJ[g.objtype]) die(`FAIL: unexpected default privilege in manifest: ${g.objtype}/${g.priv}`, 1);
    await needRole(g.role);
    await needRole(g.grantee);
    await db.exec(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(g.role)}${g.nsp ? ` IN SCHEMA ${ident(g.nsp)}` : ""} GRANT ${g.priv} ON ${OBJ[g.objtype]} TO ${who(g.grantee)}${g.grantable ? " WITH GRANT OPTION" : ""}`);
  }
});

// 6–8 over a loopback socket, with the same pg driver the verifier uses on Neon.
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", ssl: false });
await client.connect();
const fingerprint = async () => {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL ROLE ${ident(ownerRole)}`);
  const fp = await takeFingerprint(client, { contentHash: true });
  await client.query("ROLLBACK");
  return fp;
};
const restoredFp = await T("verify", fingerprint);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "restored-fingerprint.json"), JSON.stringify(restoredFp, null, 1));
const cmp = compareFingerprints(baseline, restoredFp);
await client.query("BEGIN READ ONLY");
await client.query(`SET LOCAL ROLE ${ident(ownerRole)}`);
const hazards = await restoredHazards(client);
await client.query("ROLLBACK");
timings.restoreToVerifiedMs = Date.now() - t0;
let revoked = null, cmpRevoked = null;
if (!args.includes("--no-revoke")) {
  await client.query(`SET ROLE ${ident(ownerRole)}`);
  revoked = await T("revoke", () => revokeAllAfterRestore(client, { reason: "isolated restore drill (lane F2)" }));
  await client.query(`RESET ROLE`);
  const fp2 = await fingerprint();
  fs.writeFileSync(path.join(outDir, "restored-revoked-fingerprint.json"), JSON.stringify(fp2, null, 1));
  cmpRevoked = compareFingerprints(baseline, fp2, { expectRevoked: true });
}
const summary = {
  verdict: cmp.verdict === "PASS" && (!cmpRevoked || cmpRevoked.verdict === "PASS") ? "RESTORED-AND-VERIFIED" : "FAIL",
  target: `PGlite ${(await db.query("select version() v")).rows[0].v.split(" on ")[0]} in-process${dataDir ? " (data dir)" : " (memory)"}, 127.0.0.1:${port}`,
  node: process.version,
  recoveryPoint: manifest.recoveryPoint,
  recoverableAgeAtVerifyMs: Date.parse(restoredFp.takenAt instanceof Date ? restoredFp.takenAt.toISOString() : restoredFp.takenAt) - Date.parse(manifest.recoveryPoint),
  migrationsReplayed: migRows.length,
  migrationsEditedAfterApply: editedAfterApply,
  // SF-95: which line-ending variant of each migration matched the source's checksum (and was replayed).
  migrationLineEndings: Object.values(replayedVariant).reduce((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {}),
  migrationsReplayedAsVariant: Object.entries(replayedVariant).filter(([, v]) => v !== "as-checked-out").map(([migration, variant]) => ({ migration, variant })),
  placeholderRoles,
  rowsLoaded: Object.values(loaded).reduce((s, n) => s + n, 0),
  compare: { verdict: cmp.verdict, fails: cmp.fails, notes: cmp.notes.length },
  hazards,
  revoked,
  compareAfterRevoke: cmpRevoked && { verdict: cmpRevoked.verdict, fails: cmpRevoked.fails, notes: cmpRevoked.notes },
  timings,
};
console.log(JSON.stringify(summary));
await client.end();
const serve = Number(opt("serve-seconds", "0"));
if (serve > 0) {
  // PGlite is one session: the socket server serves one client at a time, and session state (SET ROLE) is shared.
  console.error(`serving the restored copy on 127.0.0.1:${port} for ${serve}s`);
  await new Promise((r) => setTimeout(r, serve * 1000));
}
await server.stop();
await db.close();
process.exit(summary.verdict === "RESTORED-AND-VERIFIED" ? 0 : 1);
