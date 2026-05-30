// Read-only verify: are both gym accounts present and do the passwords match?
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function check(slug, email) {
  const tenant = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.tenant.findFirst({
      where: { slug },
      select: { id: true, name: true, slug: true, subscriptionStatus: true, deletedAt: true },
    });
  });
  if (!tenant) return { slug, exists: false };

  const user = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.user.findFirst({
      where: { tenantId: tenant.id, email, role: "owner" },
      select: {
        id: true, email: true, role: true, name: true,
        passwordHash: true, failedLoginCount: true, lockedUntil: true,
        totpEnabled: true,
      },
    });
  });

  return {
    tenant,
    user: user
      ? {
          email: user.email,
          name: user.name,
          role: user.role,
          totpEnabled: user.totpEnabled,
          locked: user.lockedUntil && user.lockedUntil > new Date(),
          failedLogins: user.failedLoginCount,
          passwordMatchesTestPassword: await bcrypt.compare(TEST_PASSWORD, user.passwordHash),
        }
      : null,
  };
}

console.log("=== TotalBJJ ===");
console.log(JSON.stringify(await check("totalbjj", "owner@totalbjj.com"), null, 2));

console.log("\n=== Noe Test Gym ===");
console.log(JSON.stringify(await check("noetest", "noetopalian@gmail.com"), null, 2));

await prisma.$disconnect();
