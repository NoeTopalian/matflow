// SF-36 — a Google identity must never be attached to an account by matching
// email alone (security campaign iteration 2, lane A2, 9 Oct 2026).
//
// Drives the REAL signIn callback of auth.ts (captured by mocking next-auth, as
// google-door-provisional does) with a VERIFIED Google profile whose address
// matches an existing member (no password — the magic-link door refuses such a
// member) and an existing staff account. Before the fix both were signed in.
// Interim rule until the explicit-link store exists: refuse every Google
// sign-in with a dedicated code; never hydrate the account.

import { vi, describe, it, expect, beforeEach } from "vitest";

type SignIn = (args: { user: Record<string, unknown>; account: Record<string, unknown> | null; profile?: unknown }) => Promise<unknown>;
const captured: { signIn?: SignIn } = {};

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { signIn?: SignIn } }) => {
    if (config.callbacks?.signIn) captured.signIn = config.callbacks.signIn;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  tenantFindUnique: vi.fn(),
  logAudit: vi.fn(async () => {}),
  recordLoginEvent: vi.fn(async () => {}),
  clearPending: vi.fn(async () => {}),
}));
const tx = {
  user: { findUnique: h.userFindUnique, findFirst: vi.fn() },
  member: { findUnique: h.memberFindUnique, findFirst: vi.fn() },
  tenant: { findUnique: h.tenantFindUnique },
};
vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false, isProductionDatabase: () => false }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: h.recordLoginEvent }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(async () => "club-a2"),
  clearPendingTenantSlug: h.clearPending,
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

await import("@/auth");

const MEMBER_NO_PASSWORD = {
  id: "m-a2", tenantId: "t-a2", email: "member@example.test", name: "A2 Member", passwordHash: null,
  sessionVersion: 0, totpEnabled: false, notifyOnNewLogin: false,
};
const COACH = {
  id: "u-a2", tenantId: "t-a2", email: "coach@example.test", name: "A2 Coach", role: "coach", sessionVersion: 0,
  totpEnabled: false, mustChangePassword: false, loginEmailProvisionalSince: null, notifyOnNewLogin: false,
};
function google(email: string, verified = true) {
  const user: Record<string, unknown> = { email };
  return {
    user,
    result: captured.signIn!({
      user,
      account: { provider: "google", providerAccountId: "google-sub-secA2-0001", type: "oidc" },
      profile: { email_verified: verified, email, sub: "google-sub-secA2-0001" },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tenantFindUnique.mockResolvedValue({
    id: "t-a2", slug: "club-a2", name: "Club A2", subscriptionStatus: "active", deletedAt: null,
    primaryColor: "#000000", secondaryColor: "#000000", textColor: "#ffffff",
  });
  h.userFindUnique.mockResolvedValue(null);
  h.memberFindUnique.mockResolvedValue(null);
});

describe("Google sign-in: no linking by email", () => {
  it("captured the real signIn callback", () => {
    expect(typeof captured.signIn).toBe("function");
  });

  it("a verified Google address matching a password-less MEMBER is refused, not signed in", async () => {
    h.memberFindUnique.mockResolvedValue(MEMBER_NO_PASSWORD);
    const g = google("member@example.test");
    expect(await g.result).toBe("/login?error=google_link_required");
    expect(g.user.id, "the account was not hydrated into the token").toBeUndefined();
    expect(g.user.memberId).toBeUndefined();
    expect(h.recordLoginEvent).not.toHaveBeenCalled();
  });

  it("a verified Google address matching a STAFF account is refused, not signed in", async () => {
    h.userFindUnique.mockResolvedValue(COACH);
    const g = google("coach@example.test");
    expect(await g.result).toBe("/login?error=google_link_required");
    expect(g.user.id).toBeUndefined();
    expect(g.user.role).toBeUndefined();
  });

  it("the pending-club cookie is not consumed by a refused attempt", async () => {
    h.userFindUnique.mockResolvedValue(COACH);
    await google("coach@example.test").result;
    expect(h.clearPending).not.toHaveBeenCalled();
  });

  it("controls: unverified address keeps its refusal; unknown address gets the one Google-door code", async () => {
    expect(await google("coach@example.test", false).result).toBe("/login?error=GoogleEmailUnverified");
    // Lane A3 (R3 §5): one code whether or not the address has an account here.
    expect(await google("nobody@example.test").result).toBe("/login?error=google_link_required");
  });

  it("the credentials door is untouched by this rule (it does not consult Google links)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("auth.ts", "utf8");
    const authorize = src.slice(src.indexOf("async authorize("), src.indexOf("callbacks: {"));
    expect(authorize).not.toContain("linkedExternalIdentity");
  });
});
