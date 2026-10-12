/**
 * SF-120 (review R7-N2) — lib/rate-limit.ts logs the bucket FAMILY and counts, never the key (security campaign
 * iteration 2, lane M1 v2, 10 Oct 2026).
 *
 * The over-limit warning on a DATABASE answer used to print the whole bucket, so a burst on a forgot-password,
 * TOTP-recover or magic-link bucket wrote the e-mail address into the logs, and an IP-keyed bucket wrote the IP.
 * Here a 120-request burst on an e-mail-keyed and on an IP-keyed bucket (max 5) must produce log lines that carry
 * the family and the counts, and contain neither the address/IP nor any 8-character piece of it, of the full key,
 * or of a SHA-256 digest of either. A store-failure burst on the same buckets is checked the same way, and a static
 * check pins that no console call in the module interpolates the bucket.
 *
 * Lane M2 (10 Oct 2026, SF-130 / R8 residual): the static check used to match only a literal `${bucket}`, so R8's
 * fourth mutant (`k=${bucket.split(":").slice(1).join(":")}` on the store-failure path) passed it. It now parses the
 * module with the TypeScript compiler and refuses ANY use of the `bucket` or `key` identifier inside a console call's
 * arguments — interpolation, concatenation, method call, property access — except as the argument of
 * bucketFamily(…). A planted-snippet control proves each shape is caught.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Every use of `bucket`/`key` inside a console.<level>(…) call that is not exactly bucketFamily(bucket). */
function consoleKeyUses(text: string): { calls: number; uses: string[] } {
  const sf = ts.createSourceFile("rate-limit.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let calls = 0;
  const uses: string[] = [];
  const isConsoleCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === "console";
  const inArgs = (n: ts.Node) => {
    if (ts.isIdentifier(n) && (n.text === "bucket" || n.text === "key")) {
      const p = n.parent;
      const familyOnly =
        ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "bucketFamily" && p.arguments.length === 1;
      if (!familyOnly) uses.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${p.getText(sf).slice(0, 60)}`);
    }
    ts.forEachChild(n, inArgs);
  };
  const visit = (n: ts.Node) => {
    if (isConsoleCall(n)) {
      calls++;
      for (const a of n.arguments) inArgs(a);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, uses };
}

type Op = { kind: "lock" | "insert"; values: unknown[] };
const h = vi.hoisted(() => ({ mode: "ok" as "ok" | "down", rows: new Map<string, number>() }));

vi.mock("@/lib/prisma", () => {
  const tag = (kind: "lock" | "insert") => (_s: TemplateStringsArray, ...values: unknown[]): Op => ({ kind, values });
  const runOps = async (ops: Op[]) => {
    if (h.mode !== "ok") throw down();
    const insert = ops.find((o) => o.kind === "insert")!;
    const bucket = insert.values[0] as string;
    const max = insert.values[4] as number;
    const n = h.rows.get(bucket) ?? 0;
    const inserted = n < max ? 1 : 0;
    if (inserted) h.rows.set(bucket, n + 1);
    return ops.map((o) => (o.kind === "insert" ? [{ count: n, inserted, oldestAgeMs: 1_000 }] : 1));
  };
  const down = () => Object.assign(new Error("connect ECONNREFUSED (secm1 fake)"), { code: "ECONNREFUSED" });
  return {
    prisma: {
      rateLimitHit: {
        groupBy: async ({ where }: { where: { bucket: string } }) => {
          if (h.mode === "down") throw down();
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

const EMAIL = "secm1.burst-victim@example.test";
const IP = "203.0.113.177";
const BUCKETS = [
  { name: "e-mail-keyed (forgot-password)", bucket: `forgot:${EMAIL}`, secret: EMAIL, family: "forgot" },
  { name: "IP-keyed (login)", bucket: `login:${IP}`, secret: IP, family: "login" },
];

let lines: string[] = [];

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

/** Every 8-character window of the secret, the full key, and the hex SHA-256 of each (whole string when shorter). */
function forbiddenPieces(secret: string, bucket: string): string[] {
  const out = new Set<string>();
  for (const s of [secret, bucket, sha256(secret), sha256(bucket), sha256(secret.toLowerCase())]) {
    if (s.length <= 8) out.add(s);
    for (let i = 0; i + 8 <= s.length; i++) out.add(s.slice(i, i + 8));
  }
  return [...out];
}

async function load() {
  vi.resetModules();
  return (await import("@/lib/rate-limit")).checkRateLimit;
}

beforeEach(() => {
  h.mode = "ok";
  h.rows = new Map();
  lines = [];
  vi.useFakeTimers({ now: new Date("2026-10-10T20:00:00Z"), toFake: ["Date"] });
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SF-120: rate-limit log lines carry the family and counts only", () => {
  for (const b of BUCKETS) {
    it(`a 120-request burst on an ${b.name} bucket: 5 allowed, 115 refusals logged by family, no piece of the key`, async () => {
      const checkRateLimit = await load();
      let allowed = 0;
      for (let i = 0; i < 120; i++) if ((await checkRateLimit(b.bucket, 5, 60_000)).allowed) allowed++;
      expect(allowed).toBe(5);

      const joined = lines.join("\n");
      const leaked = forbiddenPieces(b.secret, b.bucket).filter((p) => joined.includes(p));
      expect(leaked.length, "no 8-character piece of the address/IP, the key, or their digests").toBe(0);

      // Positive control: the refusals are still visible, with the family and the counts.
      const overLimit = lines.filter((l) => l.includes("[rate-limit]"));
      expect(overLimit.length).toBe(115);
      for (const l of overLimit) {
        expect(l).toContain(`family=${b.family}`);
        expect(l).toMatch(/max=5\b/);
        expect(l).toMatch(/windowMs=60000\b/);
      }
    });

    it(`a store-failure burst on the same ${b.name} bucket logs the family only`, async () => {
      const checkRateLimit = await load();
      h.mode = "down";
      for (let i = 0; i < 120; i++) await checkRateLimit(b.bucket, 5, 60_000);
      expect(lines.some((l) => l.includes(`family=${b.family}`))).toBe(true);
      const joined = lines.join("\n");
      expect(forbiddenPieces(b.secret, b.bucket).filter((p) => joined.includes(p)).length).toBe(0);
    });
  }

  it("static: no console call in lib/rate-limit.ts interpolates the bucket or the key", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/rate-limit.ts"), "utf8");
    const { calls, uses } = consoleKeyUses(src);
    expect(calls).toBeGreaterThan(0);
    expect(uses).toEqual([]);
  });

  it("static control (lane M2): every way of putting the bucket or key into a console call is caught", () => {
    const bad = [
      "console.warn(`x ${bucket}`);",
      'console.error(`k=${bucket.split(":").slice(1).join(":")}`);', // R8's fourth mutant (R8-MC2)
      'console.info("b=" + bucket);',
      "console.log(`${String(bucket)}`);",
      "console.warn(`${key}`);",
      "console.debug({ bucket });",
      "console.error(`f=${bucketFamily(bucket)} k=${bucket.slice(7)}`);",
    ];
    for (const b of bad) expect(consoleKeyUses(b).uses.length, b).toBeGreaterThan(0);
    const ok = ['console.warn(`[rate-limit] family=${bucketFamily(bucket)} bucket over limit`);', 'console.error("bucket key never logged", family);'];
    for (const g of ok) expect(consoleKeyUses(g), g).toEqual({ calls: 1, uses: [] });
  });
});
