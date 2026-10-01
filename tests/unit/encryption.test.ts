import { describe, it, expect, vi } from "vitest";

// `server-only` is a Next.js marker package with no runtime; stub it for vitest.
vi.mock("server-only", () => ({}));
// The module reads AUTH_SECRET_VALUE at load; give it a deterministic value.
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret-for-encryption-roundtrip" }));

const { encrypt, decrypt } = await import("@/lib/encryption");

describe("lib/encryption (AES-256-GCM)", () => {
  it("round-trips plaintext, including unicode and empty", () => {
    for (const s of ["", "hello", "ya29.a0-google-drive-token", "émoji 🥋 café", "x".repeat(5000)]) {
      expect(decrypt(encrypt(s))).toBe(s);
    }
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects a tampered authentication tag", () => {
    const token = encrypt("secret-token");
    const buf = Buffer.from(token, "base64");
    // The tag sits at bytes [12, 28). Flip one bit of it.
    buf[14] ^= 0x01;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("rejects tampered ciphertext body", () => {
    const token = encrypt("secret-token");
    const buf = Buffer.from(token, "base64");
    buf[buf.length - 1] ^= 0x01;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("rejects a truncated authentication tag (authTagLength enforced)", () => {
    const token = encrypt("secret-token");
    const buf = Buffer.from(token, "base64");
    // Drop one byte from the 16-byte tag region by removing a byte at index 13.
    const short = Buffer.concat([buf.subarray(0, 13), buf.subarray(14)]);
    expect(() => decrypt(short.toString("base64"))).toThrow();
  });
});
