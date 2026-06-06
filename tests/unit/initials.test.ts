/**
 * Unit tests for the shared initials helper + colour-seed bucket.
 *
 * Track A — Phase A1 (feat/member-profile-pictures). These tests run in CI
 * and guarantee that no future regression silently breaks the fallback path
 * for the Avatar component on every member name in the system.
 */
import { describe, it, expect } from "vitest";
import { initials, colorSeedBucket, AVATAR_HUES } from "@/lib/initials";

describe("initials(name, fallback?)", () => {
  it("returns the default '?' fallback for empty / null / undefined", () => {
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });

  it("respects a caller-supplied fallback", () => {
    expect(initials(null, "G")).toBe("G");
    expect(initials("", "M")).toBe("M");
  });

  it("takes the first letter of the only word for single-word names", () => {
    expect(initials("Noe")).toBe("N");
    expect(initials("alice")).toBe("A");
  });

  it("takes the first two initials for multi-word names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("alice bob")).toBe("AB");
  });

  it("caps at two characters even when there are more words", () => {
    expect(initials("John Fitzgerald Kennedy")).toBe("JF");
    expect(initials("Mary Anne Robinson Tanner")).toBe("MA");
  });

  it("collapses whitespace runs so '  Ada   Lovelace  ' still parses to AL", () => {
    expect(initials("  Ada   Lovelace  ")).toBe("AL");
    expect(initials("\tAda\nLovelace\r")).toBe("AL");
  });

  it("preserves diacritics — the renderer can display them just fine", () => {
    expect(initials("Noé Topalián")).toBe("NT");
    expect(initials("Ørjan Æthelflæd")).toBe("ØÆ");
  });

  it("handles single-letter words gracefully", () => {
    expect(initials("A B")).toBe("AB");
    expect(initials("X")).toBe("X");
  });
});

describe("colorSeedBucket(seed)", () => {
  it("returns 0 for empty / null / undefined", () => {
    expect(colorSeedBucket(null)).toBe(0);
    expect(colorSeedBucket(undefined)).toBe(0);
    expect(colorSeedBucket("")).toBe(0);
  });

  it("returns a value in [0, AVATAR_HUES.length)", () => {
    for (const seed of ["a", "abc", "memberid-12345", "Noé", "Ørjan"]) {
      const bucket = colorSeedBucket(seed);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(AVATAR_HUES.length);
    }
  });

  it("is deterministic — same seed always returns same bucket", () => {
    const seed = "cuid-xyz-789";
    const first = colorSeedBucket(seed);
    for (let i = 0; i < 20; i++) {
      expect(colorSeedBucket(seed)).toBe(first);
    }
  });

  it("spreads across all 8 buckets when fed a representative population", () => {
    // 32 fake CUIDs — should hit every bucket at least once.
    const seeds = Array.from({ length: 32 }, (_, i) => `cuid_member_${i}`);
    const counts = new Array(AVATAR_HUES.length).fill(0);
    for (const seed of seeds) counts[colorSeedBucket(seed)]++;
    expect(counts.every((n) => n > 0)).toBe(true);
  });

  it("AVATAR_HUES contract — every entry has bg + fg + ring", () => {
    for (const hue of AVATAR_HUES) {
      expect(hue.bg).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(hue.fg).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(hue.ring).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(AVATAR_HUES.length).toBe(8);
  });
});
