import { describe, it, expect, beforeAll } from "vitest";

// AUTH_SECRET must be set before importing the module under test.
beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-do-not-use-in-prod";
});

describe("hashToken (Fix 1 — bearer token at-rest hashing)", () => {
  it("produces a 64-char lowercase hex string (SHA-256 output length)", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    const out = hashToken("hello-world");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input produces same hash", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    const a = hashToken("alice@example.com");
    const b = hashToken("alice@example.com");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    expect(hashToken("a")).not.toBe(hashToken("b"));
    expect(hashToken("abc")).not.toBe(hashToken("abcd"));
    expect(hashToken("")).not.toBe(hashToken(" "));
  });

  it("produces hashes that vary by case (case-sensitive HMAC input)", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    expect(hashToken("ABC")).not.toBe(hashToken("abc"));
  });

  it("handles long tokens without truncation collisions", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    const long1 = "a".repeat(1000);
    const long2 = "a".repeat(999) + "b";
    expect(hashToken(long1)).not.toBe(hashToken(long2));
  });

  it("returns 64-char hex regardless of input length", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    expect(hashToken("").length).toBe(64);
    expect(hashToken("x").length).toBe(64);
    expect(hashToken("x".repeat(10_000)).length).toBe(64);
  });

  it("does not return the raw input under any circumstances", async () => {
    const { hashToken } = await import("@/lib/token-hash");
    const raw = "deadbeef";
    expect(hashToken(raw)).not.toBe(raw);
    expect(hashToken(raw)).not.toContain(raw);
  });
});
