// SF-40 residual (review R5 §2) on Postgres — security campaign iteration 2, lane C3, 9 Oct 2026.
//
// lib/rate-limit.ts used to count the window and THEN insert the hit in a
// second statement, so concurrent callers all read the same count and all
// passed: R5 measured a burst of 10 against max 5 letting 10 through, under
// both roles. This pins the shared-database limit as exact under a concurrent
// burst (20 parallel calls, max 5 → exactly 5 allowed, exactly 5 rows).
//
// TEST branch only, through the guarded runners (owner, and matflow_app with
// RLS_ENFORCED=1). Every bucket carries the secc3- prefix and this run's
// stamp; teardown deletes exactly those rows and checks the count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const HAS_DB = !!process.env.DATABASE_URL;
const ON_TEST_BRANCH = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `secc3-rl-${ROLE}-${STAMP}`;
const out: Record<string, unknown> = { role: ROLE };
let rowsWritten = 0;

const run = HAS_DB && ON_TEST_BRANCH ? describe : describe.skip;

async function rows(bucket: string) {
  return prisma.rateLimitHit.count({ where: { bucket } });
}

run(`checkRateLimit on a real database is exact under concurrency (${ROLE})`, () => {
  beforeAll(async () => {
    // Warm the pool so every parallel call has a connection ready (as R5's probe did).
    await Promise.all(Array.from({ length: 10 }, () => prisma.$queryRaw`SELECT 1`));
  });

  afterAll(async () => {
    const del = await prisma.rateLimitHit.deleteMany({ where: { bucket: { startsWith: PREFIX } } });
    const left = await prisma.rateLimitHit.count({ where: { bucket: { startsWith: PREFIX } } });
    out.teardown = { rowsWritten, deleted: del.count, left };
    if (process.env.C3_OUT) writeFileSync(process.env.C3_OUT, JSON.stringify(out, null, 1));
    expect(del.count).toBe(rowsWritten);
    expect(left).toBe(0);
  });

  it("positive control, sequential: five allowed, the sixth refused with a bounded Retry-After; five rows", async () => {
    const b = `${PREFIX}-seq`;
    const res = [];
    for (let i = 0; i < 6; i++) res.push(await checkRateLimit(b, 5, 60_000));
    const n = await rows(b);
    rowsWritten += n;
    out.sequential = { verdicts: res.map((r) => r.allowed), retryAfter: res[5].retryAfterSeconds, rows: n };
    expect(res.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(res[5].retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res[5].retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(n).toBe(5);
  });

  for (const round of [1, 2, 3]) {
    it(`burst of 20 in parallel against max 5 → exactly 5 allowed and exactly 5 rows (round ${round})`, async () => {
      const b = `${PREFIX}-burst20-r${round}`;
      const res = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(b, 5, 60_000)));
      const allowed = res.filter((r) => r.allowed).length;
      const n = await rows(b);
      rowsWritten += n;
      const refusedRetry = res.filter((r) => !r.allowed).map((r) => r.retryAfterSeconds);
      out[`burst20_r${round}`] = { allowed, rows: n, refusedRetryMin: Math.min(...refusedRetry), refusedRetryMax: Math.max(...refusedRetry) };
      expect({ allowed, rows: n }).toEqual({ allowed: 5, rows: 5 });
      for (const s of refusedRetry) {
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(60);
      }
    });
  }

  it("two buckets bursting at once do not borrow from each other (10 + 10 parallel, max 5 each)", async () => {
    const a = `${PREFIX}-pair-a`;
    const c = `${PREFIX}-pair-b`;
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => checkRateLimit(i % 2 ? a : c, 5, 60_000).then((r) => [i % 2, r.allowed] as const)));
    const okA = res.filter(([k, ok]) => k === 1 && ok).length;
    const okB = res.filter(([k, ok]) => k === 0 && ok).length;
    const nA = await rows(a);
    const nB = await rows(c);
    rowsWritten += nA + nB;
    out.pair = { okA, okB, rowsA: nA, rowsB: nB };
    expect({ okA, okB, nA, nB }).toEqual({ okA: 5, okB: 5, nA: 5, nB: 5 });
  });

  it("the window slides: refused at the limit, allowed again once the window has passed", async () => {
    const b = `${PREFIX}-window`;
    const first = [await checkRateLimit(b, 2, 1_500), await checkRateLimit(b, 2, 1_500), await checkRateLimit(b, 2, 1_500)];
    await new Promise((r) => setTimeout(r, 1_800));
    const after = await checkRateLimit(b, 2, 1_500);
    const n = await rows(b);
    rowsWritten += n;
    out.window = { first: first.map((r) => r.allowed), after: after.allowed, rows: n };
    expect(first.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(after.allowed).toBe(true);
    expect(n).toBe(3);
  });
});
