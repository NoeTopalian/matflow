import { vi, describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { generateSecret, generateSync } from "otplib";

// POST /api/account/login-email (7 Oct 2026, US-002): a signed-in staff user
// changes their own login email. Needs the current password AND a fresh,
// single-use authenticator code. One transaction: email, provisional mark,
// tokens for old + new retired, sessionVersion bumped, audit with digests.
// Every session (this one included) is signed out. Support sessions, code-owing
// sign-ins, temporary-password sessions and accounts without an authenticator
// are refused.

const SECRET = generateSecret();

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  compare: vi.fn(async () => true),
  logAudit: vi.fn(async () => {}),
  row: null as null | Record<string, unknown>,
  userCollision: null as null | { id: string },
  memberCollision: null as null | { id: string },
}));

const tx = {
  user: {
    findFirst: vi.fn(async (args: { where: { id?: unknown } }) =>
      typeof args.where.id === "string" ? h.row : h.userCollision),
    // Behaves like the conditional UPDATE in consumeUserTotp.
    updateMany: vi.fn(async (args: { data: { totpLastUsedStep: number } }) => {
      const last = h.row!.totpLastUsedStep as number | null;
      if (last === null || last < args.data.totpLastUsedStep) {
        h.row!.totpLastUsedStep = args.data.totpLastUsedStep;
        return { count: 1 };
      }
      return { count: 0 };
    }),
    update: vi.fn(async () => ({})),
  },
  member: { findFirst: vi.fn(async () => h.memberCollision) },
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
vi.mock("bcryptjs", () => ({ default: { compare: h.compare } }));

import { GET, POST } from "@/app/api/account/login-email/route";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ownerSession = (extra: Record<string, unknown> = {}) => ({
  user: { id: "owner-1", tenantId: "tenant-A", role: "owner", totpPending: false, mustChangePassword: false, requireTotpSetup: false, ...extra },
});
const call = (body: unknown) =>
  POST(new Request("http://localhost/api/account/login-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const good = () => ({ newEmail: " New@Owner.Example ", currentPassword: "CorrectHorse1", totpCode: generateSync({ secret: SECRET }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.session = ownerSession();
  h.compare.mockResolvedValue(true);
  h.row = {
    id: "owner-1", email: "provisional@club.example", passwordHash: "$2a$12$x",
    totpEnabled: true, totpSecret: SECRET, totpLastUsedStep: null,
    loginEmailProvisionalSince: new Date("2026-10-07T08:00:00Z"),
  };
  h.userCollision = null;
  h.memberCollision = null;
});

describe("GET /api/account/login-email", () => {
  it("returns the address and the provisional badge state", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: "provisional@club.example", provisional: true,
      provisionalSince: "2026-10-07T08:00:00.000Z", totpEnabled: true, emailDelivery: "on",
    });
  });
  it("reports the mail switch so the card's copy is true either way (review defect 3)", async () => {
    process.env.EMAIL_DELIVERY = "off";
    try {
      expect((await (await GET()).json()).emailDelivery).toBe("off");
    } finally {
      delete process.env.EMAIL_DELIVERY;
    }
  });
  it("refuses a signed-out caller", async () => {
    h.session = null;
    expect((await GET()).status).toBe(401);
  });
});

describe("POST /api/account/login-email — refusals", () => {
  it.each([
    ["signed out", null, 401],
    ["a member", { user: { id: "m1", tenantId: "tenant-A", role: "member" } }, 403],
    ["a sign-in still owing its code", ownerSession({ totpPending: true }), 403],
    ["a temporary-password session", ownerSession({ mustChangePassword: true }), 403],
    ["a support session", ownerSession({ impersonatedBy: "op-1" }), 403],
  ])("refuses %s, nothing written", async (_label, session, status) => {
    h.session = session as never;
    const res = await call(good());
    expect(res.status).toBe(status);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an account without an authenticator", async () => {
    h.session = ownerSession({ role: "coach" });
    h.row = { ...h.row!, totpEnabled: false, totpSecret: null };
    const res = await call(good());
    expect(res.status).toBe(403);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password without spending the code", async () => {
    h.compare.mockResolvedValue(false);
    const res = await call(good());
    expect(res.status).toBe(400);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses a wrong code", async () => {
    const res = await call({ ...good(), totpCode: "000000" === generateSync({ secret: SECRET }) ? "111111" : "000000" });
    expect(res.status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses a REPLAYED code (single use)", async () => {
    const body = good();
    expect((await call(body)).status).toBe(200);
    tx.user.update.mockClear();
    h.row!.email = "new@owner.example";
    const again = await call({ ...body, newEmail: "third@owner.example" });
    expect(again.status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  // Review defect 10 (7 Oct 2026): pins the conditional UPDATE on its own. A
  // valid, never-used code still loses when another request spent the step
  // first (updateMany matched no row) — afterTimeStep alone cannot see that.
  it("refuses when the conditional spend matches no row (a racing request won)", async () => {
    tx.user.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await call(good());
    expect(res.status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("refuses the current address", async () => {
    const res = await call({ ...good(), newEmail: "Provisional@Club.example" });
    expect(res.status).toBe(400);
  });

  it("a collision with another user of the club is 409 without saying whose", async () => {
    h.userCollision = { id: "coach-2" };
    const res = await call(good());
    expect(res.status).toBe(409);
    expect((await res.json()).error).not.toMatch(/coach|member|staff|owner/i);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("a collision with a member of the club is 409", async () => {
    h.memberCollision = { id: "mem-1" };
    const res = await call(good());
    expect(res.status).toBe(409);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/login-email — success", () => {
  it("changes the email, marks it provisional, bumps the version, retires old+new tokens, audits digests, signs out", async () => {
    const res = await call(good());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signInAgain: true, provisional: true });
    const upd = tx.user.update.mock.calls[0] as unknown as [{ where: { id: string }; data: Record<string, unknown> }];
    expect(upd[0].where).toEqual({ id: "owner-1" });
    expect(upd[0].data.email).toBe("new@owner.example");
    expect(upd[0].data.loginEmailProvisionalSince).toBeInstanceOf(Date);
    expect(upd[0].data.sessionVersion).toEqual({ increment: 1 });
    for (const k of ["role", "tenantId", "totpSecret", "totpEnabled", "totpRecoveryCodes", "passwordHash"]) {
      expect(upd[0].data).not.toHaveProperty(k);
    }
    expect(tx.member.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-A", email: "new@owner.example" } }));
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-A", email: { in: ["provisional@club.example", "new@owner.example"] } }),
    }));
    expect(tx.magicLinkToken.updateMany).toHaveBeenCalledTimes(1);
    const audit = (h.logAudit.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(audit).toMatchObject({
      tx,
      action: "user.login_email.changed",
      userId: "owner-1",
      metadata: expect.objectContaining({
        oldEmailSha256: sha("provisional@club.example"),
        newEmailSha256: sha("new@owner.example"),
        confirmedWith: "password+totp",
      }),
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("@");
    // This device's cookie is cleared too.
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/i);
  });

  it("an audit failure means nothing changed (500)", async () => {
    h.logAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await call(good());
    expect(res.status).toBe(500);
  });
});
