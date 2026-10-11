// SF-135 (lane L1, 11 Oct 2026): what happens to a rate-limit check and a lockout reservation when the pooled
// connection that holds their transaction stalls and then drops — the shape behind the burst suites' unhandled
// "Connection terminated unexpectedly" / "ConnectionClosed" (stack: Prisma's transaction-timeout timer → its ROLLBACK
// on the same client → the socket ends → that ROLLBACK's rejection has no handler).
//
// Fault injection on THIS process's own pooled pg clients only: the Prisma client here is built exactly as
// lib/prisma.ts builds it (PrismaPg over a pg Pool with prismaPoolConfig()), but the Pool is created in this file so
// the test can catch the client the moment it SENDS the advisory-lock statement, pause its socket (a network stall:
// the answer is never read) and later end it (destroy — a plain close, or an ECONNRESET). Nothing is SET on any
// connection by the test, no other session is touched, no backend is terminated; the server rolls back the abandoned
// transaction when the socket closes. TEST branch only through the guarded runners (owner, and matflow_app with
// RLS_ENFORCED=1); every bucket and key is secl1-prefixed and teardown deletes exactly those rows and checks the count.
//
// Each cell checks the security property, not just the exit: the call is a REFUSAL (never admitted), no row is left
// for the refused attempt, the pool gives the slot back (nothing waiting, a positive control succeeds), the outcome is
// logged by family only (nothing logged carries a key, address or IP). The SF-135 property itself — no promise
// rejection left without a handler — is Vitest's: this file installs NO process listener (Vitest stops reporting
// unhandled rejections as soon as any other listener exists), so one unhandled rejection anywhere in the run is an
// "Unhandled Rejection" block naming the cell, and exit code 1.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync } from "node:fs";

type Tracked = { c: import("pg").PoolClient; lastSql: string };
const inj = vi.hoisted(() => ({
  clients: [] as Tracked[],
  pool: undefined as unknown,
  // When armed, the next client that sends a statement matching `armPattern` has its socket paused right then.
  armed: null as null | ((t: Tracked) => void),
  armPattern: /pg_advisory_xact_lock/ as RegExp,
}));

vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  const pg = (await import("pg")).default;
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@prisma/client");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...real.prismaPoolConfig() });
  inj.pool = pool;
  pool.on("connect", (c: import("pg").PoolClient) => {
    const t: Tracked = { c, lastSql: "" };
    inj.clients.push(t);
    const q = c.query.bind(c) as (...a: unknown[]) => unknown;
    (c as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
      const cfg = a[0] as string | { text?: string };
      t.lastSql = (typeof cfg === "string" ? cfg : cfg?.text ?? "").replace(/\s+/g, " ");
      const result = q(...a);
      if (inj.armed && inj.armPattern.test(t.lastSql)) {
        const fire = inj.armed;
        inj.armed = null;
        (c as unknown as { connection: { stream: { pause: () => void } } }).connection.stream.pause();
        fire(t);
      }
      return result;
    };
  });
  const client = new PrismaClient({ adapter: new PrismaPg(pool), log: ["error"] });
  return { ...real, prisma: client };
});

import pg from "pg";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, RATE_LIMIT_LOCK_NS } from "@/lib/rate-limit";
import { lockoutKeys, lockoutState } from "@/lib/auth-lockout";
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// One bucket family per cell: the store-failure line is logged once per window per family, so cells must not share one.
const B = (family: string) => `${family}:${ROLE}-${STAMP}`;
const SLUG = `secl1-${STAMP}-club`;
const EMAIL = (cell: string) => `secl1-${STAMP}-${cell}@example.test`;
const IP = (i: number) => `192.0.2.${i}`;
// How long the stall lasts before the socket ends: past the OLD Prisma timers (5 s batch default for the rate-limit
// transaction, 10 s for the reservation), so on the old code the timer has fired and queued its ROLLBACK first.
const STALL_RL_MS = 6_500;
const STALL_LK_MS = 11_500;
// Cycle 2: past the OLD 15 s Prisma timer of withTenantContext / withRlsBypass.
const STALL_TX_MS = 16_500;

