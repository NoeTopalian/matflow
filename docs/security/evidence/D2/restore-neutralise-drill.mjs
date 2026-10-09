// Lane D2 (iteration 2, 9 Oct 2026) — restored-copy NEUTRALISATION drill (SF-80), the way lane F2 drilled the restore.
// Run against the ISOLATED restored copy served by
//   node scripts/readiness/backup-restore.mjs <export-dir> --no-revoke --serve-seconds=N --port=P
// (PGlite on 127.0.0.1, in memory; never TEST, never production). Prints counts and verdicts only — no row data.
//
//   node docs/security/evidence/D2/restore-neutralise-drill.mjs <export-dir> <port>
//
// Cells: (1) before — the copy WOULD act (hazards present, check not ok); (2) negative control — a PARTIAL
// neutralisation (kiosk only, rolled back) is still reported not ok; (3) neutraliseRestoredCopy; (4) after — nothing
// would act, the retention cron's purge predicate selects 0 clubs, every soft-deleted club is still soft-deleted, TOTP
// secrets identical (same digest, same count), one audit row with the originals; (5) idempotent second run;
// (6) the TOTP guard refuses and rolls back when a secret changes mid-run (a trigger plants the change).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { neutraliseRestoredCopy, neutralisationCheck, restoredHazards } from "../../../../scripts/readiness/backup-post-restore.mjs";

const [exportDir, portArg] = process.argv.slice(2);
if (!exportDir || !portArg) { console.error("usage: restore-neutralise-drill.mjs <export-dir> <port>"); process.exit(2); }
const baseline = JSON.parse(fs.readFileSync(path.join(exportDir, "baseline-fingerprint.json"), "utf8"));
const owner = baseline.tables.AuditLog.owner;
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(owner)) throw new Error("unexpected owner name");
const client = new pg.Client({ host: "127.0.0.1", port: Number(portArg), user: "postgres", database: "postgres", ssl: false });
await client.connect();
await client.query(`SET ROLE "${owner}"`);
const results = [];
const cell = (name, pass, detail = {}) => results.push({ cell: name, pass: !!pass, ...detail });
const readOnly = async (fn) => {
  await client.query("BEGIN READ ONLY");
  await client.query("SELECT set_config('app.bypass_rls','on',true)");
  try { return await fn(); } finally { await client.query("ROLLBACK"); }
};
const softDeleted = () => readOnly(async () => Number((await client.query(`select count(*) n from "Tenant" where "deletedAt" is not null`)).rows[0].n));
const purgeCandidates = () => readOnly(async () => Number((await client.query(`select count(*) n from "Tenant" where "deletedAt" is not null and "deletedAt" < now() - interval '30 days'`)).rows[0].n));

// (1) before
const before = await readOnly(() => neutralisationCheck(client));
const hazards = await readOnly(() => restoredHazards(client));
const softBefore = await softDeleted();
cell("before: the restored copy would act (check not ok)", !before.ok, {
  tenantsPastPurgeGrace: before.tenantsPastPurgeGrace, tenantsWithKioskToken: before.tenantsWithKioskToken,
  tenantsWithDisplayToken: before.tenantsWithDisplayToken, tenantsWithStripeAccount: before.tenantsWithStripeAccount,
  totpSecretsKept: before.totpSecretsKept, softDeleted: softBefore, usersWithTotp: hazards.usersWithTotp, membersWithTotp: hazards.membersWithTotp,
});

// (2) negative control: kiosk-only neutralisation, rolled back, must still be not ok
await client.query("BEGIN");
await client.query("SELECT set_config('app.bypass_rls','on',true)");
await client.query(`update "Tenant" set "kioskTokenHash" = null where "kioskTokenHash" is not null`);
const partial = await neutralisationCheck(client);
await client.query("ROLLBACK");
cell("negative control: a partial (kiosk-only) neutralisation is reported not ok", !partial.ok && partial.tenantsWithKioskToken === 0, {
  tenantsPastPurgeGrace: partial.tenantsPastPurgeGrace, tenantsWithStripeAccount: partial.tenantsWithStripeAccount,
});

