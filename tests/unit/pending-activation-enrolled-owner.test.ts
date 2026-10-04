// Pending owner activation when an authenticator is ALREADY enrolled
// (Sean verification, 4 Oct 2026).
//
// The handover design is: temporary password -> own password -> enrol TOTP ->
// club data (proxy-activation-gates.test.ts, owner-activation-order.test.ts).
// Those files test the row the design expects: mustChangePassword TRUE and
// totpEnabled FALSE. This file pins what the product does with the row that is
// actually on the account when the operator enrolled their own authenticator
// during set-up and then reset only the password: mustChangePassword TRUE and
// totpEnabled TRUE.
//
// What it shows (characterisation, not a fix):
//   1. authorize() mints totpPending=true, so the second-factor challenge comes
//      BEFORE the password change — the holder of the temporary password alone
//      is stopped at /login/totp and cannot reach /set-password.
//   2. the proxy holds every dashboard page and every /api route behind
//      /login/totp (/set-password is the exception: not a reserved slug, so the
//      proxy lets it through; its API still refuses while the code is owed);
//      an /api call is NOT answered with data (it is a 307 to /login/totp,
//      not the JSON 403 the other gates give — pinned so a change is noticed).
//   3. after the operator's "Reset owner 2FA" (row: totpEnabled FALSE, password
//      untouched, mustChangePassword still TRUE) the designed order resumes:
//      /set-password first, then /login/totp/setup.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;

const captured: { authorize?: Authorize } = {};

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    // proxy.ts wraps its handler in auth(); the identity function lets the
    // test drive the handler with a hand-built req.auth.
    return { handlers: {}, auth: (fn: unknown) => fn, signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (cfg: { authorize?: Authorize }) => cfg }));
vi.mock("next-auth/providers/google", () => ({ default: (cfg: unknown) => cfg }));

const { tenantFindUnique, userFindUnique, memberFindUnique } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
}));

const tx = {
  tenant: { findUnique: tenantFindUnique },
  user: { findUnique: userFindUnique, findFirst: vi.fn(), update: vi.fn() },
  member: { findUnique: memberFindUnique, update: vi.fn() },
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
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: vi.fn().mockResolvedValue("ok") }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn() }));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@/lib/pending-tenant-cookie", () => ({ readPendingTenantSlug: vi.fn(), clearPendingTenantSlug: vi.fn() }));

const TEMP_PASSWORD = "TempPass2345";
const HASH = bcrypt.hashSync(TEMP_PASSWORD, 4);
const TENANT = {
  id: "t1", slug: "club", name: "Club", subscriptionStatus: "active", deletedAt: null,
  primaryColor: "#000", secondaryColor: "#111", textColor: "#fff",
};
const ownerRow = (totpEnabled: boolean) => ({
  id: "u-owner", email: "owner@example.test", name: "Owner", role: "owner", sessionVersion: 4, tenantId: "t1",
  passwordHash: HASH, failedLoginCount: 0, lockedUntil: null, totpEnabled, notifyOnNewLogin: false,
  mustChangePassword: true,
});

async function signInWithTempPassword() {
  if (!captured.authorize) await import("@/auth");
  return captured.authorize!(
    { email: "owner@example.test", password: TEMP_PASSWORD, tenantSlug: "club" },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

async function viaProxy(pathname: string, claims: Record<string, unknown>) {
  const mod = await import("../../proxy");
  const proxy = mod.default as unknown as (req: unknown) => Promise<Response>;
  const url = `http://localhost:3847${pathname}`;
  return proxy({
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    cookies: { get: () => undefined },
    auth: { user: { id: "u-owner", tenantId: "t1", role: "owner", ...claims } },
  });
}
const location = (res: Response) => {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TESTING_MODE", "");
  tenantFindUnique.mockResolvedValue(TENANT);
  memberFindUnique.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("temporary password + authenticator ALREADY enrolled (current pending state)", () => {
  it("the temporary password signs in, but the session owes the second factor first", async () => {
    userFindUnique.mockResolvedValue(ownerRow(true));
    const u = await signInWithTempPassword();
    expect(u).not.toBeNull();
    expect(u!.totpPending).toBe(true);
    expect(u!.mustChangePassword).toBe(true);
    // Not "set up an authenticator": one is already there, so the enrolment
    // page (which is where a fresh owner chooses THEIR OWN) is never offered.
    expect(u!.requireTotpSetup).toBe(false);
  });

  // /login/totp/setup sits under the public "/login" prefix, so the proxy does
  // not gate it; the page itself sends a mustChangePassword account to
  // /set-password, and with a factor already enrolled the setup API never
  // re-exposes the secret (app/api/auth/totp/setup/route.ts GET).
  it("every dashboard page is held at /login/totp", async () => {
    userFindUnique.mockResolvedValue(ownerRow(true));
    const claims = (await signInWithTempPassword())!;
    for (const path of ["/dashboard", "/dashboard/members", "/dashboard/settings"]) {
      const res = await viaProxy(path, claims);
      expect(location(res), path).toBe("/login/totp");
    }
  });

  it("/set-password is NOT gated by the proxy at all — it is not in RESERVED_SLUGS, so it passes as a club short URL", async () => {
    // The page renders for a totpPending session (app/set-password/page.tsx
    // checks role + mustChangePassword only), but its API refuses the change
    // while the code is owed (app/api/auth/set-password/route.ts:63, pinned by
    // set-password-route.test.ts). So the form shows and submitting it fails.
    userFindUnique.mockResolvedValue(ownerRow(true));
    const claims = (await signInWithTempPassword())!;
    const res = await viaProxy("/set-password", claims);
    expect(location(res)).toBeNull();
    const { isReservedSlug } = await import("@/lib/reserved-slugs");
    expect(isReservedSlug("set-password")).toBe(false);
  });

  it("an /api call gets no data — it is redirected to /login/totp (a 307, not a JSON 403)", async () => {
    userFindUnique.mockResolvedValue(ownerRow(true));
    const claims = (await signInWithTempPassword())!;
    for (const path of ["/api/members", "/api/reports", "/api/settings/display"]) {
      const res = await viaProxy(path, claims);
      expect(res.status, path).not.toBe(200);
      expect(res.status, path).toBe(307);
      expect(location(res), path).toBe("/login/totp");
    }
  });
});

describe("after the operator's 'Reset owner 2FA' (totpEnabled FALSE, password untouched)", () => {
  it("the same temporary password now leads to /set-password first, then enrolment", async () => {
    userFindUnique.mockResolvedValue(ownerRow(false));
    const u = (await signInWithTempPassword())!;
    expect(u.totpPending).toBe(false);
    expect(u.mustChangePassword).toBe(true);
    expect(u.requireTotpSetup).toBe(true);

    expect(location(await viaProxy("/dashboard", u))).toBe("/set-password");
    const api = await viaProxy("/api/members", u);
    expect(api.status).toBe(403);
    expect((await api.json()).error).toMatch(/password/);

    // Password chosen -> the enrolment gate takes over.
    const afterPassword = { ...u, mustChangePassword: false };
    expect(location(await viaProxy("/dashboard", afterPassword))).toBe("/login/totp/setup");
    const api2 = await viaProxy("/api/members", afterPassword);
    expect(api2.status).toBe(403);
    expect((await api2.json()).error).toMatch(/authenticator/);
  });
});
