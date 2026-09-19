import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-003 (audit H8): /api/members/accept-invite consumes a first_time_signup
// MagicLinkToken, sets the member's passwordHash, and marks the token used.

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
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
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { tokenFindMock, tokenUpdateMock, memberFindMock, memberUpdateMock, txMock } = vi.hoisted(() => ({
  tokenFindMock: vi.fn(),
  tokenUpdateMock: vi.fn(),
  memberFindMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  txMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    magicLinkToken: { findUnique: tokenFindMock, update: tokenUpdateMock },
    member: { findUnique: memberFindMock, update: memberUpdateMock },
    $transaction: txMock,
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn().mockReturnValue("203.0.113.99"),
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed-pw") },
}));

import { POST } from "@/app/api/members/accept-invite/route";

beforeEach(() => {
  vi.clearAllMocks();
  txMock.mockResolvedValue([{}, {}]);
});

function makeReq(body: object) {
  return new Request("http://localhost/api/members/accept-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_PW = "Walkthrough123!";
const VALID_TOKEN = "a".repeat(48); // matches z.string().min(20)

describe("POST /api/members/accept-invite", () => {
  it("rejects an unknown token with 404", async () => {
    tokenFindMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW }));
    expect(res.status).toBe(404);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("rejects a token whose purpose is not first_time_signup", async () => {
    tokenFindMock.mockResolvedValueOnce({
      id: "t1", purpose: "login", used: false, expiresAt: new Date(Date.now() + 60_000),
      tenantId: "t-A", email: "x@y.z",
    });
    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW }));
    expect(res.status).toBe(404);
  });

  it("returns 410 for an expired token", async () => {
    tokenFindMock.mockResolvedValueOnce({
      id: "t1", purpose: "first_time_signup", used: false,
      expiresAt: new Date(Date.now() - 60_000),
      tenantId: "t-A", email: "x@y.z",
    });
    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW }));
    expect(res.status).toBe(410);
  });

  it("returns 410 for an already-used token", async () => {
    tokenFindMock.mockResolvedValueOnce({
      id: "t1", purpose: "first_time_signup", used: true,
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: "t-A", email: "x@y.z",
    });
    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW }));
    expect(res.status).toBe(410);
  });

  it("sets passwordHash + consumes token + returns tenantSlug on success", async () => {
    tokenFindMock.mockResolvedValueOnce({
      id: "t1", purpose: "first_time_signup", used: false,
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: "t-A", email: "alex@example.com",
    });
    memberFindMock.mockResolvedValueOnce({ id: "mem-1", tenant: { slug: "totalbjj" } });

    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tenantSlug).toBe("totalbjj");
    expect(body.email).toBe("alex@example.com");
    expect(memberUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("rejects weak passwords (Zod schema)", async () => {
    const res = await POST(makeReq({ token: VALID_TOKEN, password: "weak" }));
    expect(res.status).toBe(400);
    expect(tokenFindMock).not.toHaveBeenCalled();
  });
});

/**
 * Lane L-C round 1, defect 1.
 *
 * This route was the ONE door that could hand an under-13 a password. Every
 * other creation path writes `passwordHash: null` for a kid and says so in a
 * comment — app/api/members/route.ts:251, app/api/member/children/route.ts:96
 * — and bulk-invite excludes `accountType: "kids"` from its candidate set
 * entirely, so a child is never even sent one of these links. The schema
 * comment on Member puts it plainly: "Kids + magic-link-only members never
 * enrol."
 *
 * The old order of operations was the whole bug: bcrypt.hash and the member
 * update ran first, and the age was only derived afterwards to label the row
 * `kids`. The result was a nine-year-old with a working login and no parent
 * attached. The age check therefore has to happen BEFORE anything is written
 * and before the token is spent, so a parent can still use the same link.
 */
describe("POST /api/members/accept-invite — the under-13 gate", () => {
  /** A date of birth `age` years ago today, from local components. */
  function dobForAge(age: number): string {
    const now = new Date();
    const d = new Date(now.getFullYear() - age, now.getMonth(), now.getDate());
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it("refuses a date of birth under 13 with 422 and writes nothing", async () => {
    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW, dateOfBirth: dobForAge(9) }));

    expect(res.status).toBe(422);
    expect(memberUpdateMock, "no password may be written for a child").not.toHaveBeenCalled();
    expect(tokenUpdateMock, "and the link must still work for their parent").not.toHaveBeenCalled();
  });

  it("does not even look the token up for an under-13, so the link is not burned", async () => {
    await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW, dateOfBirth: dobForAge(5) }));
    expect(tokenFindMock).not.toHaveBeenCalled();
  });

  it("says a parent must hold the account, in British English", async () => {
    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW, dateOfBirth: dobForAge(11) }));
    const body = await res.json();
    expect(String(body.error)).toMatch(/parent|guardian/i);
    expect(String(body.error), "the sentence must say what to do next").toMatch(/account/i);
  });

  it("admits somebody who turns 13 today — the boundary is not off by one", async () => {
    tokenFindMock.mockResolvedValueOnce({
      id: "t1", purpose: "first_time_signup", used: false,
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: "t-A", email: "thirteen@example.com",
    });
    memberFindMock.mockResolvedValueOnce({ id: "mem-13", tenant: { slug: "totalbjj" } });

    const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW, dateOfBirth: dobForAge(13) }));
    expect(res.status).toBe(200);
  });

  it("still admits an adult, and one who sends no date of birth at all", async () => {
    for (const dob of [dobForAge(30), undefined]) {
      vi.clearAllMocks();
      txMock.mockResolvedValue([{}, {}]);
      tokenFindMock.mockResolvedValueOnce({
        id: "t1", purpose: "first_time_signup", used: false,
        expiresAt: new Date(Date.now() + 60_000),
        tenantId: "t-A", email: "adult@example.com",
      });
      memberFindMock.mockResolvedValueOnce({ id: "mem-a", tenant: { slug: "totalbjj" } });
      const res = await POST(makeReq({ token: VALID_TOKEN, password: VALID_PW, ...(dob ? { dateOfBirth: dob } : {}) }));
      expect(res.status, `dateOfBirth = ${dob ?? "(absent)"}`).toBe(200);
    }
  });
});
