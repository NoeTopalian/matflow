// READ-ONLY state of a club's staff accounts, for handing the owner account
// over (3 Oct 2026). Prints security flags and counts only: emails are masked,
// no password hashes, TOTP secrets or recovery codes are printed (only whether
// they are set and how many). The whole read runs in a READ ONLY transaction,
// so Postgres itself refuses any write.
//
//   node scripts/readiness/owner-account-state.mjs --tenant totalbjj                  # DATABASE_URL from .env (PRODUCTION: operator runs this by hand)
//   node scripts/readiness/owner-account-state.mjs --tenant totalbjj --env .env.test  # test branch
//
// Exit code: 0 when every handover invariant passes, 2 when any fails, 1 on error.
//
// The handover invariants:
//   1. exactly one User on the tenant;
//   2. that user is the owner;
//   3. EITHER ready-for-handover (totpEnabled false, no TOTP secret, zero
//      recovery codes, mustChangePassword true) OR already activated by the
//      owner (totpEnabled true, mustChangePassword false) - said which.
//      "ALREADY ACTIVATED" is printed only with at least one LoginEvent for
//      the owner and no password/TOTP audit row for the owner carrying
//      metadata.actingAs (a support session); otherwise the precise state is
//      printed and the check FAILS (scripts/readiness/activation-verdict.mjs);
//   4. no unused, unexpired password-reset token for the owner's address (the
//      address is provisional and its mailbox is not proven - a live reset
//      link there is a way in for whoever reads that mailbox);
//   5. the account is not locked.
// Reached through the audited operator routes, not SQL: /admin -> the club ->
// "Reset password" (force-password-reset) then "Reset 2FA" (totp-reset).
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
import { ownerActivationVerdict, countSupportCredentialRows, countOperatorResetsBeforeActivation, selectOwnActivationEvidence, OPERATOR_CREATE_ACTIONS, operatorCreateRowsFor } from "./activation-verdict.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const SLUG = opt("--tenant", "");
const envFile = opt("--env", ".env");
if (!SLUG) {
  console.error("Usage: node scripts/readiness/owner-account-state.mjs --tenant <slug> [--env .env.test]");
  process.exit(1);
}
dotenv.config({ path: envFile, override: true });

