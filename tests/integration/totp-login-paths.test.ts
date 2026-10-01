import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * TOTP edge routing matrix (proxy.ts).
 *
 * Mandatory TOTP for owners was removed on 2026-05-07 and RE-INTRODUCED on
 * 1 Oct 2026 for the Total BJJ launch: a not-yet-enrolled owner
 * (`requireTotpSetup`) is redirected to /login/totp/setup and may reach only
 * the enrolment page and the forced password change. The
 * second-factor-in-progress `totpPending → /login/totp` gate is also preserved.
 * This test enumerates the live states by driving the middleware handler
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

  it("NOT enrolled owner (requireTotpSetup true) → redirect to /login/totp/setup (mandatory TOTP, re-introduced 1 Oct 2026)", async () => {
    const { status, location } = await run("/dashboard", {
      user: { role: "owner", totpEnabled: false, requireTotpSetup: true, totpPending: false },
    });
    expect(status).toBe(307);
    expect(location).toContain("/login/totp/setup");
  });

  it("NOT enrolled owner may reach the enrolment page itself (no redirect loop)", async () => {
    const { status, location } = await run("/login/totp/setup", {
      user: { role: "owner", totpEnabled: false, requireTotpSetup: true, totpPending: false },
    });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("NOT enrolled owner may still reach /set-password (forced password change comes first)", async () => {
    const { status, location } = await run("/set-password", {
      user: { role: "owner", totpEnabled: false, requireTotpSetup: true, totpPending: false },
    });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("NOT enrolled owner on an /api route → proxy does NOT redirect; the route handler's JSON 403 answers (FINDING-2)", async () => {
    const { status, location } = await run("/api/members", {
      user: { role: "owner", totpEnabled: false, requireTotpSetup: true, totpPending: false },
    });
    // A 307 to an HTML page would make a fetch() parse login HTML as JSON.
    // No redirect: the route handler answers with the api-authz JSON 403.
    expect(location).toBeNull();
    expect(status).toBe(200);
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
