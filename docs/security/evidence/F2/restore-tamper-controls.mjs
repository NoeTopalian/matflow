// SF-64 negative controls for the iteration-2 restore verifier (lane F2, 9 Oct 2026). Run against the ISOLATED
// restored copy served by `backup-restore.mjs <export> --no-revoke --serve-seconds=N --port=P` (PGlite on 127.0.0.1;
// never TEST, never production). Each tamper runs in its own transaction, is fingerprinted INSIDE that transaction
// (uncommitted changes are visible to it), compared with the export's baseline, and rolled back. A positive control
// (no tamper) must PASS; every tamper must FAIL. Prints verdicts and the first matching fail line only.
//
//   node docs/security/evidence/F2/restore-tamper-controls.mjs <export-dir> <port>
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { takeFingerprint, compareFingerprints } from "../../../../scripts/readiness/restore-verify.mjs";

const [exportDir, portArg] = process.argv.slice(2);
const baseline = JSON.parse(fs.readFileSync(path.join(exportDir, "baseline-fingerprint.json"), "utf8"));
const owner = baseline.tables.AuditLog.owner;
const client = new pg.Client({ host: "127.0.0.1", port: Number(portArg), user: "postgres", database: "postgres", ssl: false });
await client.connect();
const cases = [
  ["positive control (no tamper)", [], true],
  ["policy USING expression changed, same name (SF-64 a)", [`ALTER POLICY tenant_isolation ON "AuditLog" USING (true)`], false],
  ["trigger function body replaced, same name (SF-64 b)", [`CREATE OR REPLACE FUNCTION matflow_lowercase_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`], false],
  ["trigger disabled", [`ALTER TABLE "User" DISABLE TRIGGER "User_email_lowercase"`], false],
  ["BYPASSRLS granted to the runtime role (SF-64 c)", [`ALTER ROLE matflow_app BYPASSRLS`], false],
  ["extra grant: TRUNCATE on AuditLog to the runtime role (SF-64 c)", [`GRANT TRUNCATE ON "AuditLog" TO matflow_app`], false],
  ["audit row rewritten, row count kept (SF-64 d)", [`UPDATE "AuditLog" SET action = 'secF2.tampered' WHERE id = (SELECT id FROM "AuditLog" ORDER BY id LIMIT 1)`], false],
  ["session version rewound on one user (security state, SF-64 e)", [`UPDATE "User" SET "sessionVersion" = "sessionVersion" - 1 WHERE id = (SELECT id FROM "User" ORDER BY id LIMIT 1)`], false],
  // The TEST copy holds no MagicLinkToken rows (9 Oct 2026), so "re-open a used link" would be vacuous: plant one.
  ["outstanding sign-in link planted (security state)", [`INSERT INTO "MagicLinkToken"(id, "tenantId", email, "tokenHash", "expiresAt") SELECT 'secF2-tamper', id, 'secf2-tamper@test.local', 'secF2-tamper', now() + interval '1 hour' FROM "Tenant" ORDER BY id LIMIT 1`], false],
  // Without content hashes the only signal for a rewound session version is the security state, which iteration 1
  // printed but never failed on.
  ["session version rewound, fingerprint WITHOUT content hashes", [`UPDATE "User" SET "sessionVersion" = "sessionVersion" - 1 WHERE id = (SELECT id FROM "User" ORDER BY id LIMIT 1)`], false, false],
];
const results = [];
for (const [name, stmts, expectPass, contentHash = true] of cases) {
  await client.query("BEGIN");
  try {
    for (const s of stmts) await client.query(s);
    await client.query(`SET LOCAL ROLE "${owner}"`);
    const fp = await takeFingerprint(client, { contentHash });
    const r = compareFingerprints(baseline, fp);
    const ok = (r.verdict === "PASS") === expectPass;
    results.push({ case: name, expected: expectPass ? "PASS" : "FAIL", got: r.verdict, caught: ok, firstFail: r.fails[0] ?? null });
  } finally {
    await client.query("ROLLBACK");
  }
}
await client.end();
for (const r of results) console.log(JSON.stringify(r));
const bad = results.filter((r) => !r.caught);
console.log(JSON.stringify({ cases: results.length, asExpected: results.length - bad.length, node: process.version }));
process.exit(bad.length ? 1 : 0);
