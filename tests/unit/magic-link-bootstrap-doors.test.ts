import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// Mailbox doors on a bootstrap account (3 Oct 2026).
//
// While a staff account carries `mustChangePassword`, its credential is the
// temporary password handed over privately — not its mailbox, which for the
// first real club owner is a provisional address he is not proven to control.
// The magic-link door must neither send a link nor honour one for such an
// account. Separately, an ENROLLED owner/manager/admin who signs in by link
// is now challenged for TOTP; coaches and members keep the 7 May bypass.

vi.mock("next/server", () => ({
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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    magicLinkToken: { updateMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, logId: "log-1" }),
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: vi.fn(() => false) }));
vi.mock("next-auth/jwt", () => ({
  encode: vi.fn().mockResolvedValue("encoded-jwt-token"),
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));

import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";
import { encode } from "next-auth/jwt";
import { isTestingMode } from "@/lib/testing-mode";
import { POST } from "@/app/api/magic-link/request/route";
import { GET } from "@/app/api/magic-link/verify/route";

const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockTokenUpdateMany = vi.mocked(prisma.magicLinkToken.updateMany);
const mockTokenCreate = vi.mocked(prisma.magicLinkToken.create);
const mockTokenFindUnique = vi.mocked(prisma.magicLinkToken.findUnique);
const mockSendEmail = vi.mocked(sendEmail);
const mockEncode = vi.mocked(encode);

const TENANT = {
  id: "tenant-A", slug: "total-bjj", name: "Total BJJ",
  primaryColor: "#111111", secondaryColor: "#222222", textColor: "#333333",
  subscriptionStatus: "active", deletedAt: null,
};

const savedResend = process.env.RESEND_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTestingMode).mockReturnValue(false);
  process.env.RESEND_API_KEY = "re_test";
  mockTenantFindUnique.mockResolvedValue(TENANT as never);
  mockTokenUpdateMany.mockResolvedValue({ count: 1 } as never);
  mockTokenCreate.mockResolvedValue({} as never);
});

afterAll(() => {
  if (savedResend === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedResend;
});

function requestLink(email = "owner@club.example") {
  return POST(
    new Request("http://localhost/api/magic-link/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, tenantSlug: "total-bjj" }),
    }),
  );
}

// The request route calls user.findFirst twice: the subject, then the owner
// (for Reply-To). Route both through one implementation keyed on `where.role`.
function staffSubject(row: Record<string, unknown> | null) {
  mockUserFindFirst.mockImplementation((async (args: { where?: { role?: string } }) =>
    args?.where?.role === "owner" ? { email: "owner@club.example" } : row) as never);
}

describe("magic-link request — a temporary-password account gets no link", () => {
  it("answers 200 {ok:true}, mints no token and sends nothing for a flagged staff user", async () => {
    staffSubject({ id: "user-1", mustChangePassword: true });
    mockMemberFindFirst.mockResolvedValue(null as never);

    const res = await requestLink();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTokenCreate).not.toHaveBeenCalled();
    expect(mockTokenUpdateMany).not.toHaveBeenCalled();
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.magic_link.refused_bootstrap", entityId: "user-1" }),
    );
  });

  it("answers byte-for-byte like an unknown address", async () => {
    staffSubject({ id: "user-1", mustChangePassword: true });
    mockMemberFindFirst.mockResolvedValue(null as never);
    const flagged = await (await requestLink()).json();

    staffSubject(null);
    mockMemberFindFirst.mockResolvedValue(null as never);
    const unknown = await (await requestLink("nobody@club.example")).json();

    expect(flagged).toEqual(unknown);
  });

  it("still sends a link once the person has chosen their own password", async () => {
    staffSubject({ id: "user-1", mustChangePassword: false });
    mockMemberFindFirst.mockResolvedValue(null as never);

    const res = await requestLink();

    expect(res.status).toBe(200);
    expect(mockTokenCreate).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("leaves members unaffected", async () => {
    staffSubject(null);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1" } as never);

    const res = await requestLink("member@club.example");

    expect(res.status).toBe(200);
    expect(mockTokenCreate).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

function primeToken() {
  mockTokenUpdateMany.mockResolvedValue({ count: 1 } as never);
  mockTokenFindUnique.mockResolvedValue({
    tenantId: "tenant-A", email: "owner@club.example", purpose: "login",
  } as never);
}

async function verify() {
  return GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);
}

function mintedToken() {
  return mockEncode.mock.calls[0][0].token as Record<string, unknown>;
}

describe("magic-link verify — a temporary-password account cannot sign in by link", () => {
  it("refuses a link requested before the flag was set, as an expired link, with no cookie", async () => {
    primeToken();
    mockUserFindFirst.mockResolvedValue({
      id: "user-1", tenantId: "tenant-A", email: "owner@club.example", name: "Owner",
      role: "owner", sessionVersion: 3, totpEnabled: false, mustChangePassword: true,
    } as never);
    mockMemberFindFirst.mockResolvedValue(null as never);

    const res = await verify();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=invalid_link");
    expect(mockEncode).not.toHaveBeenCalled();
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});

describe("magic-link verify — elevated roles are challenged (3 Oct narrowing)", () => {
  function staff(role: string, totpEnabled: boolean) {
    primeToken();
    mockUserFindFirst.mockResolvedValue({
      id: "user-1", tenantId: "tenant-A", email: "owner@club.example", name: "Staff",
      role, sessionVersion: 1, totpEnabled, mustChangePassword: false,
    } as never);
    mockMemberFindFirst.mockResolvedValue(null as never);
  }

  it("an enrolled owner gets totpPending true, so /login/totp still asks for the code", async () => {
    staff("owner", true);
    const res = await verify();
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(mintedToken().totpPending).toBe(true);
    expect(mintedToken().requireTotpSetup).toBe(false);
  });

  it("an enrolled manager is challenged too", async () => {
    staff("manager", true);
    await verify();
    expect(mintedToken().totpPending).toBe(true);
  });

  it("an enrolled coach keeps the 7 May bypass", async () => {
    staff("coach", true);
    await verify();
    expect(mintedToken().totpPending).toBe(false);
  });

  it("an unenrolled owner is held at enrolment, not at a challenge", async () => {
    staff("owner", false);
    await verify();
    expect(mintedToken().requireTotpSetup).toBe(true);
    expect(mintedToken().totpPending).toBe(false);
  });

  it("TESTING_MODE keeps the challenge off, as auth.ts does", async () => {
    vi.mocked(isTestingMode).mockReturnValue(true);
    staff("owner", true);
    await verify();
    expect(mintedToken().totpPending).toBe(false);
  });

  it("members are never challenged on this door", async () => {
    primeToken();
    mockUserFindFirst.mockResolvedValue(null as never);
    mockMemberFindFirst.mockResolvedValue({
      id: "mem-1", tenantId: "tenant-A", email: "owner@club.example", name: "Sam",
      sessionVersion: 1, totpEnabled: true,
    } as never);
    await verify();
    expect(mintedToken().totpPending).toBe(false);
  });
});
