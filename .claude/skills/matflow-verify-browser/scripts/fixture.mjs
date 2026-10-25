// Synthetic club on the Neon TEST branch: one owner (password + authenticator enrolled, so sign-in lands normally)
// and two members, all on example.test. Never touches an existing club.
//   node fixture.mjs create [--onboarding]   (--onboarding: club still in first setup)
//   node fixture.mjs teardown                deletes this run's fixtures and confirms 0 rows left
//   node fixture.mjs status                  this run's fixtures as the ledger and the database see them
//
// Ownership (harness.mjs): the slug embeds the run id (mfv-<runId>-<n>); the ledger (DATA/fixtures-ledger.jsonl)
// records the intent before the insert, the tenant id after it, and the teardown. Teardown deletes a tenant only when
// its id, its slug and this run's ledger entry agree; it refuses (exit 4) when they do not, and never looks at any
// other "mfv-" club. Teardown is one transaction and idempotent: an interrupted one is simply run again.
//
// MF_HARNESS_FAULT (harness self-test only): "teardown-crash" exits inside the delete transaction (it rolls back);
// "teardown-crash-after-delete" exits after the commit, before the ledger and state are updated.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { APP, DB_URL, RUN, state, saveState, bcrypt, newSecret, sha256 } from "./lib.mjs";
import { ledgerAppend, ledgerRead, ledgerSlugs, openFixtures } from "./harness.mjs";

const require = createRequire(`${APP}/package.json`);
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const bypass = (fn) => prisma.$transaction(async (tx) => { await tx.$executeRaw`select set_config('app.bypass_rls','on',true)`; return fn(tx); }, { timeout: 60000, maxWait: 20000 });
// Tenant has FORCE row-level security: an ownership check read without the bypass sees nothing under a role
// without BYPASSRLS, and every refusal below would silently pass (review 25 Oct, L8).
const tenantRead = (args) => bypass((tx) => tx.tenant.findUnique(args));
const FAULT = process.env.MF_HARNESS_FAULT ?? "";
const runId = RUN.runId;
const prefix = `mfv-${runId}-`;

/** Delete one fixture tenant's rows (child tables first). Models the schema under test lacks are skipped. */
async function deleteTenant(tx, tenantId) {
  const del = async (model, where) => { if (tx[model]) await tx[model].deleteMany({ where }); };
  for (const m of ["auditLog", "emailLog", "magicLinkToken", "passwordResetToken", "attendanceRecord", "memberStatusEvent", "memberPhoto", "importJob", "payment", "classMembershipTier"]) {
    await del(m, { tenantId });
    if (FAULT === "teardown-crash" && m === "attendanceRecord") { console.log("[fault] teardown-crash: exiting inside the delete transaction"); process.exit(9); }
  }
  await tx.$executeRawUnsafe(`delete from "LoginEvent" where "tenantId" = $1`, tenantId);
  await tx.$executeRawUnsafe(`delete from "PasswordHistory" where "userId" in (select id from "User" where "tenantId" = $1)`, tenantId);
  const rankIds = (await tx.memberRank.findMany({ where: { member: { tenantId } }, select: { id: true } })).map((r) => r.id);
  await tx.rankHistory.deleteMany({ where: { memberRankId: { in: rankIds } } });
  await tx.memberRank.deleteMany({ where: { id: { in: rankIds } } });
  await tx.rankSystem.deleteMany({ where: { tenantId } });
  const classIds = (await tx.class.findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id);
  // Bookings and squad lists reference the class without a cascade; the membership list cascades.
  await del("classSubscription", { classId: { in: classIds } });
  await del("classRoster", { classId: { in: classIds } });
  await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
  await tx.classInstance.deleteMany({ where: { classId: { in: classIds } } });
  await tx.class.deleteMany({ where: { tenantId } });
  await tx.membershipTier.deleteMany({ where: { tenantId } });
  await tx.member.deleteMany({ where: { tenantId } });
  await tx.user.deleteMany({ where: { tenantId } });
  await tx.tenant.deleteMany({ where: { id: tenantId } });
}

/** Rows a fixture tenant still has in the tables a fixture writes to. */
async function rowsLeft(tenantId) {
  return bypass(async (tx) => ({
    tenant: await tx.tenant.count({ where: { id: tenantId } }),
    users: await tx.user.count({ where: { tenantId } }),
    members: await tx.member.count({ where: { tenantId } }),
    classes: await tx.class.count({ where: { tenantId } }),
    attendance: await tx.attendanceRecord.count({ where: { tenantId } }),
  }));
}

/**
 * The fixtures this run may tear down, each with its ownership checked: the slug carries this run's id, this run's
 * ledger has it, and the database tenant (if it still exists) has exactly that id and slug.
 */
