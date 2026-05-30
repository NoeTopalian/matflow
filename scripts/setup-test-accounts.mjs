// One-shot: reset TotalBJJ to its seed credentials AND create a fresh
// personal test gym for Noe (noetopalian@gmail.com).

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const TOTALBJJ_EMAIL = "owner@totalbjj.com";
const NOE_EMAIL      = "noetopalian@gmail.com";
const PASSWORD       = process.env.SEED_PASSWORD;
if (!PASSWORD) {
  console.error("SEED_PASSWORD env var required (audit C-1).");
  process.exit(1);
}
const NOE_TENANT_SLUG = "noetest";
const NOE_TENANT_NAME = "Noe Test Gym";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const hash = bcrypt.hashSync(PASSWORD, 12);

console.log("=== Resetting TotalBJJ owner ===");
const totalbjj = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.tenant.findFirst({ where: { slug: "totalbjj" }, select: { id: true } });
});
if (totalbjj) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.user.updateMany({
      where: { tenantId: totalbjj.id, role: "owner" },
      data: { email: TOTALBJJ_EMAIL, passwordHash: hash, failedLoginCount: 0, lockedUntil: null },
    });
  });
  console.log(`  TotalBJJ owner restored to ${TOTALBJJ_EMAIL} / ${PASSWORD}`);
}

console.log("\n=== Setting up Noe Test Gym ===");
const existing = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.tenant.findFirst({ where: { slug: NOE_TENANT_SLUG }, select: { id: true } });
});

let noeTenantId;
if (existing) {
  noeTenantId = existing.id;
  console.log(`  Tenant '${NOE_TENANT_SLUG}' already exists (id=${existing.id}) — updating owner.`);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.user.updateMany({
      where: { tenantId: existing.id, role: "owner" },
      data: { email: NOE_EMAIL, passwordHash: hash, failedLoginCount: 0, lockedUntil: null },
    });
  });
} else {
  console.log(`  Creating new tenant '${NOE_TENANT_SLUG}'…`);
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenant = await tx.tenant.create({
      data: {
        name: NOE_TENANT_NAME,
        slug: NOE_TENANT_SLUG,
        subscriptionStatus: "active",
        subscriptionTier: "pro",
        onboardingCompleted: true,
        primaryColor: "#10b981",
        secondaryColor: "#059669",
        textColor: "#ffffff",
        bgColor: "#0a0b0e",
        currency: "GBP",
        timezone: "Europe/London",
        country: "UK",
      },
      select: { id: true },
    });
    await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: NOE_EMAIL,
        name: "Noe Topalian",
        role: "owner",
        passwordHash: hash,
        sessionVersion: 0,
      },
    });
    return tenant;
  });
  noeTenantId = created.id;
  console.log(`  Created tenant id=${created.id}`);
}

console.log("\n=== Login credentials ===\n");
console.log("TotalBJJ (seed test gym):");
console.log(`  Club code: TOTALBJJ`);
console.log(`  Email:     ${TOTALBJJ_EMAIL}`);
console.log(`  Password:  ${PASSWORD}\n`);
console.log("Noe Test Gym (your personal playground):");
console.log(`  Club code: ${NOE_TENANT_SLUG.toUpperCase()}`);
console.log(`  Email:     ${NOE_EMAIL}`);
console.log(`  Password:  ${PASSWORD}\n`);
console.log("Both accounts will require TOTP enrolment on production (matflow.studio).");
console.log("On preview / dev with TESTING_MODE=true, TOTP is bypassed.");

await prisma.$disconnect();
