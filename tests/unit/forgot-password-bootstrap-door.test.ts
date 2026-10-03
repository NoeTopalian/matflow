import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// Mailbox doors on a bootstrap account (3 Oct 2026): forgot-password and
// reset-password.
//
// A staff account on a temporary password (`mustChangePassword`) must not be
// resettable through its mailbox — the first real club owner's address is
// provisional, and a reset code there hands the account to whoever reads it.
// forgot-password answers as for an unknown address and sends nothing;
// reset-password refuses a code requested before the flag was set, with the
// expired-code message, and changes nothing. Members are unaffected.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    member: { findFirst: vi.fn(), update: vi.fn() },
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
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, logId: "log-1" }),
}));
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(false),
    hash: vi.fn().mockResolvedValue("$2a$12$newhash"),
  },
}));

import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { POST as forgot } from "@/app/api/auth/forgot-password/route";
import { POST as reset } from "@/app/api/auth/reset-password/route";

const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockPrtCreate = vi.mocked(prisma.passwordResetToken.create);
const mockPrtUpdateMany = vi.mocked(prisma.passwordResetToken.updateMany);
const mockPrtFindFirst = vi.mocked(prisma.passwordResetToken.findFirst);
const mockUserUpdate = vi.mocked(prisma.user.update);
const mockMemberUpdate = vi.mocked(prisma.member.update);
const mockSendEmail = vi.mocked(sendEmail);

const savedResend = process.env.RESEND_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "tenant-A", name: "Total BJJ" } as never);
  vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([] as never);
  mockPrtUpdateMany.mockResolvedValue({ count: 1 } as never);
  mockPrtFindFirst.mockResolvedValue({
    id: "rt-1", email: "owner@club.example", tenantId: "tenant-A", used: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as never);
});

afterAll(() => {
  if (savedResend === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedResend;
});

function forgotReq(email = "owner@club.example") {
  return forgot(
    new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, tenantSlug: "total-bjj" }),
    }),
  );
}

function resetReq(email = "owner@club.example") {
  return reset(
    new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "123456", email, tenantSlug: "total-bjj", password: "Str0ngPassword!" }),
    }),
  );
}

describe("forgot-password — a temporary-password account gets no code", () => {
  it("answers 200 {ok:true}, writes no token and sends nothing for a flagged staff user", async () => {
    mockUserFindFirst.mockResolvedValue({ id: "user-1", mustChangePassword: true } as never);
    mockMemberFindFirst.mockResolvedValue(null as never);

    const res = await forgotReq();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockPrtCreate).not.toHaveBeenCalled();
    expect(mockPrtUpdateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does not reopen through a member who shares the address", async () => {
    mockUserFindFirst.mockResolvedValue({ id: "user-1", mustChangePassword: true } as never);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1" } as never);

    await forgotReq();

    expect(mockPrtCreate).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends a code once the person has chosen their own password", async () => {
    mockUserFindFirst.mockResolvedValue({ id: "user-1", mustChangePassword: false } as never);
    mockMemberFindFirst.mockResolvedValue(null as never);

    await forgotReq();

    expect(mockPrtCreate).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("leaves members unaffected", async () => {
    mockUserFindFirst.mockResolvedValue(null as never);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1" } as never);

    await forgotReq("member@club.example");

    expect(mockPrtCreate).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("reset-password — a code cannot reset a temporary-password account", () => {
  it("refuses with the expired-code message and changes nothing", async () => {
    mockUserFindFirst.mockResolvedValue({
      id: "user-1", passwordHash: "$2a$12$oldhash", mustChangePassword: true,
    } as never);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", passwordHash: "$2a$12$memhash" } as never);

    const res = await resetReq();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid or has expired/);
    expect(mockPrtUpdateMany).not.toHaveBeenCalled(); // token not consumed
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("still resets an account whose owner has chosen their password", async () => {
    mockUserFindFirst.mockResolvedValue({
      id: "user-1", passwordHash: "$2a$12$oldhash", mustChangePassword: false,
    } as never);

    const res = await resetReq();

    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledTimes(1);
  });

  it("still resets a member", async () => {
    mockUserFindFirst.mockResolvedValue(null as never);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", passwordHash: "$2a$12$memhash" } as never);

    const res = await resetReq("member@club.example");

    expect(res.status).toBe(200);
    expect(mockMemberUpdate).toHaveBeenCalledTimes(1);
  });
});
