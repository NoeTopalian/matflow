import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Lazy Prisma client.
//
// Why lazy: Next.js's "Collecting page data" build step imports every API
// route module to extract its metadata. If `prisma` is created at module
// init, a missing DATABASE_URL fails the entire build — even though no
// real DB query runs at build time. By deferring instantiation until the
// first method access, the import is free and only actual *runtime* DB use
// fails when DATABASE_URL is unset.
//
// Behaviour at runtime is unchanged: the first call to e.g. `prisma.member
// .findMany()` constructs the client; subsequent calls reuse the cached
// instance. The dev-mode global cache is preserved to avoid hot-reload
// connection leaks.

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

let realClient: PrismaClient | null = null;
function getClient(): PrismaClient {
  if (realClient) return realClient;
  if (globalForPrisma.prisma) {
    realClient = globalForPrisma.prisma;
    return realClient;
  }
  realClient = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = realClient;
  }
  return realClient;
}

// Proxy so importing `prisma` is free; instantiation happens on first use.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop as keyof typeof client];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
}) as PrismaClient;
