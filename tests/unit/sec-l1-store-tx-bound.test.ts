/**
 * SF-135 (lane L1, 11 Oct 2026) — the shape CI can check without a database. The behaviour (a stalled-then-dropped
 * connection under the transaction is a refusal, nothing unhandled, the bound is server-side and transaction-local) is
 * proved on Postgres under both roles by tests/integration/sec-l1-connection-drop-db.test.ts; this file pins:
 *  - both transactions (checkRateLimit's and the lockout reservation's) are INTERACTIVE, their lock statement sets
 *    lock_timeout and statement_timeout with set_config(…, true) — transaction-local, never session — to the declared
 *    bound, inside a MATERIALIZED CTE that runs before the lock is requested;
 *  - Prisma's transaction timeout AND maxWait are beyond the bound (plus the pool's own connection deadline), so
 *    Prisma's timer is never what ends the transaction and Prisma never abandons a half-finished start (SF-136);
 *  - cycle 2: lib/prisma-tenant.ts (withTenantContext / withRlsBypass) is bounded the same way, in its first statement,
 *    with the caller's budget kept as a typed refusal to commit; and no other code opens a transaction;
 *  - a failed reservation is THROWN as LockoutReservationError with a reason and one log line without the address,
 *    the network or the key — including an unexpected failure (it is never turned into a quiet answer);
 *  - a failed rate-limit transaction on a security bucket is a refusal, logged with the reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Tx = { $executeRaw: (...a: unknown[]) => Promise<unknown>; $queryRaw: (...a: unknown[]) => Promise<unknown> };
const h = vi.hoisted(() => ({
  fail: null as null | (() => unknown),
  options: [] as Array<{ maxWait?: number; timeout?: number } | undefined>,
  sql: [] as string[],
}));

vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  const count = async () => 0;
  return {
    ...real,
    prisma: {
      rateLimitHit: { count, groupBy: async () => [], deleteMany: async () => ({ count: 0 }) },
      $transaction: async (fn: (tx: Tx) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) => {
        h.options.push(options);
        if (typeof fn !== "function") throw new Error("expected an interactive transaction");
        return fn({
          $executeRaw: async (s: unknown) => {
            h.sql.push((s as string[]).join("?"));
            if (h.fail) throw h.fail();
            return 1;
          },
          $queryRaw: async (s: unknown) => {
            h.sql.push((s as string[]).join("?"));
            const text = (s as string[]).join("?");
            return text.includes("pairCount") ? [{ pairCount: 0, addrCount: 0, inserted: 2 }] : [{ count: 0, inserted: 1, oldestAgeMs: null }];
          },
        });
      },
    },
  };
});

import { POOL_CONNECTION_TIMEOUT_MS } from "@/lib/prisma";
import { checkRateLimit, STORE_TX_BOUND_MS } from "@/lib/rate-limit";
import { lockoutKeys, lockoutState, LockoutReservationError, RESERVE_TX_BOUND_MS } from "@/lib/auth-lockout";
import {
  withTenantContext,
  withRlsBypass,
  TenantTransactionBudgetError,
  TENANT_STATEMENT_BOUND_MS,
  TENANT_STATEMENT_BOUND_EXTENDED_MS,
  TENANT_LOCK_BOUND_MS,
  TENANT_LOCK_BOUND_EXTENDED_MS,
} from "@/lib/prisma-tenant";
import path from "node:path";
import fs from "node:fs";

const EMAIL = "secl1-unit@example.test";
const IP = "192.0.2.55";
let logs: string[] = [];

beforeEach(() => {
  h.fail = null;
  h.options = [];
  h.sql = [];
  logs = [];
  for (const m of ["error", "warn"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});

function lockStatementOf(file: string, fnStart: string): string {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf(fnStart);
  expect(i, `${fnStart} in ${file}`).toBeGreaterThanOrEqual(0);
  const m = src.slice(i).match(/\$executeRaw`([^`]*)`/);
  expect(m, `the lock statement in ${fnStart}`).not.toBeNull();
  return m![1];
}

describe("the bound is the transaction's own, server-side and transaction-local", () => {
  for (const [file, fn, bound] of [
    ["lib/rate-limit.ts", "async function checkDbRateLimit(", STORE_TX_BOUND_MS],
    ["lib/auth-lockout.ts", "function reserveTx(", RESERVE_TX_BOUND_MS],
  ] as const) {
    it(`${file}: lock_timeout and statement_timeout = ${bound} ms, set_config(…, true), in a MATERIALIZED CTE before the lock`, () => {
      const sql = lockStatementOf(file, fn);
      expect(sql).toMatch(/^WITH bound AS MATERIALIZED \(SELECT /);
      expect(sql).toContain(`set_config('lock_timeout', '${bound}ms', true)`);
      expect(sql).toContain(`set_config('statement_timeout', '${bound}ms', true)`);
      expect(sql, "never a session-level setting on a pooled connection").not.toMatch(/,\s*false\s*\)|SET\s+(SESSION\s+)?(lock|statement)_timeout/i);
      expect(sql).toMatch(/SELECT pg_advisory_xact_lock\(.*\) FROM bound$/);
    });
  }

  it("Prisma's timeout and maxWait are out of reach of the bounds (both transactions, interactive)", async () => {
    await checkRateLimit("secl1u:rl", 5, 60_000);
    await lockoutState(lockoutKeys("secl1-club", EMAIL, IP), async () => false);
    expect(h.options).toHaveLength(2);
    for (const [o, bound] of [[h.options[0], STORE_TX_BOUND_MS], [h.options[1], RESERVE_TX_BOUND_MS]] as const) {
      // The timer starts after BEGIN: the lock wait + the insert + COMMIT, each bounded, all well inside Prisma's limit
      // (with the pool deadline added for good measure).
      expect(o?.timeout).toBeGreaterThan(POOL_CONNECTION_TIMEOUT_MS + 3 * bound);
      expect(o?.timeout).toBeLessThanOrEqual(2_147_483_647); // a larger Node timer delay would fire at once
    }
    // SF-136: Prisma never abandons a start; the pool's own deadline bounds the wait for a connection.
    for (const o of h.options) expect(o?.maxWait).toBeGreaterThan(POOL_CONNECTION_TIMEOUT_MS + 3 * RESERVE_TX_BOUND_MS);
  });
});

describe("cycle 2: tenant transactions own their bound (lib/prisma-tenant.ts)", () => {
  const first = () => h.sql[0];
  for (const [name, run] of [
    ["withTenantContext", (opts?: { timeout?: number }) => withTenantContext("tenant-A", async () => "ok", opts)],
    ["withRlsBypass", (opts?: { timeout?: number }) => withRlsBypass(async () => "ok", opts)],
  ] as const) {
    it(`${name}: default budget → the FIRST statement sets statement_timeout = ${TENANT_STATEMENT_BOUND_MS} ms and lock_timeout = ${TENANT_LOCK_BOUND_MS} ms (below it; R10-5), transaction-local`, async () => {
      await run();
      expect(first()).toContain(`set_config('lock_timeout', '${TENANT_LOCK_BOUND_MS}ms', true)`);
      expect(TENANT_LOCK_BOUND_MS).toBeLessThan(TENANT_STATEMENT_BOUND_MS);
      expect(first()).toContain(`set_config('statement_timeout', '${TENANT_STATEMENT_BOUND_MS}ms', true)`);
      expect(first(), "the bypass setting stays in the same statement").toMatch(/set_config\('app\.bypass_rls', '(on|off)', true\)/);
      expect(first()).not.toMatch(/,\s*false\s*\)/);
    });
    it(`${name}: a larger caller budget → the extended bound (${TENANT_STATEMENT_BOUND_EXTENDED_MS} ms)`, async () => {
      await run({ timeout: 45_000 });
      expect(first()).toContain(`set_config('statement_timeout', '${TENANT_STATEMENT_BOUND_EXTENDED_MS}ms', true)`);
      expect(first()).toContain(`set_config('lock_timeout', '${TENANT_LOCK_BOUND_EXTENDED_MS}ms', true)`);
      expect(TENANT_LOCK_BOUND_EXTENDED_MS).toBeLessThan(TENANT_STATEMENT_BOUND_EXTENDED_MS);
    });
    it(`${name}: Prisma's timeout and maxWait are out of reach whatever the caller passes`, async () => {
      await run({ timeout: 45_000 });
      const o = h.options[0];
      expect(o?.timeout).toBeGreaterThan(POOL_CONNECTION_TIMEOUT_MS + 3 * TENANT_STATEMENT_BOUND_EXTENDED_MS);
      expect(o?.maxWait).toBeGreaterThan(POOL_CONNECTION_TIMEOUT_MS + 3 * TENANT_STATEMENT_BOUND_EXTENDED_MS);
      expect(o?.timeout).toBeLessThanOrEqual(2_147_483_647);
    });
  }

  it("a callback that overruns its budget is refused (typed, P2028) so nothing commits; within budget it returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slow = withTenantContext("tenant-A", async () => {
        vi.setSystemTime(Date.now() + 16_000);
        return "late";
      });
      await expect(slow).rejects.toBeInstanceOf(TenantTransactionBudgetError);
      await expect(slow).rejects.toMatchObject({ code: "P2028", budgetMs: 15_000 });
      const ok = await withTenantContext("tenant-A", async () => "fine", { timeout: 30_000 });
      expect(ok).toBe("fine");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error from the callback is the caller's, unchanged (no wrapping, no retry)", async () => {
    const boom = Object.assign(new Error("unique"), { code: "P2002" });
    await expect(withTenantContext("tenant-A", async () => { throw boom; })).rejects.toBe(boom);
    expect(h.options).toHaveLength(1);
  });

  // R10-2 (lane L2): the opener pattern also matches the generic form `$transaction<T>(` (the old `/\$transaction\s*\(/`
  // missed it), and scripts/ is scanned too — its callers are operator CLIs, allowed only while no runtime file imports them.
  const OPENS_TRANSACTION = /\$transaction\s*(<[^>]*>)?\s*\(/;
  const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const sourceFiles = (roots: string[]) => {
    const out: string[] = [];
    const walk = (p: string) => {
      if (!fs.existsSync(p)) return;
      const st = fs.statSync(p);
      if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
      if (!/\.(ts|tsx|mjs|cjs|js)$/.test(p)) return;
      out.push(path.normalize(path.relative(process.cwd(), p)));
    };
    for (const r of roots) walk(path.resolve(process.cwd(), r));
    return out;
  };
  const RUNTIME_ROOTS = ["app", "lib", "auth.ts", "proxy.ts"];

  it("the opener pattern catches every spelling of a Prisma transaction call (incl. the generic form)", () => {
    for (const s of ["prisma.$transaction(async (tx) => 1)", "prisma.$transaction (fn)", "prisma.$transaction<number>(async (tx) => 1)", "db.$transaction< { a: string } >(fn)", "prisma.$transaction([a, b])"]) {
      expect(OPENS_TRANSACTION.test(codeOnly(s)), s).toBe(true);
    }
    for (const s of ["// prisma.$transaction<T>(fn)", " * prisma.$transaction(fn)", "const $transactionCount = 1"]) {
      expect(OPENS_TRANSACTION.test(codeOnly(s)), s).toBe(false);
    }
  });

  it("source invariant: no code outside the three owned boundaries opens a Prisma transaction", () => {
    const owned = new Set(["lib/prisma-tenant.ts", "lib/rate-limit.ts", "lib/auth-lockout.ts"].map((f) => path.normalize(f)));
    const offenders = sourceFiles(RUNTIME_ROOTS)
      .filter((rel) => !owned.has(rel))
      .filter((rel) => OPENS_TRANSACTION.test(codeOnly(fs.readFileSync(rel, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("source invariant: scripts/ that open a transaction are not imported by any runtime file (they are operator CLIs)", () => {
    const scriptOpeners = sourceFiles(["scripts"]).filter((rel) => OPENS_TRANSACTION.test(codeOnly(fs.readFileSync(rel, "utf8"))));
    expect(scriptOpeners.length, "scripts/ is scanned (operator CLIs open their own transactions)").toBeGreaterThan(0);
    const scriptsDir = path.resolve(process.cwd(), "scripts") + path.sep;
    const imported: string[] = [];
    for (const rel of sourceFiles(RUNTIME_ROOTS)) {
      const src = codeOnly(fs.readFileSync(rel, "utf8"));
      for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)) {
        const spec = m[1];
        const target = spec.startsWith("@/")
          ? path.resolve(process.cwd(), spec.slice(2))
          : spec.startsWith(".") ? path.resolve(path.dirname(path.resolve(process.cwd(), rel)), spec) : null;
        if (target && (target + path.sep).startsWith(scriptsDir)) imported.push(`${rel} imports ${spec}`);
      }
    }
    expect(imported).toEqual([]);
  });
});

describe("a failed reservation is thrown with a reason and logged without the key", () => {
  const keys = lockoutKeys("secl1-club", EMAIL, IP);
  const cases: Array<[string, () => unknown, string]> = [
    ["dropped connection", () => new Error("Connection terminated unexpectedly"), "unreachable"],
    ["reset connection", () => Object.assign(new Error("Server has closed the connection."), { code: "P1017" }), "unreachable"],
    ["lock bound reached", () => Object.assign(new Error("Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`"), { code: "P2010", meta: { code: "55P03" } }), "lock-timeout"],
    ["statement bound reached", () => Object.assign(new Error("Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`"), { code: "P2010", meta: { code: "57014" } }), "statement-timeout"],
    ["pool deadline", () => new Error("timeout exceeded when trying to connect"), "pool-timeout"],
    // Visibility: an UNEXPECTED failure is not converted into a quiet answer — it is thrown and logged like the rest.
    ["unexpected programming error", () => new TypeError("cannot read properties of undefined (planted)"), "error"],
  ];
  for (const [name, make, reason] of cases) {
    it(`${name} → LockoutReservationError(${reason}), never a granted state`, async () => {
      h.fail = make;
      const err = await lockoutState(keys, async () => false).then(
        (v) => ({ resolved: v }),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LockoutReservationError);
      expect((err as LockoutReservationError).reason).toBe(reason);
      expect(((err as Error).cause as Error).message).toBe((make() as Error).message);
      expect(logs.filter((l) => l.includes("[auth-lockout]"))).toEqual([`[auth-lockout] reservation failed reason=${reason} outcome=refused`]);
      for (const l of logs) for (const s of [EMAIL, IP, keys.addr, keys.pair]) expect(l.includes(s)).toBe(false);
    });
  }

  it("positive control: a healthy store grants the reservation and logs nothing", async () => {
    const s = await lockoutState(keys, async () => false);
    expect(s.blocked).toBe(false);
    expect(s.blocked === false && !!s.reservation).toBe(true);
    expect(logs).toEqual([]);
  });
});

describe("a failed rate-limit transaction on a security bucket is a refusal with the reason", () => {
  it("lock bound reached → refused, Retry-After ≤ 30 s, logged reason=lock-timeout by family", async () => {
    h.fail = () => Object.assign(new Error("Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`"), { code: "P2010", meta: { code: "55P03" } });
    const r = await checkRateLimit("secl1lt:key-198.51.100.7", 5, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(logs.some((l) => /\[rate-limit\] store unavailable reason=lock-timeout class=security family=secl1lt outcome=refused/.test(l))).toBe(true);
    for (const l of logs) expect(l.includes("198.51.100.7")).toBe(false);
  });

  it("dropped connection → refused, logged reason=unreachable", async () => {
    h.fail = () => new Error("Connection terminated unexpectedly");
    const r = await checkRateLimit("secl1dc:key", 5, 60_000);
    expect(r.allowed).toBe(false);
    expect(logs.some((l) => /reason=unreachable class=security family=secl1dc outcome=refused/.test(l))).toBe(true);
  });
});
