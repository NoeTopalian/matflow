// SF-35 residuals R3-2 and R3-3 (security campaign iteration 2, lane A3, 9 Oct 2026).
//
// Review R3 found two ways the credentials door still told an attacker
// something about an address it should not:
//
//  R3-2  An account row-locked by "Wasn't me?" or by an operator returned null
//        BEFORE the failure was recorded, so it answered "refused" for ever,
//        while an address with no account answered refused x10 and then
//        rate_limited. Twelve guesses told locked accounts apart.
//  R3-3  A wrong password for an EXISTING account ran one extra transaction
//        (the failedLoginCount increment) that an address with no account did
//        not: +205..263 ms on the review link, a few ms in region, averageable.
//
// This file drives the REAL authorize() and the REAL lib/auth-lockout.ts over a
// recording fake of Prisma. Every top-level query and every transaction (with
// the number of statements inside it) is written to a trace; the trace for an
// existing member, an existing staff account and a row-locked account must be
// IDENTICAL to the trace for an address with no account, at 0, 9, 10 and 11
// prior failures. Same answer, same round trips.
//
// It also kills R3's surviving mutant "skip the known-device lookup for
// non-existent addresses" (the capped path would then run an empty transaction
// for a ghost and a one-statement one for a real account).

import { vi, describe, it, expect, beforeEach } from "vitest";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;

const h = vi.hoisted(() => ({
  authorize: undefined as undefined | Authorize,
  trace: [] as string[],
  hits: [] as { bucket: string; hitAt: number }[],
  user: null as unknown,
  member: null as unknown,
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
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: async () => null,
  clearPendingTenantSlug: async () => {},
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
// The per-IP attempt brake is existence-independent and lives in lib/rate-limit;
// the attacker paces under it. Kept out of the trace.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
// bcrypt is not what this file measures (the DB test uses real cost 12).
const PASSWORD = "secA3-correct-horse-battery";
vi.mock("bcryptjs", () => ({
  default: {
    compare: async (pw: string) => pw === "secA3-correct-horse-battery",
    hashSync: () => "$2a$12$secA3dummyhashdummyhashdummyhashdummyhashdummyhash00",
  },
}));

// ── A recording Prisma ─────────────────────────────────────────────────────
const TENANT = {
  id: "t-a3", slug: "a3-club", name: "A3", primaryColor: "#000000", secondaryColor: "#111111", textColor: "#ffffff",
  subscriptionStatus: "active", deletedAt: null,
};

function client(sink: (op: string) => void) {
  const op = <T,>(name: string, fn: () => T) => async (..._args: unknown[]) => {
    sink(name);
    return fn();
  };
  return {
    tenant: { findUnique: op("tenant.findUnique", () => TENANT) },
    user: {
      findUnique: op("user.findUnique", () => h.user),
      update: op("user.update", () => ({ failedLoginCount: 1 })),
      updateMany: op("user.updateMany", () => ({ count: 1 })),
    },
    member: {
      findUnique: op("member.findUnique", () => h.member),
      update: op("member.update", () => ({ failedLoginCount: 1 })),
      updateMany: op("member.updateMany", () => ({ count: 0 })),
    },
    loginEvent: { findFirst: op("loginEvent.findFirst", () => null) },
    rateLimitHit: {
      count: async (args: { where: { bucket: string } }) => {
        sink("rateLimitHit.count");
        return h.hits.filter((x) => x.bucket === args.where.bucket).length;
      },
      createMany: async (args: { data: { bucket: string }[] }) => {
        sink("rateLimitHit.createMany");
        for (const d of args.data) h.hits.push({ bucket: d.bucket, hitAt: Date.now() });
        return { count: args.data.length };
      },
      deleteMany: async (args: { where: { bucket: string } }) => {
        sink("rateLimitHit.deleteMany");
        h.hits = h.hits.filter((x) => x.bucket !== args.where.bucket);
        return { count: 0 };
      },
    },
  };
}

const top = client((name) => h.trace.push(`q:${name}`));
vi.mock("@/lib/prisma", () => ({ prisma: top }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => {
    let n = 0;
    try {
      return await fn(client(() => n++));
    } finally {
      h.trace.push(`bypass-tx:${n}`);
    }
  },
  // One entry per transaction, carrying how many statements ran inside it:
  // the unit that costs round trips. Which model was touched is NOT recorded
  // (a member row and a sentinel no-op differ by name, not by cost).
  withTenantContext: async <T,>(_tenantId: string, fn: (t: unknown) => Promise<T>) => {
    let n = 0;
    try {
      return await fn(client(() => n++));
    } finally {
      h.trace.push(`tenant-tx:${n}`);
    }
  },
}));

// Dynamic, so it loads after the recording client above exists (a static
// import is hoisted above it and would load lib/prisma's mock too early).
const { lockoutKeys } = await import("@/lib/auth-lockout");

const EMAIL = "someone@example.test";
const IP = "198.51.100.77";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const LOCKED_UNTIL = () => new Date(Date.now() + 24 * 3600 * 1000);

const MEMBER = (extra: Record<string, unknown> = {}) => ({
  id: "m-a3", tenantId: "t-a3", email: EMAIL, name: "A3 Member", passwordHash: "$2a$12$member",
  sessionVersion: 0, failedLoginCount: 0, lockedUntil: null, totpEnabled: false, notifyOnNewLogin: false, ...extra,
});
const USER = (extra: Record<string, unknown> = {}) => ({
  id: "u-a3", tenantId: "t-a3", email: EMAIL, name: "A3 Coach", role: "coach", passwordHash: "$2a$12$user",
  sessionVersion: 0, failedLoginCount: 0, lockedUntil: null, totpEnabled: false, notifyOnNewLogin: false,
  mustChangePassword: false, loginEmailProvisionalSince: null, ...extra,
});

type Kind = "none" | "member" | "user" | "locked-member" | "locked-user";
function arrange(kind: Kind) {
  h.user = kind === "user" ? USER() : kind === "locked-user" ? USER({ lockedUntil: LOCKED_UNTIL() }) : null;
  h.member = kind === "member" ? MEMBER() : kind === "locked-member" ? MEMBER({ lockedUntil: LOCKED_UNTIL() }) : null;
}

function seed(addrFailures: number, pairFailures = 0) {
  const k = lockoutKeys(TENANT.slug, EMAIL, IP);
  h.hits = [
    ...Array.from({ length: addrFailures }, () => ({ bucket: k.addr, hitAt: Date.now() })),
    ...Array.from({ length: pairFailures }, () => ({ bucket: k.pair, hitAt: Date.now() })),
  ];
}

async function attempt(password: string) {
  if (!h.authorize) await import("@/auth");
  h.trace = [];
  let outcome: string;
  try {
    const r = await h.authorize!(
      { email: EMAIL, password, tenantSlug: TENANT.slug },
      new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "x-vercel-forwarded-for": IP, "user-agent": UA },
      }),
    );
    outcome = r ? "admitted" : "refused";
  } catch (e) {
    outcome = `code:${(e as { code?: string }).code ?? "error"}`;
  }
  return { outcome, trace: [...h.trace] };
}

