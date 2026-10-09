// READ-ONLY restore verifier (security campaign 9 Oct 2026, lane F, SEC-086 / SEC-087).
//
// Takes a structural + security-state FINGERPRINT of a database and compares two fingerprints, so a restored
// copy (a Neon point-in-time branch, or a pg_restore of a weekly dump) can be checked against a baseline of the
// source. Counts and catalogue facts only: no row data, no credentials, no addresses.
//
//   node scripts/readiness/restore-verify.mjs snapshot <env-file> <expected-host-substring> [VAR] > fp.json
//   node scripts/readiness/restore-verify.mjs compare <baseline.json> <restored.json> [--allow-drift=T1,T2]
//
// snapshot opens ONE connection, runs ONE `BEGIN READ ONLY` transaction (statement_timeout 15 s, whole run capped at
// 180 s) and records, per public table: exact row count, RLS enabled/forced, policy names, non-internal triggers;
// plus: Postgres major version, every migration in _prisma_migrations (name + finished/rolled-back state), every FK
// constraint with its validated flag and its ORPHAN count (child rows whose parent is missing), and the security
// state a restore silently rewinds (outstanding unexpired sign-in/reset tokens, sum of session versions, operators).
// The production host (ep-bold-wave) is refused unless `--production-read-only` is passed explicitly; that flag is
// for the lead or Noe taking a baseline, never for a lane.
//
// compare exits 0 only when: same major version; identical migration list; identical table set; identical RLS /
// force flags, policies and triggers; zero orphans and zero unvalidated FKs in the restored copy; identical row
// counts except tables named in --allow-drift (activity between the restore point and the baseline). It always
// prints the post-restore security actions (sessions and tokens rewind with the data; see
// docs/security/INCIDENT-AND-RESTORE-RUNBOOK.md §3).
import fs from "node:fs";
import pg from "pg";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const [mode, a, b, c4] = process.argv.slice(2);
const flags = process.argv.slice(2).filter((x) => x.startsWith("--"));
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

if (mode === "snapshot") await snapshot(a, b, c4 && !c4.startsWith("--") ? c4 : "DATABASE_URL");
else if (mode === "compare") compare(a, b);
else die("usage: restore-verify.mjs snapshot <env-file> <expected-host-substring> [VAR] | compare <base.json> <restored.json> [--allow-drift=A,B]");

async function snapshot(envFile, expectHost, varName) {
  if (!envFile || !expectHost) die("snapshot needs <env-file> <expected-host-substring>");
  const env = Object.fromEntries(
    fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
  );
  const url = env[varName];
  if (!url) die(`no ${varName} in ${envFile}`);
  // Shared guard (review of lane F, 9 Oct 2026): resolves the EFFECTIVE host the way pg does, refuses
  // host= / hostaddr= / options= overrides outright, compares case-insensitively, and admits the production
  // endpoint only behind the explicit flag.
  let host;
  try {
    host = resolveDbTarget(url, { expectHost, allowProduction: flags.includes("--production-read-only") });
  } catch (e) {
    die(e instanceof TargetRefused ? e.message : `REFUSED: ${String(e)}`);
  }
  const killer = setTimeout(() => die("ABORTED: 180 s ceiling reached", 3), 180_000);
  const client = new pg.Client({ connectionString: url, application_name: "matflow-restore-verify-readonly" });
  await client.connect();
  const q = async (sql, p = []) => (await client.query(sql, p)).rows;
  const fp = { takenAt: new Date().toISOString(), hostPrefix: host.slice(0, 16), pooler: host.includes("-pooler") };
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Counts must not depend on the connecting role: the policies honour this transaction-local flag.
    await client.query("SELECT set_config('app.bypass_rls','on',true)");
    fp.role = (await q("select current_user as u"))[0].u;
    fp.pgMajor = Number((await q("show server_version_num"))[0].server_version_num.slice(0, 2));
    const mig = await q(`select migration_name, finished_at is not null as finished, rolled_back_at is not null as rolled_back
                           from _prisma_migrations order by migration_name`);
    fp.migrations = mig.map((m) => `${m.migration_name}${m.finished ? "" : " [UNFINISHED]"}${m.rolled_back ? " [ROLLED-BACK]" : ""}`);
    const tables = await q(`select c.relname t, c.relrowsecurity rls, c.relforcerowsecurity force
                              from pg_class c join pg_namespace n on n.oid=c.relnamespace
                             where n.nspname='public' and c.relkind='r' order by c.relname`);
    const pol = await q(`select tablename t, string_agg(policyname||':'||cmd, ',' order by policyname) p from pg_policies where schemaname='public' group by tablename`);
    const trg = await q(`select c.relname t, string_agg(tg.tgname, ',' order by tg.tgname) g from pg_trigger tg join pg_class c on c.oid=tg.tgrelid
                          join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not tg.tgisinternal group by c.relname`);
    const polBy = Object.fromEntries(pol.map((r) => [r.t, r.p]));
    const trgBy = Object.fromEntries(trg.map((r) => [r.t, r.g]));
    fp.tables = {};
    for (const t of tables) {
      const n = (await q(`select count(*)::bigint n from public.${ident(t.t)}`))[0].n;
      fp.tables[t.t] = { rows: Number(n), rls: t.rls, force: t.force, policies: polBy[t.t] ?? "", triggers: trgBy[t.t] ?? "" };
    }
    const fks = await q(`select con.conname, cl.relname child, pl.relname parent, con.convalidated validated,
                                (select array_agg(a.attname order by k.i) from unnest(con.conkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.n) ccols,
                                (select array_agg(a.attname order by k.i) from unnest(con.confkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.n) pcols
                           from pg_constraint con join pg_class cl on cl.oid=con.conrelid join pg_class pl on pl.oid=con.confrelid
                           join pg_namespace n on n.oid=cl.relnamespace where con.contype='f' and n.nspname='public' order by con.conname`);
    fp.foreignKeys = {};
    for (const f of fks) {
      const cc = pgArr(f.ccols), pc = pgArr(f.pcols);
      const notNull = cc.map((c) => `ch.${ident(c)} is not null`).join(" and ");
      const join = cc.map((c, i) => `p.${ident(pc[i])} = ch.${ident(c)}`).join(" and ");
      const orphans = (await q(`select count(*)::bigint n from public.${ident(f.child)} ch where ${notNull}
                                   and not exists (select 1 from public.${ident(f.parent)} p where ${join})`))[0].n;
      fp.foreignKeys[f.conname] = { child: f.child, parent: f.parent, validated: f.validated, orphans: Number(orphans) };
    }
    // Security state that rewinds with the data (compare prints the consequences; values are counts only).
    const one = async (sql) => Number(Object.values((await q(sql))[0])[0]);
    fp.securityState = {
      magicLinkOutstanding: await one(`select count(*) from "MagicLinkToken" where not used and "expiresAt" > now()`),
      passwordResetOutstanding: await one(`select count(*) from "PasswordResetToken" where not used and "expiresAt" > now()`),
      userSessionVersionSum: await one(`select coalesce(sum("sessionVersion"),0) from "User"`),
      memberSessionVersionSum: await one(`select coalesce(sum("sessionVersion"),0) from "Member"`),
      operatorSessionVersionSum: await one(`select coalesce(sum("sessionVersion"),0) from "Operator"`),
      operators: await one(`select count(*) from "Operator"`),
      latestAuditAt: (await q(`select max("createdAt") m from "AuditLog"`))[0].m,
    };
    await client.query("ROLLBACK");
  } finally {
    clearTimeout(killer);
    await client.end();
  }
  console.log(JSON.stringify(fp, null, 1));
}

