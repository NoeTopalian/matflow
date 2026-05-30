// One-shot: reset TOTP on every owner-role User on the totalbjj tenant.
// Mirrors what POST /api/admin/customers/[id]/totp-reset does, scoped to
// the whole tenant rather than a single customer.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const tenant = await prisma.tenant.findUnique({
  where: { slug: "totalbjj" },
  select: { id: true, name: true },
});
if (!tenant) {
  console.error("Tenant 'totalbjj' not found.");
  process.exit(1);
}

const owners = await prisma.user.findMany({
  where: { tenantId: tenant.id, role: "owner" },
  select: { id: true, email: true, totpEnabled: true, sessionVersion: true },
});

console.log(`Found ${owners.length} owner(s) on '${tenant.name}' (${tenant.id}):`);
for (const o of owners) {
  console.log(`  - ${o.email}  totpEnabled=${o.totpEnabled}  sessionVersion=${o.sessionVersion}`);
}

if (owners.length === 0) {
  console.log("Nothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

const result = await prisma.user.updateMany({
  where: { tenantId: tenant.id, role: "owner" },
  data: {
    totpEnabled: false,
    totpSecret: null,
    totpRecoveryCodes: [],
    sessionVersion: { increment: 1 },
  },
});

console.log(`\nReset TOTP on ${result.count} owner(s). They will be pinned to /login/totp/setup on next sign-in.`);

const after = await prisma.user.findMany({
  where: { tenantId: tenant.id, role: "owner" },
  select: { id: true, email: true, totpEnabled: true, totpSecret: true, sessionVersion: true },
});
console.log("\nPost-reset state:");
for (const o of after) {
  console.log(`  - ${o.email}  totpEnabled=${o.totpEnabled}  totpSecret=${o.totpSecret === null ? "null" : "(set)"}  sessionVersion=${o.sessionVersion}`);
}

await prisma.$disconnect();
