// One-off: clear the RateLimitHit table on the *test branch* so e2e setup
// logins aren't blocked by the 5/15min-per-email auth rate limit.
// Guarded — refuses to run against the production Neon endpoint.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "";
if (url.includes("ep-bold-wave")) {
  throw new Error("Refusing to run against production Neon endpoint");
}
const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

prisma.rateLimitHit
  .deleteMany({})
  .then((r) => console.log(`cleared ${r.count} rate-limit hits`))
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
