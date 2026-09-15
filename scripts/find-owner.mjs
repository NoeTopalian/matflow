import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const tenant = await prisma.tenant.findUnique({ where: { slug: "totalbjj" }, select: { id: true, name: true } });
if (!tenant) { console.log("tenant not found"); process.exit(1); }
const owner = await prisma.user.findFirst({
  where: { tenantId: tenant.id, role: "owner" },
  select: { email: true, failedLoginAttempts: true, lockedUntil: true }
});
console.log("tenant:", tenant.name);
console.log("owner email:", owner?.email);
console.log("failed attempts:", owner?.failedLoginAttempts);
console.log("locked until:", owner?.lockedUntil);
await prisma.$disconnect();
