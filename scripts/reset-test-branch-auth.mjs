// One-off dev utility: reset auth-related state on the Neon TEST BRANCH so
// repeated e2e runs don't trip the DB-backed rate limiter / account lockout.
//
// Clears:
//   - RateLimitHit rows (login:ip:* and login:<tenant>:<email> buckets)
//   - User/Member lockout (lockedUntil=null, failedLoginCount=0)
//   - User/Member TOTP enrolment (so setup logins are clean and specs can enrol)
//
// HARD SAFETY: refuses to run unless DATABASE_URL points at the known test
// branch endpoint (ep-hidden-salad). Never touches production (ep-bold-wave).
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("ep-hidden-salad")) {
  console.error(`ABORT: DATABASE_URL is not the test branch (got endpoint: ${(url.match(/ep-[a-z0-9-]+/) ?? ["NONE"])[0]}).`);
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const rl = await prisma.rateLimitHit.deleteMany({});
  const u = await prisma.user.updateMany({
    data: { lockedUntil: null, failedLoginCount: 0, totpEnabled: false, totpSecret: null, totpRecoveryCodes: [] },
  });
  const m = await prisma.member.updateMany({
    data: { lockedUntil: null, failedLoginCount: 0, totpEnabled: false, totpSecret: null },
  });
  console.log(`Cleared ${rl.count} rate-limit rows; reset ${u.count} users, ${m.count} members (lockout + TOTP).`);
} finally {
  await prisma.$disconnect();
}
