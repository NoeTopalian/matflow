import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";

// Provisional login email (7 Oct 2026, US-001): the doors.
//
// While `User.loginEmailProvisionalSince` is set, the address is a login
// identifier, not a proven mailbox. Every mailbox door must stay shut whatever
// the password state (these rows are NOT on a temporary password — that is the
// 3 Oct bootstrap rule, pinned in forgot-password-bootstrap-door and
// magic-link-bootstrap-doors):
//   - forgot-password and magic-link request mint and send nothing and answer
//     exactly as for an unknown address; the refusal is audited;
//   - reset-password and magic-link verify refuse an outstanding token as
//     expired, burn it, and audit the refusal;
//   - Google sign-in is refused (source-level: the callback is built inside
//     NextAuth's config);
//   - password + authenticator sign-in is untouched.

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => { void fn(); },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
    redirect: (url: URL | string) => {
      const loc = url instanceof URL ? url.toString() : url;
      return { status: 302, headers: new Headers({ location: loc }), cookies: { set: mockCookieSet } };
    },
  },
}));
const mockCookieSet = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    member: { findFirst: vi.fn(), update: vi.fn() },
    magicLinkToken: { updateMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    passwordResetToken: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    passwordHistory: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: vi.fn(() => "203.0.113.7"),
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue({ ok: true, logId: "log-1" }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: vi.fn(() => false) }));
vi.mock("next-auth/jwt", () => ({ encode: vi.fn().mockResolvedValue("encoded-jwt-token") }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(false), hash: vi.fn().mockResolvedValue("$2a$12$newhash") },
}));

import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";
import { encode } from "next-auth/jwt";
import { POST as requestLinkRoute } from "@/app/api/magic-link/request/route";
import { GET as verifyLinkRoute } from "@/app/api/magic-link/verify/route";
import { POST as forgotRoute } from "@/app/api/auth/forgot-password/route";
import { POST as resetRoute } from "@/app/api/auth/reset-password/route";
import { isLoginEmailProvisional } from "@/lib/login-email";

const m = {
  tenant: vi.mocked(prisma.tenant.findUnique),
  user: vi.mocked(prisma.user.findFirst),
  userUpdate: vi.mocked(prisma.user.update),
  member: vi.mocked(prisma.member.findFirst),
  linkUpdateMany: vi.mocked(prisma.magicLinkToken.updateMany),
  linkCreate: vi.mocked(prisma.magicLinkToken.create),
  linkFind: vi.mocked(prisma.magicLinkToken.findUnique),
  resetFind: vi.mocked(prisma.passwordResetToken.findFirst),
  resetUpdateMany: vi.mocked(prisma.passwordResetToken.updateMany),
  resetCreate: vi.mocked(prisma.passwordResetToken.create),
  send: vi.mocked(sendEmail),
  audit: vi.mocked(logAudit),
  encode: vi.mocked(encode),
};

const TENANT = {
  id: "tenant-A", slug: "club-a", name: "Club A",
  primaryColor: "#111111", secondaryColor: "#222222", textColor: "#333333",
  subscriptionStatus: "active", deletedAt: null,
};
const SINCE = new Date("2026-10-07T09:00:00Z");
const OWNER = {
  id: "user-1", tenantId: "tenant-A", email: "owner@club.example", name: "Owner", role: "owner",
  sessionVersion: 3, totpEnabled: true, mustChangePassword: false, notifyOnNewLogin: true,
  passwordHash: "$2a$12$x", loginEmailProvisionalSince: SINCE,
};