async function ownedTargets() {
  const open = openFixtures(runId);
  if (state.club && !open.some((f) => f.slug === state.club.slug)) {
    // A state file naming a fixture the ledger does not hold open: stale (restored from a copy, or left by a crash
    // after the ledger line) if nothing with that id or slug exists; otherwise someone else's — refuse.
    const byId = state.club.tenantId ? await tenantRead({ where: { id: state.club.tenantId }, select: { id: true } }) : null;
    const bySlug = await tenantRead({ where: { slug: state.club.slug }, select: { id: true } });
    if (byId || bySlug) return { refused: `state names ${state.club.slug}, which this run's ledger does not hold open, and its tenant id or slug exists in the database — ownership uncertain` };
    if (open.length) return { refused: `state names ${state.club.slug} but this run's ledger holds ${open.map((f) => f.slug).join(", ")} open — state and ledger disagree` };
    return { targets: [], staleState: state.club.slug };
  }
  const targets = [];
  for (const f of open) {
    if (!f.slug.startsWith(prefix)) return { refused: `ledger entry ${f.slug} does not carry run id ${runId}` };
    const bySlug = await tenantRead({ where: { slug: f.slug }, select: { id: true, slug: true } });
    const byId = f.tenantId ? await tenantRead({ where: { id: f.tenantId }, select: { id: true, slug: true } }) : null;
    if (byId && byId.slug !== f.slug) return { refused: `tenant ${f.tenantId} now has slug ${byId.slug}, not ${f.slug} — ownership uncertain` };
    if (f.tenantId && bySlug && bySlug.id !== f.tenantId) return { refused: `slug ${f.slug} now belongs to tenant ${bySlug.id}, not ${f.tenantId} — ownership uncertain` };
    if (state.club && state.club.slug === f.slug && f.tenantId && state.club.tenantId !== f.tenantId) return { refused: `state and ledger disagree on the tenant of ${f.slug}` };
    targets.push({ slug: f.slug, tenantId: f.tenantId ?? bySlug?.id ?? null });
  }
  return { targets };
}

const [cmd, flag] = process.argv.slice(2);
try {
  if (cmd === "create") {
    if (state.club) { console.log(JSON.stringify({ exists: state.club.slug, runId })); process.exit(0); }
    const S = `${prefix}${ledgerSlugs(runId).length + 1}`;
    // Random per run; kept only in DATA/runs/<runId>/fixture-state.json, never in git.
    const ownerPass = randomBytes(18).toString("base64url");
    const secret = newSecret();
    ledgerAppend({ event: "intent", runId, slug: S });
    await bypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${S} Synthetic Club`, slug: S, onboardingCompleted: flag !== "--onboarding", subscriptionStatus: "trial" } });
      const u = await tx.user.create({ data: {
        tenantId: t.id, email: `${S}-owner@example.test`, name: "Sam Synthetic", role: "owner",
        passwordHash: await bcrypt.hash(ownerPass, 10), totpEnabled: true, totpSecret: secret,
        totpRecoveryCodes: Array.from({ length: 8 }, (_, i) => sha256(`${S}-rc-${i}`)),
      } });
      for (let i = 1; i <= 2; i++) await tx.member.create({ data: { tenantId: t.id, name: `Member ${i}`, email: `${S}-m${i}@example.test` } });
      state.club = { tenantId: t.id, slug: S, name: t.name, owner: { id: u.id, email: u.email, password: ownerPass, secret } };
    });
    ledgerAppend({ event: "created", runId, slug: S, tenantId: state.club.tenantId });
    saveState();
    console.log(JSON.stringify({ created: state.club.slug, runId, onboarding: flag === "--onboarding" }));
  } else if (cmd === "teardown") {
    const owned = await ownedTargets();
    if (owned.refused) {
      ledgerAppend({ event: "refused", runId, reason: owned.refused });
      console.log(JSON.stringify({ refused: owned.refused, runId }));
      process.exit(4);
    }
    if (owned.targets.length === 0) {
      if (state.club) { delete state.club; saveState(); }
      if (owned.staleState) ledgerAppend({ event: "stale-state-cleared", runId, slug: owned.staleState });
      console.log(JSON.stringify({ nothingToTearDown: true, ...(owned.staleState ? { clearedStaleState: owned.staleState } : {}), runId }));
      process.exit(0);
    }
    const results = [];
    for (const t of owned.targets) {
      ledgerAppend({ event: "teardown-started", runId, slug: t.slug, tenantId: t.tenantId });
      if (t.tenantId) await bypass((tx) => deleteTenant(tx, t.tenantId));
      if (FAULT === "teardown-crash-after-delete") { console.log("[fault] teardown-crash-after-delete: exiting after the commit"); process.exit(9); }
      const left = t.tenantId ? await rowsLeft(t.tenantId) : { tenant: 0 };
      const clean = Object.values(left).every((n) => n === 0);
      ledgerAppend({ event: clean ? "torn-down" : "teardown-incomplete", runId, slug: t.slug, tenantId: t.tenantId, left });
      results.push({ tornDown: clean ? t.slug : null, incomplete: clean ? null : t.slug, left });
    }
    if (results.every((r) => r.tornDown) && state.club) { delete state.club; saveState(); }
    for (const r of results) console.log(JSON.stringify({ ...r, runId }));
    process.exit(results.every((r) => r.tornDown) ? 0 : 1);
  } else if (cmd === "status") {
    const open = openFixtures(runId);
    const rows = [];
    for (const f of open) rows.push({ slug: f.slug, tenantId: f.tenantId, inDatabase: !!(await tenantRead({ where: { slug: f.slug }, select: { id: true } })) });
    console.log(JSON.stringify({ runId, state: state.club?.slug ?? null, open: rows, ledgerEvents: ledgerRead().filter((e) => e.runId === runId).length }));
  } else {
    console.log("usage: node fixture.mjs create [--onboarding] | teardown | status");
    process.exit(2);
  }
} finally { await prisma.$disconnect(); }