function compare(basePath, restoredPath) {
  if (!basePath || !restoredPath) die("compare needs <baseline.json> <restored.json>");
  const A = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const B = JSON.parse(fs.readFileSync(restoredPath, "utf8"));
  const allow = new Set((flags.find((f) => f.startsWith("--allow-drift=")) ?? "").replace("--allow-drift=", "").split(",").filter(Boolean));
  const fails = [];
  const notes = [];
  if (A.pgMajor !== B.pgMajor) fails.push(`postgres major ${A.pgMajor} -> ${B.pgMajor}`);
  const ma = A.migrations.join("\n"), mb = B.migrations.join("\n");
  if (ma !== mb) fails.push(`migrations differ (baseline ${A.migrations.length}, restored ${B.migrations.length}; restored head ${B.migrations.at(-1)})`);
  if (B.migrations.some((m) => /UNFINISHED|ROLLED-BACK/.test(m))) fails.push("restored copy has an unfinished or rolled-back migration");
  const ta = Object.keys(A.tables), tb = Object.keys(B.tables);
  for (const t of ta) if (!B.tables[t]) fails.push(`table missing in restored copy: ${t}`);
  for (const t of tb) if (!A.tables[t]) fails.push(`unexpected table in restored copy: ${t}`);
  for (const t of ta) {
    const x = A.tables[t], y = B.tables[t];
    if (!y) continue;
    if (x.rls !== y.rls || x.force !== y.force) fails.push(`RLS flags changed on ${t}: ${x.rls}/${x.force} -> ${y.rls}/${y.force}`);
    if (x.policies !== y.policies) fails.push(`policies changed on ${t}`);
    if (x.triggers !== y.triggers) fails.push(`triggers changed on ${t}: [${x.triggers}] -> [${y.triggers}]`);
    if (x.rows !== y.rows) (allow.has(t) ? notes : fails).push(`row count ${t}: ${x.rows} -> ${y.rows}${allow.has(t) ? " (allowed drift)" : ""}`);
  }
  for (const [k, f] of Object.entries(B.foreignKeys)) {
    if (f.orphans > 0) fails.push(`orphans in ${f.child} via ${k}: ${f.orphans}`);
    if (!f.validated) fails.push(`foreign key not validated: ${k}`);
    if (!A.foreignKeys[k]) fails.push(`unexpected foreign key ${k}`);
  }
  for (const k of Object.keys(A.foreignKeys)) if (!B.foreignKeys[k]) fails.push(`foreign key missing in restored copy: ${k}`);
  const s = B.securityState, sa = A.securityState;
  console.log(JSON.stringify({ verdict: fails.length ? "FAIL" : "PASS", fails, notes }, null, 1));
  console.log("\nPOST-RESTORE SECURITY ACTIONS (always required; the restored copy rewinds them):");
  console.log(`- Session versions rewind (restored sums user ${s.userSessionVersionSum}/member ${s.memberSessionVersionSum}/operator ${s.operatorSessionVersionSum} vs baseline ${sa.userSessionVersionSum}/${sa.memberSessionVersionSum}/${sa.operatorSessionVersionSum}): every revocation after the restore point is undone. Revoke all sessions (runbook §3.4).`);
  console.log(`- ${s.magicLinkOutstanding} sign-in links and ${s.passwordResetOutstanding} reset codes are outstanding in the restored copy, including any consumed after the restore point. Cancel them (runbook §3.4).`);
  console.log("- Re-apply DSAR erasures and account removals made after the restore point (docs/runbooks/db-restore.md).");
  process.exit(fails.length ? 1 : 0);
}

function ident(s) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unexpected identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
}
function pgArr(v) {
  return Array.isArray(v) ? v : String(v).replace(/^{|}$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
}
