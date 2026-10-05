/**
 * Operator security audit, 5 Oct 2026 (Q4): can an impersonation session be
 * mistaken for the owner's own activation?
 *
 * "Activated" for the handover means three things on the owner's User row:
 * `mustChangePassword` cleared (own password chosen), `totpEnabled` true (own
 * authenticator enrolled) and — as supporting evidence — a LoginEvent. The
 * readiness script scripts/readiness/owner-account-state.mjs decides
 * "ALREADY ACTIVATED" from the first two flags alone.
 *
 * The impersonation session here is built the way the product builds it: the
 * REAL auth.ts jwt() callback runs with a signed-cookie claim present, and the
 * REAL session() callback turns that token into `session.user`. `next-auth` is
 * mocked only to capture the callbacks and to hand the routes that session
 * from `auth()`.
 *
 * Tests named "REFUSED" pin refusals that exist today. Tests named "GAP" pin
 * the current, unsafe behaviour: each is an ISSUE in the audit report and is
 * expected to go red — and be inverted — when that issue is fixed.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import bcrypt from "bcryptjs";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const h = vi.hoisted(() => ({
  captured: {} as { jwt?: Jwt; session?: SessionCb },
  authMock: vi.fn(),
  readImpersonationCookie: vi.fn(),
  checkSessionVersion: vi.fn(),
  recordLoginEvent: vi.fn(),
  logAudit: vi.fn(),
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  historyCreate: vi.fn(),
  loginEventCreate: vi.fn(),
  getToken: vi.fn(),
  encode: vi.fn(),
  verifySync: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { jwt?: Jwt; session?: SessionCb } }) => {
    if (config.callbacks?.jwt) h.captured.jwt = config.callbacks.jwt;
    if (config.callbacks?.session) h.captured.session = config.callbacks.session;
    return { handlers: {}, auth: (...a: unknown[]) => h.authMock(...a), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/jwt", () => ({
  getToken: (...a: unknown[]) => h.getToken(...a),
  encode: (...a: unknown[]) => h.encode(...a),
}));

const tx = {
  user: { findUnique: h.userFindUnique, findFirst: h.userFindFirst, update: h.userUpdate },
  member: { findUnique: vi.fn(), findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
  loginEvent: { create: h.loginEventCreate, upsert: h.loginEventCreate },
  passwordHistory: {
    findMany: vi.fn().mockResolvedValue([]),
    create: h.historyCreate,
    deleteMany: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: h.readImpersonationCookie }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: h.checkSessionVersion }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: h.recordLoginEvent }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(),
  clearPendingTenantSlug: vi.fn(),
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("@/lib/auth-cookie", () => ({ SESSION_COOKIE_NAME: "authjs.session-token", SESSION_COOKIE_SECURE: false }));
vi.mock("otplib", () => ({
  generateSecret: () => "OPERATOR-CHOSEN-SECRET",
  generateURI: () => "otpauth://totp/x",
  verifySync: (...a: unknown[]) => h.verifySync(...a),
}));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AA" } }));

// The operator's own NextAuth token (whatever account their browser holds).
const OPERATOR_TOKEN = {
  id: "u-operator",
  tenantId: "t-operator",
  tenantSlug: "matflow-hq",
  tenantName: "MatFlow HQ",
  primaryColor: "#0a0",
  secondaryColor: "#0b0",
  textColor: "#fff",
  role: "owner",
  sessionVersion: 7,
  memberId: null,
  totpPending: false,
  requireTotpSetup: false,
  totpEnabled: true,
};

// The pending owner: temporary password, no authenticator — the handover state.
const SEAN_ROW = {
  id: "u-sean",
  role: "owner",
  sessionVersion: 3,
  tenantId: "t-club",
  tenant: { name: "Club", slug: "club", primaryColor: "#f00", secondaryColor: "#900", textColor: "#000" },
};

const CLAIM = {
  adminUserId: "op-noe",
  targetUserId: "u-sean",
  targetTenantId: "t-club",
  reason: "support ticket 41",
};

const TEMP_HASH = bcrypt.hashSync("TempPass1234", 4);

async function impersonatedToken() {
  if (!h.captured.jwt) await import("@/auth");
  h.readImpersonationCookie.mockResolvedValue(CLAIM);
  return (await h.captured.jwt!({ token: { ...OPERATOR_TOKEN } })) as Record<string, unknown>;
}

async function impersonatedSession() {
  const token = await impersonatedToken();
  return h.captured.session!({ session: { user: {}, expires: "2099-01-01" }, token }) as {
    user: Record<string, unknown>;
  };
}

function post(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.userFindUnique.mockResolvedValue(SEAN_ROW);
  h.checkSessionVersion.mockResolvedValue("ok");
  h.userUpdate.mockResolvedValue({ sessionVersion: 4 });
  h.getToken.mockResolvedValue({ ...OPERATOR_TOKEN, id: "u-sean", impersonatedBy: "op-noe" });
  h.encode.mockResolvedValue("re-encoded");
});

describe("the impersonation session itself", () => {
  it("is marked: session.user.impersonatedBy carries the operator id", async () => {
    const s = await impersonatedSession();
    expect(s.user.id).toBe("u-sean");
    expect(s.user.role).toBe("owner");
    expect(s.user.impersonatedBy).toBe("op-noe");
  });

  it("REFUSED (c): starting/refreshing it writes nothing to the owner row and records no LoginEvent", async () => {
    await impersonatedToken();
    await impersonatedToken();
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.loginEventCreate).not.toHaveBeenCalled();
    expect(h.recordLoginEvent).not.toHaveBeenCalled();
  });

  it("lifts every activation gate in the CLAIMS (DB untouched): no TOTP challenge, no enrolment, no forced password change", async () => {
    const s = await impersonatedSession();
    expect(s.user.totpPending).toBe(false);
    expect(s.user.requireTotpSetup).toBe(false);
    expect(s.user.mustChangePassword).toBe(false);
    expect(s.user.totpEnabled).toBe(true);
  });
});

describe("(a) clearing mustChangePassword — POST /api/auth/set-password", () => {
  it("REFUSED once the owner has activated: the row has no change pending", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindFirst.mockResolvedValue({ id: "u-sean", passwordHash: TEMP_HASH, mustChangePassword: false });
    const { POST } = await import("@/app/api/auth/set-password/route");
    const res = await POST(post("http://localhost/api/auth/set-password", { password: "OperatorChose1A" }));
    expect(res.status).toBe(403);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("GAP (ISSUE Q4-a): on a PENDING owner the operator sets the password and clears mustChangePassword", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindFirst.mockResolvedValue({ id: "u-sean", passwordHash: TEMP_HASH, mustChangePassword: true });
    const { POST } = await import("@/app/api/auth/set-password/route");
    const res = await POST(post("http://localhost/api/auth/set-password", { password: "OperatorChose1A" }));
    expect(res.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-sean" },
        data: expect.objectContaining({ mustChangePassword: false }),
      }),
    );
    // Recorded as the owner setting their own password; attribution rests
    // solely on logAudit reading the impersonation cookie (metadata.actingAs).
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.password.set_own", userId: "u-sean" }));
  });
});

describe("(b) enrolling a TOTP factor — /api/auth/totp/setup", () => {
  it("REFUSED to re-expose the seed once the owner has enrolled (GET says alreadyEnabled)", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindUnique.mockResolvedValue({ totpSecret: "SEANS-SECRET", totpEnabled: true, email: "o@example.test" });
    const { GET } = await import("@/app/api/auth/totp/setup/route");
    const res = await GET();
    expect(await res.json()).toEqual({ alreadyEnabled: true });
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("GAP (ISSUE Q4-b): on a pending owner the operator mints a seed (GET) and enables it (POST), with no audit row", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindUnique.mockResolvedValue({ totpSecret: null, totpEnabled: false, email: "o@example.test" });
    const { GET, POST } = await import("@/app/api/auth/totp/setup/route");
    const g = await GET();
    expect((await g.json()).secret).toBe("OPERATOR-CHOSEN-SECRET");

    h.userFindUnique.mockResolvedValue({ totpSecret: "OPERATOR-CHOSEN-SECRET" });
    h.verifySync.mockReturnValue({ valid: true });
    const p = await POST(post("http://localhost/api/auth/totp/setup", { code: "123456" }) as never);
    expect(p.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-sean" }, data: expect.objectContaining({ totpEnabled: true }) }),
    );
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe("other owner-only doors under impersonation", () => {
  it("REFUSED: self-disabling 2FA is closed to every session", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    const { POST } = await import("@/app/api/auth/totp/disable/route");
    expect((await POST()).status).toBe(403);
  });

  it("REFUSED: recovery codes need a live code from the enrolled authenticator", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindFirst.mockResolvedValue({ id: "u-sean", totpEnabled: true, totpSecret: "SEANS-SECRET" });
    h.verifySync.mockReturnValue({ valid: false });
    const { POST } = await import("@/app/api/auth/totp/recovery-codes/route");
    const res = await POST(post("http://localhost/api/auth/totp/recovery-codes", { totpCode: "000000" }));
    expect(res.status).toBe(401);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("REFUSED: owner-side ownership transfer needs the owner's own password", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindFirst.mockResolvedValue({ id: "u-sean", email: "o@example.test", name: "Owner", passwordHash: TEMP_HASH });
    const { POST } = await import("@/app/api/staff/[id]/transfer-ownership/route");
    const res = await POST(post("http://localhost/api/staff/u-x/transfer-ownership", { password: "guess" }), {
      params: Promise.resolve({ id: "u-x" }),
    });
    expect(res.status).toBe(403);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });
});

describe("(e) the readiness verdict", () => {
  it("GAP (ISSUE Q4-e): owner-account-state.mjs calls an owner ACTIVATED from the two row flags alone", () => {
    const src = readFileSync(path.join(process.cwd(), "scripts/readiness/owner-account-state.mjs"), "utf8");
    const line = src.split("\n").find((l) => l.includes("const activated ="));
    expect(line).toBeDefined();
    expect(line).toContain("owner.totpEnabled === true && owner.mustChangePassword === false");
    // Nothing in the predicate looks at who did it: no LoginEvent, no actingAs.
    expect(line).not.toMatch(/loginEvents|actingAs|imperson/);
  });
});
