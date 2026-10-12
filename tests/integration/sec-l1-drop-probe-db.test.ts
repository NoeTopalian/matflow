// SF-135 (lane L1, 11 Oct 2026): OBSERVATION probe for the post-burst connection failures. Not a gate: it runs the
// sec-c3 burst shape against the real lib/rate-limit.ts on a Prisma client built exactly as lib/prisma.ts builds it
// (same pg Pool options from prismaPoolConfig()), except that the pg Pool is created here so every pooled client's
// lifecycle can be timed: when it connected, which statement it last sent and when, and when its socket ended.
// Nothing is set on any connection; no other session is touched. TEST branch only through the guarded runners;
// buckets carry the secl1- prefix and teardown deletes exactly those rows and checks the count.
//
// Prisma's transaction-manager debug channel (DEBUG=prisma:client:transactionManager, set by the runner when wanted)
// prints "Transaction timed out." when Prisma's own timer fires; the probe correlates socket ends with it.
import { vi, describe, it, expect, afterAll } from "vitest";
import { appendFileSync } from "node:fs";

type Life = { id: number; connectedAt: number; lastSql: string; lastSentAt: number; endedAt?: number; endedWhileActive?: boolean };
const probe = vi.hoisted(() => ({ lives: [] as Life[], t0: Date.now(), pool: undefined as unknown }));

vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  const pg = (await import("pg")).default;
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@prisma/client");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ...real.prismaPoolConfig() });
  probe.pool = pool;
  let n = 0;
  pool.on("connect", (c: import("pg").PoolClient) => {
    const life: Life = { id: ++n, connectedAt: Date.now() - probe.t0, lastSql: "", lastSentAt: 0 };
    probe.lives.push(life);
    const q = c.query.bind(c) as (...a: unknown[]) => unknown;
    (c as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
      const cfg = a[0] as string | { text?: string };
      life.lastSql = (typeof cfg === "string" ? cfg : cfg?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
      life.lastSentAt = Date.now() - probe.t0;
      return q(...a);
    };
    c.on("end", () => {
      life.endedAt = Date.now() - probe.t0;
      life.endedWhileActive = !!(c as unknown as { _activeQuery?: unknown })._activeQuery;
    });
  });
  const client = new PrismaClient({ adapter: new PrismaPg(pool), log: ["error"] });
  return { ...real, prisma: client };
});

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const PREFIX = `secl1-probe-${ROLE}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ROUNDS = Number(process.env.L1_ROUNDS ?? 6);
const OUT = process.env.L1_PROBE_OUT;
function report(tag: string, data: Record<string, unknown>) {
  const line = `${tag} ${JSON.stringify(data)}`;
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n");
}
// No process listener here: Vitest stops reporting unhandled rejections once any other listener exists. An unhandled
// rejection in this run is Vitest's "Unhandled Rejection" block and exit code 1.

let rowsWritten = 0;
describe.skipIf(!ON_TEST)(`L1 probe: connection lifecycle under the c3 burst (${ROLE})`, () => {
  afterAll(async () => {
    const del = await prisma.rateLimitHit.deleteMany({ where: { bucket: { startsWith: PREFIX } } });
    const left = await prisma.rateLimitHit.count({ where: { bucket: { startsWith: PREFIX } } });
    const pool = probe.pool as { totalCount: number; idleCount: number; waitingCount: number };
    report("L1-PROBE-END", {
      role: ROLE,
      teardown: { rowsWritten, deleted: del.count, left },
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      ended: probe.lives.filter((l) => l.endedAt !== undefined),
      clients: probe.lives.length,
    });
    expect(del.count).toBe(rowsWritten);
    expect(left).toBe(0);
  }, 120_000);

  for (let r = 1; r <= ROUNDS; r++) {
    it(`round ${r}: 20 in parallel against max 5`, async () => {
      const b = `${PREFIX}-r${r}`;
      const start = Date.now() - probe.t0;
      const res = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const s = Date.now();
          const v = await checkRateLimit(b, 5, 60_000);
          return { allowed: v.allowed, ms: Date.now() - s };
        }),
      );
      const n = await prisma.rateLimitHit.count({ where: { bucket: b } });
      rowsWritten += n;
      const allowed = res.filter((x) => x.allowed).length;
      report("L1-PROBE-ROUND", { role: ROLE, round: r, startMs: start, allowed, rows: n, maxMs: Math.max(...res.map((x) => x.ms)) });
      // The security property, whatever the connection does: never more than max rows, and every allowance holds a
      // row (a row without an allowance — a COMMIT that landed but whose answer was lost — is the fail-safe direction).
      expect(n).toBeLessThanOrEqual(5);
      expect(allowed).toBeLessThanOrEqual(n);
    }, 120_000);
  }
});
