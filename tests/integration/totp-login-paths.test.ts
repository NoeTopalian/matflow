import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * 2FA-optional spec (2026-05-07) — edge routing matrix (proxy.ts).
 *
 * The mandatory `requireTotpSetup → /login/totp/setup` gate was REMOVED; the
 * second-factor-in-progress `totpPending → /login/totp` gate is PRESERVED.
 * This test enumerates the 4 live states by driving the middleware handler
 * directly.
 *
 * proxy.ts exports `auth(async function proxy(req){...})`. We mock @/auth so
 * `auth` is an identity wrapper, making the default export the raw handler we
 * can call with a synthetic NextRequest carrying `req.auth`. next/server is
 * NOT mocked, so NextResponse.redirect/next produce real Response objects.
 */

vi.mock("@/auth", () => ({
  // Identity wrapper: `export default auth(fn)` becomes `export default fn`.
  auth: (fn: unknown) => fn,
}));

import middleware from "@/proxy";

type Auth = { user: { totpPending?: boolean; role?: string; totpEnabled?: boolean; requireTotpSetup?: boolean } } | null;

function makeReq(pathname: string, auth: Auth) {
  return {
    nextUrl: { pathname },
    url: `http://localhost${pathname}`,
    headers: new Headers(),
    cookies: { get: () => undefined },
    auth,
  } as never;
}

async function run(pathname: string, auth: Auth) {
  const res = await (middleware as unknown as (req: never) => Promise<Response>)(makeReq(pathname, auth));
  return { status: res.status, location: res.headers.get("location") };
}

beforeEach(() => {
  delete process.env.MAINTENANCE_MODE;
});

describe("proxy.ts — TOTP login-path matrix", () => {
  it("enrolled + second-factor pending → redirect to /login/totp", async () => {
    const { status, location } = await run("/dashboard", {
      user: { role: "owner", totpEnabled: true, totpPending: true },
    });
    expect(status).toBe(307);
    expect(location).toContain("/login/totp");
  });

  it("enrolled + verified (totpPending false) → no TOTP redirect, reaches /dashboard", async () => {
    const { status, location } = await run("/dashboard", {
      user: { role: "owner", totpEnabled: true, totpPending: false },
    });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("NOT enrolled (requireTotpSetup true) → NO redirect to /login/totp/setup; reaches /dashboard", async () => {
    const { status, location } = await run("/dashboard", {
      user: { role: "owner", totpEnabled: false, requireTotpSetup: true, totpPending: false },
    });
    // The removed gate must not reappear — the banner handles the nudge.
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("in the onboarding wizard → public prefix, never gated by TOTP", async () => {
    const { status, location } = await run("/onboarding", {
      user: { role: "owner", totpEnabled: false, requireTotpSetup: true },
    });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("no session at all → redirect to /login", async () => {
    const { status, location } = await run("/dashboard", null);
    expect(status).toBe(307);
    expect(location).toContain("/login");
  });

  it("enrolled member with pending factor on a member route → still forced to /login/totp first", async () => {
    const { status, location } = await run("/member/home", {
      user: { role: "member", totpEnabled: true, totpPending: true },
    });
    expect(status).toBe(307);
    expect(location).toContain("/login/totp");
  });
});
