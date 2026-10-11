// SF-40 / review R6-N3 on Postgres — security campaign iteration 2, lane C4, 10 Oct 2026.
// Adopted from reviewer R6's probe zz-r6-c3-saturation-db (docs/security/evidence/R6/).
//
// The C3 limiter is exact while the database answers. But every allowed-path caller holds a pooled connection for
// the length of its transaction while it queues on the bucket's advisory lock, so a burst on ONE bucket saturates
// the production pool (max 5 per instance, lib/prisma.ts): the rest wait for a connection, Prisma's transaction
// start times out ("Unable to start a transaction in the given time"), and checkRateLimit used to catch that and
// answer from the per-process memory store — which had never seen the 5 database hits and allowed 5 more. R6
// measured 10 allowed against max 5 (5 rows + 5 from memory), both roles, with the production pool and the test
// pool, and nothing logged but Prisma's own error line.
//
// The pool is capped at the PRODUCTION size here (NODE_ENV=production → prismaPoolConfig().max === 5, asserted).
// Bursts of 60 and 120 against max 5:
//   - a security bucket (the default class): exactly 5 allowed, every allowance has its row;
//   - an explicitly non-security bucket ("tenant-lookup:"): the memory fallback is seeded FULL for the window, so it
//     adds no capacity — exactly 5 allowed, every allowance has its row;
//   - the store failure is logged ONCE per window per bucket class/family, and the log never carries the key.
//
// TEST branch only, through the guarded runners (owner, and matflow_app with RLS_ENFORCED=1). Every bucket carries
// this run's secc4 prefix; teardown deletes exactly those rows and checks the count.
//
// SF-136 (lane L1, cycle 2, 11 Oct 2026): checkDbRateLimit no longer lets Prisma abandon a transaction start after 2 s
// (that discard returned the client to the pool inside its BEGIN — a lost write); a caller now waits for the pool's own
// 10 s deadline. A burst of 60 at pool 5 therefore usually finishes inside that deadline WITHOUT any store failure, so
// "the burst saturates the pool" can no longer be assumed. The saturation is now FORCED and verified: phase 1 holds
// all five pool connections in the test's own open transactions while the burst runs, so every call must meet the
// pool deadline — the burst is asserted to have been refused entirely (0 allowed, 0 rows) and the fallback line is the
// observable; phase 2 releases the pool and runs the same burst again — exactly 5 allowed, each with its row, which is
// the R6 property (a store failure never adds capacity: the memory store gave nothing extra in phase 1, and the
// database decides in phase 2).
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";

vi.hoisted(() => {
  // Production pool size (5) — the configuration R6 measured the overshoot on.
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.AUTH_SECRET ??= "secc4-saturation-synthetic-0123456789abcdef0123456789";
});

import { prisma, prismaPoolConfig } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const ON_TEST_BRANCH = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const KEY = `secc4-${ROLE}-${STAMP}`;
const out: Record<string, unknown> = { role: ROLE, nodeEnv: process.env.NODE_ENV, results: [] as unknown[] };
const ownBucket = (b: string) => b.includes(KEY);
const FALLBACK_LOG = "[rate-limit] store unavailable";