// (6, run before the real neutralisation so the copy is still in its restored state) TOTP guard
await client.query(`CREATE OR REPLACE FUNCTION secd2_totp_flip() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN UPDATE "User" SET "totpSecret" = "totpSecret" || 'X' WHERE id = (SELECT id FROM "User" WHERE "totpSecret" IS NOT NULL ORDER BY id LIMIT 1); RETURN NULL; END $$`);
await client.query(`CREATE TRIGGER secd2_totp_flip AFTER UPDATE ON "Tenant" FOR EACH STATEMENT EXECUTE FUNCTION secd2_totp_flip()`);
let refused = null;
try { await neutraliseRestoredCopy(client, { reason: "lane D2 drill: TOTP guard control" }); } catch (e) { refused = String(e.message ?? e); }
await client.query(`DROP TRIGGER secd2_totp_flip ON "Tenant"`);
await client.query(`DROP FUNCTION secd2_totp_flip()`);
const afterRefusal = await readOnly(() => neutralisationCheck(client));
cell("TOTP guard: a secret changed mid-run → refused and rolled back (state unchanged)", refused?.includes("TOTP secrets changed") && afterRefusal.totpDigest === before.totpDigest
  && afterRefusal.tenantsWithKioskToken === before.tenantsWithKioskToken && afterRefusal.tenantsWithStripeAccount === before.tenantsWithStripeAccount, { refusal: refused });

// (3) neutralise
const t = Date.now();
const out = await neutraliseRestoredCopy(client, { reason: "lane D2 isolated restore drill" });
cell("neutraliseRestoredCopy committed", true, { ...out, ms: Date.now() - t });

// (4) after
const after = await readOnly(() => neutralisationCheck(client));
cell("after: nothing would act (check ok)", after.ok, {
  tenantsPastPurgeGrace: after.tenantsPastPurgeGrace, tenantsWithKioskToken: after.tenantsWithKioskToken,
  tenantsWithDisplayToken: after.tenantsWithDisplayToken, tenantsWithStripeAccount: after.tenantsWithStripeAccount,
});
cell("retention cron purge predicate (lib/tenant-purge.ts) selects 0 clubs", (await purgeCandidates()) === 0);
cell("every soft-deleted club is still soft-deleted (grace reset, not restored)", (await softDeleted()) === softBefore, { softDeleted: softBefore });
cell("TOTP secrets kept (same digest, same count)", after.totpDigest === before.totpDigest && after.totpSecretsKept === before.totpSecretsKept, { totpSecretsKept: after.totpSecretsKept });
const audit = await readOnly(async () => (await client.query(`select metadata from "AuditLog" where action = 'admin.restore.neutralise' and metadata->>'reason' = 'lane D2 isolated restore drill'`)).rows);
const md = audit[0]?.metadata ?? {};
cell("one audit row with counts and the originals (clocks, Stripe ids) for a deliberate re-attach", audit.length === 1
  && md.originals?.purgeClocks?.length === out.purgeClocksReset && md.originals?.stripeAccounts?.length === out.stripeAccountsDetached
  && md.kioskTokensRevoked === out.kioskTokensRevoked, { auditRows: audit.length });
cell("counts match the before state", out.kioskTokensRevoked === before.tenantsWithKioskToken && out.stripeAccountsDetached === before.tenantsWithStripeAccount
  && out.displayTokensRevoked === before.tenantsWithDisplayToken && out.purgeClocksReset === softBefore);

// (5) idempotent
const again = await neutraliseRestoredCopy(client, { reason: "lane D2 drill: second run" });
const after2 = await readOnly(() => neutralisationCheck(client));
cell("idempotent: second run revokes/detaches nothing new and stays ok", after2.ok && again.kioskTokensRevoked === 0 && again.stripeAccountsDetached === 0 && again.displayTokensRevoked === 0, again);

await client.query("RESET ROLE");
await client.end();
for (const r of results) console.log(JSON.stringify(r));
const bad = results.filter((r) => !r.pass);
console.log(JSON.stringify({ cells: results.length, passed: results.length - bad.length, node: process.version, target: `PGlite restored copy 127.0.0.1:${portArg}` }));
process.exit(bad.length ? 1 : 0);
