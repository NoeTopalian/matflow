import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-003 (audit H8): /api/members/accept-invite consumes a first_time_signup
// MagicLinkToken, sets the member's passwordHash, and marks the token used.

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
    expect(txMock).toHaveBeenCalledTimes(1);
  });

  it("rejects weak passwords (Zod schema)", async () => {
    const res = await POST(makeReq({ token: VALID_TOKEN, password: "weak" }));
    expect(res.status).toBe(400);
    expect(tokenFindMock).not.toHaveBeenCalled();
  });
});