const buckets = new Set<string>();
const OUT = process.env.L1_EVIDENCE_OUT;
function report(tag: string, data: Record<string, unknown>) {
  const line = `${tag} ${JSON.stringify(data)}`;
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n");
}

const poolStats = () => {
  const p = inj.pool as { totalCount: number; idleCount: number; waitingCount: number };
  return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pool counts once settled: a snapshot can catch a queued acquire (e.g. the 5 % prune) in the tick before it is served. */
async function settledPool() {
  for (let i = 0; i < 30 && poolStats().waiting > 0; i++) await sleep(100);
  return poolStats();
}

/** Arms the stall: resolves with the client whose lock statement was just sent and whose socket is now paused. */
function stallNextLock(pattern: RegExp = /pg_advisory_xact_lock/): Promise<Tracked> {
  inj.armPattern = pattern;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      inj.armed = null;
      reject(new Error("no pooled client sent the lock statement within 15 s"));
    }, 15_000);
    inj.armed = (x) => {
      clearTimeout(t);
      resolve(x);
    };
  });
}

/** If the stall never arms, the call under test is still awaited (its outcome reported) before the harness fails. */
async function settleOnStallFailure<T>(stalled: Promise<Tracked>, call: Promise<T>): Promise<Tracked> {
  try {
    return await stalled;
  } catch (e) {
    const outcome = await call.then(
      (v) => `resolved ${JSON.stringify(v)}`,
      (err: Error) => `rejected ${err?.name}: ${String(err?.message).slice(0, 80)}`,
    );
    throw new Error(`${(e as Error).message}; the call itself ${outcome}`);
  }
}

function endSocket(t: Tracked, how: "close" | "reset") {
  const stream = (t.c as unknown as { connection: { stream: { destroy: (e?: Error) => void } } }).connection.stream;
  if (how === "close") stream.destroy();
  else stream.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -4077, syscall: "read" }));
}

