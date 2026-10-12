// SF-35 residual R3-2 on Postgres (security campaign iteration 2, lane A3, 9 Oct 2026).
//
// Adopted from reviewer R3's independent probe
// (docs/security/evidence/R3/zz-r3-lockout-oracle-db.test.ts.txt) and extended
// with the row-locked cases. TEST branch only, through the guarded runners
// (owner, and matflow_app with RLS_ENFORCED=1). Synthetic secA3- club,
// count-checked teardown. Real authorize(), real bcrypt at cost 12 (as
// production hashes and DUMMY_HASH), real RateLimitHit counters, identical
// request shapes. The per-IP attempt throttle is replaced by "allowed" (the
// attacker paces under it), as in A2's and R3's tests.
//
// What R3 found: a member row-locked by "Wasn't me?" (or a staff row locked by
// an operator) returned null BEFORE the failure was recorded, so it answered
// refused x12 while an address with no account answered refused x10 then
// rate_limited — a lock-state and existence oracle.
//
// Timing (R3-3) is measured and written to the report, not asserted here: on a
// shared link the medians move with load. The equal-work property is pinned
// deterministically by tests/unit/sec-a3-failure-path-cost.test.ts.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { writeFileSync } from "node:fs";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;
const captured = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a3-lockout-db-secret-0123456789abcdef0123456789";
  return { authorize: undefined as undefined | Authorize };
});

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    return { handlers: {}, auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
// after() as in a real request: scheduled, not awaited by the response.
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    setTimeout(() => void fn(), 0);
  },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { prisma } from "@/lib/prisma";
