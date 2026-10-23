// Synthetic club on the Neon TEST branch: one owner (password + authenticator enrolled, so sign-in lands normally)
// and two members, all on example.test. Never touches an existing club.
//   node fixture.mjs create [--onboarding]   (--onboarding: club still in first setup)
//   node fixture.mjs teardown                deletes it and confirms 0 rows left
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { APP, DB_URL, state, saveState, bcrypt, newSecret, sha256 } from "./lib.mjs";

const require = createRequire(`${APP}/package.json`);
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const bypass = (fn) => prisma.$transaction(async (tx) => { await tx.$executeRaw`select set_config('app.bypass_rls','on',true)`; return fn(tx); }, { timeout: 60000, maxWait: 20000 });

const [cmd, flag] = process.argv.slice(2);
try {
  if (cmd === "create") {
    if (state.club) { console.log(JSON.stringify({ exists: state.club.slug })); process.exit(0); }
    const S = `mfv-${Date.now().toString(36)}`;
    // Random per run; kept only in the output folder's fixture-state.json, never in git.
    const ownerPass = randomBytes(18).toString("base64url");
    const secret = newSecret();
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
    saveState();
    console.log(JSON.stringify({ created: state.club.slug, onboarding: flag === "--onboarding" }));
  } else if (cmd === "teardown") {
    const c = state.club;
    if (!c) { console.log(JSON.stringify({ nothingToTearDown: true })); process.exit(0); }
    if (!c.slug.startsWith("mfv-")) throw new Error("refusing: not a fixture slug");
    const tenantId = c.tenantId;
    await bypass(async (tx) => {
      for (const m of ["auditLog", "emailLog", "magicLinkToken", "passwordResetToken", "attendanceRecord", "memberStatusEvent", "memberPhoto", "importJob", "payment", "classMembershipTier"]) { try { await tx[m].deleteMany({ where: { tenantId } }); } catch {} }
      await tx.$executeRawUnsafe(`delete from "LoginEvent" where "tenantId" = $1`, tenantId).catch(() => {});
      await tx.$executeRawUnsafe(`delete from "PasswordHistory" where "userId" in (select id from "User" where "tenantId" = $1)`, tenantId).catch(() => {});
      const rankIds = (await tx.memberRank.findMany({ where: { member: { tenantId } }, select: { id: true } })).map((r) => r.id);
      await tx.rankHistory.deleteMany({ where: { memberRankId: { in: rankIds } } }).catch(() => {});
      await tx.memberRank.deleteMany({ where: { id: { in: rankIds } } }).catch(() => {});
      await tx.rankSystem.deleteMany({ where: { tenantId } });
      const classIds = (await tx.class.findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id);
      await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classInstance.deleteMany({ where: { classId: { in: classIds } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    const left = await bypass(async (tx) => ({ tenant: await tx.tenant.count({ where: { id: tenantId } }), users: await tx.user.count({ where: { tenantId } }), members: await tx.member.count({ where: { tenantId } }) }));
    delete state.club; saveState();
    console.log(JSON.stringify({ tornDown: c.slug, left }));
  } else {
    console.log("usage: node fixture.mjs create [--onboarding] | teardown");
    process.exit(2);
  }
} finally { await prisma.$disconnect(); }
