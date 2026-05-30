// One-shot: swap the TotalBJJ owner's email + reset the password.
// Run once to make the seed owner reachable as the user's real email.
//
// After this the user logs in with: noetopalian@gmail.com / <NEW_PASSWORD>
// Magic links + password resets will land in the user's inbox.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const NEW_EMAIL = "noetopalian@gmail.com";
const NEW_PASSWORD = process.env.NEW_OWNER_PASSWORD;
if (!NEW_PASSWORD) {
  console.error("NEW_OWNER_PASSWORD env var required (audit C-1).");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

console.log("=== Swap TotalBJJ owner email + password ===\n");

const tenant = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.tenant.findFirst({ where: { slug: "totalbjj" }, select: { id: true, name: true } });
});

if (!tenant) {
  console.error("No tenant with slug 'totalbjj' — aborting.");
  await prisma.$disconnect();
  process.exit(1);
}

const owner = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.user.findFirst({
    where: { tenantId: tenant.id, role: "owner" },
    select: { id: true, email: true, name: true },
  });
});

if (!owner) {
  console.error(`No owner-role user found for ${tenant.name} — aborting.`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`Found owner: ${owner.name} <${owner.email}> (id=${owner.id})`);
console.log(`New email:   ${NEW_EMAIL}`);
console.log(`New password: ${NEW_PASSWORD}\n`);

const hash = bcrypt.hashSync(NEW_PASSWORD, 12);

await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  await tx.user.update({
    where: { id: owner.id },
    data: {
      email: NEW_EMAIL,
      passwordHash: hash,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
});

console.log("✅ Updated.\n");
console.log("Log in at the preview URL:");
console.log("  Club code: TOTALBJJ");
console.log(`  Email:     ${NEW_EMAIL}`);
console.log(`  Password:  ${NEW_PASSWORD}`);
console.log("\nNo 2FA prompt expected (TESTING_MODE bypass active on preview).");

await prisma.$disconnect();
