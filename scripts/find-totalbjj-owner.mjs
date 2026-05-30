// Look up the actual owner email for the TotalBJJ tenant.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const tenant = await prisma.tenant.findFirst({ where: { slug: "totalbjj" }, select: { id: true, name: true } });
if (!tenant) {
  console.log("No tenant with slug 'totalbjj' exists in this DB.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Tenant: ${tenant.name} (id=${tenant.id})\n`);
const users = await prisma.user.findMany({
  where: { tenantId: tenant.id },
  select: { email: true, name: true, role: true, totpEnabled: true, lockedUntil: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});
console.log(`Users (${users.length}):`);
for (const u of users) {
  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date() ? " 🔒 LOCKED" : "";
  console.log(`  - ${u.email} (${u.name}) — role: ${u.role}, totp: ${u.totpEnabled ? "yes" : "no"}${locked}`);
}

await prisma.$disconnect();
