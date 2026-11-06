// Speed quick win 2c (6 Nov 2026): the no-argument auth() is wrapped in React
// cache(), so the layout, the page and any server component that ask during
// ONE render share one session check instead of running jwt() (and its
// revocation lookup) once each.
//
// The property that must survive the change: revocation is still checked on
// EVERY request. These cases drive the REAL jwt() and session() callbacks out
// of the NextAuth({ … }) config and the REAL lib/session-revocation.ts, with
// next-auth's auth() standing in for what NextAuth does per call (decode the
// cookie, run jwt(), run session()).
//
// Vitest loads React's client build, whose cache() memoises nothing. React's
// server build memoises per render pass and, outside one (route handlers,
// server actions), memoises nothing. The mock below reproduces exactly that:
// a scope per simulated render, none outside it.

import { vi, describe, it, expect, beforeEach } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const captured: { jwt?: Jwt; session?: SessionCb } = {};

const h = vi.hoisted(() => ({
  authMock: vi.fn(),
  renderScope: { current: null as Map<unknown, unknown> | null },
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  resolveActiveImpersonation: vi.fn(),
  hasImpersonationCookie: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const cache = <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      const scope = h.renderScope.current;
      if (!scope) return fn(...a); // not a render pass: every call runs
      if (!scope.has(fn)) scope.set(fn, fn(...a));
      return scope.get(fn) as R;
    };
  return { ...actual, default: { ...actual, cache }, cache };
});

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { jwt?: Jwt; session?: SessionCb } }) => {
    if (config.callbacks?.jwt) captured.jwt = config.callbacks.jwt;
    if (config.callbacks?.session) captured.session = config.callbacks.session;
    return { handlers: {}, auth: h.authMock, signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));

const tx = {
  user: { findUnique: h.userFindUnique, findFirst: vi.fn(), update: vi.fn() },
  member: { findUnique: h.memberFindUnique, findFirst: vi.fn(), update: vi.fn() },
  tenant: { findUnique: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/impersonation", () => ({
  resolveActiveImpersonation: h.resolveActiveImpersonation,
  hasImpersonationCookie: h.hasImpersonationCookie,
}));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false, isProductionDatabase: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/pending-tenant-cookie", () => ({ readPendingTenantSlug: vi.fn(), clearPendingTenantSlug: vi.fn() }));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));

const ROW = { sessionVersion: 3, name: "Coach Synthetic", tenantId: "t-cache" };

/** The token the browser's cookie carries on every request. */
const COOKIE_TOKEN = {
  id: "u-cache-coach",
  role: "coach",
  tenantId: "t-cache",
  tenantSlug: "cache-club",
  tenantName: "Cache Club",
  sessionVersion: 3,
  memberId: null,
  mustChangePassword: false,
  totpPending: false,
  name: "Coach Synthetic",
};

type ServerAuth = () => Promise<{ user?: { id?: string } } | null>;

async function loadAuth(): Promise<ServerAuth> {
  const mod = await import("@/auth");
  return mod.auth as unknown as ServerAuth;
}

/** One server render: a fresh cache scope for its duration, like React's. */
async function inOneRender<T>(fn: () => Promise<T>): Promise<T> {
  h.renderScope.current = new Map();
  try {
    return await fn();
  } finally {
    h.renderScope.current = null;
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.renderScope.current = null;
  h.resolveActiveImpersonation.mockResolvedValue(null);
  h.hasImpersonationCookie.mockResolvedValue(false);
  h.userFindUnique.mockResolvedValue(ROW);
  await import("@/auth");
  // What NextAuth's auth() does on each call: decode the cookie, run jwt()
  // (which runs the revocation check), then session().
  h.authMock.mockImplementation(async (...args: unknown[]) => {
    if (args.length > 0) return "request-form";
    const t = (await captured.jwt!({ token: { ...COOKIE_TOKEN } })) as Record<string, unknown> | null;
    if (t === null) return null;
    return captured.session!({
      session: { user: { name: t.name }, expires: new Date(Date.now() + 3600_000).toISOString() },
      token: t,
    });
  });
});

describe("auth() inside one render shares one session check", () => {
  it("layout + page + component ask three times: one jwt() run, one revocation lookup", async () => {
    const auth = await loadAuth();
    const [layout, page, component] = await inOneRender(() =>
      Promise.all([auth(), auth(), auth()]),
    );
    expect(layout?.user?.id).toBe("u-cache-coach");
    expect(page).toBe(layout);
    expect(component).toBe(layout);
    expect(h.authMock).toHaveBeenCalledTimes(1);
    expect(h.userFindUnique).toHaveBeenCalledTimes(1);
  });
});

describe("revocation is still checked on every request", () => {
  it("the next request runs the lookup again and sees a revocation made in between", async () => {
    const auth = await loadAuth();

    const first = await inOneRender(async () => [await auth(), await auth()]);
    expect(first[0]?.user?.id).toBe("u-cache-coach");
    expect(h.userFindUnique).toHaveBeenCalledTimes(1);

    // Between the two requests: "sign out everywhere", a password reset or a
    // staff removal bumps the row's version.
    h.userFindUnique.mockResolvedValue({ ...ROW, sessionVersion: 4 });

    const second = await inOneRender(async () => [await auth(), await auth()]);
    expect(second[0]).toBeNull();
    expect(second[1]).toBeNull();
    expect(h.userFindUnique).toHaveBeenCalledTimes(2);
  });

  it("route handlers and server actions are not a render pass: every call checks", async () => {
    const auth = await loadAuth();
    expect((await auth())?.user?.id).toBe("u-cache-coach");
    h.userFindUnique.mockResolvedValue({ ...ROW, sessionVersion: 4 });
    expect(await auth()).toBeNull();
    expect(h.userFindUnique).toHaveBeenCalledTimes(2);
  });

  it("a revoked session in one render stays refused for the whole render", async () => {
    h.userFindUnique.mockResolvedValue({ ...ROW, sessionVersion: 4 });
    const auth = await loadAuth();
    const results = await inOneRender(() => Promise.all([auth(), auth()]));
    expect(results).toEqual([null, null]);
  });
});

describe("the forms with arguments are untouched", () => {
  it("auth(handler) / auth(req) pass straight through, uncached", async () => {
    const auth = (await import("@/auth")).auth as unknown as (...a: unknown[]) => unknown;
    await inOneRender(async () => {
      expect(await auth("x")).toBe("request-form");
      expect(await auth("x")).toBe("request-form");
    });
    expect(h.authMock).toHaveBeenCalledTimes(2);
  });
});
