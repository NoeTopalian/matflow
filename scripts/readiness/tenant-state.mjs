// Read-only state of one club, for the handover evidence record. Aggregates
// and security flags only: no member names, emails, phones or dates of birth
// are selected, and the owner's email is masked. Nothing is written.
//
//   node scripts/readiness/tenant-state.mjs --tenant totalbjj               # DATABASE_URL from .env (production — operator runs this by hand)
//   node scripts/readiness/tenant-state.mjs --tenant totalbjj --env .env.test
//
// Why it exists: the import, the tier set-up and the owner's activation all
// change what is true about the club, and the evidence record needs the state
// as it IS, read independently of the screens that wrote it.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
import { ownerActivationVerdict, countSupportCredentialRows, countOperatorResetsBeforeActivation, selectOwnActivationEvidence, OPERATOR_CREATE_ACTIONS, operatorCreateRowsFor } from "./activation-verdict.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SLUG = opt("--tenant", "totalbjj");
const envFile = opt("--env", ".env");
dotenv.config({ path: envFile });

const url = process.env.DATABASE_URL ?? "";
const host = url.replace(/^.*@/, "").replace(/\/.*$/, "") || "(unset)";
console.log(`env file: ${envFile}   db host: ${host}`);
if (!url) { console.error("DATABASE_URL unset — aborting."); process.exit(1); }

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });

const mask = (email) => {
  if (!email) return "(none)";
  const [l, d] = email.split("@");
  return `${l.slice(0, 2)}…@${d}`;
};
const count = (p) => p.catch((e) => `n/a (${String(e.message ?? e).slice(0, 60)})`);

