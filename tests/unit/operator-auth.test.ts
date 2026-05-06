/**
 * Unit tests for the v1.5 operator session token machinery.
 *
 * Pure-function tests only — no DB/Prisma. The bcrypt + DB path is
 * exercised by integration tests (out of scope here).
 */
import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-do-not-use-in-prod";
});

describe("operator session token", () => {
  it("issued token round-trips through verify", async () => {
    const { issueOperatorSession, verifyOperatorSession } = await import("@/lib/operator-auth");
    const token = issueOperatorSession("op_123", 7);
    const v = verifyOperatorSession(token);
    expect(v).not.toBeNull();
    expect(v!.operatorId).toBe("op_123");
    expect(v!.sessionVersion).toBe(7);
  });

  it("rejects a forged signature", async () => {
    const { issueOperatorSession, verifyOperatorSession } = await import("@/lib/operator-auth");
    const token = issueOperatorSession("op_123", 1);
    const parts = token.split(".");
    parts[3] = parts[3].replace(/.$/, parts[3].endsWith("a") ? "b" : "a");
    const bad = parts.join(".");
    expect(verifyOperatorSession(bad)).toBeNull();
  });

  it("rejects a tampered operatorId", async () => {
    const { issueOperatorSession, verifyOperatorSession } = await import("@/lib/operator-auth");
    const token = issueOperatorSession("op_123", 1);
    const parts = token.split(".");
    parts[0] = "op_attacker";
    const bad = parts.join(".");
    expect(verifyOperatorSession(bad)).toBeNull();
  });

  it("rejects a tampered sessionVersion", async () => {
    const { issueOperatorSession, verifyOperatorSession } = await import("@/lib/operator-auth");
    const token = issueOperatorSession("op_123", 1);
    const parts = token.split(".");
    parts[1] = "999";
    const bad = parts.join(".");
    expect(verifyOperatorSession(bad)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { verifyOperatorSession } = await import("@/lib/operator-auth");
    const { createHmac } = await import("node:crypto");
    const expiredExp = Date.now() - 1000;
    const payload = `op_123.1.${expiredExp}`;
    const sig = createHmac("sha256", process.env.AUTH_SECRET!).update(payload).digest("hex");
    const token = `${payload}.${sig}`;
    expect(verifyOperatorSession(token)).toBeNull();
  });

  it("rejects malformed token shapes", async () => {
    const { verifyOperatorSession } = await import("@/lib/operator-auth");
    expect(verifyOperatorSession("")).toBeNull();
    expect(verifyOperatorSession("only.two")).toBeNull();
    expect(verifyOperatorSession("a.b.c.d.e")).toBeNull();
    expect(verifyOperatorSession("..a.b")).toBeNull();
  });

  it("cookie set headers include HttpOnly + SameSite=Strict + Path=/", async () => {
    const { operatorCookieSetHeaders } = await import("@/lib/operator-auth");
    const headers = operatorCookieSetHeaders("dummy.token");
    expect(headers["Set-Cookie"]).toContain("HttpOnly");
    expect(headers["Set-Cookie"]).toContain("SameSite=Strict");
    expect(headers["Set-Cookie"]).toContain("Path=/");
    expect(headers["Set-Cookie"]).toContain("matflow_op_session=dummy.token");
  });

  it("cookie clear headers expire the cookie immediately", async () => {
    const { operatorCookieClearHeaders } = await import("@/lib/operator-auth");
    const headers = operatorCookieClearHeaders();
    expect(headers["Set-Cookie"]).toContain("Max-Age=0");
    expect(headers["Set-Cookie"]).toContain("matflow_op_session=");
  });
});
