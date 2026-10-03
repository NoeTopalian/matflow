/**
 * The Google door on a temporary-password (bootstrap) staff account — read as
 * source, the way tests/unit/totp-challenge-follows-enrolment.test.ts reads the
 * Google branch, because the signIn callback is built inside NextAuth's config.
 *
 * Handover review, 3 Oct 2026 (P1): with ENABLE_GOOGLE_OAUTH on, a verified
 * Google account on the owner's provisional address signed in, was stamped
 * mustChangePassword, and landed on /set-password — able to choose the
 * password. Proving the mailbox is not proving the temporary password, so the
 * door refuses while the row carries the flag, exactly as magic-link/verify
 * does. Red on revert: delete the refusal and the second case fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("auth.ts", "utf8");

describe("Google sign-in refuses a staff account still on its temporary password", () => {
  it("the refusal sits in the signIn callback after the account lookup and before the token is hydrated", () => {
    const lookup = src.indexOf('return "/login?error=NoAccountForGym"');
    const refusal = src.indexOf('if (dbUser?.mustChangePassword === true) return "/login?error=invalid_link"');
    const hydrate = src.indexOf("Object.assign(user, dbUser");
    expect(lookup).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(lookup);
    expect(hydrate).toBeGreaterThan(refusal);
  });

  it("members are not affected: the refusal is keyed on the staff row only", () => {
    expect(src).not.toMatch(/memberRow\??\.mustChangePassword/);
  });
});
