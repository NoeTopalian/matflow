// SF-136 (lane L1, 11 Oct 2026; cycle 2): what happens to a pooled client when an interactive transaction's maxWait
// expires BEFORE the driver finished starting it.
//
// Library behaviour (cell 1, observation): Prisma 7.4.2 throws TransactionStartTimeoutError (P2028) to the caller and,
// when the start later completes, calls the adapter's transaction.rollback() — which in @prisma/adapter-pg only RELEASES
// the client (no ROLLBACK statement on this path). The client goes back to the pool inside its BEGIN; an autocommit
// write on it is held in a transaction nobody owns and is lost when the client closes. Still true of the library.
//
// The owning boundary (cell 2, the property): application code opens transactions only through withTenantContext /
// withRlsBypass (lib/prisma-tenant.ts), checkDbRateLimit (lib/rate-limit.ts) and reserveTx (lib/auth-lockout.ts) —
// pinned by tests/unit/sec-l1-store-tx-bound — and none of them lets Prisma abandon a start any more: a caller that
// cannot get a connection waits for the pool's own deadline instead. Cell 2 holds the only connection of a one-client
// pool past the OLD 2 s maxWait a caller asks for, releases it, and checks that the pool's client is not left inside a
// transaction and that the next autocommit write persists.
//
// Own pools only (the Prisma client the library code uses here is built as lib/prisma.ts builds it, with max 1), own
// synthetic secl1- rows, nothing SET on any connection; an abandoned transaction is ended by this test's own ROLLBACK or
// pool close. TEST branch only through the guarded runners.
import { vi, describe, it, expect, afterAll } from "vitest";
import { appendFileSync } from "node:fs";

const inj = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  const pg = (await import("pg")).default;
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@prisma/client");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...real.prismaPoolConfig(), max: 1 });
  inj.pool = pool;
  return { ...real, prisma: new PrismaClient({ adapter: new PrismaPg(pool), log: [] }) };
});

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { prisma, prismaPoolConfig, guardPoolRelease, POOL_CONNECTION_TIMEOUT_MS } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { checkRateLimit } from "@/lib/rate-limit";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BUCKET = (cell: string) => `secl1:start-${ROLE}-${STAMP}-${cell}`;
const OUT = process.env.L1_EVIDENCE_OUT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function report(tag: string, data: Record<string, unknown>) {
  const line = `${tag} ${JSON.stringify(data)}`;
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n");
}

