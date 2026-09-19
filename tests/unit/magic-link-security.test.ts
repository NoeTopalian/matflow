import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
    redirect: (url: URL | string) => {
      const loc = url instanceof URL ? url.toString() : url;
      return { status: 302, headers: new Headers({ location: loc }), cookies: { set: vi.fn() } };
    },
  },
  NextRequest: class {
    url: string;
    headers: Headers;
    constructor(url: string, init?: RequestInit) {
      this.url = url;
      this.headers = new Headers(init?.headers as HeadersInit);
    }
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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    magicLinkToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
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

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  })),
}));

vi.mock("next-auth/jwt", () => ({
  encode: vi.fn().mockResolvedValue("encoded-jwt-token"),
}));

vi.mock("@/lib/auth-secret", () => ({
  AUTH_SECRET_VALUE: "test-secret",
}));

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST } from "@/app/api/magic-link/request/route";
import { GET } from "@/app/api/magic-link/verify/route";
import { randomBytes } from "crypto";

const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockTokenUpdateMany = vi.mocked(prisma.magicLinkToken.updateMany);
const mockTokenCreate = vi.mocked(prisma.magicLinkToken.create);
const mockTokenFindUnique = vi.mocked(prisma.magicLinkToken.findUnique);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

beforeEach(() => vi.clearAllMocks());

// ── 1. Atomic consume: used/expired token returns redirect ────────────────────

describe("verify — atomic consume rejects used/expired token", () => {
  it("redirects to /login?error=invalid_link when updateMany returns count 0", async () => {
    mockTokenUpdateMany.mockResolvedValue({ count: 0 });

    const req = new Request(
      "http://localhost/api/magic-link/verify?token=deadbeef",
    );
    // Cast to NextRequest-like shape the route handler accepts
    const res = await GET(req as never);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/login?error=invalid_link",
    );
    // This assertion CHANGED on 19 Sep 2026, deliberately.
    //
    // It used to be `expect(mockTokenFindUnique).not.toHaveBeenCalled()` — "the
    // token row must not be read after a failed consume". The route now reads
    // the row BEFORE the consume, to resolve the tenant and decide admission
    // while the token is still spendable; refusing afterwards burned the link.
    // The property that actually protects anything is unchanged and asserted
    // here instead: a failed consume mints nothing and leaks nothing, because
    // the handler returns before it ever resolves a user, a member or a
    // session.
    const { encode } = await import("next-auth/jwt");
    expect(vi.mocked(encode), "no session is minted on a failed consume").not.toHaveBeenCalled();
    expect(mockUserFindFirst, "no subject is resolved on a failed consume").not.toHaveBeenCalled();
  });
});

// ── 2. Atomic consume race: second call with same token fails ─────────────────

describe("verify — concurrent verify: first wins, second rejected", () => {
  it("first call (count=1) succeeds, second call (count=0) redirects to error", async () => {
    // First call: token found and consumed
    mockTokenUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    mockTokenFindUnique.mockResolvedValue({
      tenantId: "tenant-1",
      email: "user@gym.com",
      purpose: "login",
    } as never);

    mockUserFindFirst.mockResolvedValue({
      id: "user-1",
      tenantId: "tenant-1",
      email: "user@gym.com",
      name: "Test User",
      role: "admin",
      sessionVersion: 0,
    } as never);

    mockTenantFindUnique.mockResolvedValue({ slug: "test-gym" } as never);

    const makeReq = () =>
      new Request("http://localhost/api/magic-link/verify?token=racetoken") as never;

    const res1 = await GET(makeReq());
    const res2 = await GET(makeReq());

    // First wins — redirects to dashboard (not error)
    expect(res1.status).toBe(302);
    expect(res1.headers.get("location")).not.toContain(
      "error=invalid_link",
    );

    // Second loses — redirects to error
    expect(res2.status).toBe(302);
    expect(res2.headers.get("location")).toContain(
      "/login?error=invalid_link",
    );
  });
});

// ── 3. Cross-tenant replay: token row tenant != resolved user tenant ───────────

describe("verify — cross-tenant replay is rejected", () => {
  it("returns error redirect when no user/member found for token's tenantId", async () => {
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });

    // Token row has tenantId tenant-A
    mockTokenFindUnique.mockResolvedValue({
      tenantId: "tenant-A",
      email: "attacker@gym.com",
      purpose: "login",
    } as never);

    // No user or member found for tenant-A + that email (cross-tenant scenario)
    mockUserFindFirst.mockResolvedValue(null);
    mockMemberFindFirst.mockResolvedValue(null);

    const req = new Request(
      "http://localhost/api/magic-link/verify?token=crosstoken",
    ) as never;
    const res = await GET(req);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/login?error=invalid_link",
    );
  });
});

