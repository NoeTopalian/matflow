// R6-N1 (security campaign iteration 2, lane A4, 10 Oct 2026) — unit cells for the failure-slot reservation in
// lib/auth-lockout.ts, driven through the REAL authorize() and the REAL lockout module over a fake Prisma that
// applies the reservation rule in memory. The Postgres behaviour (two connections, the advisory lock, both roles) is
// tests/integration/sec-a4-lockout-burst-db.test.ts; this file pins what that one cannot see cheaply:
//   - the slot is reserved BEFORE the password is judged (bcrypt), for every address, with or without an account;
//   - a correct password gives the address slot back, a wrong one keeps it;
//   - a reservation the database cannot make refuses even the right password (fail closed);
//   - the known-device exemption still applies when a concurrent burst fills the cap between the read and the
//     reservation;
//   - the lock namespace is lane C3's;
//   - SF-121 (lane A5, 10 Oct 2026): in the single reservation statement the known-device exemption is evaluated
//     AFTER, and only inside, the network-cap check — it can lift the address cap, never the network cap. Pinned on
//     the SQL itself (its grant expression is parsed from lib/auth-lockout.ts and evaluated as a truth table) and
//     through authorize() with the fake granting by that parsed rule.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;

const h = vi.hoisted(() => ({
  authorize: undefined as undefined | Authorize,
  trace: [] as string[],
  hits: [] as { bucket: string; id?: string }[],
  member: null as unknown,
  known: false,
  reserveFails: false,
  // Simulates a burst that fills the address cap between the unlocked read and the reservation.
  addrFilledByBurst: false,
  // SF-121 (lane A5): simulates a burst on THIS network that fills the network cap between the read and the reservation.
  pairFilledByBurst: false,
  // When set, the fake grants a reservation by the rule parsed out of lib/auth-lockout.ts's SQL (not its own copy).
  sourceRule: undefined as undefined | ((pn: number, an: number, exempt: boolean) => boolean),
  deletes: [] as unknown[],
}));

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) h.authorize = p.authorize;
    return { handlers: {}, auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false, isProductionDatabase: () => false }));
vi.mock("@/lib/pending-tenant-cookie", () => ({ readPendingTenantSlug: async () => null, clearPendingTenantSlug: async () => {} }));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
const PASSWORD = "secA4-correct-horse-battery";
vi.mock("bcryptjs", () => ({
  default: {
    compare: async (pw: string) => {
      h.trace.push("bcrypt");
      return pw === "secA4-correct-horse-battery";
    },
    hashSync: () => "$2a$12$secA4dummyhashdummyhashdummyhashdummyhashdummyhash00",
  },
}));

const TENANT = { id: "t-a4", slug: "a4-club", name: "A4", primaryColor: "#000000", secondaryColor: "#111111", textColor: "#ffffff", subscriptionStatus: "active", deletedAt: null };
const MEMBER = () => ({
  id: "m-a4", tenantId: "t-a4", email: "someone@example.test", name: "A4 Member", passwordHash: "$2a$12$member",
  sessionVersion: 0, failedLoginCount: 0, lockedUntil: null, totpEnabled: false, notifyOnNewLogin: false,
});

