import { describe, it, expect } from "vitest";

// LB-004 (audit H10): JWT picks up tenant branding on a 5-minute refresh
// instead of caching it for the full 30-day token lifetime.
import { shouldRefreshBrand, BRAND_REFRESH_INTERVAL_MS } from "@/lib/brand-refresh";

describe("shouldRefreshBrand", () => {
  it("returns true when brandFetchedAt is undefined (new token, never refreshed)", () => {
    expect(shouldRefreshBrand(undefined)).toBe(true);
  });

  it("returns true when last fetch was longer ago than the refresh interval", () => {
    const now = 10_000_000;
    const stale = now - BRAND_REFRESH_INTERVAL_MS - 1;
    expect(shouldRefreshBrand(stale, now)).toBe(true);
  });

  it("returns false when last fetch was within the refresh interval", () => {
    const now = 10_000_000;
    const fresh = now - 60_000; // 1 minute ago
    expect(shouldRefreshBrand(fresh, now)).toBe(false);
  });

  it("returns false at exactly the boundary (>, not >=)", () => {
    const now = 10_000_000;
    const exactly = now - BRAND_REFRESH_INTERVAL_MS;
    expect(shouldRefreshBrand(exactly, now)).toBe(false);
  });

  it("uses a 5-minute interval", () => {
    expect(BRAND_REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
