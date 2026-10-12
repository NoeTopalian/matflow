/**
 * R10-1(b) (lane L2, 12 Oct 2026) — the tenant transaction budget is an ENFORCED DEADLINE, not a check made after the
 * callback returns. Before: lib/prisma-tenant.ts withinBudget awaited the callback and only then compared the elapsed
 * time, so a callback idle past its budget (awaiting something that is not the database) held its pooled connection
 * until it returned — the reviewer's example, app/api/members/[id]/rank/route.ts awaiting @vercel/blob del() with
 * retries, could hold a slot for minutes.
 *
 * The mock below reproduces Prisma 7.4.2's _transactionWithCallback exactly as shipped
 * (node_modules/@prisma/client/runtime/client.js): start; `result = await callback(tx)`; commit; on ANY throw
 * `await rollback().catch(() => {})` and rethrow. Rollback and commit each release the client once. So "the deadline
 * throws in time" is what makes Prisma's awaited rollback end the transaction and free the slot.
 *
 * No database: everything here is mocked; the database cells (B1 and the R10-4 cells) are phase 2,
 * tests/integration/sec-l2-*-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as string[],
  commits: 0,
  rollbacks: 0,
  releases: 0,
  closed: false,
}));

vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  return {
    ...real,
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        h.closed = false;
        const guard = () => {
          if (h.closed) throw new Error("Transaction already closed: a late statement was refused");
        };
        const tx = {
          $executeRaw: async () => { guard(); h.events.push("stmt"); return 1; },
          $queryRaw: async () => { guard(); h.events.push("query"); return [{ pid: "1", ts: "1" }]; },
          lateWrite: async () => { guard(); h.events.push("late-write"); return 1; },
        };
        let out: unknown;
        try {
          out = await fn(tx);
          h.commits++;
          h.events.push("commit");
          h.closed = true;
          h.releases++;
        } catch (e) {
          await (async () => {
            h.rollbacks++;
            h.events.push("rollback");
            h.closed = true;
            h.releases++;
          })().catch(() => {});
          throw e;
        }
        return out;
      },
    },
  };
});

import { withTenantContext, withRlsBypass, TenantTransactionBudgetError } from "@/lib/prisma-tenant";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUDGET = 200;
const MARGIN = 150;
const SECRET_RESULT = "late-result-secret-7f3a";
const SECRET_ERROR = "late-error-secret-91bc";

let logs: string[] = [];
let unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => { unhandled.push(r); };

beforeEach(() => {
  h.events = [];
  h.commits = 0;
  h.rollbacks = 0;
  h.releases = 0;
  h.closed = false;
  logs = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  for (const m of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(`${m}: ${a.map(String).join(" ")}`);
    });
  }
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

describe("R10-1(b): a callback still running at its budget is cut at the budget", () => {
  for (const [name, open] of [
    ["withTenantContext", (fn: (tx: { lateWrite: () => Promise<number> }) => Promise<unknown>) =>
      withTenantContext("tenant-L2", fn as never, { timeout: BUDGET })],
    ["withRlsBypass", (fn: (tx: { lateWrite: () => Promise<number> }) => Promise<unknown>) =>
      withRlsBypass(fn as never, { timeout: BUDGET })],
  ] as const) {
    it(`${name}: resolves after the budget → TenantTransactionBudgetError within budget + margin; rollback once, release once; late result logged and discarded`, async () => {
      const started = Date.now();
      let finishedLate = false;
      const err = await open(async () => {
        await sleep(BUDGET * 3);
        finishedLate = true;
        return SECRET_RESULT;
      }).then(
        (v) => ({ resolved: v }),
        (e: unknown) => e,
      );
      const elapsed = Date.now() - started;

      expect(err).toBeInstanceOf(TenantTransactionBudgetError);
      expect(err).toMatchObject({ code: "P2028", budgetMs: BUDGET });
      expect(elapsed, "the caller is answered at the budget, not when the callback returns").toBeLessThan(BUDGET + MARGIN);
      expect(elapsed).toBeGreaterThanOrEqual(BUDGET - 5);
      expect(finishedLate, "the callback was still running when the caller was answered").toBe(false);
      expect(h.rollbacks).toBe(1);
      expect(h.commits).toBe(0);
      expect(h.releases).toBe(1);

      // Let the losing callback finish: its result is logged at error level and discarded, nothing unhandled.
      await sleep(BUDGET * 3);
      expect(finishedLate).toBe(true);
      expect(h.rollbacks).toBe(1);
      expect(h.commits).toBe(0);
      expect(h.releases).toBe(1);
      const late = logs.filter((l) => l.includes("[prisma-tenant]"));
      expect(late).toHaveLength(1);
      expect(late[0]).toMatch(/^error: /);
      if (name === "withTenantContext") expect(late[0]).toContain("tenant=tenant-L2");
      for (const l of logs) expect(l.includes(SECRET_RESULT)).toBe(false);
      expect(unhandled).toEqual([]);
    });

    it(`${name}: a callback that FAILS after the budget → its error is logged without its content and discarded, nothing unhandled`, async () => {
      const err = await open(async () => {
        await sleep(BUDGET * 2);
        throw new Error(SECRET_ERROR);
      }).then(
        (v) => ({ resolved: v }),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TenantTransactionBudgetError);
      await sleep(BUDGET * 3);
      const late = logs.filter((l) => l.includes("[prisma-tenant]"));
      expect(late).toHaveLength(1);
      expect(late[0]).toMatch(/^error: /);
      for (const l of logs) expect(l.includes(SECRET_ERROR)).toBe(false);
      expect(h.rollbacks).toBe(1);
      expect(h.releases).toBe(1);
      expect(unhandled).toEqual([]);
    });

    it(`${name}: after the cut, a late statement from the losing callback is refused (it cannot write on a closed transaction)`, async () => {
      const err = await open(async (tx) => {
        await sleep(BUDGET * 2);
        await tx.lateWrite();
        return "never";
      }).then(
        (v) => ({ resolved: v }),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TenantTransactionBudgetError);
      await sleep(BUDGET * 3);
      expect(h.events).not.toContain("late-write");
      expect(h.events.filter((e) => e === "rollback")).toHaveLength(1);
      expect(logs.filter((l) => l.includes("[prisma-tenant]"))).toHaveLength(1);
      expect(unhandled).toEqual([]);
    });

    it(`${name}: a callback that resolves in time → its value, committed once, no rollback, no log`, async () => {
      const v = await open(async () => {
        await sleep(BUDGET / 4);
        return "in-time";
      });
      expect(v).toBe("in-time");
      expect(h.commits).toBe(1);
      expect(h.rollbacks).toBe(0);
      expect(h.releases).toBe(1);
      await sleep(BUDGET * 2); // the deadline timer must not fire after success
      expect(h.rollbacks).toBe(0);
      expect(logs).toEqual([]);
      expect(unhandled).toEqual([]);
    });

    it(`${name}: a callback that throws in time → its own error, unchanged; rollback once, release once`, async () => {
      const boom = Object.assign(new Error("unique"), { code: "P2002" });
      await expect(open(async () => {
        await sleep(BUDGET / 4);
        throw boom;
      })).rejects.toBe(boom);
      expect(h.rollbacks).toBe(1);
      expect(h.commits).toBe(0);
      expect(h.releases).toBe(1);
      await sleep(BUDGET * 2);
      expect(h.rollbacks).toBe(1);
      expect(logs).toEqual([]);
      expect(unhandled).toEqual([]);
    });
  }

  it("withTenantContext keeps the error context on the budget error (tenant attributed for lib/api-error.ts)", async () => {
    const { readErrorContext } = await import("@/lib/error-context");
    const err = await withTenantContext("tenant-ctx", async () => { await sleep(BUDGET * 2); return 1; }, { timeout: BUDGET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantTransactionBudgetError);
    expect(readErrorContext(err)).toMatchObject({ tenantId: "tenant-ctx" });
    await sleep(BUDGET * 2);
  });
});
