// Probe: when app.current_tenant_id GUC is NOT set, does RLS deny rows
// or silently allow them? This is the lane-1 critical-unknown question
// from the deep-dive trace.
//
// Pure read-only — runs three SELECTs, doesn't write anything.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

console.log("=== RLS uncontexted-query probe ===\n");

// 1. Find a real tenantId to probe against.
const tenants = await prisma.$queryRaw`SELECT id, name FROM "Tenant" LIMIT 1`;
if (tenants.length === 0) {
  console.log("No tenants found — skipping probe.");
  await prisma.$disconnect();
  process.exit(0);
}
const tenantId = tenants[0].id;
const tenantName = tenants[0].name;
console.log(`Probing against tenant: ${tenantName} (id=${tenantId})\n`);

// 2. Get the TRUE count of Members for this tenant via a bypass.
const trueCountRows = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  return tx.$queryRaw`SELECT count(*)::int AS n FROM "Member" WHERE "tenantId" = ${tenantId}`;
});
const trueCount = trueCountRows[0].n;
console.log(`Step 1 — TRUE count via bypass: ${trueCount}`);

// 3. Now query without setting GUC. If RLS denies, we get 0.
// If RLS allows (because NULL = NULL is "unknown"), we get trueCount.
const uncontextedRows = await prisma.$queryRaw`
  SELECT count(*)::int AS n FROM "Member" WHERE "tenantId" = ${tenantId}
`;
const uncontextedCount = uncontextedRows[0].n;
console.log(`Step 2 — uncontexted count (NULL GUC): ${uncontextedCount}`);

// 4. Set the GUC to a different fake tenant and query — should get 0.
const wrongContextRows = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.current_tenant_id', 'fake-tenant-id', true)`;
  return tx.$queryRaw`SELECT count(*)::int AS n FROM "Member" WHERE "tenantId" = ${tenantId}`;
});
const wrongContextCount = wrongContextRows[0].n;
console.log(`Step 3 — wrong-context count (GUC set to fake tenant): ${wrongContextCount}`);

console.log("\n=== Verdict ===");
if (uncontextedCount === 0) {
  console.log("✅ SAFE: uncontexted queries return 0 rows. Dashboard pages relying on WHERE clause + RLS are *not* leaking, but they're also silently returning 0 rows. Wrapping in withTenantContext is good hygiene.");
} else if (uncontextedCount === trueCount) {
  console.log("⚠️ CRITICAL: uncontexted queries return all rows matching WHERE. RLS does NOT deny when GUC is NULL. Dashboard bare-prisma calls leak across tenants if the WHERE clause is ever wrong/missing. Fix is mandatory.");
} else {
  console.log(`⚠️ UNEXPECTED: uncontexted count (${uncontextedCount}) is neither 0 nor trueCount (${trueCount}). Investigate further.`);
}

if (wrongContextCount === 0) {
  console.log("✅ SAFE: setting GUC to a different tenant correctly blocks rows from this tenant.");
} else {
  console.log(`⚠️ CRITICAL: wrong-context query returned ${wrongContextCount} rows. RLS policy is not enforcing tenantId match.`);
}

await prisma.$disconnect();
