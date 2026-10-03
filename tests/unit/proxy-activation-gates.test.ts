import { describe, it, expect, vi } from "vitest";

/**
 * Proxy activation gates (proxy.ts, 3 Oct 2026).
 *
 * The real owner account is handed over as: temporary password -> owner
 * chooses a password -> owner enrols an authenticator -> club data. These
 * drive the proxy handler itself (NextAuth's wrapper mocked to the identity
 * function, as tests/unit/proxy-matcher.test.ts does) with a session carrying
 * the flags auth.ts puts on the token.
 *
 * Red on revert: delete the mustChangePassword block in proxy.ts and the
 * "/api → JSON 403" and "page → /set-password" cases fail (the API call is let
 * through and the page goes to /login/totp/setup instead).
 */

vi.mock("@/auth", () => ({ auth: (fn: unknown) => fn }));

type Flags = { mustChangePassword?: boolean; requireTotpSetup?: boolean; totpPending?: boolean; role?: string };

async function run(pathname: string, flags: Flags | null) {
  const mod = await import("../../proxy");
  const proxy = mod.default as unknown as (req: unknown) => Promise<Response>;
  const url = `http://localhost:3847${pathname}`;
  const req = {
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    cookies: { get: () => undefined },
    auth: flags === null ? null : { user: { id: "u1", tenantId: "t1", role: "owner", ...flags } },
  };
  return proxy(req);
}

const location = (res: Response) => {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
};

describe("proxy — temporary password gate", () => {
  it.each(["/api/members", "/api/reports", "/api/payments/export.csv", "/api/settings", "/api/memberships"])(
    "%s → JSON 403 while mustChangePassword is set",
    async (path) => {
      const res = await run(path, { mustChangePassword: true });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: "Choose your own password to continue." });
    },
  );

  it.each(["/dashboard", "/dashboard/members", "/dashboard/settings"])(
    "page %s → redirect to /set-password",
    async (path) => {
      const res = await run(path, { mustChangePassword: true });
      expect(res.status).toBe(307);
      expect(location(res)).toBe("/set-password");
    },
  );

  it.each(["/set-password", "/login/totp/setup"])("%s stays reachable", async (path) => {
    const res = await run(path, { mustChangePassword: true });
    expect(location(res)).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("proxy — activation order with both flags set", () => {
  it("a page goes to /set-password first, not the authenticator", async () => {
    const res = await run("/dashboard", { mustChangePassword: true, requireTotpSetup: true });
    expect(location(res)).toBe("/set-password");
  });

  it("an /api call is refused with the password message", async () => {
    const res = await run("/api/members", { mustChangePassword: true, requireTotpSetup: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/password/);
  });

  it.each(["/set-password", "/login/totp/setup"])("%s stays reachable with both flags", async (path) => {
    const res = await run(path, { mustChangePassword: true, requireTotpSetup: true });
    expect(location(res)).toBeNull();
  });

  it("once the password is chosen, the authenticator gate takes over", async () => {
    const page = await run("/dashboard", { mustChangePassword: false, requireTotpSetup: true });
    expect(location(page)).toBe("/login/totp/setup");
    const api = await run("/api/members", { mustChangePassword: false, requireTotpSetup: true });
    expect(api.status).toBe(403);
    expect((await api.json()).error).toMatch(/authenticator/);
  });

  it("both steps done → through", async () => {
    const res = await run("/api/members", { mustChangePassword: false, requireTotpSetup: false });
    expect(res.status).toBe(200);
    expect(location(res)).toBeNull();
  });

  it("an enrolled user mid-challenge (totpPending) answers the code first", async () => {
    const res = await run("/dashboard", { mustChangePassword: true, totpPending: true });
    expect(location(res)).toBe("/login/totp");
  });

  it("no session → 401 on /api, unchanged", async () => {
    const res = await run("/api/members", null);
    expect(res.status).toBe(401);
  });
});
