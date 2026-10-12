import { vi, describe, it, expect, beforeEach } from "vitest";
import { generateSecret, generateSync } from "otplib";

// POST /api/account/password (8 Oct 2026, account-editing lane R, story C2):
// a signed-in staff user changes their own password after activation. Pins:
// current password + a fresh SINGLE-USE authenticator code for enrolled
// accounts; the shared strength rule; no reuse of the current or recent
// passwords; strict body; temporary-password, code-owing, support and member
// sessions refused; one transaction (conditional hash update, history row,
// sessionVersion bump, reset/sign-in tokens retired, audit without secrets);
// every session signed out (cookie cleared, signInAgain).

const SECRET = generateSecret();
const CURRENT = "CurrentPass1";
const NEW = "BrandNewPass9";

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  logAudit: vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => {}),
  row: null as null | Record<string, unknown>,
  history: [] as { passwordHash: string }[],
}));

// bcrypt stand-in: a "hash" is "h:" + the password. Fast and transparent.
vi.mock("bcryptjs", () => ({
  default: {
    compare: async (pw: string, hash: string) => hash === `h:${pw}`,
    hash: async (pw: string) => `h:${pw}`,
  },
}));

const tx = {
  user: {
    // A copy, as Prisma returns: the route's view must not change under it.
    findFirst: vi.fn(async () => (h.row ? { ...h.row } : null)),
    // Two shapes: consumeUserTotp's conditional step update, and the
    // conditional password update.
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ("totpLastUsedStep" in args.data) {
        const last = h.row!.totpLastUsedStep as number | null;
        const step = args.data.totpLastUsedStep as number;
        if (last === null || last < step) {
          h.row!.totpLastUsedStep = step;
          return { count: 1 };
        }
        return { count: 0 };
      }
      if (args.where.passwordHash !== h.row!.passwordHash) return { count: 0 };
      h.row!.passwordHash = args.data.passwordHash;
      return { count: 1 };
    }),
    update: vi.fn(async () => ({})),
  },
  passwordHistory: {
    findMany: vi.fn(async () => h.history.map((x, i) => ({ ...x, id: `ph-${i}` }))),
    create: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  passwordResetToken: { updateMany: vi.fn(async () => ({ count: 1 })) },
  magicLinkToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
};

vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));

import { POST } from "@/app/api/account/password/route";
import { PASSWORD_HISTORY_LIMIT, staffPasswordSchema } from "@/lib/password-policy";

