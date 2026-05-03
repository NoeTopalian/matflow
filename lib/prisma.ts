import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (url.startsWith("file:")) {
    throw new Error("SQLite is not supported. Use a Postgres URL.");
  }
  // WP-I (audit): production must use the pooled Neon connection or burst
  // traffic exhausts the pool and routes start timing out at 60s. Warn loud
  // — don't throw, since some setups use a dedicated direct URL on purpose.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    !url.includes("pgbouncer=true")
  ) {
    console.warn(
      "[prisma] DATABASE_URL is missing pgbouncer=true&connection_limit=1 — pool exhaustion risk under burst. " +
      "Append `?pgbouncer=true&connection_limit=1` (or `&` if other params exist) in Vercel env.",
    );
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