describe.skipIf(!ON_TEST_BRANCH)(`SF-40 / R6-N3: rate limit when the burst saturates the production-size pool (${ROLE})`, () => {
  const touched: string[] = [];
  const loggedFamilies = new Set<string>();

  beforeAll(() => {
    expect(prismaPoolConfig().max).toBe(5);
  });

  afterAll(async () => {
    let deleted = 0;
    for (const b of touched) deleted += (await prisma.rateLimitHit.deleteMany({ where: { bucket: b } })).count;
    const left = await prisma.rateLimitHit.count({ where: { bucket: { contains: KEY } } });
    out.teardown = { buckets: touched.length, deleted, left };
    console.log("C4-SAT " + JSON.stringify(out));
    if (process.env.C4_OUT) writeFileSync(process.env.C4_OUT, JSON.stringify(out, null, 1));
    expect(touched.every(ownBucket)).toBe(true);
    expect(left).toBe(0);
  });

  it("positive control: store healthy, sequential — five allowed, the sixth refused, five rows", async () => {
    const bucket = `secc4ctl:${KEY}`;
    touched.push(bucket);
    const v = [];
    for (let i = 0; i < 6; i++) v.push((await checkRateLimit(bucket, 5, 60_000)).allowed);
    expect(v).toEqual([true, true, true, true, true, false]);
    expect(await prisma.rateLimitHit.count({ where: { bucket } })).toBe(5);
  });

  const cases = [
    { burst: 60, cls: "security", family: "secc4s60", bucket: `secc4s60:${KEY}` },
    { burst: 120, cls: "security", family: "secc4s120", bucket: `secc4s120:${KEY}` },
    { burst: 60, cls: "non-security", family: "tenant-lookup", bucket: `tenant-lookup:${KEY}-60` },
    { burst: 120, cls: "non-security", family: "tenant-lookup", bucket: `tenant-lookup:${KEY}-120` },
  ];
  /** Holds all five pool connections in the test's own open transactions until released. */
  async function saturatePool(): Promise<() => Promise<void>> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready: Promise<void>[] = [];
    const held: Promise<unknown>[] = [];
    for (let i = 0; i < prismaPoolConfig().max; i++) {
      let up!: () => void;
      const isUp = new Promise<void>((r) => (up = r));
      const h = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        up();
        await gate;
      }, { maxWait: 60_000, timeout: 120_000 });
      held.push(h);
      // A holder that cannot take its connection fails the cell here, visibly, instead of leaving it waiting.
      ready.push(Promise.race([isUp, h.then(() => { throw new Error("a holder finished before the pool was saturated"); })]));
    }
    try {
      await Promise.all(ready);
    } catch (e) {
      release();
      await Promise.allSettled(held);
      throw e;
    }
    return async () => {
      release();
      await Promise.all(held);
    };
  }

  for (const c of cases) {
    it(`${c.cls} bucket, burst of ${c.burst} on ONE bucket, max 5: with the pool forced saturated nothing is allowed; once free exactly 5 allowed, each with its row; one fallback log, no key`, async () => {
      touched.push(c.bucket);
      const errs = vi.spyOn(console, "error").mockImplementation(() => {});
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t0 = performance.now();
      // Phase 1 — saturation forced and verified, not assumed.
      const unsaturate = await saturatePool();
      const res1 = await Promise.all(Array.from({ length: c.burst }, () => checkRateLimit(c.bucket, 5, 60_000)));
      const ms1 = Math.round(performance.now() - t0);
      await unsaturate();
      const rows1 = await prisma.rateLimitHit.count({ where: { bucket: c.bucket } });
      // Phase 2 — the store answers again: the same burst.
      const t1 = performance.now();
      const res2 = await Promise.all(Array.from({ length: c.burst }, () => checkRateLimit(c.bucket, 5, 60_000)));
      const ms2 = Math.round(performance.now() - t1);
      const lines = [...errs.mock.calls, ...warns.mock.calls].map((a) => a.map(String).join(" "));
      errs.mockRestore();
      warns.mockRestore();
      const res = [...res1, ...res2];
      const allowed1 = res1.filter((r) => r.allowed).length;
      const allowed = res.filter((r) => r.allowed).length;
      const refused = res.filter((r) => !r.allowed);
      const rows = await prisma.rateLimitHit.count({ where: { bucket: c.bucket } });
      const fallbackLines = lines.filter((l) => l.includes(FALLBACK_LOG) && l.includes(`family=${c.family}`));
      const r = {
        cls: c.cls, burst: c.burst, saturatedPhase: { allowed: allowed1, rows: rows1, ms: ms1 }, freePhase: { ms: ms2 },
        allowed, rows, allowedWithoutRow: allowed - rows,
        fallbackLogLines: fallbackLines.length, fallbackLog: fallbackLines[0]?.replace(KEY, "<KEY>") ?? null,
      };
      (out.results as unknown[]).push(r);
      // The saturation took effect: with every connection held past the pool deadline nothing got through — not from
      // the database and not from the memory store.
      expect({ allowed: allowed1, rows: rows1 }, JSON.stringify(r)).toEqual({ allowed: 0, rows: 0 });
      expect(allowed, JSON.stringify(r)).toBe(5);
      expect(rows, JSON.stringify(r)).toBe(5);
      expect(refused.every((x) => x.retryAfterSeconds >= 1), JSON.stringify(r)).toBe(true);
      // The key never reaches the fallback log; the class and family do.
      expect(lines.filter((l) => l.includes(FALLBACK_LOG) && l.includes(KEY))).toEqual([]);
      // The limiter's own line is the observable of the store failure (Prisma's own error line goes through a console
      // reference captured at load, out of reach of the spy). Once per window per class/family: the first burst on a
      // family logs exactly one line however many calls failed; the second tenant-lookup burst, inside that window,
      // logs none.
      const expected = loggedFamilies.has(c.family) ? 0 : 1;
      expect(fallbackLines.length, JSON.stringify(r)).toBe(expected);
      if (expected) {
        expect(fallbackLines[0]).toContain(`class=${c.cls}`);
        // A security bucket is refused outright; only the non-security class reaches the (seeded) memory store.
        expect(fallbackLines[0]).toContain(c.cls === "security" ? "outcome=refused" : "outcome=memory-fallback");
      }
      if (fallbackLines.length) loggedFamilies.add(c.family);
    }, 240_000);
  }
});
