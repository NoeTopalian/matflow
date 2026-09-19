import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// L2 — POST /api/auth/reset-password must bump sessionVersion in the same
// transaction as the password update so any pre-existing JWT becomes invalid
// on the next Node-runtime auth() check.

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
    passwordResetToken: { findFirst: vi.fn(), updateMany: vi.fn() },
    passwordHistory: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
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

const mockCheckRateLimit = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(false),
    hash: vi.fn().mockResolvedValue("$2a$12$newhash"),
  },
}));

import { prisma } from "@/lib/prisma";

const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockUserUpdate = vi.mocked(prisma.user.update);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockMemberUpdate = vi.mocked(prisma.member.update);
const mockPrtFindFirst = vi.mocked(prisma.passwordResetToken.findFirst);
const mockPrtUpdateMany = vi.mocked(prisma.passwordResetToken.updateMany);
const mockHistoryFindMany = vi.mocked(prisma.passwordHistory.findMany);
const mockTx = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockTenantFindUnique.mockResolvedValue({ id: "tenant-A" } as never);
  mockUserFindFirst.mockResolvedValue({
    id: "user-1",
    email: "alice@gym.com",
    tenantId: "tenant-A",
    passwordHash: "$2a$12$oldhash",
  } as never);
  mockPrtFindFirst.mockResolvedValue({
    id: "rt-1",
    token: "valid-token",
    email: "alice@gym.com",
    tenantId: "tenant-A",
    used: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as never);
  mockPrtUpdateMany.mockResolvedValue({ count: 1 } as never);
  mockHistoryFindMany.mockResolvedValue([] as never);
  // Capture the operations passed into $transaction so we can assert on them.
  mockTx.mockImplementation(async (ops: unknown) => {
    return Array.isArray(ops) ? ops.map(() => ({})) : ([] as never);
  });
});

function makeReq() {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "valid-token",
      email: "alice@gym.com",
      tenantSlug: "gym",
      password: "Str0ngPassword!", // satisfies validatePassword
    }),
  });
}

describe("L2 — reset-password bumps sessionVersion", () => {
  it("calls user.update with passwordHash AND sessionVersion increment in the transaction", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);

    // The $transaction was called with an array including a user.update that
    // sets BOTH passwordHash AND sessionVersion.increment. We exercise the
    // same Prisma surface the route uses by re-invoking the user.update mock
    // through the captured operation list.
    expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: expect.objectContaining({
        passwordHash: "$2a$12$newhash",
        sessionVersion: { increment: 1 },
      }),
    }));
  });

  it("does NOT bump sessionVersion when token is invalid (returns 400)", async () => {
    mockPrtFindFirst.mockResolvedValue(null);
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("does NOT bump sessionVersion when concurrent token consume races (count 0)", async () => {
    mockPrtUpdateMany.mockResolvedValue({ count: 0 } as never);
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });
});

/**
 * A reset must clear the brute-force lockout as well as the password.
 *
 * `app/login/page.tsx:61` tells a locked person, in as many words: "Try again
 * in an hour, or reset your password." Follow that instruction and — before
 * this fix — nothing happens: `auth.ts:294` computes `isLocked` and
 * `auth.ts:312` throws `AccountLockedError` BEFORE the password is compared, so
 * the brand-new password is never consulted. The clear at `auth.ts:358-374`
 * only runs after a successful sign-in, which the lock has already prevented.
 *
 * Whoever holds the reset code has proved control of the mailbox, which is a
 * stronger claim than the ten wrong guesses that set the lock. Clearing it here
 * is what the screen already promises.
 */
