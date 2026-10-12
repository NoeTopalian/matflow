/**
 * R10-3 (lane L2 phase 2, 12 Oct 2026) — a statement error SWALLOWED inside a tenant / bypass callback must not be
 * reported as success. Postgres aborts the whole transaction on any statement error; the callback catches it and
 * returns normally; Prisma then sends COMMIT, which the server answers with the ROLLBACK tag and no error — so before
 * this fix the caller was told "done" while nothing persisted (review R10 phase 2: B5a swallowed 57014 under a 120 s
 * budget, B5c a swallowed non-timeout error, both roles).
 *
 * The fix: withTenantContext / withRlsBypass run one cheap liveness statement after the callback and before COMMIT.
 * On an aborted transaction the server answers 25P02, and the caller gets TenantTransactionAbortedError (nothing was
 * committed; Prisma's awaited rollback ends the transaction). Cost: one extra round trip per tenant transaction.
 *
 * The mock reproduces both halves exactly: Prisma 7.4.2's _transactionWithCallback (commit after the callback, awaited
 * rollback on a throw) and Postgres's aborted-transaction rule (after one failed statement, every later statement fails
 * with 25P02 until the transaction ends; COMMIT "succeeds" as a rollback).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  aborted: false,
  committed: 0,
  silentlyRolledBack: 0,
  rollbacks: 0,
  statements: [] as string[],
  failNext: null as null | (() => Error),
}));

/** The shape Prisma 7.4.2 + adapter-pg give a failed raw statement (recorded by tests/integration/sec-l2-tenant-bounds-db: name PrismaClientKnownRequestError, code P2010, the SQLSTATE only in the message). */
function pgError(code: string, message: string) {
  return Object.assign(new Error(`\nInvalid \`prisma.$executeRaw()\` invocation:\n\n\nRaw query failed. Code: \`${code}\`. Message: \`${message}\``), { name: "PrismaClientKnownRequestError", code: "P2010" });
}

vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  const run = async (s: unknown) => {
    const text = (s as string[]).join("?");
    h.statements.push(text);
    if (h.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
    if (h.failNext) {
      const e = h.failNext();
      h.failNext = null;
      h.aborted = true;
      throw e;
    }
    return 1;
  };
  return {
    ...real,
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        h.aborted = false;
        const tx = { $executeRaw: run, $queryRaw: async (s: unknown) => { await run(s); return [{ ok: 1 }]; } };
        let out: unknown;
        try {
          out = await fn(tx);
        } catch (e) {
          await (async () => { h.rollbacks++; })().catch(() => {});
          throw e;
        }
        // COMMIT on an aborted transaction: the server answers ROLLBACK, no error.
        if (h.aborted) h.silentlyRolledBack++;
        else h.committed++;
        return out;
      },
    },
  };
});

import { withTenantContext, withRlsBypass, TenantTransactionAbortedError } from "@/lib/prisma-tenant";

let logs: string[] = [];
beforeEach(() => {
  h.aborted = false;
  h.committed = 0;
  h.silentlyRolledBack = 0;
  h.rollbacks = 0;
  h.statements = [];
  h.failNext = null;
  logs = [];
  for (const m of ["error", "warn"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(`${m}: ${a.map(String).join(" ")}`); });
  }
});
afterEach(() => vi.restoreAllMocks());

type Tx = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> };
const sql = (s: string) => Object.assign([s], { raw: [s] }) as unknown as TemplateStringsArray;

describe("R10-3: a swallowed statement error is never reported as success", () => {
  for (const [name, open] of [
    ["withTenantContext", (fn: (tx: Tx) => Promise<unknown>, timeout?: number) => withTenantContext("tenant-L2", fn as never, { timeout })],
    ["withRlsBypass", (fn: (tx: Tx) => Promise<unknown>, timeout?: number) => withRlsBypass(fn as never, { timeout })],
  ] as const) {
    for (const [kind, make, timeout] of [
      ["a swallowed 57014 statement timeout (extended budget)", () => pgError("57014", "canceling statement due to statement timeout"), 120_000],
      ["a swallowed generic error (division by zero)", () => pgError("22012", "division by zero"), undefined],
      ["a swallowed unique violation", () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" }), undefined],
    ] as const) {
      it(`${name}: ${kind} → TenantTransactionAbortedError, nothing reported as committed, rollback once`, async () => {
        const err = await open(async (tx) => {
          await tx.$executeRaw(sql("INSERT INTO t VALUES (1)"));
          h.failNext = make;
          await tx.$executeRaw(sql("SELECT pg_sleep(62)")).catch(() => null); // swallowed by the callback
          return "reported-ok";
        }, timeout).then((v) => ({ resolved: v }), (e: unknown) => e);
        expect(err).toBeInstanceOf(TenantTransactionAbortedError);
        expect(err).toMatchObject({ code: "25P02" });
        expect(h.committed).toBe(0);
        expect(h.silentlyRolledBack, "COMMIT was never sent on the aborted transaction").toBe(0);
        expect(h.rollbacks).toBe(1);
        const line = logs.filter((l) => l.includes("[prisma-tenant]"));
        expect(line).toHaveLength(1);
        expect(line[0]).toMatch(/^error: .*aborted/);
        if (name === "withTenantContext") expect(line[0]).toContain("tenant=tenant-L2");
      });
    }

    it(`${name}: control — no swallowed error → committed once, exactly one extra liveness statement (the cost)`, async () => {
      const v = await open(async (tx) => {
        await tx.$executeRaw(sql("INSERT INTO t VALUES (1)"));
        return "ok";
      });
      expect(v).toBe("ok");
      expect(h.committed).toBe(1);
      expect(h.rollbacks).toBe(0);
      // first statement (context + bounds), the callback's insert, the liveness check — nothing else
      expect(h.statements).toHaveLength(3);
      expect(h.statements[2]).toMatch(/^SELECT 1/);
      expect(logs).toEqual([]);
    });

    it(`${name}: an error the callback does NOT swallow is the caller's own, unchanged (no liveness statement)`, async () => {
      const boom = pgError("22012", "division by zero");
      await expect(open(async (tx) => {
        h.failNext = () => boom;
        await tx.$executeRaw(sql("SELECT 1/0"));
        return "unreachable";
      })).rejects.toBe(boom);
      expect(h.rollbacks).toBe(1);
      expect(h.statements.some((s) => /^SELECT 1$/.test(s))).toBe(false);
    });

    it(`${name}: the liveness statement failing for another reason (connection lost) → that error, rollback once`, async () => {
      const lost = new Error("Connection terminated unexpectedly");
      const err = await open(async () => {
        h.failNext = () => lost; // the next statement is the liveness check
        return "ok";
      }).then((v) => ({ resolved: v }), (e: unknown) => e);
      expect(err).toBe(lost);
      expect(h.committed).toBe(0);
      expect(h.rollbacks).toBe(1);
    });
  }
});
