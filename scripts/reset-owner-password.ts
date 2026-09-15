import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

async function main() {
  const hash = await bcrypt.hash("password123", 12);
  const result = await prisma.user.updateMany({
    where: { email: "owner@totalbjj.com" },
    data: { passwordHash: hash },
  });
  console.log(`Updated ${result.count} user(s).`);
}

main().then(() => prisma.$disconnect()).catch(console.error);
