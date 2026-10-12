import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

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

/**
 * How long a query waits for a free pool connection before failing (security
 * campaign SEC-076, lane F, 9 Oct 2026). node-postgres defaults this to 0 =
 * WAIT FOR EVER: with all `max` connections held (a slow query, a burst, a
 * stuck transaction), every non-transactional query on the instance queued
 * with no deadline and each request held its function open until the
 * platform's maxDuration killed it — an outage that bills duration on every
 * waiting request. Interactive transactions were already bounded by their own
 * maxWait (lib/prisma-tenant.ts, 10 s); this gives plain queries the same
 * deadline, so exhaustion surfaces as a fast error instead of a hang.
 * Measured by tests/integration/sec-f-pool-exhaustion-db.test.ts.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The pg Pool options PrismaPg forwards to `new pg.Pool(...)`. Exported so the
 * pool-exhaustion test exercises exactly what production runs.
 */
export function prismaPoolConfig(nodeEnv: string | undefined = process.env.NODE_ENV) {
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
  const max = nodeEnv === "production" ? 5 : 20;
  // keepAlive: Neon (and NATs on the way to it) sever idle sockets; without
  // TCP keepalive the pool only discovers the corpse when a route tries to
  // open a transaction on it — surfacing as a 500 "Connection terminated
  // unexpectedly" on an otherwise healthy request (observed 2026-09-21,
  // reference MF-DFF20J). Keepalive probes retire dead peers between requests.
  return { max, keepAlive: true, connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS };
}

/**
 * SF-136 / R10-2 release guard (lane L1 patch 0001, applied by lane L2 on 12 Oct 2026). Never keep a pooled client
 * that comes back INSIDE a transaction. @prisma/adapter-pg 7.4.2 "rolls back" a transaction whose start Prisma
 * abandoned (maxWait expired before BEGIN was answered) by RELEASING the client without a ROLLBACK, so the client went
 * back to the pool inside its BEGIN and the next autocommit write on it was held in a transaction nobody owned and
 * lost on close (review R10 phase 2, MR2, both roles). The application's own openers no longer let Prisma abandon a
 * start (lib/prisma-tenant.ts, lib/rate-limit.ts, lib/auth-lockout.ts); this closes the library mechanism for any
 * future caller as well.
 *
 * How: the server's ReadyForQuery message carries the transaction status ('I' idle, 'T' in a transaction, 'E' in a
 * failed transaction). Each pooled client records the last one; when a client is released with 'T' or 'E' it is ended,
 * so the server rolls the transaction back, and pg-pool drops it instead of idling it (pg-pool 3.13.0 _release emits
 * 'release' first and then removes a client whose _ending is set). A client released WITH an error is already being
 * removed by the pool and is left to it.
 *
 * It relies on two pg internals — client.connection's 'readyForQuery' event and client._ending — so pg and pg-pool are
 * pinned exactly (package.json: "pg": "8.20.0", overrides "pg-pool": "3.13.0") and tests/unit/sec-l2-pool-release-guard
 * exercises both against the installed versions (a real pg client and pool over a local protocol stub).
 */
export function guardPoolRelease(pool: pg.Pool): pg.Pool {
  type Tracked = { __txStatus?: string; _ending?: boolean; connection: { on(e: "readyForQuery", f: (m: { status: string }) => void): void } };
  pool.on("connect", (client) => {
    const c = client as unknown as Tracked;
    c.connection.on("readyForQuery", (m) => {
      c.__txStatus = m.status;
    });
  });
  pool.on("release", (err, client) => {
    const c = client as unknown as Tracked;
    if (err || c._ending) return;
    const status = c.__txStatus;
    if (status === "T" || status === "E") {
      console.error(`[prisma] pooled client released inside a transaction (status=${status}); closing it`);
      // end() sets _ending synchronously, so pg-pool removes the client instead of idling it. Its own failure is
      // observed and logged here, where the promise is created (no unhandled rejection, nothing hidden).
      (client as unknown as pg.Client).end().catch((e: Error) => console.error(`[prisma] closing that client failed: ${e.message}`));
    }
  });
  return pool;
}

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
  // Pool options (max, keepAlive, connection deadline): prismaPoolConfig() above. The pool is built here (not by
  // PrismaPg) so the release guard above can watch it.
  const pool = guardPoolRelease(new pg.Pool({ connectionString: url, ...prismaPoolConfig() }));
  const adapter = new PrismaPg(pool);
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
