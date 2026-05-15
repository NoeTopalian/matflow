// Pre-migration cleanup helper.
//
// The Member_kids_must_have_parent CHECK constraint (migration
// 202605XX_member_kids_check_constraint) refuses any row where
// accountType='kids' AND parentMemberId IS NULL. This script surfaces any
// such rows that already exist in the target DB so they can be resolved
// before the migration's `VALIDATE CONSTRAINT` step rejects them.
//
// Run it against the same DATABASE_URL the migration will run against.
// Resolution options the script does NOT take — they're a human decision:
//   1. Reassign the kid to a real parent (UPDATE Member SET parentMemberId = ...)
//   2. Promote the kid to junior/adult (UPDATE Member SET accountType = 'junior')
//   3. Delete the row entirely (DELETE FROM Member WHERE id = ...)

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const orphans = await prisma.member.findMany({
  where: { accountType: "kids", parentMemberId: null },
  select: {
    id: true,
    tenantId: true,
    name: true,
    email: true,
    dateOfBirth: true,
    createdAt: true,
    tenant: { select: { name: true, slug: true } },
  },
  orderBy: { createdAt: "asc" },
});

if (orphans.length === 0) {
  console.log("No orphan kids found. Safe to apply the CHECK constraint migration.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Found ${orphans.length} orphan kid Member row(s):\n`);
for (const k of orphans) {
  const dob = k.dateOfBirth ? new Date(k.dateOfBirth).toISOString().slice(0, 10) : "no DOB";
  console.log(
    `  - ${k.id}  tenant=${k.tenant.slug} name="${k.name}" email=${k.email} dob=${dob} created=${k.createdAt.toISOString().slice(0, 10)}`,
  );
}
console.log("\nResolve these before applying the CHECK migration. Options per row:");
console.log("  - Reassign to a real parent (set parentMemberId)");
console.log("  - Promote to junior or adult (set accountType)");
console.log("  - Delete entirely if the row is junk\n");

await prisma.$disconnect();
process.exit(1);
