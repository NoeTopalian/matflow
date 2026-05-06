/**
 * Regression guard for the NextAuth v5 cookie-name bug.
 *
 * Three custom routes hand-roll a JWT cookie write to mutate session state
 * server-side. Before this fix, all three used the legacy v4 cookie name
 * which auth.js v5 ignores — silently breaking TOTP enrolment, TOTP login
 * second-factor, and magic-link finalisation on production (where
 * TESTING_MODE doesn't bypass the gate).
 *
 * This test asserts:
 *   1. lib/auth-cookie.ts exports the correct v5 cookie name.
 *   2. Each of the three custom routes imports SESSION_COOKIE_NAME from
 *      @/lib/auth-cookie and never embeds the legacy v4 name as a literal
 *      string. Static check — catches future copy-paste regressions.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const V4_FRAGMENT = "next-auth.session-token";

const ROUTES = [
  "app/api/auth/totp/setup/route.ts",
  "app/api/auth/totp/verify/route.ts",
  "app/api/magic-link/verify/route.ts",
] as const;

describe("lib/auth-cookie", () => {
  it("exports a v5-style session cookie name", async () => {
    const mod = await import("@/lib/auth-cookie");
    expect(mod.SESSION_COOKIE_NAME).toMatch(/^(__Secure-)?authjs\.session-token$/);
    expect(typeof mod.SESSION_COOKIE_SECURE).toBe("boolean");
  });

  it("source defines the correct v5 cookie names for both env modes", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "lib/auth-cookie.ts"),
      "utf8",
    );
    expect(src).toContain("__Secure-authjs.session-token");
    expect(src).toContain("authjs.session-token");
  });
});

describe("custom JWT-mutating routes use the canonical cookie name", () => {
  it.each(ROUTES)(
    "%s imports SESSION_COOKIE_NAME from @/lib/auth-cookie",
    (route) => {
      const src = fs.readFileSync(path.join(REPO_ROOT, route), "utf8");
      expect(src).toMatch(/from\s+["']@\/lib\/auth-cookie["']/);
      expect(src).toMatch(/SESSION_COOKIE_NAME/);
    },
  );

  it.each(ROUTES)(
    "%s contains zero string literals matching the legacy v4 cookie name",
    (route) => {
      const src = fs.readFileSync(path.join(REPO_ROOT, route), "utf8");
      // Quoted literal forms only — comments mentioning the v4 name as
      // historical context are fine, but the literal string in any quote
      // style would mean the bug returned.
      expect(src).not.toContain(`"${V4_FRAGMENT}"`);
      expect(src).not.toContain(`'${V4_FRAGMENT}'`);
      expect(src).not.toContain(`"__Secure-${V4_FRAGMENT}"`);
      expect(src).not.toContain(`'__Secure-${V4_FRAGMENT}'`);
    },
  );
});