// ── 4. Token entropy: randomBytes(32).toString("hex") = 64-char hex ───────────

describe("token entropy", () => {
  it("produces a 64-character lowercase hex string", () => {
    for (let i = 0; i < 10; i++) {
      const token = randomBytes(32).toString("hex");
      expect(token).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
    }
  });
});

// ── 5. No-enumeration on request: non-existent user returns {ok:true} 200 ─────

describe("request — no enumeration", () => {
  it("returns 200 {ok:true} and never creates a token when user/member not found", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
    mockUserFindFirst.mockResolvedValue(null);
    mockMemberFindFirst.mockResolvedValue(null);

    const req = new Request("http://localhost/api/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ghost@gym.com", tenantSlug: "test-gym" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(mockTokenCreate).not.toHaveBeenCalled();
  });
});

// ── 6. Anti-stockpile: updateMany called BEFORE create ────────────────────────

describe("request — anti-stockpile: prior tokens invalidated before new one created", () => {
  it("calls updateMany (invalidate) before create (new token)", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
    mockUserFindFirst.mockResolvedValue({ id: "u1" } as never);
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockTokenCreate.mockResolvedValue({ id: "tok-1" } as never);

    const callOrder: string[] = [];
    mockTokenUpdateMany.mockImplementation((async () => {
      callOrder.push("updateMany");
      return { count: 1 };
    }) as never);
    mockTokenCreate.mockImplementation((async () => {
      callOrder.push("create");
      return { id: "tok-1" };
    }) as never);

    // Suppress email send in this test — RESEND_API_KEY not set, NODE_ENV = test (not production)
    const req = new Request("http://localhost/api/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@gym.com", tenantSlug: "test-gym" }),
    });

    await POST(req);

    const updateIdx = callOrder.indexOf("updateMany");
    const createIdx = callOrder.indexOf("create");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(updateIdx);
  });

  /**
   * Anti-stockpile must invalidate LOGIN tokens only.
   *
   * The table holds three purposes (prisma/schema.prisma:629): `login`, the
   * owner's `first_time_signup` activation link, and the 24-hour `waiver_open`
   * link handed to an anonymous signer from the profile share sheet and the
   * kiosk. The invalidation was written when `login` was the only one.
   *
   * Without a purpose filter this route is a destructive write that an
   * unauthenticated stranger performs against someone else's tokens, using
   * nothing but a guessed address and the club slug: it kills the member's
   * pending waiver link and the new owner's activation link, and answers
   * `200 {ok:true}` either way so neither party learns anything.
   */
  it("invalidates only `login` tokens, so a waiver or activation link survives", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
    mockUserFindFirst.mockResolvedValue({ id: "u1" } as never);
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockTokenCreate.mockResolvedValue({ id: "tok-1" } as never);

    const req = new Request("http://localhost/api/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "victim@gym.com", tenantSlug: "test-gym" }),
    });

    await POST(req);

    expect(mockTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: "victim@gym.com",
          tenantId: "t1",
          used: false,
          purpose: "login",
        }),
      }),
    );
  });
});

// ── 7. Rate-limit: silent 200 when rate-limited (no enumeration) ──────────────

describe("request — rate-limit returns silent 200", () => {
  it("returns 200 {ok:true} when rate-limited (no 429 exposed)", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });

    const req = new Request("http://localhost/api/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@gym.com", tenantSlug: "test-gym" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // No DB calls after rate-limit check
    expect(mockTenantFindUnique).not.toHaveBeenCalled();
    expect(mockTokenCreate).not.toHaveBeenCalled();
  });
});

// ── V-5: the claim the hand-rolled payload forgot ─────────────────────────────
//
// Magic link is how a member WITHOUT a password gets in — the whole point of
// the feature — and it is the only minter in the product that rebuilds the JWT
// payload by hand rather than spreading an existing token. It omitted
// `memberId`, so `app/api/member/me` answered "No member record for this
// session" with a 404 and every magic-link member landed in a broken portal.
// auth.ts sets it correctly; app/api/member/totp/verify spreads the whole
// token. This one path did neither.

