// SF-36 residuals on the Google door (security campaign iteration 2, lane A3,
// 9 Oct 2026; review R3 §5).
//
//  1. Existence signal (Low): the door answered NoAccountForGym for an address
//     with no account here and google_link_required for one that has an
//     account but no link. Only the mailbox owner sees it, but it is still a
//     per-club "is this address registered?" answer. Now ONE code for both.
//  2. The Google path's login event took its client IP from the FIRST
//     x-forwarded-for entry — the one the client writes — while the
//     credentials path uses the product's trust order (x-vercel-forwarded-for,
//     x-real-ip, then the LAST x-forwarded-for hop; lib/auth-lockout.ts
//     requestClientIp). The login event feeds new-device detection and the
//     known-device exemption of the address cap, so a spoofed IP there is a
//     spoofed device.
//
// Drives the REAL signIn callback of auth.ts. The link store does not exist
// yet (every Google sign-in is refused before the login event), so a link is
// stood up through the lib/external-identity seam to reach the event.

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
  recordLoginEvent: vi.fn(async (_args: { ip: string }) => {}),
  clearPending: vi.fn(async () => {}),
  link: vi.fn(async () => null as null | { userId?: string; memberId?: string }),
  reqHeaders: new Headers(),
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
  readPendingTenantSlug: vi.fn(async () => "club-a3"),
  clearPendingTenantSlug: h.clearPending,
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("@/lib/external-identity", () => ({ linkedExternalIdentity: h.link }));
vi.mock("next/headers", () => ({
  headers: async () => h.reqHeaders,
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

await import("@/auth");

const MEMBER = {
  id: "m-a3", tenantId: "t-a3", email: "member@example.test", name: "A3 Member", passwordHash: null,
  sessionVersion: 0, totpEnabled: false, notifyOnNewLogin: false,
};
const COACH = {
  id: "u-a3", tenantId: "t-a3", email: "coach@example.test", name: "A3 Coach", role: "coach", sessionVersion: 0,
  totpEnabled: false, mustChangePassword: false, loginEmailProvisionalSince: null, notifyOnNewLogin: false,
};
function google(email: string, verified = true) {
  const user: Record<string, unknown> = { email };
  return {
    user,
    result: captured.signIn!({
      user,
      account: { provider: "google", providerAccountId: "google-sub-secA3-0001", type: "oidc" },
      profile: { email_verified: verified, email, sub: "google-sub-secA3-0001" },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tenantFindUnique.mockResolvedValue({
    id: "t-a3", slug: "club-a3", name: "Club A3", subscriptionStatus: "active", deletedAt: null,
    primaryColor: "#000000", secondaryColor: "#000000", textColor: "#ffffff",
  });
  h.userFindUnique.mockResolvedValue(null);
  h.memberFindUnique.mockResolvedValue(null);
  h.link.mockResolvedValue(null);
  h.reqHeaders = new Headers({ "user-agent": "secA3-agent" });
});

describe("Google door: one answer whether or not the address has an account", () => {
  it("captured the real signIn callback", () => {
    expect(typeof captured.signIn).toBe("function");
  });

  it("an address with NO account here gets the same code as an account with no link", async () => {
    h.memberFindUnique.mockResolvedValue(MEMBER);
    const withAccount = await google("member@example.test").result;
    h.memberFindUnique.mockResolvedValue(null);
    const withoutAccount = await google("nobody@example.test").result;
    expect(withAccount).toBe("/login?error=google_link_required");
    expect(withoutAccount).toBe(withAccount);
  });

  it("neither refusal hydrates a token, records a login event or consumes the club cookie", async () => {
    const g = google("nobody@example.test");
    await g.result;
    expect(g.user.id).toBeUndefined();
    expect(h.recordLoginEvent).not.toHaveBeenCalled();
    expect(h.clearPending).not.toHaveBeenCalled();
  });

  it("controls unchanged: an unverified address keeps its own refusal", async () => {
    expect(await google("nobody@example.test", false).result).toBe("/login?error=GoogleEmailUnverified");
  });
});

describe("Google door: the login event's client IP follows the product's trust order", () => {
  it("positive control: a link to THIS member signs in and records a login event", async () => {
    h.memberFindUnique.mockResolvedValue(MEMBER);
    h.link.mockResolvedValue({ memberId: "m-a3" });
    const g = google("member@example.test");
    expect(await g.result).toBe(true);
    expect(g.user.id).toBe("m-a3");
    expect(h.recordLoginEvent).toHaveBeenCalledTimes(1);
  });

  it("a link to a DIFFERENT account is refused", async () => {
    h.memberFindUnique.mockResolvedValue(MEMBER);
    h.link.mockResolvedValue({ memberId: "someone-else" });
    expect(await google("member@example.test").result).toBe("/login?error=google_link_required");
  });

  it("x-vercel-forwarded-for wins over a client-written x-forwarded-for", async () => {
    h.userFindUnique.mockResolvedValue(COACH);
    h.link.mockResolvedValue({ userId: "u-a3" });
    h.reqHeaders = new Headers({
      "x-forwarded-for": "203.0.113.66, 198.51.100.9",
      "x-vercel-forwarded-for": "192.0.2.10",
      "user-agent": "secA3-agent",
    });
    expect(await google("coach@example.test").result).toBe(true);
    expect(h.recordLoginEvent.mock.calls[0][0].ip).toBe("192.0.2.10");
  });

  it("with only x-forwarded-for, the LAST hop (the one the platform appended) is used, not the first", async () => {
    h.userFindUnique.mockResolvedValue(COACH);
    h.link.mockResolvedValue({ userId: "u-a3" });
    h.reqHeaders = new Headers({ "x-forwarded-for": "203.0.113.66, 198.51.100.9", "user-agent": "secA3-agent" });
    expect(await google("coach@example.test").result).toBe(true);
    expect(h.recordLoginEvent.mock.calls[0][0].ip).toBe("198.51.100.9");
  });

  it("x-real-ip is preferred over x-forwarded-for, as on the credentials path", async () => {
    h.userFindUnique.mockResolvedValue(COACH);
    h.link.mockResolvedValue({ userId: "u-a3" });
    h.reqHeaders = new Headers({ "x-forwarded-for": "203.0.113.66", "x-real-ip": "192.0.2.44", "user-agent": "secA3-agent" });
    expect(await google("coach@example.test").result).toBe(true);
    expect(h.recordLoginEvent.mock.calls[0][0].ip).toBe("192.0.2.44");
  });
});
