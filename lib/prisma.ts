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
  // Audit memory-storage 2026-08-16 P1-2: this guard used to check for
  // `pgbouncer=true` in the URL. Under `@prisma/adapter-pg` that param — and
  // `connection_limit` with it — is INERT: both are Prisma *native engine*
  // params, silently ignored by the pg driver. So the old check both
  // false-passed (a direct host carrying the param looked fine) and
  // false-alarmed (a genuinely pooled host without it looked broken).
  //
  // What actually decides pooling is (a) the pg Pool `max` set below and
  // (b) whether the host is Neon's PgBouncer endpoint, spelled
  // `<endpoint>-pooler.<region>.aws.neon.tech`. Warn loud on a direct host —
  // don't throw, since some setups use a dedicated direct URL on purpose.
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Malformed URL — leave the warning off and let pg report it properly.
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    host !== "" &&
    !host.includes("-pooler")
  ) {
    console.warn(
      `[prisma] DATABASE_URL host "${host}" is not a Neon pooled endpoint (no "-pooler" in the hostname) — ` +
      "each instance opens direct connections, so ~10-11 concurrent instances exhaust Neon's ~112 direct " +
      "connections and routes start timing out at 60s under burst. " +
      "Fix: Neon dashboard → Connect → copy the *Pooled connection* string (its host contains `-pooler`) " +
      "and set that as DATABASE_URL in Vercel.",
    );
  }
  // `max` is a node-postgres Pool option; PrismaPg's first argument is a
  // `pg.Pool | pg.PoolConfig` and is forwarded straight to the Pool
  // constructor. Vercel Fluid can serve many concurrent requests per
  // instance, so the pg default of 10 lets a handful of warm instances alone
  // approach Neon's direct-connection ceiling. 5 per instance keeps
  // worst-case (instance count × max) inside Neon's pooled limits while
  // staying well above what a single request needs.
  //
  // That ceiling is a *production* calculation — it is about instance count ×
  // max against Neon's limit. Outside production there is exactly ONE
  // long-lived process, so 5 is not a safety margin, it is a bottleneck: every
  // tenant-scoped read runs inside an interactive transaction that holds its
  // connection for the whole aggregate (~5s for /api/member/me against a remote
  // branch, ~15 round trips at ~207ms each). A handful of concurrent page loads
  // therefore queue past withTenantContext's 10s maxWait, Prisma raises P2028,
  // and routes surface it as HTTP 503 — observed under `playwright --workers=2`.
  const max = process.env.NODE_ENV === "production" ? 5 : 20;
  const adapter = new PrismaPg({ connectionString: url, max });
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
