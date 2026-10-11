// SEC-080 provider outage — the rate limiter and the durable audit writer under a database outage
// (security campaign lane F, 9 Oct 2026).
//
// The brief's rule: an outage must produce an explicit unavailable state and never a permissive fallback.
// lib/rate-limit.ts has two declared behaviours when its store (Postgres RateLimitHit) is unreachable:
//   - failClosed callers (magic-link request, reset-password, apply, card check-in, waiver open/sign/kiosk): THROW,
//     so the route refuses;
//   - everyone else: REFUSED (lane C4, review R6-N3 — a per-instance memory window used to answer here, and a burst
//     that saturated the pool reached it on demand, doubling the limit); the failure is logged once per window,
//     without the key. Only two non-security buckets (tenant-lookup, kiosk:classes) keep a memory fallback, seeded
//     full — tests/unit/sec-c4-rate-limit-store-failure.test.ts.
// Durable audit (lib/audit-log.ts `durable` / `tx`): a write failure THROWS to the caller, so a privileged change that
// requires its audit row is refused rather than performed unrecorded (SEC-081). Best-effort rows never throw.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ down: false, hits: 0, auditWrites: 0 }));
const outage = () => Object.assign(new Error("Can't reach database server (simulated outage)"), { code: "P1001" });

vi.mock("@/lib/prisma", () => ({
  prisma: {
    rateLimitHit: {
      groupBy: vi.fn(async () => {
        if (db.down) throw outage();
        return db.hits ? [{ bucket: "b", _count: { _all: db.hits }, _min: { hitAt: new Date() } }] : [];
      }),
      create: vi.fn(async () => {
        if (db.down) throw outage();
        db.hits++;
        return {};
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // The lane C3 path: advisory lock + conditional insert in one transaction. Without these the "store up" control
    // only ever passed through the memory fallback (a TypeError on prisma.$transaction) — found by lane C4.
    $executeRaw: vi.fn(() => ({ kind: "lock" })),
    $queryRaw: vi.fn((_s: TemplateStringsArray, ...values: unknown[]) => ({ kind: "insert", values })),
    $transaction: vi.fn(async (arg: Array<{ kind: string; values?: unknown[] }> | ((tx: unknown) => Promise<unknown>)) => {
      // SF-135 (lane L1): checkRateLimit runs the same two statements in an INTERACTIVE transaction now (its bounds are
      // owned there, not by Prisma's timer). The callback's statements are recorded as the same ops and answered by the
      // same rules; nothing asserted about them changes.
      const run = async (ops: Array<{ kind: string; values?: unknown[] }>) => {
        if (db.down) throw outage();
        const max = ops[1].values![4] as number;
        const count = db.hits;
        const inserted = count < max ? 1 : 0;
        db.hits += inserted;
        return [1, [{ count, inserted, oldestAgeMs: 0 }]];
      };
      if (typeof arg !== "function") return run(arg);
      const recorded: Array<{ kind: string; values?: unknown[] }> = [];
      return arg({
        $executeRaw: async () => (recorded.push({ kind: "lock" }), 1),
        $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
          recorded.push({ kind: "insert", values });
          const out = (await run(recorded)) as unknown[];
          return out[out.length - 1];
        },
      });
    }),
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async () => { if (db.down) throw outage(); db.auditWrites++; }),
  withRlsBypass: vi.fn(async () => { if (db.down) throw outage(); db.auditWrites++; }),
}));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn(async () => null) }));

import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";

beforeEach(() => {
  db.down = false;
  db.hits = 0;
  db.auditWrites = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("SEC-080 — rate limiter during a database outage", () => {
  it("positive control: with the store up, the DB window allows then denies", async () => {
    const bucket = `secF-up-${Math.random()}`;
    const r = [];
    for (let i = 0; i < 4; i++) r.push((await checkRateLimit(bucket, 3, 60_000)).allowed);
    expect(r).toEqual([true, true, true, false]);
  });

  it("failClosed callers get an exception (the route refuses), never an allowance", async () => {
    db.down = true;
    await expect(checkRateLimit(`secF-fc-${Math.random()}`, 3, 60_000, { failClosed: true })).rejects.toThrow(/database/i);
  });

  it("default callers are refused, never given a memory allowance, and the outage is logged (lane C4, R6-N3)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    db.down = true;
    const bucket = `secF-mem:${Math.random()}`;
    const r = [];
    for (let i = 0; i < 5; i++) r.push((await checkRateLimit(bucket, 3, 60_000)).allowed);
    expect(r).toEqual([false, false, false, false, false]);
    const denied = await checkRateLimit(bucket, 3, 60_000);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("[rate-limit] store unavailable reason=unreachable class=security family=secF-mem"));
  });
});

describe("SEC-080 / SEC-081 — audit writes during a database outage", () => {
  const args = { tenantId: "secF-t", userId: null, action: "secF.probe", entityType: "Probe", entityId: "secF-1" };

  it("durable mode THROWS so the caller refuses the privileged change", async () => {
    db.down = true;
    await expect(logAudit({ ...args, durable: true })).rejects.toThrow(/database/i);
    expect(db.auditWrites).toBe(0);
  });

  it("positive control: durable mode writes when the store is up", async () => {
    await expect(logAudit({ ...args, durable: true })).resolves.toBeUndefined();
    expect(db.auditWrites).toBe(1);
  });

  it("best-effort mode never throws into the user path, and the loss is logged (not silent)", async () => {
    db.down = true;
    await expect(logAudit(args)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith("[audit-log] write failed", "secF.probe", expect.anything());
  });
});