import { lockoutKeys } from "@/lib/auth-lockout";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `secA3-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const PASSWORD = "secA3-correct-horse-battery";
const ATTACKER_IP = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const OUT = process.env.A3_OUT ?? "";
const SAMPLES = 20;
const ALL_WHO = ["acct", "ghost", "locked", "lockedstaff", "ghost2", "ghost3", "seqlocked", "seqlockedstaff"];

describe.skipIf(!HAS_DB)("SF-35 / R3-2 on Postgres: a row-locked account answers like any other address", () => {
  const ids = { tenant: "", slug: "" };

  async function attempt(email: string, password: string, fromIp = ATTACKER_IP) {
    if (!captured.authorize) await import("@/auth");
    const t0 = performance.now();
    let outcome: string;
    try {
      const r = await captured.authorize!(
        { email, password, tenantSlug: ids.slug },
        new Request("http://localhost/api/auth/callback/credentials", {
          method: "POST",
          headers: { "x-vercel-forwarded-for": fromIp, "user-agent": UA },
        }),
      );
      outcome = r ? "admitted" : "refused";
    } catch (e) {
      outcome = `code:${(e as { code?: string }).code ?? "error"}`;
    }
    return { outcome, ms: performance.now() - t0 };
  }

  async function seed(email: string, addrN: number, pairN: number) {
    const k = lockoutKeys(ids.slug, email, ATTACKER_IP);
    await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: [k.addr, k.pair] } } });
    const rows = [
      ...Array.from({ length: addrN }, () => ({ bucket: k.addr })),
      ...Array.from({ length: pairN }, () => ({ bucket: k.pair })),
    ];
    if (rows.length) await prisma.rateLimitHit.createMany({ data: rows });
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  const bucketsOf = (who: string) => {
    const k = lockoutKeys(ids.slug, E(who), ATTACKER_IP);
    return [k.addr, k.pair];
  };

  beforeAll(async () => {
    const hash = bcrypt.hashSync(PASSWORD, 12);
    const locked = new Date(Date.now() + 24 * 3600 * 1000);
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      await tx.member.create({ data: { tenantId: t.id, email: E("acct"), name: "secA3 acct", passwordHash: hash } });
      // "Wasn't me?" sets lockedUntil on the member row; an operator lock does the same on a staff row.
      for (const who of ["locked", "seqlocked"]) {
        await tx.member.create({ data: { tenantId: t.id, email: E(who), name: `secA3 ${who}`, passwordHash: hash, lockedUntil: locked } });
      }
      for (const who of ["lockedstaff", "seqlockedstaff"]) {
        await tx.user.create({ data: { tenantId: t.id, email: E(who), name: `secA3 ${who}`, role: "coach", passwordHash: hash, lockedUntil: locked } });
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await new Promise((r) => setTimeout(r, 1500));
    const buckets = ALL_WHO.flatMap(bucketsOf);
    await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: buckets } } });
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.loginEvent.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.member.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.tenant.delete({ where: { id: ids.tenant } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: ids.tenant } }),
      members: await tx.member.count({ where: { tenantId: ids.tenant } }),
      users: await tx.user.count({ where: { tenantId: ids.tenant } }),
    }));
    const hits = await prisma.rateLimitHit.count({ where: { bucket: { in: buckets } } });
    expect({ ...left, rateLimitHits: hits }).toEqual({ tenants: 0, members: 0, users: 0, rateLimitHits: 0 });
  }, 120_000);

  it("positive control: the right password for the unlocked member is admitted", async () => {
    await seed(E("acct"), 0, 0);
    expect((await attempt(E("acct"), PASSWORD)).outcome).toBe("admitted");
  }, 60_000);

  it("same code at 0, 9, 10, 11 prior failures for: account, row-locked member, row-locked staff, no account (20 samples each)", async () => {
    const rtt: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await prisma.$queryRawUnsafe("SELECT 1");
      rtt.push(performance.now() - t0);
    }
    const report: Record<string, unknown> = { role: ROLE, samples: SAMPLES, rttMedianMs: Math.round(median(rtt) * 10) / 10 };
    const mismatches: string[] = [];
    const kinds = ["acct", "locked", "lockedstaff", "ghost"] as const;
    for (const n of [0, 9, 10, 11]) {
      const res = Object.fromEntries(kinds.map((k) => [k, { outcomes: [] as string[], ms: [] as number[] }]));
      for (let i = 0; i < SAMPLES; i++) {
        // Rotate the order so drift on the link does not favour one kind.
        const order = kinds.map((_, j) => kinds[(i + j) % kinds.length]);
        for (const who of order) {
          await seed(E(who), n, 0);
          const a = await attempt(E(who), "wrong-password-a3");
          res[who].outcomes.push(a.outcome);
          res[who].ms.push(a.ms);
        }
      }
      const ghostSet = [...new Set(res.ghost.outcomes)];
      const level: Record<string, unknown> = {};
      for (const who of kinds) {
        const set = [...new Set(res[who].outcomes)];
        level[who] = {
          outcomes: set,
          medianMs: Math.round(median(res[who].ms)),
          diffVsGhostMs: Math.round(median(res[who].ms) - median(res.ghost.ms)),
        };
        if (JSON.stringify(set) !== JSON.stringify(ghostSet)) mismatches.push(`n=${n} ${who}: ${set} vs ghost ${ghostSet}`);
      }
      report[`n${n}`] = level;
    }

    // Natural accumulation from zero: R3's exact reproduction, for both kinds of row lock.
    const seq = async (who: string) => {
      await seed(E(who), 0, 0);
      const out: string[] = [];
      for (let i = 0; i < 12; i++) out.push((await attempt(E(who), "wrong-password-a3")).outcome);
      return out;
    };
    const lockedSeq = await seq("seqlocked");
    const ghostSeq = await seq("ghost2");
    const lockedStaffSeq = await seq("seqlockedstaff");
    const ghostSeq3 = await seq("ghost3");
    report.rowLockedVsNone = {
      lockedMember: lockedSeq.join(","),
      none: ghostSeq.join(","),
      lockedStaff: lockedStaffSeq.join(","),
      none2: ghostSeq3.join(","),
    };
    console.log("A3-ORACLE " + JSON.stringify(report));
    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));

    expect(mismatches, "response code differs by existence or row lock").toEqual([]);
    expect(ghostSeq.slice(10), "control: no account is capped after ten").toEqual(["code:rate_limited", "code:rate_limited"]);
    expect(lockedSeq, "row-locked member vs no account").toEqual(ghostSeq);
    expect(lockedStaffSeq, "row-locked staff vs no account").toEqual(ghostSeq3);
  }, 1_200_000);
});
