// Reproduce the auth.ts password verification offline.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const tenant = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.tenant.findFirst({ where: { slug: "totalbjj" }, select: { id: true } });
});
console.log("tenant:", tenant);

const user = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.user.findFirst({
    where: { tenantId: tenant.id, email: "noetopalian@gmail.com" },
    select: { id: true, email: true, role: true, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });
});
console.log("user:", { ...user, passwordHash: user?.passwordHash?.slice(0, 20) + "..." });

// Audit C-1: candidate passwords used to come from a hardcoded "password123"
// literal that targeted production hashes. Now sourced from env vars so the
// repo never carries a known credential, even as a verification value.
const TEST_PASSWORD = process.env.TEST_PASSWORD;
if (!TEST_PASSWORD) {
  console.error("TEST_PASSWORD env var required (audit C-1).");
  process.exit(1);
}
if (user) {
  console.log(`\nbcrypt.compare('${TEST_PASSWORD}', hash):`, await bcrypt.compare(TEST_PASSWORD, user.passwordHash));
}

// Also check rate-limit
const rl = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.rateLimitHit.findMany({
    where: { bucket: { contains: "login" } },
    orderBy: { hitAt: "desc" },
    take: 10,
    select: { bucket: true, hitAt: true },
  });
}).catch((e) => `error: ${e?.message}`);
console.log("\nrecent login rate-limit hits:", rl);

await prisma.$disconnect();
