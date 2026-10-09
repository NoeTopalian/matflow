// SEC-012 / admin hub AH-G7 (security campaign lane A, 9 Oct 2026):
// unavailable revocation state never grants protected access.
//
// Until 9 Oct the jwt() callback in auth.ts treated a revocation check it
// could not complete ("unknown": the lookup threw) as "carry on": the token
// was kept and session() returned the full user, so for as long as the lookup
// kept failing EVERY revocation in the product (password reset, log out
// everywhere, staff removal, suspension) failed open, on any request whose
// later queries happened to succeed. These cases drive the REAL callbacks out
// of the NextAuth({ … }) config and the REAL lib/session-revocation.ts (not
// mocked), with the database lookup failing the ways a database fails:
// statement timeout, connection loss, pool exhaustion, an unreachable server,
// a permission rejection, and malformed results. Every protected-route case
// has a positive control on the same harness with a healthy lookup.
//
// The database-backed counterpart (real pg errors on the TEST branch, both
// roles) is tests/integration/sec-a-revocation-fail-closed-db.test.ts.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const captured: { jwt?: Jwt; session?: SessionCb } = {};

const h = vi.hoisted(() => ({
  authMock: vi.fn(),
  redirectMock: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  resolveActiveImpersonation: vi.fn(),
  hasImpersonationCookie: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  memberUpdate: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: h.captureException }));
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
vi.mock("next/navigation", () => ({ redirect: h.redirectMock }));

const tx = {
  user: { findUnique: h.userFindUnique, findFirst: vi.fn(), update: h.userUpdate },
  member: { findUnique: h.memberFindUnique, findFirst: vi.fn(), update: h.memberUpdate },
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
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/pending-tenant-cookie", () => ({ readPendingTenantSlug: vi.fn(), clearPendingTenantSlug: vi.fn() }));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));

const ROW = { sessionVersion: 3, name: "Coach Synthetic", tenantId: "t-secA" };

function coachToken(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "u-secA-coach",
    role: "coach",
    tenantId: "t-secA",
    tenantSlug: "seca-club",
    tenantName: "secA Club",
    sessionVersion: 3,
    memberId: null,
    mustChangePassword: false,
    totpPending: false,
    name: "Coach Synthetic",
    ...extra,
  };
}

async function jwt(token: Record<string, unknown>) {
  if (!captured.jwt) await import("@/auth");
  return (await captured.jwt!({ token })) as Record<string, unknown> | null;
}

/**
 * What a route's server-side auth() returns: jwt() → null gives null (every
 * gate reads it as signed out; the server-side auth() applies no Set-Cookie,
 * so the browser keeps its cookie and the next request is checked afresh);
 * otherwise session() runs.
 */
async function sessionAction(token: Record<string, unknown>) {
  const t = await jwt(token);
  if (t === null) return { admitted: false as const, session: null, token: null };
  const session = (await captured.session!({
    session: { user: { name: t.name, email: t.email }, expires: new Date(Date.now() + 3600_000).toISOString() },
    token: t,
  })) as { user?: Record<string, unknown> };
  return { admitted: !!session?.user, session, token: t };
}

/** The ways a database fails, as the driver / Prisma reports them. */
const DB_FAILURES: [string, () => Error][] = [
  ["statement timeout (57014)", () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })],
  ["connection loss", () => new Error("Connection terminated unexpectedly")],
  ["pool exhausted", () => new Error("timeout exceeded when trying to connect")],
  ["server unreachable (P1001)", () => Object.assign(new Error("Can't reach database server"), { code: "P1001" })],
  ["permission rejection (42501)", () => Object.assign(new Error("permission denied for table User"), { code: "42501" })],
  ["transaction timeout (P2028)", () => Object.assign(new Error("Transaction API error: Transaction already closed"), { code: "P2028" })],
];

