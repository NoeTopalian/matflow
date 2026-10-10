/**
 * SF-40 residual (review R5 §2), the shape CI can check without a database — security campaign
 * iteration 2, lane C3, 9 Oct 2026. The behaviour itself (burst of 20 at max 5 → exactly 5) is
 * proved on Postgres under both roles by tests/integration/sec-c3-rate-limit-atomic-db.test.ts,
 * which skips without a TEST database; this file pins the structure that makes it true:
 *  - an allowed hit is written ONLY inside one transaction whose FIRST statement takes the
 *    per-bucket advisory lock and whose second is the conditional insert (never a bare create);
 *  - a bucket already full is refused by the unlocked aggregate without opening a transaction;
 *  - a database failure on a security bucket is a refusal, never a per-instance memory count (lane C4,
 *    R6-N3 — tests/unit/sec-c4-rate-limit-store-failure.test.ts has the full rules).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Op = { kind: "lock" | "insert"; sql: string; values: unknown[] };
const h = vi.hoisted(() => ({
  full: false,
  down: false,
  insertResult: [{ count: 0, inserted: 1, oldestAgeMs: null }] as unknown[],
  transactions: [] as Array<Array<{ kind: string; sql: string; values: unknown[] }>>,
  creates: 0,
}));

vi.mock("@/lib/prisma", () => {
  const tag = (kind: "lock" | "insert") => (s: TemplateStringsArray, ...values: unknown[]): Op => ({ kind, sql: s.join("?"), values });
  return {
    prisma: {
      rateLimitHit: {
        groupBy: async () => {
          if (h.down) throw new Error("connect ECONNREFUSED (secc3 fake)");
          return h.full ? [{ bucket: "b", _count: { _all: 5 }, _min: { hitAt: new Date(Date.now() - 30_000) } }] : [];
        },
        create: async () => {
          h.creates++;
          return {};
        },
        deleteMany: async () => ({ count: 0 }),
      },
      $executeRaw: tag("lock"),
      $queryRaw: tag("insert"),
      $transaction: async (ops: Op[]) => {
        if (h.down) throw new Error("connect ECONNREFUSED (secc3 fake)");
        h.transactions.push(ops);
        return ops.map((o) => (o.kind === "insert" ? h.insertResult : 1));
      },
    },
  };
});

import { checkRateLimit, RATE_LIMIT_LOCK_NS } from "@/lib/rate-limit";

beforeEach(() => {
  h.full = false;
  h.down = false;
  h.insertResult = [{ count: 0, inserted: 1, oldestAgeMs: null }];
  h.transactions = [];
  h.creates = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("checkRateLimit: lock, then conditional insert, in one transaction", () => {
  it("an allowed hit is one transaction: [advisory lock on this bucket, conditional insert] — and no bare create", async () => {
    expect(await checkRateLimit("secc3-unit-a", 5, 60_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(h.transactions).toHaveLength(1);
    const [lock, insert] = h.transactions[0];
    expect(h.transactions[0]).toHaveLength(2);
    expect(lock.kind).toBe("lock");
    expect(lock.sql).toMatch(/pg_advisory_xact_lock\(/);
    expect(lock.sql).not.toMatch(/pg_advisory_lock\(/); // session locks leak through a transaction-mode pooler
    expect(lock.values).toEqual([RATE_LIMIT_LOCK_NS, "secc3-unit-a"]);
    expect(insert.kind).toBe("insert");
    expect(insert.sql).toMatch(/INSERT INTO "RateLimitHit"/);
    expect(insert.sql).toMatch(/WHERE win\.n < \?::int/);
    expect(insert.values).toContain("secc3-unit-a");
    expect(insert.values).toContain(5);
    expect(h.creates).toBe(0);
  });

  it("the conditional insert declining (count reached under the lock) is a refusal with a bounded Retry-After", async () => {
    h.insertResult = [{ count: 5, inserted: 0, oldestAgeMs: 45_500 }];
    expect(await checkRateLimit("secc3-unit-b", 5, 60_000)).toEqual({ allowed: false, retryAfterSeconds: 15 });
    h.insertResult = [{ count: 5, inserted: 0, oldestAgeMs: 59_999.9 }];
    expect((await checkRateLimit("secc3-unit-b", 5, 60_000)).retryAfterSeconds).toBe(1);
  });

  it("a bucket already full is refused by the unlocked aggregate without opening a transaction", async () => {
    h.full = true;
    const r = await checkRateLimit("secc3-unit-c", 5, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(29);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(31);
    expect(h.transactions).toHaveLength(0);
  });

  it("database down: a security bucket is refused (no per-instance memory allowance); failClosed still throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.down = true;
    const b = `secc3-unit-mem-${Date.now()}`;
    const v = [await checkRateLimit(b, 2, 60_000), await checkRateLimit(b, 2, 60_000), await checkRateLimit(b, 2, 60_000)];
    expect(v.map((x) => x.allowed)).toEqual([false, false, false]);
    await expect(checkRateLimit(`${b}-fc`, 2, 60_000, { failClosed: true })).rejects.toThrow(/ECONNREFUSED/);
  });
});
