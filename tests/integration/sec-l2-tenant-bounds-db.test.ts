// Lane L2 phase 2 (12 Oct 2026) — the tenant-transaction findings of review R10, measured on Postgres (TEST branch,
// both roles through the guarded runners):
//  - R10-1 / B1: a callback IDLE past its budget no longer holds the pool slot: the caller gets
//    TenantTransactionBudgetError at the budget, the slot is freed then, a second caller on the same one-connection pool
//    is served, no own backend is left "idle in transaction", and the late callback is observed (logged once) — nothing
//    unhandled (Vitest fails the run on any unhandled rejection; this file installs no process listener).
//  - R10-5: a tenant transaction waiting on a lock ends as 55P03 at the lock bound (10 s; 45 s extended), BELOW the
//    statement bound, and isTenantRowBusyError reads the real error as busy.
//  - R10-3: a statement error swallowed by the callback (a 57014 under a 120 s budget — B5a — and a non-timeout error —
//    B5c) is refused as TenantTransactionAbortedError and nothing persists; control B5b-style success commits.
//
// Own pool only (built as lib/prisma.ts builds it, max 1), the test's own direct connections as lock holders (each in
// its own transaction, rolled back and closed in finally), nothing SET on any connection outside a transaction, no
// backend terminated. Rows: RateLimitHit with secl2- ids/buckets, deleted by exact value and count-checked.
import { vi, describe, it, expect, afterAll } from "vitest";
import { appendFileSync } from "node:fs";

const inj = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  const pg = (await import("pg")).default;
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@prisma/client");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...real.prismaPoolConfig(), max: 1 });
  inj.pool = pool;
  return { ...real, prisma: new PrismaClient({ adapter: new PrismaPg(pool), log: [] }) };
});

import pg from "pg";
import { prisma } from "@/lib/prisma";
import {
  withTenantContext,
  TenantTransactionBudgetError,
  TenantTransactionAbortedError,
  TENANT_LOCK_BOUND_MS,
  TENANT_LOCK_BOUND_EXTENDED_MS,
} from "@/lib/prisma-tenant";
import { isTenantRowBusyError } from "@/lib/tenant-lifecycle";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `secl2-${STAMP}-tenant`;
const LOCK_NS = 0x4c324c4b; // this file's own advisory-lock namespace
const OUT = process.env.L2_EVIDENCE_OUT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const written: string[] = [];
const V = (cell: string) => {
  const v = `secl2-${ROLE}-${STAMP}-${cell}`;
  written.push(v);
  return v;
};
function report(tag: string, data: Record<string, unknown>) {
  const line = `${tag} ${JSON.stringify({ role: ROLE, ...data })}`;
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n");
}
const pool = () => inj.pool as pg.Pool;
const poolStats = () => ({ total: pool().totalCount, idle: pool().idleCount, waiting: pool().waitingCount });
const errInfo = (e: unknown) => {
  const x = e as { name?: string; code?: string; meta?: { code?: string }; message?: string } | null;
  return { name: x?.name, code: x?.code, metaCode: x?.meta?.code, message: String(x?.message ?? "").slice(0, 120) };
};
async function direct() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000 });
  c.on("error", () => {});
  await c.connect();
  return c;
}
async function persisted(v: string) {
  const c = await direct();
  try {
    return (await c.query(`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE id = $1 OR bucket = $1`, [v])).rows[0].n as number;
  } finally {
    await c.end().catch(() => {});
  }
}
/**
 * The state of ONE server backend this file's own transaction ran on (its pid read inside that transaction — the TEST
 * URL is Neon's pooled endpoint, so the client's BackendKeyData is the pooler's, not the server pid).
 */
