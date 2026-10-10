// R6-N1 (security campaign iteration 2, lane A4, 10 Oct 2026) — the address-wide failure cap under a CONCURRENT
// burst. Adopted from review R6's probe zz-r6-a3-burst-db (docs/security/evidence/R6/zz-r6-a3-burst-db.test.ts.txt).
//
// Lockout v2 (lib/auth-lockout.ts) read the counters, ran bcrypt, and only then inserted the failure. Requests that
// overlapped all read the same count, so 40 concurrent guesses from 40 networks at a fresh address were ALL judged
// (cap 10) and the right password — the 40th — was admitted (R6, both roles). The claim under test is A2's: "an
// attacker rotating networks gets at most ADDR_MAX failures per hour per address", which must hold for a burst too.
//
// Cells: (1) R6's burst verbatim; (2) a burst of wrong guesses leaves the counter at exactly ADDR_MAX and the right
// password from an unknown network is then refused; (3) a successful sign-in gives its reserved slot back (refund);
// (4) the known-device exemption still admits the person at the cap, and their own wrong password still counts.
// TEST branch only through the guarded runners (owner and matflow_app/RLS), synthetic secA4- club, count-checked
// teardown. The per-IP attempt brake is replaced by "allowed" (every request comes from a different network).
//
// "Judged" is counted at the source: a VERDICT is a call of recordFailure (wrong password) or clearPairOnSuccess
// (right password) — the real functions, wrapped. A request refused because the database could not answer (fail
// closed, before bcrypt's result is used) is a refusal without a verdict and is reported separately; R6's probe
// counted every null as judged, which on the fixed code would conflate the two.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { appendFileSync } from "node:fs";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;
const captured = vi.hoisted(() => ({ authorize: undefined as undefined | Authorize }));
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
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    setTimeout(() => void fn(), 0);
  },
}));
const verdicts = vi.hoisted(() => ({ wrong: 0, right: 0, errors: [] as string[] }));
vi.mock("@/lib/auth-lockout", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth-lockout")>();
  return {
    ...real,
    // A database error here refuses the sign-in before any verdict (fail closed); recorded so the evidence says why.
    lockoutState: async (...a: Parameters<typeof real.lockoutState>) => {
      try {
        return await real.lockoutState(...a);
      } catch (e) {
        verdicts.errors.push(String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 120));
        throw e;
      }
    },
    recordFailure: async (...a: Parameters<typeof real.recordFailure>) => {
      verdicts.wrong++;
      return real.recordFailure(...a);
    },
    clearPairOnSuccess: async (...a: Parameters<typeof real.clearPairOnSuccess>) => {
      verdicts.right++;
      return real.clearPairOnSuccess(...a);
    },
  };
});
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { prisma, prismaPoolConfig } from "@/lib/prisma";
import { lockoutKeys, ADDR_MAX } from "@/lib/auth-lockout";
import { deviceHash } from "@/lib/login-fingerprint";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `secA4-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
const E = (who: string) => `${STAMP}-${who}@example.test`;
const PASSWORD = "secA4-correct-horse-battery";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const KNOWN_IP = "192.0.2.77";
const KNOWN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
// One documentation /16 per role and run, so the owner and restricted runs never share a pair counter.
const NET = Math.floor(Math.random() * 200) + 20;
const net = (i: number) => `198.${NET}.${i}.10`; // a distinct /24 per i

type Outcome = "admitted" | "refused" | `code:${string}`;
// One JSON line per cell: printed, and appended to $A4_EVIDENCE_OUT when set (Vitest hides console output of passing
// tests, and the evidence must survive a green run).
function report(tag: string, data: Record<string, unknown>) {
  const line = `${tag} ${JSON.stringify(data)}`;
  console.log(line);
  if (process.env.A4_EVIDENCE_OUT) appendFileSync(process.env.A4_EVIDENCE_OUT, line + "\n");
}
const used: { email: string; ip: string }[] = [];

describe.skipIf(!HAS_DB)("R6-N1: the address-wide failure cap holds under a concurrent burst", () => {
  const t = { id: "", slug: "" };

  async function attempt(email: string, password: string, ip: string, ua = UA): Promise<Outcome> {
    used.push({ email, ip });
    if (!captured.authorize) await import("@/auth");
    try {
      const r = await captured.authorize!(
        { email, password, tenantSlug: t.slug },
        new Request("http://localhost/api/auth/callback/credentials", {
          method: "POST",
          headers: { "x-vercel-forwarded-for": ip, "user-agent": ua },
        }),
      );
      return r ? "admitted" : "refused";
    } catch (e) {
      return `code:${(e as { code?: string }).code ?? "error"}`;
    }
  }
  const addrCount = (email: string) =>
    prisma.rateLimitHit.count({ where: { bucket: lockoutKeys(t.slug, email, "x").addr } });
  const tally = (out: Outcome[]) => out.reduce<Record<string, number>>((a, o) => ((a[o] = (a[o] ?? 0) + 1), a), {});
  const resetVerdicts = () => Object.assign(verdicts, { wrong: 0, right: 0, errors: [] });

  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    if (ROLE === "restricted") expect(who[0]?.current_user).toBe("matflow_app");
    else expect(who[0]?.current_user).not.toBe("matflow_app");
    const hash = bcrypt.hashSync(PASSWORD, 12); // real cost: the burst must overlap bcrypt as in production
    await withRlsBypass(async (tx) => {
      const c = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`, onboardingCompleted: true } });
      Object.assign(t, { id: c.id, slug: c.slug });
      for (const w of ["burst", "overflow", "refund", "known"]) {
        const m = await tx.member.create({ data: { tenantId: c.id, email: E(w), name: `secA4 ${w}`, passwordHash: hash } });
        if (w === "known") {
          await tx.loginEvent.create({
            data: { tenantId: c.id, memberId: m.id, deviceHash: deviceHash(KNOWN_IP, KNOWN_UA), ipApprox: "192.0.2.0", uaSummary: "Safari 17 on macOS" },
          });
        }
      }
    });
    await import("@/auth");
  }, 120_000);

  afterAll(async () => {
    if (!t.id) return;
    await new Promise((r) => setTimeout(r, 1500)); // let after() audit writes land before the sweep
    const buckets = [...new Set(used.flatMap(({ email, ip }) => [lockoutKeys(t.slug, email, ip).addr, lockoutKeys(t.slug, email, ip).pair]))];
    await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: buckets } } });
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: t.id } });
      await tx.loginEvent.deleteMany({ where: { tenantId: t.id } });
      await tx.member.deleteMany({ where: { tenantId: t.id } });
      await tx.tenant.delete({ where: { id: t.id } });
    }, { timeout: 60_000 });
    const left = {
      tenants: await withRlsBypass((tx) => tx.tenant.count({ where: { slug: { startsWith: STAMP } } })),
      members: await withRlsBypass((tx) => tx.member.count({ where: { tenantId: t.id } })),
      hits: await prisma.rateLimitHit.count({ where: { bucket: { in: buckets } } }),
    };
    expect(left).toEqual({ tenants: 0, members: 0, hits: 0 });
  }, 120_000);

  it(`R6's burst: 40 concurrent guesses (39 wrong + the right one last) from 40 networks → at most ${ADDR_MAX} judged`, async () => {
    const email = E("burst");
    resetVerdicts();
    const out = await Promise.all(
      Array.from({ length: 40 }, (_, i) => attempt(email, i === 39 ? PASSWORD : `wrong-guess-${i}-a4`, net(i))),
    );
    const counter = await addrCount(email);
    const judged = verdicts.wrong + verdicts.right;
    const v = { wrong: verdicts.wrong, right: verdicts.right, failClosedErrors: [...new Set(verdicts.errors)].map((m) => `${verdicts.errors.filter((x) => x === m).length}x ${m}`) };
    const after = await attempt(email, "wrong-after-burst-a4", net(200));
    const refusedWithoutVerdict = out.filter((o) => o === "refused").length - v.wrong;
    report("A4-BURST", { role: ROLE, nodeEnv: process.env.NODE_ENV, poolMax: prismaPoolConfig().max, tally: tally(out), judged, verdicts: v, refusedWithoutVerdict, rightPasswordOutcome: out[39], addressCounterAfter: counter, nextAttempt: after });
    expect(judged, "guesses judged (a verdict reached) in one burst at a fresh address").toBeLessThanOrEqual(ADDR_MAX);
    expect(counter, "address counter after the burst").toBeLessThanOrEqual(ADDR_MAX);
    expect(counter, "every wrong verdict holds exactly one slot; a right one gave its slot back").toBe(v.wrong);
    // The right password is admitted only if it reached a verdict inside the cap; otherwise it is refused.
    expect(out.filter((o) => o === "admitted").length).toBe(v.right);
    expect(out[39]).toMatch(v.right === 1 ? /^admitted$/ : /^(code:rate_limited|refused)$/);
    expect(out.every((o) => o === "refused" || o === "admitted" || o === "code:rate_limited"), "only the generic answers").toBe(true);
    // One more wrong guess from a fresh network: judged only if the burst left a slot (the refunded right password).
    expect(after).toBe(counter >= ADDR_MAX ? "code:rate_limited" : "refused");
  }, 600_000);

  it(`a burst of 39 wrong guesses leaves the counter at exactly ${ADDR_MAX}; the right password from an unknown network is then refused`, async () => {
    const email = E("overflow");
    resetVerdicts();
    const out = await Promise.all(Array.from({ length: 39 }, (_, i) => attempt(email, `wrong-overflow-${i}-a4`, net(i))));
    const counter = await addrCount(email);
    const v = { wrong: verdicts.wrong, right: verdicts.right, failClosedErrors: [...new Set(verdicts.errors)].map((m) => `${verdicts.errors.filter((x) => x === m).length}x ${m}`) };
    const right = await attempt(email, PASSWORD, net(201));
    report("A4-OVERFLOW", { role: ROLE, tally: tally(out), verdicts: v, refusedWithoutVerdict: out.filter((o) => o === "refused").length - v.wrong, addressCounterAfter: counter, rightPasswordAfter: right });
    expect(v.wrong, "wrong guesses judged").toBe(ADDR_MAX);
    expect(counter).toBe(ADDR_MAX);
    expect(right).toBe("code:rate_limited");
  }, 600_000);

  it("a successful sign-in gives its reserved slot back: the counter is what it was before", async () => {
    const email = E("refund");
    const seeded = 5;
    await prisma.rateLimitHit.createMany({
      data: Array.from({ length: seeded }, () => ({ bucket: lockoutKeys(t.slug, email, "x").addr })),
    });
    used.push({ email, ip: "x" });
    const ok = await attempt(email, PASSWORD, net(202));
    const counter = await addrCount(email);
    report("A4-REFUND", { role: ROLE, outcome: ok, seeded, counterAfter: counter });
    expect(ok).toBe("admitted");
    expect(counter, "a correct password spends nothing").toBe(seeded);
    // And a wrong one does spend: the reservation is kept.
    expect(await attempt(email, "wrong-refund-a4", net(203))).toBe("refused");
    expect(await addrCount(email)).toBe(seeded + 1);
  }, 120_000);

  it("known-device exemption: at the cap the person's own device is still judged; an unknown network is not", async () => {
    const email = E("known");
    await prisma.rateLimitHit.createMany({
      data: Array.from({ length: ADDR_MAX }, () => ({ bucket: lockoutKeys(t.slug, email, "x").addr })),
    });
    used.push({ email, ip: "x" });
    const stranger = await attempt(email, PASSWORD, net(204));
    const own = await attempt(email, PASSWORD, KNOWN_IP, KNOWN_UA);
    const afterOwn = await addrCount(email);
    const ownWrong = await attempt(email, "wrong-known-a4", KNOWN_IP, KNOWN_UA);
    const afterOwnWrong = await addrCount(email);
    report("A4-KNOWN", { role: ROLE, stranger, own, afterOwn, ownWrong, afterOwnWrong });
    expect(stranger).toBe("code:rate_limited");
    expect(own).toBe("admitted");
    expect(afterOwn, "the exempt success is refunded too").toBe(ADDR_MAX);
    expect(ownWrong, "a wrong password from the known device is judged").toBe("refused");
    expect(afterOwnWrong, "and counted").toBe(ADDR_MAX + 1);
  }, 120_000);
});
