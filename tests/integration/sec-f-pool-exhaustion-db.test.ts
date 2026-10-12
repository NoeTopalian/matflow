// SEC-076 pool exhaustion — bounded resource test (security campaign lane F, 9 Oct 2026).
//
// What it proves, against a real Postgres (the TEST branch through the guarded runners, either role):
//   1. With every pool connection held, a further query on the PRODUCTION pool config fails within
//      POOL_CONNECTION_TIMEOUT_MS (+ slack) instead of waiting for ever.
//   2. The same through Prisma + PrismaPg exactly as lib/prisma.ts builds it: a plain query queued behind a
//      held interactive transaction fails fast, and the transaction itself still commits (no collateral).
//   3. Positive control: once the connection is released the pool serves queries again.
//   4. Hazard control: a pool WITHOUT the deadline (node-postgres default 0) is still waiting after 12 s —
//      the behaviour the setting removes. Cancelled by ending the pool.
//
// Ceilings: pool max 1 (one held connection + one waiter), at most 3 connections open at once from this file,
// every wait capped by a race sentinel, whole file < 90 s. No rows are written.
import { describe, it, expect } from "vitest";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prismaPoolConfig, POOL_CONNECTION_TIMEOUT_MS } from "@/lib/prisma";

const URL_ = process.env.DATABASE_URL ?? "";
const HAS_DB = URL_.length > 0 && !URL_.includes("ep-bold-wave");
const SLACK_MS = 4_000;
const PENDING = Symbol("still-pending");
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then((v) => ({ v }), (e: unknown) => ({ e })), new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

describe.skipIf(!HAS_DB)("SEC-076 — a saturated pool fails fast instead of hanging", () => {
  it("the production pool config carries a connection deadline", () => {
    for (const env of ["production", "development", "test"]) {
      const cfg = prismaPoolConfig(env);
      expect(cfg.connectionTimeoutMillis).toBe(POOL_CONNECTION_TIMEOUT_MS);
      expect(cfg.connectionTimeoutMillis).toBeGreaterThan(0);
    }
    expect(prismaPoolConfig("production").max).toBe(5);
  });

  it("pg Pool with the production config: the waiter is refused within the deadline; positive control after release", async () => {
    const pool = new pg.Pool({ connectionString: URL_, ...prismaPoolConfig("production"), max: 1 });
    try {
      const held = await pool.connect();
      const t0 = Date.now();
      const r = await within(pool.query("select 1 as ok"), POOL_CONNECTION_TIMEOUT_MS + SLACK_MS);
      const waited = Date.now() - t0;
      expect(r, "the waiter was still pending past the deadline").not.toBe(PENDING);
      expect(r).toHaveProperty("e");
      expect(String((r as { e: Error }).e?.message)).toMatch(/timeout/i);
      expect(waited).toBeGreaterThanOrEqual(POOL_CONNECTION_TIMEOUT_MS - 500);
      held.release();
      const ok = await pool.query("select 1 as ok");
      expect(ok.rows[0].ok).toBe(1);
    } finally {
      await pool.end();
    }
  }, 40_000);

  it("Prisma + PrismaPg as lib/prisma.ts builds it: a plain query behind a held transaction fails fast; the transaction still commits", async () => {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL_, ...prismaPoolConfig("production"), max: 1 }) });
    try {
      await client.$queryRaw`select 1`; // warm the single connection
      const holdSeconds = POOL_CONNECTION_TIMEOUT_MS / 1000 + 3;
      const tx = client.$transaction(
        async (t) => {
          // Hold the connection idle-in-transaction from JS rather than with a long-running statement:
          // the TEST owner role carries statement_timeout = 10 s, which would cancel a pg_sleep and free
          // the connection early (seen on the first run), while matflow_app carries none.
          await t.$queryRaw`select 1`;
          await new Promise((r) => setTimeout(r, holdSeconds * 1000));
          return "committed";
        },
        { maxWait: 5_000, timeout: (holdSeconds + 10) * 1000 },
      );
      await new Promise((r) => setTimeout(r, 300)); // let the transaction take the connection first
      const t0 = Date.now();
      const r = await within(client.$queryRaw`select 1 as ok`, POOL_CONNECTION_TIMEOUT_MS + SLACK_MS);
      const waited = Date.now() - t0;
      expect(r, "the plain query was still pending past the deadline").not.toBe(PENDING);
      expect(r).toHaveProperty("e");
      expect(waited).toBeLessThan(POOL_CONNECTION_TIMEOUT_MS + SLACK_MS);
      await expect(tx).resolves.toBe("committed");
      const after = await client.$queryRaw<Array<{ ok: number }>>`select 1 as ok`;
      expect(after[0].ok).toBe(1);
    } finally {
      await client.$disconnect();
    }
  }, 60_000);

  it("hazard control: without the deadline (pg default) the waiter is still pending after 12 s", async () => {
    const pool = new pg.Pool({ connectionString: URL_, max: 1 });
    const held = await pool.connect();
    try {
      const r = await within(pool.query("select 1"), 12_000);
      expect(r).toBe(PENDING);
    } finally {
      held.release();
      await pool.end().catch(() => {});
    }
  }, 30_000);
});