const staffSession = (extra: Record<string, unknown> = {}) => ({
  user: { id: "owner-1", tenantId: "tenant-A", role: "owner", totpPending: false, mustChangePassword: false, requireTotpSetup: false, ...extra },
});
const call = (body: unknown) =>
  POST(new Request("http://localhost/api/account/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const good = () => ({ currentPassword: CURRENT, newPassword: NEW, totpCode: generateSync({ secret: SECRET }) });
const passwordWrites = () =>
  tx.user.updateMany.mock.calls.filter(([a]) => "passwordHash" in (a as { data: object }).data);

beforeEach(() => {
  vi.clearAllMocks();
  h.session = staffSession();
  h.row = {
    id: "owner-1", email: "owner@club.example", role: "owner", passwordHash: `h:${CURRENT}`, mustChangePassword: false,
    totpEnabled: true, totpSecret: SECRET, totpLastUsedStep: null,
  };
  h.history = [{ passwordHash: "h:OlderPass1x" }];
});

describe("POST /api/account/password — success", () => {
  it("changes the password in one transaction, signs out everywhere, audits without secrets", async () => {
    const res = await call(good());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signInAgain: true });
    // Conditional on the checked hash, scoped to the session user + tenant.
    const writes = passwordWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatchObject({
      where: { id: "owner-1", tenantId: "tenant-A", passwordHash: `h:${CURRENT}`, mustChangePassword: false },
      data: { passwordHash: `h:${NEW}`, failedLoginCount: 0, lockedUntil: null, sessionVersion: { increment: 1 } },
    });
    expect(tx.passwordHistory.create).toHaveBeenCalledWith({ data: { userId: "owner-1", passwordHash: `h:${CURRENT}` } });
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-A", email: { in: ["owner@club.example"] }, used: false }),
    }));
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const audit = h.logAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      tx, tenantId: "tenant-A", userId: "owner-1", action: "user.password.changed", entityId: "owner-1",
      metadata: { confirmedWith: "password+totp", signedOutEverywhere: true },
    });
    const meta = JSON.stringify(audit.metadata);
    expect(meta).not.toContain(CURRENT);
    expect(meta).not.toContain(NEW);
    expect(meta).not.toMatch(/h:|hash|secret/i);
    // This device's cookie cleared.
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/i);
    // Nothing else on the row touched (email, role, tenant, authenticator).
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("an account without an authenticator (coach, not required) confirms with the current password alone", async () => {
    h.session = staffSession({ id: "coach-1", role: "coach" });
    h.row = { ...h.row!, id: "coach-1", role: "coach", totpEnabled: false, totpSecret: null };
    const res = await call({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(200);
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({ metadata: { confirmedWith: "password" } });
  });

  it("uses the same strength rule as set-password / reset-password", () => {
    for (const bad of ["Short1A", "alllowercase1", "ALLUPPERCASE1", "NoNumbersHere"]) {
      expect(staffPasswordSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(staffPasswordSchema.safeParse(NEW).success).toBe(true);
  });
});

describe("POST /api/account/password — credential checks", () => {
  it("refuses a wrong current password WITHOUT spending the code", async () => {
    const res = await call({ ...good(), currentPassword: "WrongPass1x" });
    expect(res.status).toBe(400);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.row!.totpLastUsedStep).toBeNull();
  });

  it("refuses a missing code for an enrolled account", async () => {
    const res = await call({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(400);
    expect(passwordWrites()).toHaveLength(0);
  });

  it("refuses a wrong code", async () => {
    const code = generateSync({ secret: SECRET });
    const res = await call({ ...good(), totpCode: code === "000000" ? "111111" : "000000" });
    expect(res.status).toBe(400);
    expect(passwordWrites()).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("refuses a REPLAYED code (single use, shared totpLastUsedStep)", async () => {
    const code = generateSync({ secret: SECRET });
    expect((await call({ ...good(), totpCode: code })).status).toBe(200);
    h.row!.mustChangePassword = false;
    const res = await call({ currentPassword: NEW, newPassword: "AnotherPass77", totpCode: code });
    expect(res.status).toBe(400);
    expect(passwordWrites()).toHaveLength(1);
  });

  it("refuses a code already spent elsewhere (e.g. at sign-in)", async () => {
    const code = generateSync({ secret: SECRET });
    // Mark the current step as spent, as /api/auth/totp/verify would.
    h.row!.totpLastUsedStep = Math.floor(Date.now() / 30_000);
    const res = await call({ ...good(), totpCode: code });
    expect(res.status).toBe(400);
    expect(passwordWrites()).toHaveLength(0);
  });

  it.each([
    ["too short", "Ab1"],
    ["no upper-case", "lowercase123"],
    ["no number", "NoNumberHere"],
  ])("refuses a new password that is %s", async (_k, pw) => {
    const res = await call({ ...good(), newPassword: pw });
    expect(res.status).toBe(400);
    expect(passwordWrites()).toHaveLength(0);
  });

  it("refuses the current password as the new one", async () => {
    const res = await call({ ...good(), newPassword: CURRENT });
    expect(res.status).toBe(400);
    expect(passwordWrites()).toHaveLength(0);
  });

  it("refuses a recent password from history", async () => {
    const res = await call({ ...good(), newPassword: "OlderPass1x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/haven't used before/);
    expect(passwordWrites()).toHaveLength(0);
  });

  it("a hash that moved in between (racing change) is a 409 and nothing is recorded", async () => {
    tx.user.updateMany.mockImplementationOnce(async (args: { data: Record<string, unknown> }) => {
      // let the TOTP spend succeed…
      h.row!.totpLastUsedStep = args.data.totpLastUsedStep as number;
      return { count: 1 };
    });
    h.row!.passwordHash = `h:${CURRENT}`;
    const original = h.row!.passwordHash;
    tx.user.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const res = await call(good());
    expect(res.status).toBe(409);
    expect(h.row!.passwordHash).toBe(original);
    expect(tx.passwordHistory.create).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/password — review fixes (D1, D2, history limit)", () => {
  const wrongCode = () => (generateSync({ secret: SECRET }) === "000000" ? "111111" : "000000");

  it("D1: right password + WEAK new password + wrong code → the generic refusal, code unspent", async () => {
    const res = await call({ currentPassword: CURRENT, newPassword: "weak", totpCode: wrongCode() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Your current password or authenticator code was not accepted.");
    expect(h.row!.totpLastUsedStep).toBeNull();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("D1: right password + REUSED old password + wrong code → the generic refusal, history not consulted for an answer", async () => {
    const res = await call({ currentPassword: CURRENT, newPassword: "OlderPass1x", totpCode: wrongCode() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Your current password or authenticator code was not accepted.");
    expect(h.row!.totpLastUsedStep).toBeNull();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("D1: a valid code is checked first but spent only in the transaction (weak password → rule message, code unspent)", async () => {
    const res = await call({ currentPassword: CURRENT, newPassword: "weak", totpCode: generateSync({ secret: SECRET }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 10 characters/);
    expect(h.row!.totpLastUsedStep).toBeNull();
  });

  it.each(["owner", "manager", "admin"])("D2: an unenrolled %s ROW is refused the password-only path (403), whatever the token says", async (role) => {
    h.session = staffSession({ role, requireTotpSetup: false });
    h.row = { ...h.row!, role, totpEnabled: false, totpSecret: null };
    const res = await call({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(403);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it(`refuses the OLDEST of ${PASSWORD_HISTORY_LIMIT} history passwords and reads exactly that many`, async () => {
    expect(PASSWORD_HISTORY_LIMIT).toBe(8);
    h.history = Array.from({ length: 8 }, (_, i) => ({ passwordHash: `h:HistoryPass${i}x` })); // index 7 = oldest
    const res = await call({ ...good(), newPassword: "HistoryPass7x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/haven't used before/);
    expect(tx.passwordHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 8, orderBy: { createdAt: "desc" } }));
    expect(passwordWrites()).toHaveLength(0);
  });
});

describe("POST /api/account/password — refusals", () => {
  it.each([
    ["signed out", null, 401],
    ["a member", { user: { id: "m1", tenantId: "tenant-A", role: "member" } }, 403],
    ["a sign-in still owing its code", staffSession({ totpPending: true }), 403],
    ["a temporary-password session", staffSession({ mustChangePassword: true }), 403],
    ["an elevated role not yet enrolled", staffSession({ requireTotpSetup: true }), 403],
    ["a support session", staffSession({ impersonatedBy: "op-1" }), 403],
  ])("refuses %s, nothing written", async (_label, session, status) => {
    h.session = session as never;
    const res = await call(good());
    expect(res.status).toBe(status);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("refuses when the ROW still owes a forced change, even if the token says otherwise", async () => {
    h.row!.mustChangePassword = true;
    const res = await call(good());
    expect(res.status).toBe(403);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["userId", { userId: "someone-else" }],
    ["tenantId", { tenantId: "tenant-B" }],
    ["email", { email: "x@example.com" }],
    ["role", { role: "owner" }],
    ["mustChangePassword", { mustChangePassword: false }],
  ])("refuses an extra %s key (strict body), nothing written", async (_k, extra) => {
    const res = await call({ ...good(), ...extra });
    expect(res.status).toBe(400);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });
});
