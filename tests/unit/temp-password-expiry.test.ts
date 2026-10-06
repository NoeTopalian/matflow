// Temporary password expiry at the credentials door (lane A, 6 Oct 2026) —
// audit OPERATOR-ADMIN-SECURITY 2026-10-05 Q5 / ranked #8: "Temporary password
// never expires".
//
// An operator reset sets User.tempPasswordExpiresAt (72 h). Pinned here,
// driving the real Credentials authorize() from auth.ts:
//   - the correct temporary password after its expiry is refused with the
//     `temp_password_expired` code (a clear message, not "wrong password");
//   - before its expiry it signs in, still flagged mustChangePassword (the
//     setup-only gating in proxy.ts / lib/api-authz.ts then applies — pinned by
//     tests/unit/proxy-activation-gates.test.ts);
//   - a WRONG password on an expired account is the ordinary refusal, so the
//     expiry reveals nothing to a guesser;
//   - null expiry (every row from before the column, and Sean's existing
//     bootstrap) behaves exactly as before.
// Red on revert: delete the expiry check in auth.ts and the first case fails.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { LEGACY_TEMP_PASSWORD_DEADLINE, isTempPasswordExpired } from "@/lib/temp-password";

describe("D2: lib/temp-password effective expiry", () => {
  const before = LEGACY_TEMP_PASSWORD_DEADLINE.getTime() - 1;
  const after = LEGACY_TEMP_PASSWORD_DEADLINE.getTime() + 1;
  it("the legacy deadline is the one Noe set", () => {
    expect(LEGACY_TEMP_PASSWORD_DEADLINE.toISOString()).toBe("2026-10-20T23:59:59.000Z");
  });
  it("null expiry with mustChangePassword: live before, expired after", () => {
    expect(isTempPasswordExpired({ mustChangePassword: true, tempPasswordExpiresAt: null }, before)).toBe(false);
    expect(isTempPasswordExpired({ mustChangePassword: true, tempPasswordExpiresAt: null }, after)).toBe(true);
  });
  it("a recorded expiry wins over the legacy deadline", () => {
    const later = new Date(after + 1000);
    expect(isTempPasswordExpired({ mustChangePassword: true, tempPasswordExpiresAt: later }, after)).toBe(false);
    expect(isTempPasswordExpired({ mustChangePassword: true, tempPasswordExpiresAt: new Date(before - 1) }, before)).toBe(true);
  });
  it("never expired without mustChangePassword", () => {
    expect(isTempPasswordExpired({ mustChangePassword: false, tempPasswordExpiresAt: null }, after)).toBe(false);
    expect(isTempPasswordExpired({ mustChangePassword: false, tempPasswordExpiresAt: new Date(0) }, after)).toBe(false);
  });
});

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;
const captured: { authorize?: Authorize } = {};

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));

const { compareMock } = vi.hoisted(() => ({ compareMock: vi.fn(async (pw: string) => pw === "TEMP-PASSWORD-OK") }));
vi.mock("bcryptjs", () => ({
  default: { compare: compareMock, hashSync: () => "$2a$10$x", hash: async () => "$2a$10$x" },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));

const row: Record<string, unknown> = {};
const tx = {
  tenant: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(async () => ({ ...row })), findFirst: vi.fn(), update: vi.fn(async () => ({ ...row })) },
  member: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn(), update: vi.fn() },
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
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn() }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: vi.fn() }));
vi.mock("@/lib/pending-tenant-cookie", () => ({ readPendingTenantSlug: vi.fn(), clearPendingTenantSlug: vi.fn() }));

const TENANT = { id: "t1", slug: "club", name: "Club", subscriptionStatus: "active", deletedAt: null };

async function signIn(password: string) {
  if (!captured.authorize) await import("@/auth");
  return captured.authorize!(
    { email: "owner@example.test", password, tenantSlug: "club" },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.tenant.findUnique.mockResolvedValue(TENANT);
  for (const k of Object.keys(row)) delete row[k];
  Object.assign(row, {
    id: "u-owner", email: "owner@example.test", name: "Owner", role: "owner", tenantId: "t1",
    sessionVersion: 3, passwordHash: "$2a$10$hash", totpEnabled: false, notifyOnNewLogin: false,
    failedLoginCount: 0, lockedUntil: null, mustChangePassword: true, tempPasswordExpiresAt: null,
  });
});

describe("temporary password expiry", () => {
  it("refuses the CORRECT temporary password after its expiry, with its own code", async () => {
    row.tempPasswordExpiresAt = new Date(Date.now() - 1000);
    await expect(signIn("TEMP-PASSWORD-OK")).rejects.toMatchObject({ code: "temp_password_expired" });
  });

  it("signs in before the expiry, still flagged for the forced change", async () => {
    row.tempPasswordExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const user = await signIn("TEMP-PASSWORD-OK");
    expect(user).toMatchObject({ id: "u-owner", mustChangePassword: true });
  });

  it("a wrong password on an expired account is the ordinary refusal (reveals nothing)", async () => {
    row.tempPasswordExpiresAt = new Date(Date.now() - 1000);
    await expect(signIn("a-guess")).resolves.toBeNull();
  });

  // Was: "no expiry recorded (null) behaves as before — existing bootstrap rows
  // are unaffected". Review finding D2 (6 Oct 2026): a legacy row never
  // expired. It now expires at LEGACY_TEMP_PASSWORD_DEADLINE (lib/temp-password.ts).
  it("D2: no expiry recorded (null) still signs in BEFORE the legacy deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(LEGACY_TEMP_PASSWORD_DEADLINE.getTime() - 60_000));
      row.tempPasswordExpiresAt = null;
      expect(await signIn("TEMP-PASSWORD-OK")).toMatchObject({ mustChangePassword: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("D2: no expiry recorded (null) is refused AFTER the legacy deadline, with the expired code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(LEGACY_TEMP_PASSWORD_DEADLINE.getTime() + 1000));
      row.tempPasswordExpiresAt = null;
      await expect(signIn("TEMP-PASSWORD-OK")).rejects.toMatchObject({ code: "temp_password_expired" });
      // and a wrong password is still the ordinary refusal
      await expect(signIn("a-guess")).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("D2: the legacy deadline never applies to a password the user chose (mustChangePassword false)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(LEGACY_TEMP_PASSWORD_DEADLINE.getTime() + 86_400_000));
      row.mustChangePassword = false;
      row.tempPasswordExpiresAt = null;
      expect(await signIn("TEMP-PASSWORD-OK")).toMatchObject({ mustChangePassword: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale expiry on an account that already chose its own password is ignored", async () => {
    row.mustChangePassword = false;
    row.tempPasswordExpiresAt = new Date(Date.now() - 1000);
    expect(await signIn("TEMP-PASSWORD-OK")).toMatchObject({ mustChangePassword: false });
  });
});