async function observe(kind: Kind, addrFailures: number, password = "wrong-password-a3") {
  arrange(kind);
  seed(addrFailures);
  return attempt(password);
}

beforeEach(() => {
  h.hits = [];
  h.trace = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("R3-3: a wrong password costs the same database work whether or not the account exists", () => {
  it("positive control: the right password for an unlocked member is admitted", async () => {
    expect((await observe("member", 0, PASSWORD)).outcome).toBe("admitted");
  });

  it("the trace is not empty and shows the expected shape for an address with no account", async () => {
    const none = await observe("none", 0);
    expect(none.outcome).toBe("refused");
    // tenant lookup, account lookup, two counter reads, the failure write and
    // re-count, and ONE row-counter transaction with ONE statement — the
    // no-op an address without an account must still pay for.
    expect(none.trace).toEqual([
      "bypass-tx:1",
      "tenant-tx:2",
      "q:rateLimitHit.count",
      "q:rateLimitHit.count",
      "q:rateLimitHit.createMany",
      "q:rateLimitHit.count",
      "tenant-tx:1",
    ]);
  });

  for (const kind of ["member", "user", "locked-member", "locked-user"] as const) {
    for (const n of [0, 9, 10, 11]) {
      it(`${kind} at ${n} prior failures: same answer and same transactions as an address with no account`, async () => {
        const none = await observe("none", n);
        const real = await observe(kind, n);
        expect(real.outcome, "response code").toBe(none.outcome);
        expect(real.trace, "database round trips (transactions and statements)").toEqual(none.trace);
      });
    }
  }

  it("the capped path runs the known-device lookup for an address with no account (R3's surviving mutant)", async () => {
    // At the address-wide cap the known-device lookup runs. If it were skipped
    // for an address with no account, the ghost would answer one statement
    // (one round trip) sooner than a real account.
    const none = await observe("none", 10);
    expect(none.outcome).toBe("code:rate_limited");
    expect(none.trace, "one transaction with one statement: the known-device lookup").toContain("tenant-tx:1");
    const member = await observe("member", 10);
    expect(member.trace).toEqual(none.trace);
  });
});

describe("R3-2: a row-locked account counts its refusals exactly like any other address", () => {
  for (const kind of ["locked-member", "locked-user"] as const) {
    it(`${kind}: twelve wrong passwords give the same answers as an address with no account`, async () => {
      const seq = async (k: Kind) => {
        arrange(k);
        seed(0);
        const out: string[] = [];
        for (let i = 0; i < 12; i++) out.push((await attempt("wrong-password-a3")).outcome);
        return out;
      };
      const none = await seq("none");
      const locked = await seq(kind);
      expect(none.slice(10), "control: an address with no account is capped after ten").toEqual([
        "code:rate_limited",
        "code:rate_limited",
      ]);
      expect(locked).toEqual(none);
    });
  }

  it("each refused attempt on a locked row writes both counters (address and address+network)", async () => {
    arrange("locked-member");
    seed(0);
    await attempt("wrong-password-a3");
    const k = lockoutKeys(TENANT.slug, EMAIL, IP);
    expect(h.hits.filter((x) => x.bucket === k.addr)).toHaveLength(1);
    expect(h.hits.filter((x) => x.bucket === k.pair)).toHaveLength(1);
  });

  it("the RIGHT password on a locked row is still refused, and that refusal is counted too", async () => {
    arrange("locked-member");
    seed(0);
    const r = await attempt(PASSWORD);
    expect(r.outcome).toBe("refused");
    const k = lockoutKeys(TENANT.slug, EMAIL, IP);
    expect(h.hits.filter((x) => x.bucket === k.addr)).toHaveLength(1);
  });
});
