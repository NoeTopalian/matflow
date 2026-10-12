/**
 * Review of lane I (6 Oct 2026, defensive): proxy.ts gated on `!req.auth` and
 * lib/authz.ts requireSession on `!session`. Both accepted a session object with
 * no user id ({ user: undefined } — the shape auth.ts's session callback gives
 * an invalidated token), so the page gate let it through and requireSession
 * returned a context with userId undefined. Both now treat a session without
 * `user.id` as signed out, as lib/api-authz.ts already did.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("@/auth", () => ({
  // proxy.ts wraps its handler in auth(fn); lib/authz.ts calls auth().
  auth: (fn?: unknown) => (typeof fn === "function" ? fn : Promise.resolve(h.session)),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

async function proxyRun(pathname: string, auth: unknown) {
  const mod = await import("../../proxy");
  const proxy = mod.default as unknown as (req: unknown) => Promise<Response>;
  const url = `http://localhost:3847${pathname}`;
  return proxy({ nextUrl: new URL(url), url, headers: new Headers(), cookies: { get: () => undefined }, auth });
}
const location = (res: Response) => {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
};

beforeEach(() => {
  h.session = null;
});

describe("proxy: a session without a user id is signed out", () => {
  it.each([{ user: undefined }, { user: {} }, { user: { tenantId: "t1", role: "owner" } }])(
    "page /dashboard with %o → /login",
    async (auth) => {
      const res = await proxyRun("/dashboard", auth);
      expect(res.status).toBe(307);
      expect(location(res)).toBe("/login");
    },
  );

  it("an /api call with { user: undefined } → 401, not let through", async () => {
    const res = await proxyRun("/api/members", { user: undefined });
    expect(res.status).toBe(401);
  });

  it("control: a session with a user id passes the gate", async () => {
    const res = await proxyRun("/dashboard", { user: { id: "u1", tenantId: "t1", role: "owner" } });
    expect(location(res)).not.toBe("/login");
  });
});

describe("requireSession: a session without a user id redirects to /login", () => {
  it.each([{ user: undefined }, { user: {} }, { expires: "2099-01-01" }])("%o → /login", async (s) => {
    h.session = s;
    const { requireSession } = await import("@/lib/authz");
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });

  it("control: a real session returns its context", async () => {
    h.session = { user: { id: "u1", tenantId: "t1", role: "owner" } };
    const { requireSession } = await import("@/lib/authz");
    await expect(requireSession()).resolves.toMatchObject({ userId: "u1", tenantId: "t1", role: "owner" });
  });
});
