import { describe, it, expect, vi } from "vitest";

/**
 * Review finding D1 (6 Oct 2026) — the proxy half.
 *
 * tests/unit/impersonation-jwt-claims.test.ts pins that auth.ts jwt() returns
 * null when resolveActiveImpersonation() throws while support may be live
 * (support cookie present, or a stash / impersonatedBy on the token). This file
 * pins what the proxy does with that null: a mutating API request reaches the
 * proxy with NO session and is refused there, so the route handler — whose own
 * auth() could have resolved support and run as the TARGET owner — never runs.
 *
 * Before the fix the proxy received the operator's restored claims (no
 * impersonatedBy), isSupportSession() was false and the POST was let through
 * (NextResponse.next(), no status refusal).
 */

vi.mock("@/auth", () => ({ auth: (fn: unknown) => fn }));

async function run(method: string, pathname: string, auth: unknown) {
  const mod = await import("../../proxy");
  const proxy = mod.default as unknown as (req: unknown) => Promise<Response>;
  const url = `http://localhost:3847${pathname}`;
  const req = {
    method,
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    cookies: { get: () => undefined },
    auth,
  };
  return proxy(req);
}

const isPassThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("D1 — jwt() refusing the session refuses the POST at the proxy", () => {
  it.each(["/api/members", "/api/settings", "/api/staff", "/api/payments/p1/refund"])(
    "POST %s with the session ended (auth null) → 401, handler not reached",
    async (path) => {
      const res = await run("POST", path, null);
      expect(res.status).toBe(401);
      expect(isPassThrough(res)).toBe(false);
    },
  );

  it("control: the operator's restored claims (what the old fail-open produced) WERE let through", async () => {
    const res = await run("POST", "/api/members", {
      user: { id: "u-operator", tenantId: "t-operator", role: "owner" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("control: a live support session is refused read-only (403)", async () => {
    const res = await run("POST", "/api/members", {
      user: { id: "u-target", tenantId: "t-victim", role: "owner", impersonatedBy: "op-noe" },
    });
    expect(res.status).toBe(403);
  });
});