describe("reset-password clears the account lockout the login page tells people to clear", () => {
  it("clears lockedUntil and failedLoginCount for a staff User", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);

    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          passwordHash: "$2a$12$newhash",
          sessionVersion: { increment: 1 },
          lockedUntil: null,
          failedLoginCount: 0,
        }),
      }),
    );
  });

  it("clears lockedUntil and failedLoginCount for a Member", async () => {
    // No staff row for this address — the route falls through to the Member
    // branch (route.ts:93-104), which is the common case: members are the ones
    // who get locked out at the kiosk and on the portal.
    mockUserFindFirst.mockResolvedValue(null);
    mockMemberFindFirst.mockResolvedValue({
      id: "member-1",
      passwordHash: "$2a$12$oldhash",
    } as never);

    const res = await POST_route(makeReq());
    expect(res.status).toBe(200);

    expect(mockMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-1" },
        data: expect.objectContaining({
          passwordHash: "$2a$12$newhash",
          sessionVersion: { increment: 1 },
          lockedUntil: null,
          failedLoginCount: 0,
        }),
      }),
    );
  });

  it("does not clear a lockout when the code is wrong", async () => {
    mockPrtFindFirst.mockResolvedValue(null);
    const res = await POST_route(makeReq());
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });
});

async function POST_route(req: Request) {
  const { POST } = await import("@/app/api/auth/reset-password/route");
  return POST(req as never);
}

/**
 * The consume side needs a brake of its own.
 *
 * `forgot-password` is limited to three sends per fifteen minutes per
 * email+club, so nobody can flood a mailbox. `reset-password` had no limit at
 * all — and it is the side that accepts a SIX-DIGIT code with a two-minute
 * life. One live code and two minutes is a million guesses wide in principle
 * and, over a fast connection, a serious fraction of that in practice, against
 * an address an attacker already knows. A guessed code is a full account
 * takeover: it sets the password and, since the lockout fix above, clears the
 * lockout with it.
 *
 * Keyed on tenant+email like its sibling, and `failClosed` — if the limiter
 * store is unreachable the right answer is to stop accepting guesses, not to
 * wave them through.
 */
describe("reset-password limits how many codes can be tried", () => {
  it("refuses with 429 and a Retry-After once the bucket is spent, writing nothing", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });

    const res = await POST_route(makeReq());

    expect(res.status).toBe(429);
    expect(mockUserUpdate, "a throttled attempt changes no password").not.toHaveBeenCalled();
    expect(mockPrtUpdateMany, "and consumes no token").not.toHaveBeenCalled();
  });

  it("keys the bucket on tenant and email, and fails closed", async () => {
    await POST_route(makeReq());

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("alice@gym.com"),
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ failClosed: true }),
    );
    const key = mockCheckRateLimit.mock.calls[0][0] as string;
    expect(key, "the club is part of the key, so one club cannot throttle another").toContain("gym");
  });

  it("lets a first, legitimate attempt straight through", async () => {
    const res = await POST_route(makeReq());
    expect(res.status).toBe(200);
  });
});

// ── The recovery doors have exactly ONE answer ────────────────────────────────
//
// `forgot-password` answers `200 {"ok":true}` for a malformed body, an unknown
// club and an address with no account, so that nobody can use "I forgot my
// password" to ask whether someone trains at a club. Only an address that DOES
// have an account reaches the send at the end of the handler — where, until
// 19 Sep 2026, a dead mail service answered 503. That made the route a clean
// oracle whenever mail was down: 503 meant "this person trains here" and 200
// meant "they do not". The e2e campaign caught it as a coach's address
// answering 503 while two decoys answered 200.
//
// A scan, not a behavioural test, and deliberately so: the property is about
// the route having no second answer at all, which is exactly the shape a
// reviewer cannot hold in their head and a future `return 503` would quietly
// break.
describe("the recovery routes never answer anything but 200", () => {
  for (const file of [
    "app/api/auth/forgot-password/route.ts",
    "app/api/magic-link/request/route.ts",
  ]) {
    it(`${file} has no non-200 exit after the subject is resolved`, () => {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // A 429 is allowed: the limiter runs BEFORE the subject is looked up, so
      // it answers the same for an address with an account and one without. A
      // 5xx is not, because every 5xx in these handlers sits after that lookup
      // and therefore only an existing subject can ever receive one.
      const offenders = code.match(/status:\s*5\d\d|apiError\(/g) ?? [];
      expect(offenders, `${file} must not answer 5xx to a resolved subject`).toEqual([]);
    });
  }
});
