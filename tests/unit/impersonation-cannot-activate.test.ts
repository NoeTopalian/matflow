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
 * Tests named "REFUSED" pin refusals. The four tests that were named "GAP"
 * (ISSUE Q4-a, Q4-b, Q4-e) pinned the unsafe behaviour found on 5 Oct 2026; they
 * were inverted on 6 Oct 2026 (remediation lane B) when support sessions became
 * read-only and the readiness verdict began demanding evidence. Each keeps its
 * old name in a comment.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { ownerActivationVerdict, countSupportCredentialRows } from "../../scripts/readiness/activation-verdict.mjs";
import { readFileSync } from "fs";
import path from "path";
import bcrypt from "bcryptjs";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const h = vi.hoisted(() => ({
  captured: {} as { jwt?: Jwt; session?: SessionCb },
  authMock: vi.fn(),
  resolveActiveImpersonation: vi.fn(),
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
vi.mock("@/lib/impersonation", () => ({ resolveActiveImpersonation: h.resolveActiveImpersonation }));
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
  v: 2 as const,
  adminUserId: "op-noe",
  opSv: 1,
  targetUserId: "u-sean",
  targetTenantId: "t-club",
  tsv: 3,
  reason: "support ticket 41",
  n: "nonce-0123456789abcdef",
  exp: Math.floor(Date.now() / 1000) + 600,
};

const TEMP_HASH = bcrypt.hashSync("TempPass1234", 4);

async function impersonatedToken() {
  if (!h.captured.jwt) await import("@/auth");
  h.resolveActiveImpersonation.mockResolvedValue({ payload: CLAIM, target: SEAN_ROW });
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

  // Was "GAP (ISSUE Q4-a): on a PENDING owner the operator sets the password and clears
  // mustChangePassword" — 200, the row updated, and an audit row user.password.set_own that read as the
  // owner's own act. Inverted 6 Oct 2026: support sessions are read-only.
  it("REFUSED (was GAP Q4-a): on a PENDING owner a support session cannot choose the password: 403, no write, no audit row", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindFirst.mockResolvedValue({ id: "u-sean", passwordHash: TEMP_HASH, mustChangePassword: true });
    const { POST } = await import("@/app/api/auth/set-password/route");
    const res = await POST(post("http://localhost/api/auth/set-password", { password: "OperatorChose1A" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/read-only/i);
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.historyCreate).not.toHaveBeenCalled();
    expect(h.encode).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe("(b) enrolling a TOTP factor — /api/auth/totp/setup", () => {
  it("REFUSED to re-expose the seed once the owner has enrolled (now refused before the row is read)", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindUnique.mockResolvedValue({ totpSecret: "SEANS-SECRET", totpEnabled: true, email: "o@example.test" });
    const { GET } = await import("@/app/api/auth/totp/setup/route");
    const res = await GET();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("SEANS-SECRET");
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  // Was "GAP (ISSUE Q4-b): on a pending owner the operator mints a seed (GET) and enables it (POST),
  // with no audit row". Inverted 6 Oct 2026: the GET (which WRITES a new secret) and the POST are both
  // refused to a support session before anything is read or written.
  it("REFUSED (was GAP Q4-b): on a pending owner a support session can neither mint a seed (GET) nor enable one (POST)", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindUnique.mockResolvedValue({ totpSecret: null, totpEnabled: false, email: "o@example.test" });
    const { GET, POST } = await import("@/app/api/auth/totp/setup/route");
    const g = await GET();
    expect(g.status).toBe(403);
    expect((await g.json()).secret).toBeUndefined();

    h.verifySync.mockReturnValue({ valid: true });
    const p = await POST(post("http://localhost/api/auth/totp/setup", { code: "123456" }) as never);
    expect(p.status).toBe(403);
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.verifySync).not.toHaveBeenCalled();
  });
});

describe("other owner-only doors under impersonation", () => {
  it("REFUSED: self-disabling 2FA is closed to every session", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    const { POST } = await import("@/app/api/auth/totp/disable/route");
    expect((await POST()).status).toBe(403);
  });

  it("REFUSED: recovery codes cannot be (re)generated by a support session, even with a valid code", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    h.userFindFirst.mockResolvedValue({ id: "u-sean", totpEnabled: true, totpSecret: "SEANS-SECRET" });
    h.verifySync.mockReturnValue({ valid: true });
    const { POST } = await import("@/app/api/auth/totp/recovery-codes/route");
    const res = await POST(post("http://localhost/api/auth/totp/recovery-codes", { totpCode: "123456" }));
    expect(res.status).toBe(403);
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.verifySync).not.toHaveBeenCalled();
  });

  it("REFUSED: a support session cannot sign the owner out of every device", async () => {
    h.authMock.mockResolvedValue(await impersonatedSession());
    const { POST } = await import("@/app/api/auth/logout-all/route");
    const res = await POST(post("http://localhost/api/auth/logout-all", {}));
    expect(res.status).toBe(403);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("positive control: the owner's OWN session (no impersonatedBy) still reaches set-password", async () => {
    h.authMock.mockResolvedValue({
      user: { id: "u-sean", tenantId: "t-club", role: "owner", totpPending: false, mustChangePassword: true },
      expires: "2099-01-01",
    });
    // A temporary password still inside its deadline. (A null deadline means the
    // legacy cut-off, 20 Oct 2026, which has passed — that case is the expiry
    // test's, not this positive control's.)
    h.userFindFirst.mockResolvedValue({ id: "u-sean", passwordHash: TEMP_HASH, mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + 86_400_000) });
    const { POST } = await import("@/app/api/auth/set-password/route");
    const res = await POST(post("http://localhost/api/auth/set-password", { password: "OwnerChose1Abc" }));
    expect(res.status).not.toBe(403);
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
  // Was "GAP (ISSUE Q4-e): owner-account-state.mjs calls an owner ACTIVATED from the two row flags
  // alone" (`const activated = owner.totpEnabled === true && owner.mustChangePassword === false`).
  // Inverted 6 Oct 2026: the verdict lives in scripts/readiness/activation-verdict.mjs and needs evidence.
  it("FIXED (was GAP Q4-e): both readiness scripts take the verdict from activation-verdict.mjs, not the flags", () => {
    for (const file of ["owner-account-state.mjs", "tenant-state.mjs"]) {
      const src = readFileSync(path.join(process.cwd(), "scripts/readiness", file), "utf8");
      expect(src, file).toContain("ownerActivationVerdict(owner)");
      expect(src, file).not.toMatch(/const activated = owner\.totpEnabled === true && owner\.mustChangePassword === false/);
      // The words are printed only from the shared verdict (comments aside).
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code.includes("ALREADY ACTIVATED"), file).toBe(false);
    }
  });

  const FLAGS = { totpEnabled: true, mustChangePassword: false };

  it("flags alone, no owner sign-in: NOT 'ALREADY ACTIVATED'", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 0, supportCredentialRows: 0 });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("FLAGS SET, NO OWNER SIGN-IN");
  });

  it("a credential change made under support access (actingAs) wins over a sign-in: NOT activated", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 4, supportCredentialRows: 1 });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("FLAGS SET UNDER SUPPORT ACCESS");
  });

  it("flags + a real owner sign-in + no support-attributed change: ALREADY ACTIVATED", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 1, supportCredentialRows: 0 });
    expect(v.activated).toBe(true);
    expect(v.state).toBe("ALREADY ACTIVATED");
  });

  it("flags not set: NOT ACTIVATED whatever the sign-ins", () => {
    expect(ownerActivationVerdict({ totpEnabled: false, mustChangePassword: true, loginEvents: 9, supportCredentialRows: 0 }).state).toBe("NOT ACTIVATED");
    expect(ownerActivationVerdict({ totpEnabled: true, mustChangePassword: true, loginEvents: 9, supportCredentialRows: 0 }).activated).toBe(false);
  });

  it("counts only the owner's own credential rows that carry actingAs (operator-plane admin.* rows excluded)", () => {
    expect(
      countSupportCredentialRows([
        { action: "user.password.set_own", metadata: { actingAs: "op-noe" } },
        { action: "auth.totp.enrolled", metadata: { actingAs: "op-noe" } },
        { action: "auth.totp.recovery_codes.generated", metadata: {} },
        { action: "user.password.set_own", metadata: null },
        { action: "admin.owner.force_password_reset", metadata: { actingAs: "op-noe" } },
        { action: "member.update", metadata: { actingAs: "op-noe" } },
      ]),
    ).toBe(2);
  });
});
