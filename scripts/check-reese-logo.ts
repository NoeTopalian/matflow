/**
 * Diagnostic: find Reese (member) and inspect their tenant's logoUrl.
 * Helps explain why the deployed member portal shows no logo.
 *
 * Run: npx tsx scripts/check-reese-logo.ts
 */

import { prisma } from "@/lib/prisma";

async function main() {
  const reese = await prisma.member.findFirst({
    where: {
      OR: [
        { name: { contains: "Reese", mode: "insensitive" } },
        { email: { contains: "reese", mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      tenantId: true,
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          primaryColor: true,
          bgColor: true,
        },
      },
    },
  });

  if (!reese) {
    console.log("No member with name/email matching 'Reese' found.");
    return;
  }

  console.log("Reese member:", { id: reese.id, name: reese.name, email: reese.email, tenantId: reese.tenantId });
  console.log("Tenant:", reese.tenant);
  console.log("logoUrl is", reese.tenant?.logoUrl ? `set (${reese.tenant.logoUrl.slice(0, 80)}…, length ${reese.tenant.logoUrl.length})` : "NULL");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
