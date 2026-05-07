import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const app = await prisma.gymApplication.findFirst({
  where: { email: "assess-2026-05-07-owner@example.com" },
  orderBy: { createdAt: "desc" },
});
console.log("APPLICATION:");
console.log(JSON.stringify(app, null, 2));

const tokens = await prisma.magicLinkToken.findMany({
  where: { email: "assess-2026-05-07-owner@example.com" },
  orderBy: { createdAt: "desc" },
  take: 3,
});
console.log("\nTOKENS:");
console.log(JSON.stringify(tokens, null, 2));

await prisma.$disconnect();
