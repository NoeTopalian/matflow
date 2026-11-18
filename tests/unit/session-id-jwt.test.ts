// Session identity inside auth.ts jwt() (Round 8, 16 Nov 2026).
//
// Pins the guarantees behind "sign out ends this session and nothing else":
//   1. every sign-in is a new session with its own random id; independent sign-ins never share one;
//   2. every later pass keeps the id it was given, and hands it to the revocation check;
//   3. a token from before session ids gets its person's DERIVED id — the same on every copy — so no copy (a delayed
//      response, a second tab, a replayed cookie) can come back with a fresh id that escapes a sign-out;
//   4. a revoked id is refused (cookie cleared); a check that cannot run grants nothing.
//
// Same harness as tests/unit/support-carrier-jwt.test.ts: next-auth is mocked to capture the REAL callbacks.

import { sessionRowRaw } from "./helpers/session-row";
import { vi, describe, it, expect, beforeEach } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const captured: { jwt?: Jwt; session?: SessionCb } = {};

const { authMock, redirectMock, resolveActiveImpersonation, hasImpersonationCookie, userFindUnique, checkSessionVersion } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    redirectMock: vi.fn((to: string) => {
      throw new Error(`REDIRECT:${to}`);
    }),
    resolveActiveImpersonation: vi.fn(),
    hasImpersonationCookie: vi.fn(),
    userFindUnique: vi.fn(),
    checkSessionVersion: vi.fn(),
  }));

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { jwt?: Jwt; session?: SessionCb } }) => {
    if (config.callbacks?.jwt) captured.jwt = config.callbacks.jwt;
    if (config.callbacks?.session) captured.session = config.callbacks.session;
    return { handlers: {}, auth: authMock, signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const memberFindUniqueForRevocation = vi.fn();
const tx = {
  $queryRaw: sessionRowRaw({ member: { findUnique: (a: unknown) => memberFindUniqueForRevocation(a) }, user: { findUnique: (a: unknown) => userFindUnique(a) } }),
  user: { findUnique: userFindUnique, findFirst: vi.fn() },
  member: { findUnique: memberFindUniqueForRevocation, findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/impersonation", () => ({ resolveActiveImpersonation, hasImpersonationCookie }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(),
  clearPendingTenantSlug: vi.fn(),
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));


function signInUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u-1",
    role: "owner",
    sessionVersion: 0,
    tenantId: "t-1",
    tenantSlug: "club",
    tenantName: "Club",
    primaryColor: "#000",
    secondaryColor: "#111",
    textColor: "#fff",
    memberId: null,
    totpPending: false,
    requireTotpSetup: false,
    totpEnabled: true,
    ...overrides,
  };
}

async function signIn(overrides: Record<string, unknown> = {}) {
  if (!captured.jwt) await import("@/auth");
  return (await captured.jwt!({ token: { name: "Owner", email: "o@example.test" }, user: signInUser(overrides) })) as Record<string, unknown>;
}

async function pass(token: Record<string, unknown>) {
  if (!captured.jwt) await import("@/auth");
  return (await captured.jwt!({ token: structuredClone(token) })) as Record<string, unknown> | null;
}

/** A token minted before session ids: the claims an old cookie decodes to. */
function preReleaseToken(over: Record<string, unknown> = {}) {
  const t = { ...signInUser(), name: "Owner", email: "o@example.test", brandFetchedAt: 1, iat: 1, exp: 9e9, jti: "old" };
  return { ...t, ...over } as Record<string, unknown>;
}

const revoked = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  revoked.clear();
  hasImpersonationCookie.mockResolvedValue(false);
  resolveActiveImpersonation.mockResolvedValue(null);
  checkSessionVersion.mockImplementation(async (c: { sid?: string | null }) =>
    c.sid && revoked.has(c.sid) ? "revoked" : "ok",
  );
});

describe("1. a sign-in is a new session", () => {
  it("mints a random id, different for every sign-in of the same person", async () => {
    const a = await signIn();
    const b = await signIn();
    expect(typeof a.sid).toBe("string");
    expect(a.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.sid).not.toBe(a.sid);
  });
});

describe("2. every later pass keeps the id and checks it", () => {
  it("re-issue after re-issue carries the same id, and the revocation check is asked about it", async () => {
    const minted = await signIn();
    let t: Record<string, unknown> | null = minted;
    for (let i = 0; i < 3; i++) {
      t = await pass(t!);
      expect(t!.sid).toBe(minted.sid);
    }
    expect(checkSessionVersion).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "u-1", sid: minted.sid }),
      expect.any(Function),
    );
  });
});

describe("3. a token from before session ids", () => {
  it("is given its person's derived id, identical on every copy", async () => {
    const a = await pass(preReleaseToken({ iat: 10, jti: "copy-a" }));
    const b = await pass(preReleaseToken({ iat: 99, jti: "copy-b", brandFetchedAt: 77 }));
    expect(a!.sid).toBeDefined();
    expect(String(a!.sid).startsWith("legacy-")).toBe(true);
    expect(b!.sid).toBe(a!.sid);
  });

  it("a member's old token is derived from the member, not shared with staff of the same id", async () => {
    const staff = await pass(preReleaseToken());
    const member = await pass(preReleaseToken({ role: "member", memberId: "m-1" }));
    expect(member!.sid).not.toBe(staff!.sid);
  });

  it("one in the middle of a support session is ended (it has no own identity to derive from)", async () => {
    expect(await pass(preReleaseToken({ impersonatedBy: "op-1" }))).toBeNull();
    expect(await pass(preReleaseToken({ impersonatorClaims: { id: "u-op" } }))).toBeNull();
  });
});

describe("4. a signed-out session cannot come back", () => {
  it("a delayed copy of a signed-out session is refused, and is never given a fresh id", async () => {
    const minted = await signIn();
    const inFlight = await pass(minted); // a response that left the server before the sign-out
    revoked.add(minted.sid as string); // the sign-out lands
    expect(await pass(inFlight!)).toBeNull();
    expect(await pass(minted)).toBeNull();
  });

  it("another device's session (its own sign-in) is untouched", async () => {
    const here = await signIn();
    const otherDevice = await signIn();
    revoked.add(here.sid as string);
    expect(await pass(here)).toBeNull();
    expect((await pass(otherDevice))!.sid).toBe(otherDevice.sid);
  });

  it("old copies of a pre-release session are refused once that person signs one of them out — no copy escapes", async () => {
    const first = await pass(preReleaseToken({ jti: "phone" }));
    revoked.add(first!.sid as string);
    // Every other old copy derives the same id, so every one is refused.
    expect(await pass(preReleaseToken({ jti: "laptop", iat: 5 }))).toBeNull();
    expect(await pass(preReleaseToken({ jti: "late-response", iat: 6, brandFetchedAt: 9 }))).toBeNull();
    // A session signed in after the release is the person's own, separate session.
    const fresh = await signIn();
    expect((await pass(fresh))!.sid).toBe(fresh.sid);
  });

  it("a check that cannot run grants nothing: the token is kept for revalidation, with no authority", async () => {
    const minted = await signIn();
    checkSessionVersion.mockResolvedValue("unknown");
    const t = await pass(minted);
    expect(t).not.toBeNull();
    expect(t!.revalidateSince).toEqual(expect.any(Number));
    const s = captured.session!({ session: { user: {}, expires: "" }, token: t! }) as { user?: unknown; authUnavailable?: boolean };
    expect(s.user).toBeUndefined();
    expect(s.authUnavailable).toBe(true);
  });
});