describe("verify — the minted session is usable", () => {
  const TENANT = {
    slug: "total-bjj", name: "Total BJJ",
    primaryColor: "#111111", secondaryColor: "#222222", textColor: "#333333",
  };

  async function verifyAs(kind: "member" | "user") {
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockTokenFindUnique.mockResolvedValue({
      tenantId: "tenant-A",
      email: "sam@example.com",
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      purpose: "login",
    } as never);
    mockTenantFindUnique.mockResolvedValue(TENANT as never);
    if (kind === "member") {
      mockUserFindFirst.mockResolvedValue(null as never);
      mockMemberFindFirst.mockResolvedValue({
        id: "mem-1", tenantId: "tenant-A", email: "sam@example.com",
        name: "Sam", sessionVersion: 2, totpEnabled: false,
      } as never);
    } else {
      mockUserFindFirst.mockResolvedValue({
        id: "user-1", tenantId: "tenant-A", email: "sam@example.com",
        name: "Sam", role: "owner", sessionVersion: 1, totpEnabled: false,
      } as never);
      mockMemberFindFirst.mockResolvedValue(null as never);
    }

    await GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);

    const { encode } = await import("next-auth/jwt");
    return vi.mocked(encode).mock.calls[0][0].token as Record<string, unknown>;
  }

  it("mints memberId for a member, so the portal is not a 404", async () => {
    const token = await verifyAs("member");
    // The defect, in one assertion.
    expect(token.memberId).toBe("mem-1");
    expect(token.role).toBe("member");
  });

  it("carries the club's branding, so the first render is not unbranded", async () => {
    const token = await verifyAs("member");
    expect(token.tenantName).toBe("Total BJJ");
    expect(token.primaryColor).toBe("#111111");
  });

  it("carries branding for a staff magic-link session too", async () => {
    const token = await verifyAs("user");
    expect(token.tenantName).toBe("Total BJJ");
    // Staff sessions have no member record; `memberId` must stay unset rather
    // than be faked, or member-scoped routes would serve a staff user.
    expect(token.memberId).toBeUndefined();
  });

  it("reads totpEnabled, so the member's own security screen tells the truth", async () => {
    const token = await verifyAs("member");
    expect(token.totpEnabled).toBe(false);
    // The magic-link TOTP bypass itself is a deliberate, documented decision
    // (the single-use 30-minute token IS the second factor) and is unchanged.
    expect(token.totpPending).toBe(false);
  });
});

// ── the suspension side door ──────────────────────────────────────────────────

describe("verify — a suspended club is refused here too", () => {
  function tokenFor(tenant: Record<string, unknown>) {
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockTokenFindUnique.mockResolvedValue({
      tenantId: "tenant-A", email: "sam@example.com",
      usedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), purpose: "login",
    } as never);
    mockTenantFindUnique.mockResolvedValue(tenant as never);
    mockUserFindFirst.mockResolvedValue(null as never);
    mockMemberFindFirst.mockResolvedValue({
      id: "mem-1", tenantId: "tenant-A", email: "sam@example.com",
      name: "Sam", sessionVersion: 1, totpEnabled: false,
    } as never);
  }

  // The expected codes below CHANGED on 19 Sep 2026, deliberately.
  //
  // They used to read `tenant_suspended` and `tenant_deleted`, which is what
  // the route emitted — and which `app/login/page.tsx:58-72` has no case for,
  // so both fell through to "Incorrect email or password." These assertions
  // pinned the refusal and never asked what the refused person was told, so a
  // green suite sat on top of a member being sent to reset a password that was
  // fine. The codes are now the two the page can actually render.
  it("refuses a suspended club with a code the login page renders", async () => {
    // This was the whole defect: auth.ts refused, this route did not even look.
    tokenFor({ slug: "total-bjj", name: "Total BJJ", subscriptionStatus: "suspended", deletedAt: null });

    const res = await GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tenant_paused");
  });

  it("refuses a soft-deleted club with a code the login page renders", async () => {
    tokenFor({ slug: "total-bjj", name: "Total BJJ", subscriptionStatus: "active", deletedAt: new Date() });

    const res = await GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);
    expect(res.headers.get("location")).toContain("tenant_closed");
  });

  it("does not burn the token when it refuses the club", async () => {
    // A refusal that consumes the link punishes the member for their club's
    // billing: they lose their only token and must wait out the 15-minute
    // request bucket to be refused again.
    tokenFor({ slug: "total-bjj", name: "Total BJJ", subscriptionStatus: "suspended", deletedAt: null });

    await GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);

    expect(mockTokenUpdateMany, "the consuming updateMany must not run").not.toHaveBeenCalled();
  });

  it("still admits a club in good standing", async () => {
    tokenFor({ slug: "total-bjj", name: "Total BJJ", subscriptionStatus: "active", deletedAt: null });

    const res = await GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);
    expect(res.headers.get("location")).not.toContain("tenant_");
  });
});
// ── 8. A token minted for another purpose cannot mint a session ───────────────
//
// Found 19 Sep 2026 by critic 1 of the A0 prompt review: this route consumed
// ANY MagicLinkToken whose hash matched — `purpose` was selected at :33 and
// never read. A `waiver_open` token is handed to an anonymous signer (24 h,
// from the member profile share sheet and the kiosk waiver request), so a
// waiver link doubled as a login link for the member it named. Only `login`
// (magic-link request) and `first_time_signup` (owner activation, minted by
// the operator approve route, which links here) may sign anyone in.
describe("verify — only login and activation tokens mint a session", () => {
  it("consumes tokens by purpose, so a waiver_open token is invalid here and stays usable at /waiver/open", async () => {
    mockTokenUpdateMany.mockResolvedValue({ count: 0 });

    await GET(new Request("http://localhost/api/magic-link/verify?token=deadbeef") as never);

    expect(mockTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          used: false,
          purpose: { in: ["login", "first_time_signup"] },
        }),
      }),
    );
  });
});

