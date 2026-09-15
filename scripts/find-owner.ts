import { prisma } from "@/lib/prisma";

async function main() {
  const users = await prisma.user.findMany({
    where: { role: "owner" },
    select: { email: true, tenantId: true, tenant: { select: { slug: true } } },
  });
  console.log(JSON.stringify(users, null, 2));
}

main().then(() => prisma.$disconnect()).catch(console.error);