const savedResend = process.env.RESEND_API_KEY;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  m.tenant.mockResolvedValue(TENANT as never);
  m.member.mockResolvedValue(null as never);
  m.linkUpdateMany.mockResolvedValue({ count: 1 } as never);
  m.linkCreate.mockResolvedValue({} as never);
  m.resetUpdateMany.mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([] as never);
});
afterAll(() => {
  if (savedResend === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedResend;
});

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// The request route reads user.findFirst twice: the subject, then the owner (Reply-To).
function subject(row: Record<string, unknown> | null) {
  m.user.mockImplementation((async (args: { where?: { role?: string } }) =>
    args?.where?.role === "owner" ? { email: OWNER.email, loginEmailProvisionalSince: SINCE } : row) as never);
}

describe("isLoginEmailProvisional", () => {
  it("is true only for a non-null provisional-since", () => {
    expect(isLoginEmailProvisional({ loginEmailProvisionalSince: SINCE })).toBe(true);
    expect(isLoginEmailProvisional({ loginEmailProvisionalSince: "2026-10-07T09:00:00Z" })).toBe(true);
    expect(isLoginEmailProvisional({ loginEmailProvisionalSince: null })).toBe(false);
    expect(isLoginEmailProvisional({})).toBe(false);
    expect(isLoginEmailProvisional(null)).toBe(false);
  });
});

describe("magic-link request — a provisional login email gets no link", () => {
  const request = (email = OWNER.email) => requestLinkRoute(post("http://localhost/api/magic-link/request", { email, tenantSlug: "club-a" }));

  it("answers 200 {ok:true}, mints and sends nothing, and audits the refusal", async () => {
    subject(OWNER);
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.linkCreate).not.toHaveBeenCalled();
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.magic_link.refused_provisional", entityId: "user-1" }),
    );
  });

  it("answers exactly as for an unknown address", async () => {
    subject(OWNER);
    const provisional = await (await request()).json();
    subject(null);
    const unknown = await (await request("nobody@club.example")).json();
    expect(provisional).toEqual(unknown);
  });

  it("a verified (non-provisional) owner still gets a link", async () => {
    subject({ ...OWNER, loginEmailProvisionalSince: null });
    await request();
    expect(m.linkCreate).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("a member's link never carries a provisional owner address as Reply-To", async () => {
    subject(null);
    m.member.mockResolvedValue({ id: "mem-1" } as never);
    await request("member@club.example");
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).not.toHaveProperty("replyTo");
  });
});

describe("magic-link verify — a provisional login email never signs in by link", () => {
  const verify = () => verifyLinkRoute(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);

  for (const purpose of ["login", "first_time_signup"]) {
    it(`refuses a ${purpose} token as an expired link, consumed, no cookie, audited`, async () => {
      m.linkFind.mockResolvedValue({ tenantId: "tenant-A", email: OWNER.email, purpose } as never);
      m.user.mockResolvedValue(OWNER as never);
      const res = await verify();
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login?error=invalid_link");
      expect(m.linkUpdateMany).toHaveBeenCalledTimes(1); // consumed: not replayable later
      expect(m.encode).not.toHaveBeenCalled();
      expect(mockCookieSet).not.toHaveBeenCalled();
      expect(m.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "auth.magic_link.refused_provisional", entityId: "user-1" }),
      );
    });
  }

  it("a verified owner's link still works (control)", async () => {
    m.linkFind.mockResolvedValue({ tenantId: "tenant-A", email: OWNER.email, purpose: "login" } as never);
    m.user.mockResolvedValue({ ...OWNER, loginEmailProvisionalSince: null } as never);
    const res = await verify();
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(m.encode).toHaveBeenCalledTimes(1);
  });
});

describe("forgot-password — a provisional login email gets no code", () => {
  const forgot = (email = OWNER.email) => forgotRoute(post("http://localhost/api/auth/forgot-password", { email, tenantSlug: "club-a" }));

  it("answers 200 {ok:true}, writes no token, sends nothing, audits", async () => {
    m.user.mockResolvedValue({ id: "user-1", mustChangePassword: false, loginEmailProvisionalSince: SINCE } as never);
    const res = await forgot();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.resetCreate).not.toHaveBeenCalled();
    expect(m.resetUpdateMany).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.password_reset.refused_provisional", entityId: "user-1" }),
    );
  });

  it("a member sharing the address does not reopen the door (User precedence)", async () => {
    m.user.mockResolvedValue({ id: "user-1", mustChangePassword: false, loginEmailProvisionalSince: SINCE } as never);
    m.member.mockResolvedValue({ id: "mem-1" } as never);
    await forgot();
    expect(m.resetCreate).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("answers exactly as for an unknown address", async () => {
    m.user.mockResolvedValue({ id: "user-1", mustChangePassword: false, loginEmailProvisionalSince: SINCE } as never);
    const a = await (await forgot()).json();
    m.user.mockResolvedValue(null as never);
    const b = await (await forgot("nobody@club.example")).json();
    expect(a).toEqual(b);
  });

  it("a verified owner still gets a code (control)", async () => {
    m.user.mockResolvedValue({ id: "user-1", mustChangePassword: false, loginEmailProvisionalSince: null } as never);
    await forgot();
    expect(m.resetCreate).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
});

describe("reset-password — an outstanding code for a provisional login email is dead", () => {
  const reset = () =>
    resetRoute(post("http://localhost/api/auth/reset-password", {
      token: "123456", email: OWNER.email, tenantSlug: "club-a", password: "Str0ngPassword!",
    }));

  it("refuses as an expired code, burns the code, changes nothing, audits", async () => {
    m.resetFind.mockResolvedValue({
      id: "rt-1", email: OWNER.email, tenantId: "tenant-A", used: false, expiresAt: new Date(Date.now() + 60_000),
    } as never);
    m.user.mockResolvedValue({ id: "user-1", passwordHash: "$2a$12$old", mustChangePassword: false, loginEmailProvisionalSince: SINCE } as never);
    const res = await reset();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid or has expired/);
    expect(m.resetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "rt-1" }), data: { used: true } }),
    );
    expect(m.userUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.member.update)).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.password_reset.refused_provisional", entityId: "user-1" }),
    );
  });
});

