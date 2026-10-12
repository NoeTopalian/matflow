/**
 * SF-40 / review R6-N3 — what checkRateLimit does when its shared store cannot answer (security campaign
 * iteration 2, lane C4, 10 Oct 2026). The behaviour under a REAL pool saturation (bursts of 60 and 120 against
 * max 5 with the production pool size → exactly 5 allowed, both roles) is proved on Postgres by
 * tests/integration/sec-c4-rate-limit-saturation-db.test.ts; this file pins the rules without a database:
 *  - a security bucket (every bucket but the two non-security prefixes) is REFUSED on a store failure, with a
 *    short Retry-After, and is never answered from memory — even after a whole window of continuous outage;
 *  - a non-security bucket falls back to memory seeded FULL for any window this instance did not watch from its
 *    start, so the fallback never adds capacity;
 *  - every store failure is logged once per window per (class, family); the key never appears;
 *  - failClosed callers still get the original error;
 *  - every call site's bucket starts with a literal `family:` segment, so the family never carries a key.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Op = { kind: "lock" | "insert"; values: unknown[] };
const h = vi.hoisted(() => ({
  mode: "ok" as "ok" | "pool-timeout" | "down",
  rows: new Map<string, number>(),
}));

function storeError(): Error {
  if (h.mode === "pool-timeout") {
    return Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" });
  }
  return Object.assign(new Error("connect ECONNREFUSED (secc4 fake)"), { code: "ECONNREFUSED" });
}

vi.mock("@/lib/prisma", () => {
  const tag = (kind: "lock" | "insert") => (_s: TemplateStringsArray, ...values: unknown[]): Op => ({ kind, values });
  const runOps = async (ops: Op[]) => {
    if (h.mode !== "ok") throw storeError();
    const insert = ops.find((o) => o.kind === "insert")!;
    const bucket = insert.values[0] as string;
    const max = insert.values[4] as number;
    const n = h.rows.get(bucket) ?? 0;
    const inserted = n < max ? 1 : 0;
    if (inserted) h.rows.set(bucket, n + 1);
    return ops.map((o) => (o.kind === "insert" ? [{ count: n, inserted, oldestAgeMs: 1_000 }] : 1));
  };
  return {
    prisma: {
      rateLimitHit: {
        groupBy: async ({ where }: { where: { bucket: string } }) => {
          if (h.mode === "down") throw storeError();
          const n = h.rows.get(where.bucket) ?? 0;
          return n ? [{ bucket: where.bucket, _count: { _all: n }, _min: { hitAt: new Date(Date.now() - 1_000) } }] : [];
        },
        deleteMany: async () => ({ count: 0 }),
      },
      $executeRaw: tag("lock"),
      $queryRaw: tag("insert"),
      $transaction: async (arg: Op[] | ((tx: unknown) => Promise<unknown>)) => {
        // SF-135 (lane L1): checkRateLimit runs the same two statements in an INTERACTIVE transaction now (its bounds are
        // owned there, not by Prisma's timer). The callback's statements are recorded as the same ops and answered by
        // the same rules below; nothing asserted about them changes.
        if (typeof arg === "function") {
          const recorded: Op[] = [];
          return arg({
            $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (recorded.push(tag("lock")(s, ...v)), 1),
            $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
              recorded.push(tag("insert")(s, ...v));
              const out = (await runOps(recorded)) as unknown[];
              return out[out.length - 1];
            },
          });
        }
        return runOps(arg);
      },
    },
  };
});

const WINDOW = 60_000;
let errors: string[] = [];

async function load() {
  vi.resetModules();
  return (await import("@/lib/rate-limit")).checkRateLimit;
}

beforeEach(() => {
  h.mode = "ok";
  h.rows = new Map();
  errors = [];
  vi.useFakeTimers({ now: new Date("2026-10-10T10:00:00Z"), toFake: ["Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const storeLines = () => errors.filter((l) => l.startsWith("[rate-limit] store unavailable"));

describe("security buckets: a store failure is a refusal, never memory", () => {
  it("positive control: store healthy → five allowed, the sixth refused", async () => {
    const check = await load();
    const v = [];
    for (let i = 0; i < 6; i++) v.push((await check("login:ip:198.51.100.7", 5, WINDOW)).allowed);
    expect(v).toEqual([true, true, true, true, true, false]);
  });

  it("pool / transaction-start timeout: every call refused with Retry-After 1..30 s", async () => {
    const check = await load();
    h.mode = "pool-timeout";
    const res = await Promise.all(Array.from({ length: 20 }, () => check("admin:login:198.51.100.7", 5, 15 * 60_000)));
    expect(res.filter((r) => r.allowed)).toHaveLength(0);
    for (const r of res) {
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(r.retryAfterSeconds).toBeLessThanOrEqual(30);
    }
  });

  it("still refused after a whole window of continuous outage (memory would have reopened by now)", async () => {
    const check = await load();
    h.mode = "down";
    expect((await check("upload:image:user:secc4-u", 5, WINDOW)).allowed).toBe(false);
    vi.setSystemTime(Date.now() + WINDOW + 1_000);
    const later = [];
    for (let i = 0; i < 6; i++) later.push((await check("upload:image:user:secc4-u", 5, WINDOW)).allowed);
    expect(later).toEqual([false, false, false, false, false, false]);
  });

  it("once the store answers again, the database decides (no stale memory refusal)", async () => {
    const check = await load();
    h.mode = "down";
    expect((await check("totp:secc4-token", 5, WINDOW)).allowed).toBe(false);
    h.mode = "ok";
    expect((await check("totp:secc4-token", 5, WINDOW)).allowed).toBe(true);
  });

  it("failClosed callers get the original error back", async () => {
    const check = await load();
    h.mode = "pool-timeout";
    await expect(check("apply:198.51.100.7", 5, WINDOW, { failClosed: true })).rejects.toThrow(/Unable to start a transaction/);
    expect(storeLines()[0]).toContain("outcome=thrown");
  });
});

describe("non-security buckets: the memory fallback is seeded FULL and adds no capacity", () => {
  it("inside the window the outage began in: every call refused, Retry-After = the rest of that window", async () => {
    const check = await load();
    h.mode = "pool-timeout";
    const res = [];
    for (let i = 0; i < 10; i++) res.push(await check("tenant-lookup:198.51.100.7", 5, WINDOW));
    expect(res.filter((r) => r.allowed)).toHaveLength(0);
    expect(res[0].retryAfterSeconds).toBe(60);
  });

  it("after a whole window of continuous outage, memory counts from zero: max allowed, then refused", async () => {
    const check = await load();
    h.mode = "down";
    expect((await check("kiosk:classes:abcdef012345:198.51.100.7", 5, WINDOW)).allowed).toBe(false);
    vi.setSystemTime(Date.now() + WINDOW + 1_000);
    const v = [];
    for (let i = 0; i < 6; i++) v.push((await check("kiosk:classes:abcdef012345:198.51.100.7", 5, WINDOW)).allowed);
    expect(v).toEqual([true, true, true, true, true, false]);
  });

  it("a window counted in an EARLIER outage is not reused after the store recovered and failed again", async () => {
    const check = await load();
    const b = "tenant-lookup:203.0.113.9";
    h.mode = "down";
    await check(b, 5, WINDOW);
    vi.setSystemTime(Date.now() + WINDOW + 1_000);
    expect((await check(b, 5, WINDOW)).allowed).toBe(true); // memory window #2, count 1
    h.mode = "ok";
    expect((await check("login:ip:203.0.113.10", 5, WINDOW)).allowed).toBe(true); // the store answers again
    vi.setSystemTime(Date.now() + 1_000);
    h.mode = "down";
    // Hits other instances wrote while the store was up are invisible here: seeded full again.
    expect((await check(b, 5, WINDOW)).allowed).toBe(false);
  });
});

describe("store-failure logging: once per window per (class, family), never the key", () => {
  it("a burst logs one line with class, family and reason; the key and the IP are absent", async () => {
    const check = await load();
    h.mode = "pool-timeout";
    await Promise.all(Array.from({ length: 30 }, () => check("forgot:secc4-club:someone@example.test", 3, WINDOW)));
    const lines = storeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=pool-timeout");
    expect(lines[0]).toContain("class=security");
    expect(lines[0]).toContain("family=forgot");
    expect(lines[0]).toContain("outcome=refused");
    expect(lines[0]).not.toMatch(/secc4-club|someone@example\.test/);
    expect(errors.join("\n")).not.toContain("someone@example.test");
  });

  it("the next window logs again and reports how many failures the previous line stood for", async () => {
    const check = await load();
    h.mode = "down";
    for (let i = 0; i < 4; i++) await check("kiosk:checkin:abcdef012345:198.51.100.7", 30, WINDOW);
    vi.setSystemTime(Date.now() + WINDOW + 1);
    await check("kiosk:checkin:abcdef012345:198.51.100.7", 30, WINDOW);
    const lines = storeLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("reason=unreachable");
    expect(lines[1]).toContain("suppressedSinceLast=3");
    expect(lines.join("\n")).not.toMatch(/abcdef012345|198\.51\.100\.7/);
  });

  it("a non-security fallback is logged with its class and the memory outcome", async () => {
    const check = await load();
    h.mode = "pool-timeout";
    await check("tenant-lookup:198.51.100.7", 5, WINDOW);
    expect(storeLines()).toEqual([expect.stringContaining("class=non-security family=tenant-lookup outcome=memory-fallback")]);
  });
});

describe("inventory: which buckets are non-security, and every family is a literal", () => {
  it("only tenant-lookup: and kiosk:classes: fall back to memory; look-alikes and every other door refuse", async () => {
    const check = await load();
    h.mode = "down";
    const longWindow = 15 * 60_000;
    const retry = async (b: string) => (await check(b, 5, longWindow)).retryAfterSeconds;
    // Seeded-full memory answers with the rest of the window (900 s); a security refusal with ≤ 30 s.
    expect(await retry("tenant-lookup:198.51.100.7")).toBe(900);
    expect(await retry("kiosk:classes:abcdef012345:198.51.100.7")).toBe(900);
    for (const b of [
      "kiosk:checkin:abcdef012345:198.51.100.7",
      "kiosk:lookup:abcdef012345:198.51.100.7",
      "waiver:kiosk-status:198.51.100.7",
      "tenant-lookupx:198.51.100.7",
      "login:ip:198.51.100.7",
      "admin:login:198.51.100.7",
      "upload:image:user:secc4-u",
      "cron:auth:198.51.100.7",
    ]) {
      expect(await retry(b), b).toBeLessThanOrEqual(30);
    }
  });

  it("every checkRateLimit call site in app/, lib/ and auth.ts builds its bucket with a literal family: prefix", () => {
    const root = process.cwd();
    const files: string[] = ["auth.ts"];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk("app");
    walk("lib");
    const bad: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of src.matchAll(/checkRateLimit\(\s*(`[^`]*`|[A-Za-z_$][\w$]*)/g)) {
        sites++;
        let arg = m[1];
        if (!arg.startsWith("`")) {
          if (arg === "bucket" && f === "lib/rate-limit.ts") continue; // the definition itself
          const def = src.match(new RegExp(`const ${arg}\\s*=\\s*(\`[^\`]*\`)`));
          if (!def) { bad.push(`${f}: ${arg} (not a local template literal)`); continue; }
          arg = def[1];
        }
        const literal = arg.slice(1).split("${")[0];
        if (!/^[a-z][a-z0-9-]*:/.test(literal)) bad.push(`${f}: ${arg.slice(0, 40)}`);
      }
    }
    expect(sites).toBeGreaterThan(60);
    expect(bad).toEqual([]);
  });
});
