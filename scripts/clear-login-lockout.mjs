/**
 * One-off: clear "too many sign in attempts" state so a test sign-in can
 * proceed — both layers:
 *   1. Account lockout fields on the member (failedLoginCount / lockedUntil).
 *   2. Auth rate-limit buckets (`login:*` in RateLimitHit — per-email and per-IP).
 *
 * Run: node scripts/clear-login-lockout.mjs [name-or-email fragment, default "reese"]
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const who = process.argv[2] ?? "reese";

async function main() {
  const member = await prisma.member.findFirst({
    where: {
      OR: [
        { name: { contains: who, mode: "insensitive" } },
        { email: { contains: who, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, email: true, failedLoginCount: true, lockedUntil: true },
  });

  if (member) {
    console.log(`Member ${member.name} <${member.email}>: failedLoginCount=${member.failedLoginCount}, lockedUntil=${member.lockedUntil ?? "null"}`);
    await prisma.member.update({
      where: { id: member.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    console.log("  -> lockout cleared.");
  } else {
    console.log(`No member matching '${who}'.`);
  }

  const rl = await prisma.rateLimitHit.deleteMany({
    where: { bucket: { startsWith: "login:" } },
  });
  console.log(`Deleted ${rl.count} login rate-limit hits.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
