/**
 * Google sign-in refuses a provisional login email — BEHAVIOURAL (review of
 * lanes P + M, defect 10, 7 Oct 2026). tests/unit/provisional-login-email-doors
 * pins the refusal by its position in auth.ts; this drives the REAL signIn
 * callback (captured by mocking `next-auth`, as impersonation-jwt-claims does)
 * with a verified Google profile for the same address, provisional and not.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

type SignIn = (args: { user: Record<string, unknown>; account: { provider: string } | null; profile?: unknown }) => Promise<unknown>;
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
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(async () => "club-a"),
  clearPendingTenantSlug: vi.fn(async () => {}),
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));

await import("@/auth");

const OWNER = {
  id: "owner-1", tenantId: "t-a", email: "owner@club.example", name: "Owner", role: "owner",
  sessionVersion: 1, totpEnabled: true, mustChangePassword: false, loginEmailProvisionalSince: null as Date | null,
};
const google = () =>
  captured.signIn!({
    user: { email: "Owner@Club.example" },
    account: { provider: "google" },
    profile: { email_verified: true },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.tenantFindUnique.mockResolvedValue({
    id: "t-a", slug: "club-a", name: "Club A", subscriptionStatus: "active", deletedAt: null,
    primaryColor: "#000000", secondaryColor: "#000000", textColor: "#ffffff",
  });
  h.memberFindUnique.mockResolvedValue(null);
});

describe("Google sign-in and a provisional login email (behavioural)", () => {
  it("captured the real signIn callback", () => {
    expect(typeof captured.signIn).toBe("function");
  });

  it("a verified Google account for a PROVISIONAL login email is refused and audited", async () => {
    h.userFindUnique.mockResolvedValue({ ...OWNER, loginEmailProvisionalSince: new Date("2026-10-07T08:00:00Z") });
    expect(await google()).toBe("/login?error=invalid_link");
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.external_signin.refused_provisional",
      entityId: "owner-1",
    }));
  });

  it("control: the same account, not provisional, is admitted (TOTP still owed)", async () => {
    h.userFindUnique.mockResolvedValue({ ...OWNER });
    const user: Record<string, unknown> = { email: "Owner@Club.example" };
    const result = await captured.signIn!({ user, account: { provider: "google" }, profile: { email_verified: true } });
    expect(result).not.toBe("/login?error=invalid_link");
    expect(typeof result === "string" && result.startsWith("/login")).toBe(false);
    expect(user.id).toBe("owner-1");
    expect(user.totpPending).toBe(true);
    expect(h.logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auth.external_signin.refused_provisional" }));
  });
});