describe.skipIf(!ON_TEST)(`SF-136: a start that times out never leaves a client inside a BEGIN (${ROLE})`, () => {
  const checker = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const written: string[] = [];
  const visibleToOthers = async (b: string) =>
    (await checker.query(`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE bucket = $1`, [b])).rows[0].n as number;

  afterAll(async () => {
    const del = await checker.query(`DELETE FROM "RateLimitHit" WHERE bucket = ANY($1::text[])`, [written]);
    const left = await checker.query(`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE bucket = ANY($1::text[])`, [written]);
    await checker.end();
    report("L1-START-TEARDOWN", { role: ROLE, buckets: written.length, deleted: del.rowCount, left: left.rows[0].n });
    expect(left.rows[0].n).toBe(0);
  }, 60_000);

  // R10-4 / R10-2 (lane L2, 12 Oct 2026): the library cell asserts the ACTUAL outcome (before: typeof inTx only), and
  // its twin runs the same abandoned start over a pool carrying lib/prisma.ts's release guard.
  async function abandonedStart(cell: string, guarded: boolean) {
    const b = BUCKET(cell);
    written.push(b);
    const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...prismaPoolConfig(), max: 1 });
    const pool = guarded ? guardPoolRelease(raw) : raw;
    const ended: number[] = [];
    pool.on("connect", (c: pg.PoolClient) => c.on("end", () => ended.push(Date.now())));
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const own = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
    let startErr = "";
    try {
      await own.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 1, timeout: 5_000 });
    } catch (e) {
      startErr = `${(e as { code?: string }).code ?? ""} ${String((e as Error).message).slice(0, 60)}`;
    }
    // wait until the late start has finished and been "rolled back" (released): idle client, or a closed one
    for (let i = 0; i < 100 && pool.idleCount === 0 && ended.length === 0; i++) await sleep(100);
    await sleep(300);
    const inTx = (await pool.query(`SELECT (now() <> statement_timestamp()) AS in_tx`)).rows[0].in_tx as boolean;
    await own.rateLimitHit.create({ data: { bucket: b } });
    const seenByOwnClient = await own.rateLimitHit.count({ where: { bucket: b } });
    await own.$disconnect();
    await pool.end(); // this test's own pool; closing it ends any abandoned transaction
    errSpy.mockRestore();
    await sleep(500);
    const persisted = await visibleToOthers(b);
    const out = { guarded, startErr, clientReturnedInsideTransaction: inTx, plainWriteSeenByOwnClient: seenByOwnClient, plainWritePersistedAfterClose: persisted, clientsEnded: ended.length, guardLines: errors.filter((l) => l.includes("released inside a transaction")).length };
    report(guarded ? "L2-START-GUARDED" : "L1-START-LIBRARY", { role: ROLE, ...out });
    return out;
  }

  it("library observation (asserted): Prisma + adapter-pg with maxWait 1 ms return the client inside its BEGIN; a later plain write is lost on close", async () => {
    const o = await abandonedStart("lib", false);
    expect(o.startErr).toMatch(/P2028|Unable to start a transaction/i);
    expect(o.clientReturnedInsideTransaction, "the library defect (SF-136): the client is idled inside its BEGIN").toBe(true);
    expect(o.plainWriteSeenByOwnClient).toBe(1);
    expect(o.plainWritePersistedAfterClose, "the next autocommit write was held in that transaction and lost").toBe(0);
  }, 60_000);

  it("R10-2: the same abandoned start over a pool with lib/prisma.ts's release guard → the client is closed, never idled inside a BEGIN; the next plain write persists", async () => {
    const o = await abandonedStart("guard", true);
    expect(o.startErr).toMatch(/P2028|Unable to start a transaction/i);
    expect(o.clientsEnded, "the guard ended the client released inside its transaction").toBeGreaterThanOrEqual(1);
    expect(o.guardLines).toBe(1);
    expect(o.clientReturnedInsideTransaction).toBe(false);
    expect(o.plainWritePersistedAfterClose).toBe(1);
  }, 60_000);

  it("withTenantContext asked for maxWait 2 s while the pool's only connection is busy for 4 s: it waits for the pool, succeeds, and leaves no client inside a BEGIN; the next plain write persists", async () => {
    const b = BUCKET("tenant");
    written.push(b);
    const pool = inj.pool as pg.Pool;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The test's own holder takes the only connection (a transaction with its own generous limits).
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await gate;
    }, { maxWait: 60_000, timeout: 120_000 });
    for (let i = 0; i < 100 && !(pool.totalCount === 1 && pool.idleCount === 0); i++) await sleep(50);
    const started = Date.now();
    const call = withTenantContext(`secl1-start-${STAMP}`, (tx) => tx.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`, { maxWait: 2_000 }).then(
      (v) => ({ ok: true as const, v, ms: Date.now() - started }),
      (e: unknown) => ({ ok: false as const, err: `${(e as { code?: string }).code ?? ""} ${String((e as Error).message).slice(0, 60)}`, ms: Date.now() - started }),
    );
    await sleep(4_000);
    release();
    await holder;
    const outcome = await call;
    await sleep(1_000); // a discarded start (old code) would finish and be "rolled back" (released) by now
    const inTx = (await prisma.$queryRaw<{ in_tx: boolean }[]>`SELECT (now() <> statement_timestamp()) AS in_tx`)[0].in_tx;
    await prisma.rateLimitHit.create({ data: { bucket: b } });
    const persisted = await visibleToOthers(b);
    // If the client WAS left inside a transaction (the old code), end it here so the run cleans up after itself.
    if (inTx) await prisma.$executeRaw`ROLLBACK`;
    report("L1-START-TENANT", { role: ROLE, outcome, clientLeftInsideTransaction: inTx, plainWritePersistedForOthers: persisted, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(inTx, "no client back in the pool inside a BEGIN").toBe(false);
    expect(persisted, "the next autocommit write persists").toBe(1);
  }, 60_000);

  // Review R10 B6 (folded in by lane L2): the pool's only connection held 12 s, past the pool's own 10 s deadline. A
  // tenant call fails at the deadline (not later, not with a client left inside a BEGIN); a rate-limit check on a
  // security bucket is a refusal with no row; afterwards the next plain write persists.
  it(`B6: the only connection held 12 s → tenant call fails at the ${POOL_CONNECTION_TIMEOUT_MS} ms pool deadline, rate limit refused (0 rows), nothing left inside a BEGIN`, async () => {
    const bucket = BUCKET("b6rl");
    const w = BUCKET("b6w");
    written.push(bucket, w);
    const pool = inj.pool as pg.Pool;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await gate;
    }, { maxWait: 60_000, timeout: 120_000 });
    for (let i = 0; i < 100 && !(pool.totalCount === 1 && pool.idleCount === 0); i++) await sleep(50);
    const t0 = Date.now();
    const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v, ms: Date.now() - t0 }), (e: unknown) => ({ ok: false as const, err: String((e as Error)?.message).slice(0, 80), ms: Date.now() - t0 }));
    const tenant = settle(withTenantContext(`secl1-start-${STAMP}`, (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 2_000 }));
    const rl = settle(checkRateLimit(bucket, 5, 60_000));
    await sleep(12_000);
    release();
    await holder;
    const [a, b] = await Promise.all([tenant, rl]);
    await sleep(1_000);
    const inTx = (await prisma.$queryRaw<{ in_tx: boolean }[]>`SELECT (now() <> statement_timestamp()) AS in_tx`)[0].in_tx;
    await prisma.rateLimitHit.create({ data: { bucket: w } });
    const persisted = await visibleToOthers(w);
    const rows = await visibleToOthers(bucket);
    report("L2-B6", { role: ROLE, tenant: a, rateLimit: b, clientInsideTransaction: inTx, plainWritePersisted: persisted, rateLimitRows: rows, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } });
    expect(a.ok, "no connection within the pool deadline → the tenant call fails").toBe(false);
    expect(a.ms).toBeGreaterThanOrEqual(POOL_CONNECTION_TIMEOUT_MS - 100);
    expect(a.ms).toBeLessThan(POOL_CONNECTION_TIMEOUT_MS + 1_500);
    expect(b.ok && (b.v as { allowed: boolean }).allowed, "a security bucket refuses when the store is unreachable").toBe(false);
    expect(inTx).toBe(false);
    expect(persisted).toBe(1);
    expect(rows).toBe(0);
  }, 60_000);
});