async function backendState(pid: number) {
  const c = await direct();
  try {
    const r = await c.query(`SELECT state FROM pg_stat_activity WHERE pid = $1::int`, [pid]);
    return (r.rows[0]?.state as string | undefined) ?? "gone";
  } finally {
    await c.end().catch(() => {});
  }
}
async function holdLock(key: string) {
  const c = await direct();
  await c.query("BEGIN");
  await c.query(`SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))`, [LOCK_NS, key]);
  return async () => {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  };
}
/** Console lines written while fn runs (recorded AND passed through). */
async function withLogs<T>(fn: () => Promise<T>) {
  const logs: string[] = [];
  const spies = (["error", "warn"] as const).map((m) => {
    const orig = console[m].bind(console);
    return vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    });
  });
  try {
    return { value: await fn(), logs };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

describe.skipIf(!ON_TEST)(`L2: tenant transaction bounds on Postgres (${ROLE})`, () => {
  afterAll(async () => {
    const c = await direct();
    try {
      const del = await c.query(`DELETE FROM "RateLimitHit" WHERE id = ANY($1::text[]) OR bucket = ANY($1::text[])`, [written]);
      const left = await c.query(`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE id = ANY($1::text[]) OR bucket = ANY($1::text[])`, [written]);
      report("L2-TEARDOWN", { deleted: del.rowCount, left: left.rows[0].n });
      expect(left.rows[0].n).toBe(0);
    } finally {
      await c.end().catch(() => {});
      await prisma.$disconnect().catch(() => {});
      await pool().end().catch(() => {});
    }
  }, 60_000);

  it("R10-1 B1: callback idle 25 s (budget 15 s), pool max 1, second caller 7 s after the callback starts → first cut at the budget, slot freed, second served, the backend not left in a transaction, late result logged once", async () => {
    // Warm the one-connection pool first: a cold Neon connect (seconds) must not be counted against the budget window.
    await prisma.$queryRaw`SELECT 1`;
    const r = await withLogs(async () => {
      const t0 = Date.now();
      let pid = 0;
      let callbackStart = -1;
      let lateReturned = -1;
      let started!: () => void;
      const callbackStarted = new Promise<void>((res) => (started = res));
      const first = withTenantContext(TENANT, async (tx) => {
        callbackStart = Date.now() - t0;
        started();
        const x = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pid = Number(x[0].pid);
        await sleep(25_000);
        lateReturned = Date.now() - t0;
        return "first-returned";
      }).then((v) => ({ ok: true as const, v, ms: Date.now() - t0 }), (e: unknown) => ({ ok: false as const, e, ms: Date.now() - t0 }));
      await callbackStarted;
      await sleep(7_000);
      const secondAt = Date.now() - t0;
      const second = withTenantContext(TENANT, (tx) => tx.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`).then(
        (v) => ({ ok: true as const, v, ms: Date.now() - t0 }),
        (e: unknown) => ({ ok: false as const, e, ms: Date.now() - t0 }),
      );
      const midState = await backendState(pid); // while the callback idles inside its transaction (control)
      const [f, s] = await Promise.all([first, second]);
      const stateAfterCut = await backendState(pid);
      for (let i = 0; i < 150 && lateReturned < 0; i++) await sleep(100);
      await sleep(500);
      const stateAtEnd = await backendState(pid);
      return { f, s, pid, callbackStart, secondAt, lateReturned, midState, stateAfterCut, stateAtEnd, pool: poolStats() };
    });
    const o = r.value;
    const late = r.logs.filter((l) => l.includes("[prisma-tenant] callback finished after its budget was cut"));
    report("L2-B1", { first: o.f.ok ? o.f : { ms: o.f.ms, err: errInfo(o.f.e) }, second: o.s.ok ? { ms: o.s.ms, ok: true } : { ms: o.s.ms, err: errInfo(o.s.e) }, callbackStartMs: o.callbackStart, secondAtMs: o.secondAt, lateReturnedMs: o.lateReturned, pid: o.pid, midState: o.midState, stateAfterCut: o.stateAfterCut, stateAtEnd: o.stateAtEnd, pool: o.pool, lateLogLines: late.length });
    expect(o.pid).toBeGreaterThan(0);
    expect(o.midState, "control: before the cut the backend IS inside the idle transaction").toMatch(/idle in transaction/);
    expect(o.f.ok).toBe(false);
    expect(!o.f.ok && o.f.e).toBeInstanceOf(TenantTransactionBudgetError);
    const cut = o.f.ms - o.callbackStart;
    expect(cut, "cut at the 15 s budget of the callback").toBeGreaterThanOrEqual(15_000);
    expect(cut).toBeLessThan(16_500);
    expect(o.s.ok, "the second caller on the one-connection pool is served once the first is cut").toBe(true);
    expect(o.s.ms - o.secondAt, "within its own 10 s pool deadline").toBeLessThan(10_000);
    expect(o.lateReturned, "the callback itself only returned ~25 s after it started").toBeGreaterThanOrEqual(o.callbackStart + 25_000);
    expect(o.stateAfterCut, "the backend is no longer inside the cut transaction").not.toMatch(/in transaction/);
    expect(o.stateAtEnd).not.toMatch(/in transaction/);
    expect(late, "the late result is observed and logged once, with the tenant only").toHaveLength(1);
    expect(late[0]).toContain(`tenant=${TENANT}`);
    expect(o.pool.waiting).toBe(0);
  }, 90_000);

  for (const [label, budget, bound] of [
    ["default", undefined, TENANT_LOCK_BOUND_MS],
    ["extended (budget 90 s)", 90_000, TENANT_LOCK_BOUND_EXTENDED_MS],
  ] as const) {
    it(`R10-5 B4c ${label}: a tenant transaction waiting on a lock ends as 55P03 at the ${bound} ms lock bound (below the statement bound) and isTenantRowBusyError reads it as busy`, async () => {
      const key = `secl2-${STAMP}-lock-${bound}`;
      const release = await holdLock(key);
      let out: { ok: boolean; e?: unknown; ms: number };
      try {
        const t0 = Date.now();
        out = await withTenantContext(
          TENANT,
          (tx) => tx.$queryRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int4, hashtext(${key}::text))::text AS x`,
          budget ? { timeout: budget } : undefined,
        ).then(() => ({ ok: true, ms: Date.now() - t0 }), (e: unknown) => ({ ok: false, e, ms: Date.now() - t0 }));
      } finally {
        await release();
      }
      const busy = isTenantRowBusyError(out.e);
      report("L2-B4c", { label, bound, ms: out.ms, ok: out.ok, err: errInfo(out.e), busy });
      expect(out.ok).toBe(false);
      expect(errInfo(out.e).metaCode ?? errInfo(out.e).message, JSON.stringify(errInfo(out.e))).toMatch(/55P03|lock timeout/);
      expect(busy, "the restore / purge-cron check reads the real error as busy").toBe(true);
      expect(out.ms).toBeGreaterThanOrEqual(bound - 100);
      expect(out.ms).toBeLessThan(bound + 3_000);
    }, 120_000);
  }

  it("R10-3 B5c: a swallowed NON-timeout statement error → TenantTransactionAbortedError, nothing persisted", async () => {
    const v = V("b5c");
    const t0 = Date.now();
    const out = await withTenantContext(TENANT, async (tx) => {
      await tx.$executeRaw`INSERT INTO "RateLimitHit" (id, bucket, "hitAt") VALUES (${v}, ${v}, now())`;
      await tx.$executeRaw`SELECT 1/0`.catch(() => null);
      return "reported-ok";
    }).then((x) => ({ ok: true as const, x }), (e: unknown) => ({ ok: false as const, e }));
    const n = await persisted(v);
    report("L2-B5c", { ms: Date.now() - t0, ok: out.ok, err: out.ok ? null : errInfo(out.e), persisted: n });
    expect(out.ok, "never reported as success").toBe(false);
    expect(!out.ok && out.e).toBeInstanceOf(TenantTransactionAbortedError);
    expect(n).toBe(0);
  }, 60_000);

  it("R10-3 control: no swallowed error → committed and persisted", async () => {
    const v = V("ctl");
    const out = await withTenantContext(TENANT, async (tx) => {
      await tx.$executeRaw`INSERT INTO "RateLimitHit" (id, bucket, "hitAt") VALUES (${v}, ${v}, now())`;
      return "ok";
    });
    const n = await persisted(v);
    report("L2-B5-control", { out, persisted: n });
    expect(out).toBe("ok");
    expect(n).toBe(1);
  }, 60_000);

  it("R10-3 B5a: budget 120 s, a 62 s statement cancelled at the 60 s bound and swallowed → TenantTransactionAbortedError, nothing persisted", async () => {
    const v = V("b5a");
    const t0 = Date.now();
    const out = await withTenantContext(
      TENANT,
      async (tx) => {
        await tx.$executeRaw`INSERT INTO "RateLimitHit" (id, bucket, "hitAt") VALUES (${v}, ${v}, now())`;
        await tx.$queryRaw`SELECT pg_sleep(62)::text`.catch(() => null);
        return "reported-ok";
      },
      { timeout: 120_000 },
    ).then((x) => ({ ok: true as const, x }), (e: unknown) => ({ ok: false as const, e }));
    const ms = Date.now() - t0;
    const n = await persisted(v);
    report("L2-B5a", { ms, ok: out.ok, err: out.ok ? null : errInfo(out.e), persisted: n });
    expect(out.ok, "never reported as success").toBe(false);
    expect(!out.ok && out.e).toBeInstanceOf(TenantTransactionAbortedError);
    expect(n).toBe(0);
    expect(ms).toBeLessThan(64_000);
  }, 120_000);
});