/** Console lines written while fn runs (recorded AND passed through — nothing is suppressed). */
async function withLogs<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; logs: string[] }> {
  const logs: string[] = [];
  const spies = (["error", "warn", "log"] as const).map((m) => {
    const orig = console[m].bind(console);
    return vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      orig(...a);
    });
  });
  try {
    return { value: await fn(), logs };
  } catch (error) {
    return { error, logs };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

function noSecretsIn(logs: string[], secrets: string[]) {
  for (const l of logs) for (const s of secrets) expect(l.includes(s), `a log line carries ${s.slice(0, 12)}…`).toBe(false);
}

describe.skipIf(!ON_TEST)(`SF-135: a dropped connection under a pending transaction is a refusal, handled where it is owned (${ROLE})`, () => {
  beforeAll(async () => {
    await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`));
  }, 60_000);

  afterAll(async () => {
    await sleep(1_500);
    const list = [...buckets];
    const before = await prisma.rateLimitHit.count({ where: { bucket: { in: list } } });
    const del = await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: list } } });
    const left = await prisma.rateLimitHit.count({ where: { bucket: { in: list } } });
    report("L1-DROP-TEARDOWN", { role: ROLE, buckets: list.length, rowsBefore: before, deleted: del.count, left, pool: poolStats() });
    expect(del.count).toBe(before);
    expect(left).toBe(0);
  }, 120_000);

  for (const [how, family] of [["close", "secl1rc"], ["reset", "secl1rr"]] as const) {
    it(`rate limit: the lock statement's connection stalls past the old 5 s timer, then ends (${how}) → refused, no row, slot back, logged by family`, async () => {
      const b = B(family);
      buckets.add(b);
      const base = poolStats();
      const started = Date.now();
      const r = await withLogs(async () => {
        const stalled = stallNextLock();
        const p = checkRateLimit(b, 5, 60_000);
        const t = await settleOnStallFailure(stalled, p);
        await sleep(STALL_RL_MS);
        endSocket(t, how);
        return p;
      });
      const ms = Date.now() - started;
      await sleep(1_000);
      const rows = await prisma.rateLimitHit.count({ where: { bucket: b } });
      const control = await checkRateLimit(`${family}ok:${ROLE}-${STAMP}`, 5, 60_000);
      buckets.add(`${family}ok:${ROLE}-${STAMP}`);
      const after = await settledPool();
      report("L1-DROP-RL", { role: ROLE, how, ms, verdict: r.value, threw: r.error ? String((r.error as Error).message).slice(0, 80) : null, rows, control, poolBefore: base, poolAfter: after, logs: r.logs.filter((l) => /rate-limit/.test(l)) });
      expect(r.error, "a security bucket answers, it does not throw").toBeUndefined();
      expect(r.value?.allowed, "a failed check is a refusal").toBe(false);
      expect(r.value!.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(r.value!.retryAfterSeconds).toBeLessThanOrEqual(30);
      expect(rows, "the abandoned transaction left no hit").toBe(0);
      expect(control.allowed, "positive control: the pool serves the next caller").toBe(true);
      expect(after.waiting).toBe(0);
      expect(after.total, "the dead client left the pool; nothing leaked").toBeLessThanOrEqual(base.total + 1);
      expect(r.logs.some((l) => new RegExp(`\\[rate-limit\\] store unavailable reason=unreachable class=security family=${family} outcome=refused`).test(l)), "one family-only store-failure line naming the cause").toBe(true);
      noSecretsIn(r.logs, [b.slice(family.length + 1)]);
    }, 60_000);
  }

  for (const [how, n] of [["close", 31], ["reset", 32]] as const) {
    it(`lockout reservation: the lock statement's connection stalls past the old 10 s timer, then ends (${how}) → refused (thrown, no reservation), no slot written, slot back, logged without the key`, async () => {
      const email = EMAIL(`lk-${how}`);
      const ip = IP(n);
      const keys = lockoutKeys(SLUG, email, ip);
      buckets.add(keys.addr);
      buckets.add(keys.pair);
      let knownCalls = 0;
      const started = Date.now();
      const r = await withLogs(async () => {
        const stalled = stallNextLock();
        const p = lockoutState(keys, async () => {
          knownCalls++;
          return false;
        });
        const t = await settleOnStallFailure(stalled, p);
        await sleep(STALL_LK_MS);
        endSocket(t, how);
        return p;
      });
      const ms = Date.now() - started;
      await sleep(1_000);
      const rows = await prisma.rateLimitHit.count({ where: { bucket: { in: [keys.addr, keys.pair] } } });
      // Positive control on a fresh address: a reservation is granted and holds both slots.
      const ck = lockoutKeys(SLUG, EMAIL(`lk-${how}-control`), IP(40 + n));
      buckets.add(ck.addr);
      buckets.add(ck.pair);
      const control = await lockoutState(ck, async () => false);
      const controlRows = await prisma.rateLimitHit.count({ where: { bucket: { in: [ck.addr, ck.pair] } } });
      const after = await settledPool();
      const err = r.error as (Error & { reason?: string }) | undefined;
      report("L1-DROP-LK", { role: ROLE, how, ms, resolved: r.value ?? null, threw: err ? `${err.name}${err.reason ? `(${err.reason})` : ""}: ${String(err.message).slice(0, 80)}` : null, rows, knownCalls, control: { blocked: control.blocked, reserved: !control.blocked && !!control.reservation }, controlRows, poolAfter: after, logs: r.logs.filter((l) => /lockout/.test(l)) });
      // Fail closed: the caller (auth.ts) refuses the sign-in on any throw; a resolved state must never carry a slot.
      expect(err, "a failed reservation is thrown to the caller, never a granted state").toBeDefined();
      expect(r.value).toBeUndefined();
      expect(err!.name).toBe("LockoutReservationError");
      expect(err!.reason).toBe("unreachable");
      expect(rows, "no slot was written for the refused attempt").toBe(0);
      expect(control.blocked).toBe(false);
      expect(controlRows, "positive control holds both slots").toBe(2);
      expect(after.waiting).toBe(0);
      expect(r.logs.some((l) => /\[auth-lockout\] reservation failed reason=unreachable outcome=refused/.test(l)), "one logged line naming the cause").toBe(true);
      noSecretsIn(r.logs, [email, ip, keys.addr, keys.pair, keys.addr.slice(-40)]);
    }, 60_000);
  }

  it("a real lock wait on a healthy connection is bounded by the transaction itself (holder on the test's own connection)", async () => {
    const family = "secl1hl";
    const b = B(family);
    buckets.add(b);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))", [RATE_LIMIT_LOCK_NS, b]);
    // The holder lets go after 25 s whatever happens, so an unbounded wait shows as a ~25 s answer, not a hang.
    const released = sleep(25_000).then(() => holder.query("ROLLBACK"));
    const started = Date.now();
    const r = await withLogs(() => checkRateLimit(b, 5, 60_000));
    const ms = Date.now() - started;
    await released;
    await holder.end();
    const rows = await prisma.rateLimitHit.count({ where: { bucket: b } });
    // The bound is transaction-local: the next statement on a pooled connection runs with the server defaults again.
    const after = await prisma.$queryRaw<{ lt: string; st: string }[]>`SELECT current_setting('lock_timeout') AS lt, current_setting('statement_timeout') AS st`;
    report("L1-HELDLOCK-RL", { role: ROLE, ms, verdict: r.value, threw: r.error ? String((r.error as Error).message).slice(0, 80) : null, rows, settingsAfter: after[0], logs: r.logs.filter((l) => /rate-limit/.test(l)) });
    expect(r.value?.allowed, "refused while another transaction holds the bucket").toBe(false);
    expect(rows).toBe(0);
    expect(ms, "the wait is bounded by the transaction, not by the holder letting go").toBeLessThan(20_000);
    expect(r.logs.some((l) => new RegExp(`\\[rate-limit\\] store unavailable reason=lock-timeout class=security family=${family} outcome=refused`).test(l))).toBe(true);
    expect(after[0], "nothing left on the pooled connection").toEqual({ lt: "0", st: "0" });
  }, 60_000);

  // Visibility control (run only with L1_PLANT=1): an UNEXPECTED failure from an unrelated place must still fail the
  // run. The fix handles the expected connection failure where it is owned; it installs nothing that would hide this.
  // Cycle 2: the sign-in flow's other transactions. A statement of a tenant (or bypass) transaction stalls past the old
  // 15 s Prisma timer, then its connection ends: the caller gets the failure (thrown, with the tenant attached for the
  // log), nothing else is left behind, and nothing is unhandled.
  for (const name of ["withTenantContext", "withRlsBypass"] as const) {
    it(`${name}: a statement stalls past the old 15 s timer, then its connection ends → the caller sees the failure, pool slot back, nothing unhandled`, async () => {
      const started = Date.now();
      const tag = `secl1_stall_${name.toLowerCase()}`;
      const r = await withLogs(async () => {
        const stalled = stallNextLock(new RegExp(tag));
        const q = (name === "withTenantContext"
          ? withTenantContext(`secl1-${STAMP}-tenant`, (tx) => tx.$queryRawUnsafe(`SELECT 1 AS ${tag}`))
          : withRlsBypass((tx) => tx.$queryRawUnsafe(`SELECT 1 AS ${tag}`)));
        const t = await settleOnStallFailure(stalled, q);
        await sleep(STALL_TX_MS);
        endSocket(t, "close");
        return q;
      });
      const ms = Date.now() - started;
      const control = name === "withTenantContext"
        ? await withTenantContext(`secl1-${STAMP}-tenant`, (tx) => tx.$queryRaw<{ ok: number }[]>`SELECT 1::int AS ok`)
        : await withRlsBypass((tx) => tx.$queryRaw<{ ok: number }[]>`SELECT 1::int AS ok`);
      const after = await settledPool();
      const err = r.error as (Error & { code?: string }) | undefined;
      report("L1-DROP-TX", { role: ROLE, name, ms, resolved: r.value ?? null, threw: err ? `${err.name}${err.code ? `(${err.code})` : ""}: ${String(err.message).slice(0, 80)}` : null, control, poolAfter: after });
      expect(err, "the caller sees the failure").toBeDefined();
      expect(control).toEqual([{ ok: 1 }]);
      expect(after.waiting).toBe(0);
    }, 60_000);
  }

  it.runIf(process.env.L1_PLANT === "1")("planted: an unrelated rejection nobody handles still fails the run", async () => {
    void Promise.reject(new Error("L1 planted unexpected failure (unrelated to the database)"));
    await sleep(200);
    expect(true).toBe(true);
  });
});
