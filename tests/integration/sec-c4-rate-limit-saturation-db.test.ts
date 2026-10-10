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
  for (const c of cases) {
    it(`${c.cls} bucket, burst of ${c.burst} on ONE bucket, max 5 → exactly 5 allowed, each with its row; one fallback log, no key`, async () => {
      touched.push(c.bucket);
      const errs = vi.spyOn(console, "error").mockImplementation(() => {});
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t0 = performance.now();
      const res = await Promise.all(Array.from({ length: c.burst }, () => checkRateLimit(c.bucket, 5, 60_000)));
      const ms = Math.round(performance.now() - t0);
      const lines = [...errs.mock.calls, ...warns.mock.calls].map((a) => a.map(String).join(" "));
      errs.mockRestore();
      warns.mockRestore();
      const allowed = res.filter((r) => r.allowed).length;
      const refused = res.filter((r) => !r.allowed);
      const rows = await prisma.rateLimitHit.count({ where: { bucket: c.bucket } });
      const fallbackLines = lines.filter((l) => l.includes(FALLBACK_LOG) && l.includes(`family=${c.family}`));
      const r = {
        cls: c.cls, burst: c.burst, allowed, rows, allowedWithoutRow: allowed - rows, ms,
        fallbackLogLines: fallbackLines.length, fallbackLog: fallbackLines[0]?.replace(KEY, "<KEY>") ?? null,
      };
      (out.results as unknown[]).push(r);
      expect(allowed, JSON.stringify(r)).toBe(5);
      expect(rows, JSON.stringify(r)).toBe(5);
      expect(refused.every((x) => x.retryAfterSeconds >= 1), JSON.stringify(r)).toBe(true);
      // The key never reaches the fallback log; the class and family do.
      expect(lines.filter((l) => l.includes(FALLBACK_LOG) && l.includes(KEY))).toEqual([]);
      // The burst MUST saturate the pool for this test to mean anything (R6 saw it on every run at pool 5), and the
      // limiter's own line is the observable: Prisma prints its "Unable to start a transaction" through a console
      // reference captured at load, out of reach of the spy. Once per window per class/family: the first burst on a
      // family logs exactly one line however many calls failed; the second tenant-lookup burst, inside that
      // window, logs none.
      const expected = loggedFamilies.has(c.family) ? 0 : 1;
      expect(fallbackLines.length, JSON.stringify(r)).toBe(expected);
      if (expected) {
        expect(fallbackLines[0]).toContain(`class=${c.cls}`);
        // A security bucket is refused outright; only the non-security class reaches the (seeded) memory store.
        expect(fallbackLines[0]).toContain(c.cls === "security" ? "outcome=refused" : "outcome=memory-fallback");
      }
      if (fallbackLines.length) loggedFamilies.add(c.family);
    }, 180_000);
  }
});
