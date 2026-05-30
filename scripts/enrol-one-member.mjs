// One-off: mark a single member as TOTP-enrolled on the TEST BRANCH so the
// staff "Reset 2FA" control renders on their detail page for a visual smoke.
// HARD SAFETY: test branch only.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("ep-hidden-salad")) {
  console.error("ABORT: not the test branch."); process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const m = await prisma.member.findFirst({ where: { email: "alex@example.com" }, select: { id: true } });
  if (!m) { console.error("alex@example.com not found"); process.exit(1); }
  // NOTE: totpSecret value isn't verified anywhere — just needs to be non-null so
  // the staff Reset-2FA control renders. Using an obvious fixture string to keep
  // GitGuardian/secret scanners happy (no entropy match).
  await prisma.member.update({ where: { id: m.id }, data: { totpEnabled: true, totpSecret: "fake-totp-fixture-not-a-real-secret" } });
  console.log("ENROLLED_MEMBER_ID=" + m.id);
} finally {
  await prisma.$disconnect();
}