try {
  const out = await prisma.$transaction(async (tx) => {
    // Enforced, not just intended: nothing in this transaction can write.
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const [roleRow] = await tx.$queryRaw`SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`;
    const tenant = await tx.tenant.findUnique({ where: { slug: SLUG } });
    if (!tenant) return { roleRow, tenant: null };
    const id = tenant.id;
    const users = await tx.user.findMany({
      where: { tenantId: id },
      select: { id: true, email: true, name: true, role: true, totpEnabled: true, totpSecret: true, totpRecoveryCodes: true, mustChangePassword: true, sessionVersion: true, failedLoginCount: true, lockedUntil: true, createdAt: true, updatedAt: true },
    });
    const userIds = users.map((u) => u.id);
    // Credential audit rows about these users, to tell the owner's own activation from changes made by an
    // operator acting as them (metadata.actingAs). Only the count is printed.
    const credentialAudit = await tx.auditLog.findMany({
      where: {
        tenantId: id,
        AND: [
          { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] },
          { OR: ["password", "totp", "recovery"].map((w) => ({ action: { contains: w, mode: "insensitive" } })) },
        ],
      },
      select: { userId: true, entityId: true, action: true, metadata: true, createdAt: true },
    });
    // Review of lane I, D-I2: the club's admin.tenant.create row - create-tenant gives the owner a password the
    // operator chose, an operator-issued credential preceding all evidence (activation-verdict.mjs).
    const tenantCreateAudit = await tx.auditLog.findMany({
      where: { tenantId: id, action: { in: OPERATOR_CREATE_ACTIONS } },
      select: { userId: true, entityId: true, action: true, metadata: true, createdAt: true },
    });
    const userLoginEvents =await tx.loginEvent.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _count: { _all: true }, _max: { lastSeenAt: true } });
    const [members, byStatus, byAccountType, byBilledBy, tiers, classes, locations, importJobs, resetTokens, loginEvents, lastLogin, audit, waivers, payments, attendance, pushSubs, history, importedMemberships, guardianSuggested, guardianConfirmed, attendanceNonImport, attendanceImportNoJob] = await Promise.all([
      tx.member.count({ where: { tenantId: id } }),
      count(tx.member.groupBy({ by: ["status"], where: { tenantId: id }, _count: true })),
      count(tx.member.groupBy({ by: ["accountType"], where: { tenantId: id }, _count: true })),
      count(tx.member.groupBy({ by: ["billedBy"], where: { tenantId: id }, _count: true })),
      tx.membershipTier.findMany({ where: { tenantId: id }, orderBy: { name: "asc" }, select: { name: true, pricePence: true, billingCycle: true, isActive: true, isKids: true } }),
      tx.class.count({ where: { tenantId: id } }),
      count(tx.location.findMany({ where: { tenantId: id }, select: { name: true, isDefault: true } })),
      tx.importJob.findMany({ where: { tenantId: id }, orderBy: { createdAt: "asc" }, select: { id: true, source: true, mode: true, status: true, totalRows: true, importedRows: true, skippedRows: true, errorRows: true, fileHash: true, sourceExportedAt: true, mappingVersion: true, rolledBackAt: true, createdAt: true, completedAt: true } }),
      count(tx.passwordResetToken.count({ where: { tenantId: id, used: false, expiresAt: { gt: new Date() } } })),
      count(tx.loginEvent.count({ where: { userId: { in: userIds } } })),
      count(tx.loginEvent.findFirst({ where: { userId: { in: userIds } }, orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } })),
      count(tx.auditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: "desc" }, take: 30, select: { action: true, createdAt: true } })),
      count(tx.signedWaiver.count({ where: { tenantId: id } })),
      tx.payment.count({ where: { tenantId: id } }),
      tx.attendanceRecord.count({ where: { tenantId: id } }),
      count(tx.pushSubscription.count({ where: { userId: { in: userIds } } })),
      count(tx.passwordHistory.count({ where: { userId: { in: userIds } } })),
      count(tx.importedMembership.count({ where: { tenantId: id } })),
      count(tx.member.count({ where: { tenantId: id, parentMemberId: { not: null }, guardianConfirmedAt: null } })),
      count(tx.member.count({ where: { tenantId: id, parentMemberId: { not: null }, guardianConfirmedAt: { not: null } } })),
      // Imported history (checkInMethod "import", written by the attendance
      // importer) is the previous system's record, not activity in MatFlow.
      // Anything else is a check-in made here — before handover there must be none.
      tx.attendanceRecord.count({ where: { tenantId: id, checkInMethod: { not: "import" } } }),
      tx.attendanceRecord.count({ where: { tenantId: id, checkInMethod: "import", importJobId: null } }),
    ]);
    return {
      roleRow,
      tenant: {
        id, name: tenant.name, slug: tenant.slug, timezone: tenant.timezone, logo: tenant.logoUrl ? "set" : "none",
        onboardingCompleted: tenant.onboardingCompleted, subscriptionStatus: tenant.subscriptionStatus,
        stripeConnected: tenant.stripeConnected, stripeAccountId: tenant.stripeAccountId ? "set" : null,
        displayToken: tenant.displayTokenHash ? `set (issued ${tenant.displayTokenIssuedAt?.toISOString() ?? "?"})` : "none",
        kioskToken: tenant.kioskTokenHash ? `set (issued ${tenant.kioskTokenIssuedAt?.toISOString() ?? "?"})` : "none",
        reviewLockedAt: tenant.reviewLockedAt, deletedAt: tenant.deletedAt, featureFlags: tenant.featureFlags ? Object.keys(tenant.featureFlags) : null,
      },
      users: users.map((u) => ({
        id: u.id, email: mask(u.email), name: u.name, role: u.role,
        totpEnabled: u.totpEnabled, totpSecretSet: !!u.totpSecret,
        recoveryCodes: Array.isArray(u.totpRecoveryCodes) ? u.totpRecoveryCodes.length : u.totpRecoveryCodes == null ? 0 : "non-array",
        mustChangePassword: u.mustChangePassword, sessionVersion: u.sessionVersion,
        failedLoginCount: u.failedLoginCount, lockedUntil: u.lockedUntil, createdAt: u.createdAt, updatedAt: u.updatedAt,
        loginEvents: userLoginEvents.find((r) => r.userId === u.id)?._count._all ?? 0,
        supportCredentialRows: countSupportCredentialRows(credentialAudit.filter((r) => r.userId === u.id || r.entityId === u.id)),
        // Review finding D7: operator resets that precede the activation evidence.
        // D-I2: plus the club's admin.tenant.create row when it applies to this owner.
        operatorResetRows: countOperatorResetsBeforeActivation(
          [...operatorCreateRowsFor(tenantCreateAudit, u), ...credentialAudit.filter((r) => r.userId === u.id || r.entityId === u.id)],
          userLoginEvents.find((r) => r.userId === u.id)?._max?.lastSeenAt ?? null,
        ),
        operatorCreatedAccount: operatorCreateRowsFor(tenantCreateAudit, u).length > 0,
        lastSignInAt: userLoginEvents.find((r) => r.userId === u.id)?._max?.lastSeenAt ?? null,
        // E2E flow 9: the owner's own set_own / auth.totp.enrolled row (no actingAs), used when no LoginEvent exists.
        ownActivationEvidence: selectOwnActivationEvidence(
          credentialAudit.filter((r) => r.userId === u.id || r.entityId === u.id),
          u.id,
        ),
      })),
      counts: { members, byStatus, byAccountType, byBilledBy, classes, payments, attendance, attendanceImported: attendance - attendanceNonImport, attendanceNonImport, attendanceImportNoJob, waivers, importedMemberships, guardianSuggested, guardianConfirmed, locations, liveResetTokens: resetTokens, loginEvents, lastLogin, pushSubs, passwordHistory: history },
      tiers,
      importJobs: importJobs.map((j) => ({ ...j, fileHash: j.fileHash ? j.fileHash.slice(0, 12) + "…" : null })),
      auditRecent: audit,
    };
  }, { maxWait: 30_000, timeout: 120_000 });
  console.log(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
  if (out.tenant) {
    const u = out.users;
    const owner = u.find((x) => x.role === "owner");
    const checks = [
      ["exactly one user on the club", u.length === 1],
      ["that user is the owner", !!owner && u.length === 1],
      ["owner has no second factor and no recovery codes (fresh enrolment ahead)", !!owner && owner.totpEnabled === false && owner.totpSecretSet === false && owner.recoveryCodes === 0],
      ["owner must change password at next sign-in", !!owner && owner.mustChangePassword === true],
      ["no demo-era display token", out.tenant.displayToken === "none"],
      ["no demo-era kiosk token", out.tenant.kioskToken === "none"],
      ["zero payments / non-import attendance / signed waivers (nothing fabricated; imported history allowed)", out.counts.payments === 0 && out.counts.attendanceNonImport === 0 && out.counts.waivers === 0],
      ["every imported attendance row carries its import job", out.counts.attendanceImportNoJob === 0],
    ];
    console.log("\nHandover invariants:");
    for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (owner && owner.totpEnabled) console.log("  NOTE  the owner has an authenticator enrolled — either Sean has activated, or a setup factor is still on the account and must be reset before handover.");
    // Activation verdict (6 Oct 2026, audit Q4): never "ALREADY ACTIVATED" from row flags alone. It needs a
    // real owner LoginEvent and no password/authenticator change made under support access (actingAs).
    if (owner) {
      const activation = ownerActivationVerdict(owner);
      console.log(`  OWNER ACTIVATION: ${activation.state} - ${activation.detail}`);
    }
  }
} finally {
  await prisma.$disconnect();
}