const url = process.env.DATABASE_URL ?? "";
const host = url.replace(/^.*@/, "").replace(/[/?].*$/, "") || "(unset)";
console.log(`env file: ${envFile}   db host: ${host}   tenant: ${SLUG}`);
if (!url) {
  console.error("DATABASE_URL unset - aborting.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });

const mask = (email) => {
  if (!email) return "(none)";
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 2)}***@${domain ?? "?"}`;
};
const iso = (d) => (d ? new Date(d).toISOString() : "-");
const codeCount = (json) => (Array.isArray(json) ? json.length : 0);

let failed = false;
const verdict = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

try {
  const state = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenant = await tx.tenant.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, slug: true } });
    if (!tenant) return { tenant: null, users: [] };
    const rows = await tx.user.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, email: true, role: true, totpEnabled: true, totpSecret: true, totpRecoveryCodes: true,
        mustChangePassword: true, sessionVersion: true, failedLoginCount: true, lockedUntil: true,
        createdAt: true, updatedAt: true,
      },
    });
    const now = new Date();
    const ids = rows.map((u) => u.id);
    const emails = rows.map((u) => u.email);
    // One grouped query per table, not one per user: a seeded test tenant has
    // hundreds of staff rows and per-user round trips outlive the transaction.
    // Sequential on purpose - one connection, and the transaction is READ ONLY.
    const logins = await tx.loginEvent.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _count: { _all: true }, _max: { lastSeenAt: true } });
    const resetAll = await tx.passwordResetToken.groupBy({ by: ["email"], where: { tenantId: tenant.id, email: { in: emails } }, _count: { _all: true } });
    const resetLive = await tx.passwordResetToken.groupBy({ by: ["email"], where: { tenantId: tenant.id, email: { in: emails }, used: false, expiresAt: { gt: now } }, _count: { _all: true } });
    const history = await tx.passwordHistory.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _count: { _all: true } });
    const push = await tx.pushSubscription.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _count: { _all: true } });
    // Credential audit rows about these users (password / authenticator / recovery), to tell the owner's own
    // activation from changes made by an operator acting as them (metadata.actingAs). Only action + metadata
    // are read, and only actingAs is ever printed (as a count).
    const credentialAudit = await tx.auditLog.findMany({
      where: {
        tenantId: tenant.id,
        AND: [
          { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] },
          { OR: ["password", "totp", "recovery"].map((w) => ({ action: { contains: w, mode: "insensitive" } })) },
        ],
      },
      select: { userId: true, entityId: true, action: true, metadata: true, createdAt: true },
    });
    // Review of lane I, D-I2: the club's admin.tenant.create row (tenant-level: userId null, entityId = tenant
    // id). create-tenant gives the owner a password the operator chose, so it counts as an operator-issued
    // credential preceding all evidence (activation-verdict.mjs operatorCreateRowsFor).
    const tenantCreateAudit = await tx.auditLog.findMany({
      where: { tenantId: tenant.id, action: { in: OPERATOR_CREATE_ACTIONS } },
      select: { userId: true, entityId: true, action: true, metadata: true, createdAt: true },
    });
    const byKey =(list, key) => new Map(list.map((r) => [r[key], r]));
    const [loginM, resetAllM, resetLiveM, historyM, pushM] = [
      byKey(logins, "userId"), byKey(resetAll, "email"), byKey(resetLive, "email"), byKey(history, "userId"), byKey(push, "userId"),
    ];
    const users = [];
    for (const u of rows) {
      const loginEvents = loginM.get(u.id)?._count._all ?? 0;
      const lastLogin = loginM.get(u.id)?._max ?? null;
      const resetAllN = resetAllM.get(u.email)?._count._all ?? 0;
      const resetLiveN = resetLiveM.get(u.email)?._count._all ?? 0;
      const historyN = historyM.get(u.id)?._count._all ?? 0;
      const pushN = pushM.get(u.id)?._count._all ?? 0;
      const ownRows = credentialAudit.filter((r) => r.userId === u.id || r.entityId === u.id);
      const supportCredentialRows = countSupportCredentialRows(ownRows);
      // Review finding D7: operator resets that precede the activation evidence.
      const createdRows = operatorCreateRowsFor(tenantCreateAudit, u);
      const operatorResetRows = countOperatorResetsBeforeActivation([...createdRows, ...ownRows], lastLogin?.lastSeenAt ?? null);
      const operatorCreatedAccount = createdRows.length > 0;
      // E2E flow 9: the owner's own set_own / auth.totp.enrolled row (no actingAs), used when no LoginEvent exists.
      const ownActivationEvidence = selectOwnActivationEvidence(ownRows, u.id);
      users.push({
        role: u.role,
        email: mask(u.email),
        totpEnabled: u.totpEnabled,
        totpSecretSet: !!u.totpSecret,
        recoveryCodes: codeCount(u.totpRecoveryCodes),
        mustChangePassword: u.mustChangePassword,
        sessionVersion: u.sessionVersion,
        failedLoginCount: u.failedLoginCount,
        lockedUntil: u.lockedUntil,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        loginEvents,
        lastLogin: lastLogin?.lastSeenAt ?? null,
        resetTokens: resetAllN,
        resetTokensLive: resetLiveN,
        passwordHistory: historyN,
        pushSubscriptions: pushN,
        supportCredentialRows,
        operatorResetRows,
        operatorCreatedAccount,
        lastSignInAt: lastLogin?.lastSeenAt ?? null,
        ownActivationEvidence,
      });
    }
    return { tenant, users };
  }, { timeout: 120_000, maxWait: 30_000 });

  if (!state.tenant) {
    verdict(false, `tenant "${SLUG}" exists`);
    process.exit(2);
  }
  console.log(`club: ${state.tenant.name}   users: ${state.users.length}\n`);
  state.users.forEach((u, i) => {
    console.log(`user #${i + 1}`);
    console.log(`  role ${u.role}   email ${u.email}`);
    console.log(`  totpEnabled ${u.totpEnabled}   totpSecret set ${u.totpSecretSet}   recovery codes ${u.recoveryCodes}`);
    console.log(`  mustChangePassword ${u.mustChangePassword}   sessionVersion ${u.sessionVersion}`);
    console.log(`  failedLoginCount ${u.failedLoginCount}   lockedUntil ${iso(u.lockedUntil)}`);
    console.log(`  createdAt ${iso(u.createdAt)}   updatedAt ${iso(u.updatedAt)}`);
    console.log(`  LoginEvent rows ${u.loginEvents}   last login ${iso(u.lastLogin)}`);
    console.log(`  PasswordResetToken ${u.resetTokens} (unused + unexpired ${u.resetTokensLive})   PasswordHistory ${u.passwordHistory}   PushSubscription ${u.pushSubscriptions}`);
    console.log("");
  });

  const users = state.users;
  verdict(users.length === 1, "exactly one User on the tenant", `found ${users.length}`);
  const owner = users.find((u) => u.role === "owner");
  verdict(!!owner && users.length >= 1 && users[0].role === "owner" && users.filter((u) => u.role === "owner").length === 1, "that user is the owner");
  if (owner) {
    const ready = owner.totpEnabled === false && !owner.totpSecretSet && owner.recoveryCodes === 0 && owner.mustChangePassword === true;
    // Activation needs evidence, not just flags (6 Oct 2026, audit Q4): at least one real owner sign-in
    // (LoginEvent) and no password/authenticator change made by someone acting as the owner.
    const activation = ownerActivationVerdict(owner);
    console.log(`  credential changes made under support access (actingAs): ${owner.supportCredentialRows}`);
    if (activation.activated) {
      verdict(true, "owner state", `${activation.state} - ${activation.detail}`);
    } else if (activation.state !== "NOT ACTIVATED") {
      // Flags look activated but the evidence does not support it: never print ALREADY ACTIVATED here.
      verdict(false, "owner state", `${activation.state} - ${activation.detail}`);
    } else {
      const why = [];
      if (owner.totpEnabled) why.push("totpEnabled is true");
      if (owner.totpSecretSet) why.push("a TOTP secret is still stored (run totp-reset)");
      if (owner.recoveryCodes > 0) why.push(`${owner.recoveryCodes} old recovery code(s) remain (run totp-reset)`);
      if (!owner.mustChangePassword) why.push("mustChangePassword is false (run force-password-reset)");
      verdict(ready, "owner state = READY FOR HANDOVER (no TOTP, no secret, no recovery codes, must change password)", why.join("; "));
    }
    verdict(owner.resetTokensLive === 0, "no live password-reset link for the owner address", `${owner.resetTokensLive} unused + unexpired`);
    verdict(!(owner.lockedUntil && new Date(owner.lockedUntil) > new Date()), "owner account not locked", `lockedUntil ${iso(owner.lockedUntil)}`);
    if (owner.pushSubscriptions > 0) {
      console.log(`NOTE  ${owner.pushSubscriptions} push subscription(s) on the owner row predate handover - they belong to whichever browser registered them`);
    }
  }
  console.log(`\nVERDICT: ${failed ? "FAIL" : "PASS"}`);
  process.exitCode = failed ? 2 : 0;
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error("read failed:", err.name, err.code ?? "", err.message || String(err.cause ?? ""));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