function client(): Record<string, unknown> {
  return {
    tenant: { findUnique: async () => TENANT },
    user: { findUnique: async () => null, update: async () => ({}) },
    member: { findUnique: async () => h.member, update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    loginEvent: {
      findFirst: async () => {
        h.trace.push("known-device-lookup");
        return h.known ? { id: "le" } : null;
      },
    },
    rateLimitHit: {
      count: async ({ where }: { where: { bucket: string } }) => h.hits.filter((x) => x.bucket === where.bucket).length,
      createMany: async () => {
        h.trace.push("late-insert");
        return { count: 2 };
      },
      deleteMany: async (args: { where: { bucket?: string; OR?: { bucket?: string; id?: string }[] } }) => {
        h.deletes.push(args.where);
        const conds: { bucket?: string; id?: string }[] = args.where.OR ?? [args.where];
        h.hits = h.hits.filter((x) => !conds.some((c) => (c.bucket !== undefined && x.bucket === c.bucket) || (c.id !== undefined && x.id === c.id)));
        return { count: 0 };
      },
    },
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      h.trace.push(`lock:${values[0]}`);
      return 1;
    },
    $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      if (h.reserveFails) throw Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" });
      const str = values.filter((v): v is string => typeof v === "string");
      const pair = str.find((v) => v.startsWith("authfail:pair:"))!;
      const addr = str.find((v) => v.startsWith("authfail:addr:"))!;
      const [pairId, addrId] = str.filter((v) => v.startsWith("lk_"));
      const exempt = values.find((v) => typeof v === "boolean") === true;
      if (h.addrFilledByBurst) {
        h.addrFilledByBurst = false;
        for (let i = 0; i < 10; i++) h.hits.push({ bucket: addr });
      }
      if (h.pairFilledByBurst) {
        h.pairFilledByBurst = false;
        for (let i = 0; i < 10; i++) h.hits.push({ bucket: pair });
      }
      const pn = h.hits.filter((x) => x.bucket === pair).length;
      const an = h.hits.filter((x) => x.bucket === addr).length;
      const ok = h.sourceRule ? h.sourceRule(pn, an, exempt) : pn < 10 && (an < 10 || exempt);
      h.trace.push(`reserve:${ok ? "granted" : "refused"}${exempt ? ":exempt" : ""}`);
      if (ok) h.hits.push({ bucket: pair, id: pairId }, { bucket: addr, id: addrId });
      return [{ pairCount: pn, addrCount: an, inserted: ok ? 2 : 0 }];
    },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(client()),
  };
}
vi.mock("@/lib/prisma", () => ({ prisma: client() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async (fn: (t: unknown) => unknown) => fn(client()),
  withTenantContext: async (_id: string, fn: (t: unknown) => unknown) => fn(client()),
}));

const lockout = await import("@/lib/auth-lockout");
const KEYS = () => lockout.lockoutKeys(TENANT.slug, "someone@example.test", "198.51.100.77");

async function attempt(password: string) {
  if (!h.authorize) await import("@/auth");
  h.trace = [];
  try {
    const r = await h.authorize!(
      { email: "someone@example.test", password, tenantSlug: TENANT.slug },
      new Request("http://localhost/api/auth/callback/credentials", { method: "POST", headers: { "x-vercel-forwarded-for": "198.51.100.77", "user-agent": "secA4-ua" } }),
    );
    return r ? "admitted" : "refused";
  } catch (e) {
    return `code:${(e as { code?: string }).code ?? "error"}`;
  }
}
const addrHits = () => h.hits.filter((x) => x.bucket === KEYS().addr).length;

