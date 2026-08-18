// Error references (2026-08-18): the short id a member reads out to their gym
// owner, and the only thing correlating "what the user saw" with "what the
// server logged". Shape, uniqueness, and the confusable-character repair that
// makes a dictated reference survive being typed back in.

import { describe, it, expect } from "vitest";
import {
  ERROR_REFERENCE_ALPHABET,
  ERROR_REFERENCE_LENGTH,
  ERROR_REFERENCE_PATTERN,
  errorReferenceFromDigest,
  isErrorReference,
  newErrorReference,
  normaliseErrorReference,
} from "@/lib/error-reference";

describe("error reference — alphabet", () => {
  it("excludes every character confusable with another in the set", () => {
    for (const ch of "BGILOQSUZ") {
      expect(ERROR_REFERENCE_ALPHABET).not.toContain(ch);
    }
  });

  it("has no duplicate characters", () => {
    expect(new Set(ERROR_REFERENCE_ALPHABET).size).toBe(ERROR_REFERENCE_ALPHABET.length);
  });
});

describe("newErrorReference — shape", () => {
  it("is MF- plus six characters, all from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const ref = newErrorReference();
      expect(ref).toMatch(ERROR_REFERENCE_PATTERN);
      expect(ref.slice(3)).toHaveLength(ERROR_REFERENCE_LENGTH);
      for (const ch of ref.slice(3)) expect(ERROR_REFERENCE_ALPHABET).toContain(ch);
    }
  });

  it("is short enough to read aloud and quote", () => {
    expect(newErrorReference()).toHaveLength(3 + ERROR_REFERENCE_LENGTH);
  });

  it("round-trips through its own validator", () => {
    const ref = newErrorReference();
    expect(isErrorReference(ref)).toBe(true);
    expect(normaliseErrorReference(ref)).toBe(ref);
  });
});

describe("newErrorReference — uniqueness", () => {
  it("never repeats back-to-back", () => {
    for (let i = 0; i < 500; i++) {
      expect(newErrorReference()).not.toBe(newErrorReference());
    }
  });

  it("is effectively collision-free at support volumes", () => {
    // 27^6 ≈ 387m, so 2,000 draws expect ~0.005 collisions. Allowing one keeps
    // the assertion deterministic in practice (P(2+) ≈ 1e-5) while still
    // failing hard if the generator collapses its output space.
    const n = 2_000;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) seen.add(newErrorReference());
    expect(seen.size).toBeGreaterThanOrEqual(n - 1);
  });

  it("uses the whole alphabet rather than a biased slice", () => {
    // Rejection sampling exists so `% 27` doesn't favour the first 13
    // characters. With 30k draws every character should appear.
    const used = new Set<string>();
    for (let i = 0; i < 5_000; i++) for (const ch of newErrorReference().slice(3)) used.add(ch);
    expect(used.size).toBe(ERROR_REFERENCE_ALPHABET.length);
  });
});

describe("errorReferenceFromDigest — the server/client correlation", () => {
  it("gives the same reference for the same digest, on both sides", () => {
    expect(errorReferenceFromDigest("2416069568")).toBe(errorReferenceFromDigest("2416069568"));
  });

  it("gives different references for different digests", () => {
    const refs = new Set(
      Array.from({ length: 2000 }, (_, i) => errorReferenceFromDigest(`digest-${i}`)),
    );
    // Allow for the odd hash collision in a 27^6 space; a broken derivation
    // would collapse to a handful of values, not 1999 of 2000.
    expect(refs.size).toBeGreaterThan(1990);
  });

  it("has the same shape as a freshly minted reference", () => {
    for (const digest of ["a", "3376458219", "x".repeat(64), ""]) {
      expect(errorReferenceFromDigest(digest)).toMatch(ERROR_REFERENCE_PATTERN);
    }
  });
});

describe("normaliseErrorReference — what a human types back", () => {
  it("is case-insensitive", () => {
    expect(normaliseErrorReference("mf-4k7p3r")).toBe("MF-4K7P3R");
  });

  it("tolerates spaces, extra hyphens and a missing prefix", () => {
    expect(normaliseErrorReference("MF 4K7 P3R")).toBe("MF-4K7P3R");
    expect(normaliseErrorReference("mf–4k7p3r".replace("–", "-"))).toBe("MF-4K7P3R");
    expect(normaliseErrorReference("4K7P3R")).toBe("MF-4K7P3R");
  });

  it("repairs the confusable characters the alphabet never emits", () => {
    // O→0, I→1, S→5, B→8, G→6, Z→2, L→1, Q→0, U→V
    expect(normaliseErrorReference("MF-OISBGZ")).toBe("MF-015862");
    expect(normaliseErrorReference("MF-LQU444")).toBe("MF-10V444");
  });

  it("does not eat a body that legitimately starts with MF", () => {
    expect(normaliseErrorReference("MF-MF4K7P")).toBe("MF-MF4K7P");
    expect(normaliseErrorReference("MF4K7P")).toBe("MF-MF4K7P");
  });

  it("returns null for anything that cannot be a reference", () => {
    for (const junk of ["", "MF-", "MF-12345", "MF-1234567", "hello world", null, undefined]) {
      expect(normaliseErrorReference(junk)).toBeNull();
    }
  });
});
