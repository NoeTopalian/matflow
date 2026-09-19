/**
 * Lane L-G round 1, defect 3.
 *
 * All four cron routes compared the bearer with `authHeader !== \`Bearer ${expected}\``.
 * `!==` on strings short-circuits at the first differing byte, and the cron
 * routes carry no rate limit at all, so there was no brake on the attempt
 * count either. `MATFLOW_ADMIN_SECRET` was given a constant-time comparison
 * after an explicit audit (`lib/admin-auth.ts`); `CRON_SECRET` was not.
 *
 * The comparison now lives in `lib/constant-time.ts` so a cron route can reach
 * it without importing `lib/admin-auth.ts`, which pulls `next/headers`,
 * `lib/operator-auth.ts` and Prisma into a route that needs none of them.
 */
import { describe, it, expect } from "vitest";
import { constantTimeEq } from "@/lib/constant-time";
import { constantTimeEq as viaAdminAuth } from "@/lib/admin-auth";

describe("constantTimeEq", () => {
  it("is true for identical strings", () => {
    expect(constantTimeEq("Bearer abc123", "Bearer abc123")).toBe(true);
  });

  it("is false when a single byte differs", () => {
    expect(constantTimeEq("Bearer abc123", "Bearer abc124")).toBe(false);
  });

  it("is false for a length mismatch without leaking it by an early return", () => {
    // Both inputs are hashed to a fixed 32 bytes before the comparison, so a
    // length mismatch costs the same as a content mismatch.
    expect(constantTimeEq("short", "a-considerably-longer-value")).toBe(false);
    expect(constantTimeEq("", "x")).toBe(false);
  });

  it("is false for an empty candidate against a real secret", () => {
    expect(constantTimeEq("", "the-real-secret")).toBe(false);
  });

  it("is the same function lib/admin-auth.ts exposes — one implementation, not two", () => {
    expect(viaAdminAuth).toBe(constantTimeEq);
  });
});

describe("the cron bearer check", () => {
  it("accepts only the exact Bearer <secret> presentation", async () => {
    const { bearerMatches } = await import("@/lib/constant-time");
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("Bearer s3crey", "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret"), "a bare secret with no prefix").toBe(false);
    expect(bearerMatches("bearer s3cret", "s3cret"), "the scheme is case-sensitive here").toBe(false);
    expect(bearerMatches(null, "s3cret"), "no header at all").toBe(false);
    expect(bearerMatches("", "s3cret")).toBe(false);
    expect(bearerMatches("Bearer ", "s3cret")).toBe(false);
  });
});
