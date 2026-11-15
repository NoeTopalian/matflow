// "Sign out" records this session as ended BEFORE Auth.js clears the cookie (Round 8, 16 Nov 2026).
//
// Pins: the record is written first and Auth.js runs only after it succeeded; a failed write is a 503 with the
// visible message and Auth.js never runs (cookie kept); a repeat is harmless; a pre-release token records its derived
// id; a cross-site POST cannot end a session; other auth actions are untouched; and pruning removes only records
// past their expiry.

import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getToken: vi.fn(),
  createMany: vi.fn(),
  deleteMany: vi.fn(),
  authPost: vi.fn(),
  order: [] as string[],
}));

vi.mock("next-auth/jwt", () => ({ getToken: h.getToken }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) =>
    fn({ revokedSession: { createMany: h.createMany, deleteMany: h.deleteMany } }),
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("@/auth", () => ({ handlers: { GET: vi.fn(), POST: h.authPost } }));

import { POST } from "@/app/api/auth/[...nextauth]/route";
import { pruneExpiredRevocations, recordSignOut, revokeSessionId } from "@/lib/session-signout";
import { REVOKED_SESSION_RETENTION_MS, sessionIdOf } from "@/lib/session-id";
import { SIGN_OUT_FAILED_MESSAGE } from "@/lib/sign-out-client";

const ORIGIN = "http://localhost:3000";
const SID = "AbCdEfGhIjKlMnOpQrStUv";

function signOutRequest(origin: string | null = ORIGIN, path = "/api/auth/signout"): Request {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", cookie: "authjs.session-token=x" });
  if (origin) headers.set("origin", origin);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: "csrfToken=t&callbackUrl=%2Flogin" });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  process.env.NEXTAUTH_URL = ORIGIN;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.getToken.mockResolvedValue({ id: "u-1", tenantId: "t-1", sessionVersion: 0, sid: SID });
  h.createMany.mockImplementation(async () => {
    h.order.push("record");
    return { count: 1 };
  });
  h.deleteMany.mockResolvedValue({ count: 0 });
  h.authPost.mockImplementation(async () => {
    h.order.push("auth.js clears the cookie");
    return new Response(JSON.stringify({ url: `${ORIGIN}/login` }), {
      status: 200,
      headers: { "set-cookie": "authjs.session-token=; Max-Age=0; Path=/" },
    });
  });
});

describe("POST /api/auth/signout", () => {
  it("records this session's id, THEN lets Auth.js clear the cookie", async () => {
    const res = await POST(signOutRequest());
    expect(res.status).toBe(200);
    expect(h.order).toEqual(["record", "auth.js clears the cookie"]);
    const { data, skipDuplicates } = h.createMany.mock.calls[0][0] as {
      data: Array<{ sid: string; revokedAt: Date; expiresAt: Date }>;
      skipDuplicates: boolean;
    };
    expect(data).toHaveLength(1);
    expect(data[0].sid).toBe(SID);
    expect(data[0].expiresAt.getTime() - data[0].revokedAt.getTime()).toBe(REVOKED_SESSION_RETENTION_MS);
    // A repeat (retry after a lost response, a second tab) is ignored by the database, not an error.
    expect(skipDuplicates).toBe(true);
  });

  it("FAILS CLOSED: when the record cannot be written it answers 503 with the message, and Auth.js never runs", async () => {
    h.createMany.mockRejectedValue(Object.assign(new Error("Connection terminated"), { code: "57P01" }));
    const res = await POST(signOutRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SIGN_OUT_FAILED_MESSAGE, retryable: true });
    expect(SIGN_OUT_FAILED_MESSAGE).toBe("We couldn't sign you out. Try again.");
    // The cookie is not touched: no Set-Cookie, and Auth.js (which clears it) was never called.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.authPost).not.toHaveBeenCalled();
  });

  it("can be repeated: a second sign-out of the same session succeeds", async () => {
    await POST(signOutRequest());
    h.createMany.mockResolvedValueOnce({ count: 0 }); // already recorded
    const again = await POST(signOutRequest());
    expect(again.status).toBe(200);
    expect(h.createMany).toHaveBeenCalledTimes(2);
    expect(h.authPost).toHaveBeenCalledTimes(2);
  });

  it("records a pre-release token (no id) under its person's derived id", async () => {
    const token = { id: "u-1", tenantId: "t-1", sessionVersion: 0 };
    h.getToken.mockResolvedValue(token);
    await POST(signOutRequest());
    const sid = (h.createMany.mock.calls[0][0] as { data: Array<{ sid: string }> }).data[0].sid;
    expect(sid).toBe(sessionIdOf(token));
    expect(sid.startsWith("legacy-")).toBe(true);
  });

  it("with no readable session there is nothing to end: straight to Auth.js", async () => {
    h.getToken.mockResolvedValue(null);
    const res = await POST(signOutRequest());
    expect(res.status).toBe(200);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.authPost).toHaveBeenCalledTimes(1);
  });

  it("a cross-site POST cannot end someone's session", async () => {
    const res = await POST(signOutRequest("https://evil.example"));
    expect(res.status).toBe(403);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.authPost).not.toHaveBeenCalled();
    const bare = await POST(signOutRequest(null));
    expect(bare.status).toBe(403);
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("other Auth.js actions are untouched", async () => {
    await POST(signOutRequest(ORIGIN, "/api/auth/callback/credentials"));
    expect(h.getToken).not.toHaveBeenCalled();
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.authPost).toHaveBeenCalledTimes(1);
  });

  it("reads the session cookie by the same name and secure flag as Auth.js", async () => {
    await recordSignOut(signOutRequest());
    expect(h.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "test-secret", cookieName: expect.any(String), secureCookie: expect.any(Boolean) }),
    );
  });
});

describe("revocation records are kept until no token of the session can be valid, then pruned", () => {
  it("expires a record exactly REVOKED_SESSION_RETENTION_MS after it was written", async () => {
    const now = new Date("2026-11-16T00:00:00Z");
    await revokeSessionId(SID, now);
    const row = (h.createMany.mock.calls[0][0] as { data: Array<{ revokedAt: Date; expiresAt: Date }> }).data[0];
    expect(row.revokedAt).toEqual(now);
    expect(row.expiresAt).toEqual(new Date(now.getTime() + REVOKED_SESSION_RETENTION_MS));
  });

  it("pruning deletes only records whose expiry has passed", async () => {
    const now = new Date("2027-01-20T00:00:00Z");
    await pruneExpiredRevocations(now);
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });
});
