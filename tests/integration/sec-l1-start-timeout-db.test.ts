// SF-135 side probe (lane L1, 11 Oct 2026): what Prisma 7.4.2 + @prisma/adapter-pg do with a pooled client when an
// interactive transaction's maxWait expires BEFORE the driver finished starting it. Prisma throws
// TransactionStartTimeoutError to the caller and, when the start later completes, calls the adapter's
// transaction.rollback() — which in adapter-pg only RELEASES the client (it sends no ROLLBACK; the engine normally sends
// it first). The question: does that client go back to the pool still inside the BEGIN, and does a later plain write
// on it survive?
//
// Own pool of ONE client (so the next query is on the same connection), own synthetic secl1- rows, nothing SET; the
// abandoned transaction ends when this test closes its own pool. TEST branch only through the guarded runners.
import { describe, it, expect, afterAll } from "vitest";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { prismaPoolConfig } from "@/lib/prisma";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const BUCKET = `secl1:start-${ROLE}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OUT = process.env.L1_EVIDENCE_OUT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ON_TEST)(`Prisma start-timeout discard path (${ROLE})`, () => {
  const checker = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  afterAll(async () => {
    const del = await checker.query(`DELETE FROM "RateLimitHit" WHERE bucket = $1`, [BUCKET]);
    const left = await checker.query(`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE bucket = $1`, [BUCKET]);
    await checker.end();
    const line = `L1-START-TEARDOWN ${JSON.stringify({ role: ROLE, deleted: del.rowCount, left: left.rows[0].n })}`;
    console.log(line);
    if (OUT) appendFileSync(OUT, line + "\n");
    expect(left.rows[0].n).toBe(0);
  }, 60_000);

  it("maxWait expires during the start: is the client returned inside a transaction, and is a later plain write lost?", async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...prismaPoolConfig(), max: 1 });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
    let startErr = "";
    try {
      await prisma.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 1, timeout: 5_000 });
    } catch (e) {
      startErr = `${(e as { code?: string }).code ?? ""} ${String((e as Error).message).slice(0, 60)}`;
    }
    // Let the abandoned start finish (connect + BEGIN) and be "rolled back" (released).
    for (let i = 0; i < 100 && pool.idleCount === 0; i++) await sleep(100);
    // The only client in the pool: is it inside a transaction? (now() is the transaction start; a fresh implicit
    // transaction has now() = statement_timestamp().)
    const probe = await pool.query(`SELECT (now() <> statement_timestamp()) AS in_tx`);
    const inTx = probe.rows[0].in_tx as boolean;
    // A plain write through Prisma on that client (it auto-commits on a healthy client).
    await prisma.rateLimitHit.create({ data: { bucket: BUCKET } });
    const seenFromOwnClient = await prisma.rateLimitHit.count({ where: { bucket: BUCKET } });
    await prisma.$disconnect();
    await pool.end(); // the pool is this test's own; its end closes the abandoned transaction
    await sleep(500);
    const r = await checker.query(`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE bucket = $1`, [BUCKET]);
    const persisted = r.rows[0].n as number;
    const line = `L1-START-DISCARD ${JSON.stringify({ role: ROLE, startErr, clientReturnedInsideTransaction: inTx, plainWriteSeenBeforeClose: seenFromOwnClient, plainWritePersistedAfterClose: persisted })}`;
    console.log(line);
    if (OUT) appendFileSync(OUT, line + "\n");
    expect(startErr).toMatch(/P2028|Unable to start a transaction/i);
    // Recorded, not asserted either way: this is an observation of library behaviour (see the report).
    expect(typeof inTx).toBe("boolean");
  }, 60_000);
});