beforeEach(() => {
  Object.assign(h, { hits: [], member: MEMBER(), known: false, reserveFails: false, addrFilledByBurst: false, pairFilledByBurst: false, sourceRule: undefined, deletes: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the slot is reserved before the password is judged", () => {
  it("lock namespace is lane C3's (RATE_LIMIT_LOCK_NS), and the lock is on the ADDRESS bucket", async () => {
    const rl = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
    expect(lockout.LOCKOUT_LOCK_NS).toBe(rl.RATE_LIMIT_LOCK_NS);
    await attempt("wrong-a4");
    expect(h.trace).toContain(`lock:${rl.RATE_LIMIT_LOCK_NS}`);
    const src = (await import("node:fs")).readFileSync("lib/auth-lockout.ts", "utf8");
    expect(src).toMatch(/pg_advisory_xact_lock\(\$\{LOCKOUT_LOCK_NS\}::int4, hashtext\(\$\{keys\.addr\}::text\)\)/);
  });

  for (const [label, member] of [["an existing member", true], ["an address with no account", false]] as const) {
    for (const pw of [PASSWORD, "wrong-a4"]) {
      it(`${label}, ${pw === PASSWORD ? "right" : "wrong"} password: lock → reservation → bcrypt, in that order, no late insert`, async () => {
        h.member = member ? MEMBER() : null;
        await attempt(pw);
        const iLock = h.trace.findIndex((t) => t.startsWith("lock:"));
        const iRes = h.trace.findIndex((t) => t.startsWith("reserve:"));
        const iBcrypt = h.trace.indexOf("bcrypt");
        expect(iLock).toBeGreaterThanOrEqual(0);
        expect(iLock).toBeLessThan(iRes);
        expect(iRes, "reservation before the password is judged").toBeLessThan(iBcrypt);
        expect(h.trace).not.toContain("late-insert");
      });
    }
  }
});

describe("refund: a correct password spends nothing, a wrong one keeps its slot", () => {
  it("right password: admitted, and its address slot is deleted by id together with this network's pair counter", async () => {
    h.hits = Array.from({ length: 5 }, () => ({ bucket: KEYS().addr }));
    expect(await attempt(PASSWORD)).toBe("admitted");
    expect(addrHits()).toBe(5);
    const where = h.deletes.at(-1) as { OR: { bucket?: string; id?: string }[] };
    expect(where.OR).toEqual(expect.arrayContaining([{ bucket: KEYS().pair }, { id: expect.stringMatching(/^lk_/) }]));
  });
  it("wrong password: refused, and the reserved slot stays (it IS the recorded failure)", async () => {
    h.hits = Array.from({ length: 5 }, () => ({ bucket: KEYS().addr }));
    expect(await attempt("wrong-a4")).toBe("refused");
    expect(addrHits()).toBe(6);
    expect(h.deletes).toEqual([]);
  });
  it("recordFailure without a reservation refuses rather than counting late", async () => {
    await expect(lockout.recordFailure(KEYS())).rejects.toThrow(/without a reservation/);
  });
});

describe("fail closed and the known-device exemption", () => {
  it("a reservation the database cannot make refuses even the RIGHT password", async () => {
    h.reserveFails = true;
    expect(await attempt(PASSWORD)).toBe("refused");
  });
  it("cap filled by a concurrent burst after the read: an unknown device gets the one generic code", async () => {
    h.addrFilledByBurst = true;
    expect(await attempt(PASSWORD)).toBe("code:rate_limited");
    expect(h.trace).toContain("known-device-lookup");
  });
  it("cap filled by a concurrent burst after the read: the person's known device is still judged (exempt reservation)", async () => {
    h.addrFilledByBurst = true;
    h.known = true;
    expect(await attempt(PASSWORD)).toBe("admitted");
    expect(h.trace).toEqual(expect.arrayContaining(["reserve:refused", "known-device-lookup", "reserve:granted:exempt"]));
  });
  it("cap already reached at the read: an unknown device is refused WITHOUT queueing on the lock", async () => {
    h.hits = Array.from({ length: 10 }, () => ({ bucket: KEYS().addr }));
    expect(await attempt(PASSWORD)).toBe("code:rate_limited");
    expect(h.trace.some((t) => t.startsWith("lock:"))).toBe(false);
  });
});

// SF-121 (lane A5). The grant expression of reserve()'s single statement, read from the source and turned into a
// function of (pair count, address count, exempt). Only the tokens the expression may contain are accepted; anything
// else fails the parse rather than being evaluated.
function sourceGrantRule(): { sql: string; rule: (pn: number, an: number, exempt: boolean) => boolean; reserveFn: string } {
  const src = readFileSync("lib/auth-lockout.ts", "utf8");
  const start = src.indexOf("async function reserve(");
  const end = src.indexOf("export async function lockoutState(");
  expect(start, "reserve() in lib/auth-lockout.ts").toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const reserveFn = src.slice(start, end);
  const m = reserveFn.match(/SELECT pw\.n AS pn, aw\.n AS an,\s*([\s\S]*?)\s+AS ok\b/);
  expect(m, "the grant expression (… AS ok) in reserve()'s SQL").not.toBeNull();
  const sql = m![1].trim();
  const js = sql
    .replace(/::\w+/g, "")
    .replace(/\$\{PAIR_MAX\}/g, String(lockout.PAIR_MAX))
    .replace(/\$\{ADDR_MAX\}/g, String(lockout.ADDR_MAX))
    .replace(/\$\{addrExempt\}/g, "exempt")
    .replace(/\bpw\.n\b/g, "pn")
    .replace(/\baw\.n\b/g, "an")
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/\bNOT\b/g, "!")
    .replace(/<>/g, "!==")
    .replace(/(?<![<>!=])=(?!=)/g, "===");
  expect(js, `only counts, caps, the exemption and boolean/comparison operators in: ${sql}`).toMatch(/^[\s()0-9a-z<>=!&|]*$/);
  expect(new Set(js.match(/[a-z]+/g) ?? []), "identifiers in the grant expression").toEqual(
    new Set((js.match(/[a-z]+/g) ?? []).filter((w) => ["pn", "an", "exempt", "true", "false"].includes(w))),
  );
  const rule = new Function("pn", "an", "exempt", `return (${js});`) as (pn: number, an: number, exempt: boolean) => boolean;
  return { sql, rule, reserveFn };
}

describe("SF-121: the known-device exemption lifts the address cap only, never the network cap", () => {
  it("in the single reservation statement the exemption is evaluated after the network-cap check, inside the address clause (truth table over the parsed SQL)", () => {
    const { sql, rule, reserveFn } = sourceGrantRule();
    // One statement decides and inserts: one $queryRaw in reserve(), and the inserts are gated by its grant.
    expect(reserveFn.match(/\$queryRaw/g)?.length, "one reservation statement").toBe(1);
    expect(reserveFn).toMatch(/WHERE go\.ok/);
    // Order in the expression: the network cap comes first; the exemption appears only after it.
    const iPair = sql.indexOf("pw.n");
    const iExempt = sql.indexOf("${addrExempt}");
    expect(iPair, "network-cap term").toBeGreaterThanOrEqual(0);
    expect(iExempt, "exemption term").toBeGreaterThan(iPair);
    // Semantics: granted iff pair < PAIR_MAX AND (addr < ADDR_MAX OR exempt), for counts around both caps.
    const { PAIR_MAX: P, ADDR_MAX: A } = lockout;
    const wrong: string[] = [];
    for (const pn of [0, P - 1, P, P + 5])
      for (const an of [0, A - 1, A, A + 5])
        for (const exempt of [false, true]) {
          const want = pn < P && (an < A || exempt);
          if (Boolean(rule(pn, an, exempt)) !== want) wrong.push(`pair=${pn} addr=${an} exempt=${exempt}: got ${!want}, want ${want}`);
        }
    expect(wrong, `grant expression: ${sql}`).toEqual([]);
  });

  it("through authorize(), fake granting by the SQL's own rule: address at its cap, known device, a burst fills THIS network's cap after the read → refused with the generic code, no slot granted", async () => {
    h.sourceRule = sourceGrantRule().rule;
    h.hits = Array.from({ length: 10 }, () => ({ bucket: KEYS().addr }));
    h.known = true;
    h.pairFilledByBurst = true;
    expect(await attempt(PASSWORD)).toBe("code:rate_limited");
    expect(h.trace).toEqual(expect.arrayContaining(["known-device-lookup", "reserve:refused:exempt"]));
    // bcrypt still runs (equal cost, auth.ts), but no slot was granted, so its result is never a verdict.
    expect(h.trace.some((t) => t.startsWith("reserve:granted")), "no slot granted").toBe(false);
  });

  it("positive control: same address at its cap, same known device, network below its cap → the exempt reservation is granted and the right password admitted", async () => {
    h.sourceRule = sourceGrantRule().rule;
    h.hits = Array.from({ length: 10 }, () => ({ bucket: KEYS().addr }));
    h.known = true;
    expect(await attempt(PASSWORD)).toBe("admitted");
    expect(h.trace).toEqual(expect.arrayContaining(["known-device-lookup", "reserve:granted:exempt", "bcrypt"]));
  });

  it("network AND address at their caps at the read: refused before the exemption is even resolved, without queueing on the lock", async () => {
    h.hits = [...Array.from({ length: 10 }, () => ({ bucket: KEYS().addr })), ...Array.from({ length: 10 }, () => ({ bucket: KEYS().pair }))];
    h.known = true;
    expect(await attempt(PASSWORD)).toBe("code:rate_limited");
    expect(h.trace).not.toContain("known-device-lookup");
    expect(h.trace.some((t) => t.startsWith("lock:") || t.startsWith("reserve:"))).toBe(false);
  });
});