// ── 9. A failed send must not tell a stranger who has an account ──────────────
//
// Found 19 Sep 2026 by driving the e2e campaign on a runner whose mail key is
// dead. Every exit from this route answers `200 {"ok":true}` on purpose — a
// malformed body, a spent rate limit, an unknown club, an address with no
// account. Only an address that DOES have an account ever reaches the send, so
// the two 503s that used to live at the end of the handler were a clean
// enumeration oracle: 503 meant "this person trains here", 200 meant "they do
// not". The e2e run caught it as three statuses that were supposed to be
// identical coming back `[503, 200, 200]`.
describe("request — a failed send answers exactly like an unknown address", () => {
  const KEY = "RESEND_API_KEY";

  async function post(email: string) {
    return POST(
      new Request("http://localhost/api/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, tenantSlug: "test-gym" }),
      }),
    );
  }

  it("answers 200 {ok:true} when sendEmail fails, and says so only in the log", async () => {
    const before = process.env[KEY];
    process.env[KEY] = "re_not_a_real_key";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
      mockUserFindFirst.mockResolvedValue({ id: "u1" } as never);
      mockTokenUpdateMany.mockResolvedValue({ count: 0 });
      mockTokenCreate.mockResolvedValue({ id: "tok-1" } as never);
      const { sendEmail } = await import("@/lib/email");
      vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "mail is down" } as never);

      const res = await post("member@gym.com");

      expect(res.status, "a dead mail service is not a reason to disclose the roster").toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(errorSpy, "the operator is still told").toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (before === undefined) delete process.env[KEY]; else process.env[KEY] = before;
    }
  });

  it("answers identically for an address with an account and one without", async () => {
    const before = process.env[KEY];
    process.env[KEY] = "re_not_a_real_key";
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
      mockTokenUpdateMany.mockResolvedValue({ count: 0 });
      mockTokenCreate.mockResolvedValue({ id: "tok-1" } as never);
      const { sendEmail } = await import("@/lib/email");
      vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "mail is down" } as never);

      mockUserFindFirst.mockResolvedValue({ id: "u1" } as never);
      const known = await post("member@gym.com");
      mockUserFindFirst.mockResolvedValue(null);
      mockMemberFindFirst.mockResolvedValue(null);
      const unknown = await post("ghost@gym.com");

      expect(
        [known.status, JSON.stringify(await known.json())],
        "the two answers are the whole defence and must be byte-identical",
      ).toEqual([unknown.status, JSON.stringify(await unknown.json())]);
    } finally {
      if (before === undefined) delete process.env[KEY]; else process.env[KEY] = before;
    }
  });

  it("answers 200 in production when RESEND_API_KEY is unset, rather than 503", async () => {
    const beforeKey = process.env[KEY];
    const beforeEnv = process.env.NODE_ENV;
    delete process.env[KEY];
    vi.stubEnv("NODE_ENV", "production");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
      mockUserFindFirst.mockResolvedValue({ id: "u1" } as never);
      mockTokenUpdateMany.mockResolvedValue({ count: 0 });
      mockTokenCreate.mockResolvedValue({ id: "tok-1" } as never);

      const res = await post("member@gym.com");

      expect(res.status, "a missing deploy key is an operator problem, not a disclosure").toBe(200);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
      void beforeEnv;
      if (beforeKey !== undefined) process.env[KEY] = beforeKey;
    }
  });
});