/** Results a lookup could return that prove nothing. */
const MALFORMED: [string, unknown][] = [
  ["version as a string", { sessionVersion: "3", name: "x", tenantId: "t-secA" }],
  ["no version at all", { name: "x", tenantId: "t-secA" }],
  ["null version", { sessionVersion: null, tenantId: "t-secA" }],
  ["fractional version", { sessionVersion: 3.5, tenantId: "t-secA" }],
  ["negative version", { sessionVersion: -1, tenantId: "t-secA" }],
  ["a bare number", 3],
  ["a string", "ok"],
  ["undefined", undefined],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveActiveImpersonation.mockResolvedValue(null);
  h.hasImpersonationCookie.mockResolvedValue(false);
  h.userFindUnique.mockResolvedValue(ROW);
  h.memberFindUnique.mockResolvedValue({ sessionVersion: 1, name: "Member", tenantId: "t-secA" });
  h.userUpdate.mockResolvedValue({});
  h.memberUpdate.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function protectedSurfaces(session: unknown) {
  h.authMock.mockResolvedValue(session);
  const { requireApiStaff } = await import("@/lib/api-authz");
  const gate = await requireApiStaff();
  const { requireSession } = await import("@/lib/authz");
  const page = await requireSession().then(
    () => "allowed",
    (e: Error) => e.message,
  );
  const { POST: logoutAll } = await import("@/app/api/auth/logout-all/route");
  const res = await logoutAll(new Request("http://localhost/api/auth/logout-all", { method: "POST" }));
  return { gate, page, logoutAllStatus: res.status };
}

describe("positive control: a healthy check admits the session (same harness)", () => {
  it("session has the user; API gate, page gate and a protected mutation all proceed", async () => {
    const r = await sessionAction(coachToken());
    expect(r.admitted).toBe(true);
    expect(r.session?.user?.id).toBe("u-secA-coach");
    const p = await protectedSurfaces(r.session);
    expect(p.gate.ok).toBe(true);
    expect(p.page).toBe("allowed");
    expect(p.logoutAllStatus).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledTimes(1);
  });

  it("a moved version is still revoked outright", async () => {
    h.userFindUnique.mockResolvedValue({ ...ROW, sessionVersion: 4 });
    expect((await sessionAction(coachToken())).session).toBeNull();
  });
});

describe.each(DB_FAILURES)("revocation lookup fails: %s", (_label, makeError) => {
  beforeEach(() => {
    h.userFindUnique.mockRejectedValue(makeError());
  });

  it("answers this request as signed out: auth() is null, never a session — and the cookie is KEPT (SF-44)", async () => {
    const r = await sessionAction(coachToken());
    // Lane A2 (SF-44): jwt() keeps the token, marked for revalidation, so the
    // cookie is re-issued rather than cleared; session() carries no user and
    // the exported auth() turns that into null for every caller.
    expect(r.admitted).toBe(false);
    expect(r.token, "token kept: a dependency failure does not sign anyone out").not.toBeNull();
    expect(typeof r.token?.revalidateSince).toBe("number");
    expect((r.session as { authUnavailable?: unknown }).authUnavailable).toBe(true);
    h.authMock.mockResolvedValue(r.session);
    const { auth } = await import("@/auth");
    expect(await (auth as unknown as () => Promise<unknown>)()).toBeNull();
  });

  it("refuses the API gate (401), the page gate (/login) and a protected mutation, with no write", async () => {
    const r = await sessionAction(coachToken());
    const p = await protectedSurfaces(r.session);
    expect(p.gate.ok).toBe(false);
    if (!p.gate.ok) expect(p.gate.response.status).toBe(401);
    expect(p.page).toBe("REDIRECT:/login");
    expect(p.logoutAllStatus).toBe(401);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("reports it as fail-CLOSED", async () => {
    await sessionAction(coachToken());
    expect(h.captureException).toHaveBeenCalled();
    expect(h.captureException.mock.calls.at(-1)?.[1]).toMatchObject({
      tags: { area: "auth", control: "session-revocation", failMode: "closed" },
    });
  });

  it("recovers on the next request once the lookup works (the cookie was never cleared server-side)", async () => {
    const cookie = coachToken();
    const first = await sessionAction({ ...cookie });
    expect(first.admitted).toBe(false);
    h.userFindUnique.mockResolvedValue(ROW);
    const second = await sessionAction({ ...cookie });
    expect(second.session?.user?.id).toBe("u-secA-coach");
  });

  it("a member session fails closed the same way", async () => {
    h.memberFindUnique.mockRejectedValue(makeError());
    const r = await sessionAction(coachToken({ id: "m-secA", role: "member", memberId: "m-secA", sessionVersion: 1 }));
    expect(r.admitted).toBe(false);
  });
});

describe.each(MALFORMED)("revocation lookup returns a malformed result: %s", (_label, row) => {
  it("is not admitted", async () => {
    h.userFindUnique.mockResolvedValue(row);
    const r = await sessionAction(coachToken());
    expect(r.admitted).toBe(false);
    h.authMock.mockResolvedValue(r.session);
    const { requireApiStaff } = await import("@/lib/api-authz");
    const gate = await requireApiStaff();
    expect(gate.ok).toBe(false);
  });
});

describe("malformed or confused TOKENS are revoked outright", () => {
  it.each([
    ["string version", "3"],
    ["missing version", undefined],
    ["fractional version", 3.5],
  ])("token with %s → no session", async (_l, v) => {
    const t = coachToken();
    if (v === undefined) delete t.sessionVersion;
    else t.sessionVersion = v;
    expect((await sessionAction(t)).session).toBeNull();
  });

  it("a row that resolves in ANOTHER club is not this session", async () => {
    h.userFindUnique.mockResolvedValue({ ...ROW, tenantId: "t-other" });
    expect((await sessionAction(coachToken())).session).toBeNull();
  });
});

describe("the other fail-open paths in jwt()", () => {
  it("a legacy temporary-password token whose stamp cannot be read is not admitted this request", async () => {
    // Revocation lookup fine; the one-off mustChangePassword read fails.
    h.userFindUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
      if (args?.select?.mustChangePassword) throw new Error("Connection terminated unexpectedly");
      return ROW;
    });
    const legacy = coachToken();
    delete legacy.mustChangePassword;
    const r = await sessionAction({ ...legacy });
    expect(r.admitted).toBe(false);
    // Positive control: the read works → stamped and admitted.
    h.userFindUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
      args?.select?.mustChangePassword ? { mustChangePassword: false } : ROW,
    );
    const ok = await sessionAction({ ...legacy });
    expect(ok.session?.user?.id).toBe("u-secA-coach");
  });

  it("a support swap that throws part-way ends the session instead of keeping a half-swapped token", async () => {
    h.hasImpersonationCookie.mockResolvedValue(true);
    h.resolveActiveImpersonation.mockResolvedValue({
      payload: { v: 2, adminUserId: "op-secA", opSv: 1, targetUserId: "u-target", targetTenantId: "t-victim", tsv: 2, reason: "synthetic", n: "nonce-secA-0123456789", exp: Math.floor(Date.now() / 1000) + 600 },
      // No `tenant` on the target: the swap throws after it has already
      // written the target's id into the token.
      target: { id: "u-target", role: "owner", sessionVersion: 2, tenantId: "t-victim", name: "Target" },
    });
    // The half-swapped token (target id and version, operator's role, no
    // impersonatedBy so no read-only enforcement) would pass the revocation
    // check against the target's own row; before the fix it was kept.
    h.userFindUnique.mockResolvedValue({ sessionVersion: 2, name: "Target", tenantId: "t-victim" });
    expect(await jwt(coachToken())).toBeNull();
  });

  it("an Edge pass never checks (Prisma is Node-only); the Node pass of the same request decides", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    h.userFindUnique.mockRejectedValue(new Error("must not be called at the edge"));
    const t = await jwt(coachToken());
    expect(t).not.toBeNull();
    expect(h.userFindUnique).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    expect((await sessionAction(coachToken())).admitted).toBe(false);
  });
});
