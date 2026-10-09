// SF-44 (review R-1) — a revocation check that CANNOT RUN must refuse the
// request without signing the browser out (security campaign iteration 2,
// lane A2, 9 Oct 2026).
//
// Driven through the REAL proxy.ts, the REAL next-auth wrapper (5.0.0-beta.32)
// and the REAL auth.ts callbacks; only the database is stubbed (the revocation
// lookup either answers, or throws the driver error a statement timeout gives).
// Reviewer R measured that before this fix a faulted lookup returned
// `__Secure-authjs.session-token=; Max-Age=0` on pages and API routes alike.
//
// Invariant kept: an "unknown" verdict never admits a request. What changes:
// on "unknown" the reply is a retryable 503 (API: JSON + Retry-After; page: an
// "unavailable" page + Retry-After), the session cookie is NOT cleared, the
// re-issued token carries a revalidation marker, and the next request is
// admitted only after a successful check. On "revoked" the cookie IS cleared.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  mode: "ok" as "ok" | "fault" | "moved",
  lookups: 0,
}));
process.env.AUTH_SECRET = "sec-a2-proxy-outage-secret-0123456789abcdef0123456789";
process.env.AUTH_TRUST_HOST = "true";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
const row = () => ({ sessionVersion: h.mode === "moved" ? 4 : 3, name: "Coach A2", tenantId: "t-a2" });
const tx = {
  user: { findUnique: vi.fn(async () => row()), findFirst: vi.fn() },
  member: { findUnique: vi.fn(async () => row()), findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async (fn: (t: unknown) => unknown) => {
    h.lookups++;
    if (h.mode === "fault") {
      const e = new Error("canceling statement due to statement timeout") as Error & { code?: string };
      e.code = "57014";
      throw e;
    }
    return fn(tx);
  },
  withTenantContext: async (_id: string, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("@/lib/impersonation", () => ({
  resolveActiveImpersonation: vi.fn(async () => null),
  hasImpersonationCookie: vi.fn(async () => false),
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));

const COOKIE = "__Secure-authjs.session-token";
let proxy: (req: unknown, ev?: unknown) => Promise<Response>;

async function mint(extra: Record<string, unknown> = {}): Promise<string> {
  const { encode } = await import("next-auth/jwt");
  return encode({
    salt: COOKIE,
    secret: process.env.AUTH_SECRET!,
    token: {
      id: "u-a2-coach", role: "coach", tenantId: "t-a2", tenantSlug: "a2-club", tenantName: "A2 Club",
      sessionVersion: 3, memberId: null, mustChangePassword: false, totpPending: false,
      requireTotpSetup: false, totpEnabled: false, name: "Coach A2", brandFetchedAt: Date.now(),
      ...extra,
    },
  });
}
async function decodeCookie(value: string): Promise<Record<string, unknown> | null> {
  const { decode } = await import("next-auth/jwt");
  return (await decode({ salt: COOKIE, secret: process.env.AUTH_SECRET!, token: value })) as Record<string, unknown> | null;
}

/** The session cookie a response sets: "absent" | "cleared" | the new value. */
function sessionCookie(res: Response): { kind: "absent" } | { kind: "cleared" } | { kind: "set"; value: string } {
  const sc = res.headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE}=`) || c.startsWith(`${COOKIE}.`));
  if (sc.length === 0) return { kind: "absent" };
  if (sc.some((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))) return { kind: "cleared" };
  return { kind: "set", value: sc[0].split(";")[0].slice(COOKIE.length + 1) };
}

async function hit(path: string, token: string, method = "GET") {
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`https://localhost:3999${path}`, { method, headers: { cookie: `${COOKIE}=${token}` } });
  return proxy(req, {});
}

beforeAll(async () => {
  proxy = (await import("../../proxy")).default as never;
});
beforeEach(() => {
  h.mode = "ok";
  h.lookups = 0;
});

describe("positive control: a healthy check admits and refreshes the cookie", () => {
  it.each(["/dashboard", "/api/members"])("%s passes the proxy; cookie refreshed, not cleared, no marker", async (p) => {
    const res = await hit(p, await mint());
    expect(res.status).toBe(200);
    const c = sessionCookie(res);
    expect(c.kind).toBe("set");
    if (c.kind === "set") expect((await decodeCookie(c.value))?.revalidateSince).toBeUndefined();
    expect(h.lookups).toBe(1);
  });
});

describe("revocation lookup cannot run (statement timeout 57014)", () => {
  it("API route: 503 + Retry-After, JSON refusal, cookie NOT cleared, re-issued token marked for revalidation", async () => {
    h.mode = "fault";
    const res = await hit("/api/members", await mint());
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control") ?? "").toContain("no-store");
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    const c = sessionCookie(res);
    expect(c.kind, "the session cookie must not be cleared on an unknown verdict").not.toBe("cleared");
    expect(c.kind).toBe("set");
    if (c.kind === "set") {
      const t = await decodeCookie(c.value);
      expect(t?.id, "identity kept for the retry").toBe("u-a2-coach");
      expect(typeof t?.revalidateSince).toBe("number");
    }
  });

  it("page: 503 'unavailable' page + Retry-After, never the dashboard, cookie NOT cleared", async () => {
    h.mode = "fault";
    const res = await hit("/dashboard", await mint());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(sessionCookie(res).kind).not.toBe("cleared");
  });

  it("a mutation (POST) is refused with 503 too", async () => {
    h.mode = "fault";
    const res = await hit("/api/members", await mint(), "POST");
    expect(res.status).toBe(503);
    expect(sessionCookie(res).kind).not.toBe("cleared");
  });

  it("retry after restoration: the marked cookie is re-checked, admitted, and the marker removed", async () => {
    h.mode = "fault";
    const first = await hit("/api/members", await mint());
    const c1 = sessionCookie(first);
    expect(c1.kind).toBe("set");
    if (c1.kind !== "set") return;
    // Still down: still refused, still not cleared, the original marker time kept.
    const since1 = (await decodeCookie(c1.value))?.revalidateSince;
    const again = await hit("/api/members", c1.value);
    expect(again.status).toBe(503);
    const c2 = sessionCookie(again);
    expect(c2.kind).toBe("set");
    if (c2.kind !== "set") return;
    expect((await decodeCookie(c2.value))?.revalidateSince).toBe(since1);
    // Service restored.
    h.mode = "ok";
    h.lookups = 0;
    const ok = await hit("/api/members", c2.value);
    expect(ok.status).toBe(200);
    expect(h.lookups, "the next request revalidated before succeeding").toBe(1);
    const c3 = sessionCookie(ok);
    expect(c3.kind).toBe("set");
    if (c3.kind === "set") expect((await decodeCookie(c3.value))?.revalidateSince).toBeUndefined();
  });

  it("revoked while the service is down: refused (503, cannot be proven yet), then cleared once it can be proven", async () => {
    h.mode = "fault";
    const first = await hit("/api/members", await mint());
    expect(first.status).toBe(503);
    const c1 = sessionCookie(first);
    expect(c1.kind).toBe("set");
    if (c1.kind !== "set") return;
    h.mode = "moved"; // the version moved (password reset / log out everywhere) during the outage
    const after = await hit("/api/members", c1.value);
    expect(after.status).toBe(401);
    expect(sessionCookie(after).kind).toBe("cleared");
  });

  it("a token that proves its own revocation (malformed version) is cleared even during the outage", async () => {
    h.mode = "fault";
    const res = await hit("/api/members", await mint({ sessionVersion: "3" }));
    expect(res.status).toBe(401);
    expect(sessionCookie(res).kind).toBe("cleared");
  });

  it("bounded: a marker older than the cap is not refreshed indefinitely — the session ends", async () => {
    h.mode = "fault";
    const res = await hit("/api/members", await mint({ revalidateSince: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(res.status).toBe(401);
    expect(sessionCookie(res).kind).toBe("cleared");
  });

  it("a marked token is refused on a pass that does not run the check (Edge) — no cached authority", async () => {
    // jwt() skips the database at the Edge. A token still awaiting
    // revalidation must not be admitted by a pass that never checked it.
    vi.stubEnv("NEXT_RUNTIME", "edge");
    try {
      const res = await hit("/api/members", await mint({ revalidateSince: Date.now() - 1000 }));
      expect(h.lookups).toBe(0);
      expect(res.status).toBe(503);
      expect(sessionCookie(res).kind).not.toBe("cleared");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("revoked (proven): the cookie IS cleared, as before", () => {
  it.each([["/dashboard", 307], ["/api/members", 401]] as const)("%s → %s and cleared", async (p, status) => {
    h.mode = "moved";
    const res = await hit(p, await mint());
    expect(res.status).toBe(status);
    expect(sessionCookie(res).kind).toBe("cleared");
  });
});

describe("/api/auth/session (outside the proxy matcher) during the outage", () => {
  it("503 + Retry-After, cookie not cleared; healthy → 200 with the user", async () => {
    const { GET } = await import("@/app/api/auth/[...nextauth]/route");
    const { NextRequest } = await import("next/server");
    const tok = await mint();
    h.mode = "fault";
    const res = await GET(new NextRequest("https://localhost:3999/api/auth/session", { headers: { cookie: `${COOKIE}=${tok}` } }));
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(sessionCookie(res).kind).not.toBe("cleared");
    h.mode = "ok";
    const ok = await GET(new NextRequest("https://localhost:3999/api/auth/session", { headers: { cookie: `${COOKIE}=${tok}` } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { user?: { id?: string } };
    expect(body.user?.id).toBe("u-a2-coach");
  });
});
