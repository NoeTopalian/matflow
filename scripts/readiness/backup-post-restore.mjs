// Post-restore containment for a RESTORED copy (security campaign, iteration 2, lane F2; runbook §3).
//
// A restore rewinds the security state with the data: session versions bumped after the recovery point go back
// down (so JWTs those bumps had ended verify again — they are signed with the same AUTH_SECRET), sign-in links and
// reset codes consumed after the recovery point become outstanding again, and secrets re-enrolled after it (TOTP,
// OAuth tokens, kiosk tokens) revert. This module (a) inventories what could activate, counts only, and (b) applies
// the same containment the revoke-access route applies per club (app/api/admin/customers/[id]/revoke-access:
// sessionVersion + 1, outstanding reset codes and sign-in links retired, audited) — to EVERY club at once, plus
// operators (the route never touches Operator sessions) and every link purpose (the route retires only login and
// first_time_signup links). Verification afterwards: restore-verify compare --expect-revoked.
//
//   node scripts/readiness/backup-post-restore.mjs <env-file> <expected-host-substring> <VAR> inventory
//   node scripts/readiness/backup-post-restore.mjs <env-file> <expected-host-substring> <VAR> revoke --i-confirm-this-is-a-restored-copy
//
// Refuses production (ep-bold-wave) and the shared TEST branch (ep-hidden-salad): it signs everybody out. It is for a
// Neon restore branch (or the isolated restore of backup-restore.mjs, which calls the exported functions directly).
// On a production cut-over Noe uses the revoke-access route per club AND rotates AUTH_SECRET (runbook §3.4); this
// script is not authorised for production.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { resolveDbTarget, TargetRefused, PRODUCTION_ENDPOINT_ID } from "./db-target.mjs";
import { readEnvFile, refuseConnectionEnv } from "./restore-verify.mjs";

export const TEST_ENDPOINT_PREFIX = "ep-hidden-salad";

/** Counts of restored state that could activate if the copy were attached to an app or a scheduler. */
export async function restoredHazards(client) {
  const one = async (sql) => Number(Object.values((await client.query(sql)).rows[0])[0]);
  return {
    tenantsSoftDeleted: await one(`select count(*) from "Tenant" where "deletedAt" is not null`),
    tenantsPastPurgeGrace: await one(`select count(*) from "Tenant" where "deletedAt" < now() - interval '30 days'`),
    importJobsRunningOrLeased: await one(`select count(*) from "ImportJob" where status = 'running' or "leaseToken" is not null`),
    googleDriveConnections: await one(`select count(*) from "GoogleDriveConnection"`),
    usersWithTotp: await one(`select count(*) from "User" where "totpEnabled"`),
    membersWithTotp: await one(`select count(*) from "Member" where "totpEnabled"`),
    tenantsWithKioskToken: await one(`select count(*) from "Tenant" where "kioskTokenHash" is not null`),
    tenantsWithStripeAccount: await one(`select count(*) from "Tenant" where "stripeAccountId" is not null`),
    pushSubscriptions: await one(`select count(*) from "PushSubscription"`),
    magicLinkOutstanding: await one(`select count(*) from "MagicLinkToken" where not used and "expiresAt" > now()`),
    passwordResetOutstanding: await one(`select count(*) from "PasswordResetToken" where not used and "expiresAt" > now()`),
  };
}

/** Revoke every session and retire every outstanding link/code, in one transaction, audited. Returns counts. */
export async function revokeAllAfterRestore(client, { reason = "post-restore containment" } = {}) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.bypass_rls','on',true)");
    const n = async (sql, p = []) => (await client.query(sql, p)).rowCount;
    const out = {
      users: await n(`update "User" set "sessionVersion" = "sessionVersion" + 1`),
      members: await n(`update "Member" set "sessionVersion" = "sessionVersion" + 1`),
      operators: await n(`update "Operator" set "sessionVersion" = "sessionVersion" + 1`),
      resetCodes: await n(`update "PasswordResetToken" set used = true where not used`),
      signInLinks: await n(`update "MagicLinkToken" set used = true, "usedAt" = now() where not used`),
    };
    await client.query(
      `insert into "AuditLog"(id, "tenantId", action, "entityType", "entityId", metadata, "createdAt")
       values ($1, null, 'admin.restore.revoke_all', 'Platform', 'restore', $2::jsonb, now())`,
      [`restore-revoke-${Date.now()}`, JSON.stringify({ reason, ...out })],
    );
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [envFile, expectHost, varName, mode] = process.argv.slice(2);
  const die = (m, c = 2) => { console.error(m); process.exit(c); };
  if (!envFile || !expectHost || !varName || !["inventory", "revoke"].includes(mode)) die("usage: backup-post-restore.mjs <env-file> <expected-host-substring> <VAR> inventory|revoke [--i-confirm-this-is-a-restored-copy]");
  const url = readEnvFile(envFile)[varName];
  if (!url) die(`no ${varName} in ${envFile}`);
  let host;
  try {
    refuseConnectionEnv();
    host = resolveDbTarget(url, { expectHost, allowProduction: false });
  } catch (e) { die(e instanceof TargetRefused ? e.message : `REFUSED: ${String(e)}`); }
  if (host.includes(PRODUCTION_ENDPOINT_ID)) die("REFUSED: production");
  if (host.startsWith(TEST_ENDPOINT_PREFIX)) die("REFUSED: the shared TEST branch is not a restored copy");
  if (mode === "revoke" && !process.argv.includes("--i-confirm-this-is-a-restored-copy")) die("REFUSED: revoke needs --i-confirm-this-is-a-restored-copy");
  const client = new pg.Client({ connectionString: url, application_name: "matflow-post-restore" });
  await client.connect();
  try {
    if (mode === "inventory") {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.bypass_rls','on',true)");
      console.log(JSON.stringify({ hazards: await restoredHazards(client) }));
      await client.query("ROLLBACK");
    } else {
      console.log(JSON.stringify({ revoked: await revokeAllAfterRestore(client) }));
    }
  } finally {
    await client.end();
  }
}