describe("mail-dark (EMAIL_DELIVERY=off) — no orphan codes or links are minted", () => {
  const savedDelivery = process.env.EMAIL_DELIVERY;
  beforeEach(() => { process.env.EMAIL_DELIVERY = "off"; });
  afterAll(() => {
    if (savedDelivery === undefined) delete process.env.EMAIL_DELIVERY;
    else process.env.EMAIL_DELIVERY = savedDelivery;
  });

  it("forgot-password: a verified owner gets the opaque 200, no code minted, earlier codes untouched, nothing sent", async () => {
    m.user.mockResolvedValue({ id: "user-1", mustChangePassword: false, loginEmailProvisionalSince: null } as never);
    const res = await forgotRoute(post("http://localhost/api/auth/forgot-password", { email: OWNER.email, tenantSlug: "club-a" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.resetCreate).not.toHaveBeenCalled();
    expect(m.resetUpdateMany).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("magic-link request: a member gets the opaque 200, no link minted, earlier links untouched, nothing sent", async () => {
    subject(null);
    m.member.mockResolvedValue({ id: "mem-1" } as never);
    const res = await requestLinkRoute(post("http://localhost/api/magic-link/request", { email: "member@club.example", tenantSlug: "club-a" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.linkCreate).not.toHaveBeenCalled();
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("control: with delivery on (unset) the same requests do mint", async () => {
    delete process.env.EMAIL_DELIVERY;
    m.user.mockResolvedValue({ id: "user-1", mustChangePassword: false, loginEmailProvisionalSince: null } as never);
    await forgotRoute(post("http://localhost/api/auth/forgot-password", { email: OWNER.email, tenantSlug: "club-a" }));
    expect(m.resetCreate).toHaveBeenCalledTimes(1);
  });
});

describe("Google / external sign-in — refused for a provisional login email (source)", () => {
  const src = readFileSync("auth.ts", "utf8");
  it("the refusal sits in the signIn callback after the account lookup and before the token is hydrated", () => {
    const lookup = src.indexOf('if (!dbUser && !memberRow) return "/login?error=google_link_required"');
    const refusal = src.indexOf("if (isLoginEmailProvisional(dbUser))");
    const hydrate = src.indexOf("Object.assign(user, dbUser");
    expect(lookup).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(lookup);
    expect(hydrate).toBeGreaterThan(refusal);
    expect(src.slice(refusal, hydrate)).toContain('return "/login?error=invalid_link"');
    expect(src.slice(refusal, hydrate)).toContain("auth.external_signin.refused_provisional");
  });

  it("password + authenticator sign-in is unaffected: the Credentials authorize never reads the mark", () => {
    const authorizeStart = src.indexOf("async authorize(credentials, request)");
    const callbacksStart = src.indexOf("callbacks: {");
    expect(authorizeStart).toBeGreaterThan(0);
    expect(callbacksStart).toBeGreaterThan(authorizeStart);
    expect(src.slice(authorizeStart, callbacksStart)).not.toMatch(/loginEmailProvisional|isLoginEmailProvisional/);
  });
});
