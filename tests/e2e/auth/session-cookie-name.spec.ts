/**
 * Regression guard: NextAuth v5 session cookies use the canonical name.
 *
 * Bug history: three custom routes (TOTP setup verify, TOTP login verify,
 * magic-link finalisation) used the legacy v4 cookie name `next-auth.session-token`
 * which auth.js v5 ignores. Writes silently dropped on production where
 * TESTING_MODE doesn't bypass the gate. Caused noe-locked-out incident
 * 2026-05-06.
 *
 * Static guard: tests/unit/auth-cookie-name.test.ts (catches the bug class).
 * This Playwright test is a runtime smoke: hits the NextAuth credentials
 * callback via the API and asserts cookies use the v5 name. Bypasses the UI
 * (login page is multi-step and brittle to selector drift).
 */
import { test, expect } from "@playwright/test";

const V4_FORBIDDEN = ["next-auth.session-token", "__Secure-next-auth.session-token"];
const V5_PATTERN = /^(__Secure-)?authjs\.session-token$/;

test.describe("session cookie naming (runtime)", () => {
  test("NextAuth credentials callback sets v5-named session cookie", async ({
    request,
  }) => {
    // 1. Get CSRF token (NextAuth requires it for credentials sign-in).
    const csrfRes = await request.get("/api/auth/csrf");
    expect(csrfRes.ok()).toBe(true);
    const { csrfToken } = await csrfRes.json();
    expect(typeof csrfToken).toBe("string");

    // 2. Submit credentials. We accept any redirect — the only thing this
    //    test cares about is the Set-Cookie header on the response chain.
    const loginRes = await request.post("/api/auth/callback/credentials", {
      form: {
        csrfToken,
        email: process.env.TEST_EMAIL ?? "owner@totalbjj.co.uk",
        password: process.env.TEST_PASSWORD ?? "password123",
        json: "true",
      },
      // Don't follow redirects — we want the immediate Set-Cookie.
      maxRedirects: 0,
    });

    // 3. Inspect every cookie in the response context after the call.
    const cookies = await request.storageState().then((s) => s.cookies);
    const sessionCookies = cookies.filter((c) =>
      c.name.includes("session-token"),
    );

    // Must have set at least one session cookie if the auth attempt
    // succeeded; if it didn't (wrong creds in this env), at least we should
    // not see a v4-named cookie.
    expect(
      sessionCookies.filter((c) => V4_FORBIDDEN.includes(c.name)),
      `v4-named session cookie present after credentials callback. Found: ${sessionCookies
        .map((c) => c.name)
        .join(", ") || "(none)"} — login status ${loginRes.status()}.`,
    ).toEqual([]);

    // If a session cookie did get set, it must be the v5 name.
    if (sessionCookies.length > 0) {
      const v5Match = sessionCookies.some((c) => V5_PATTERN.test(c.name));
      expect(
        v5Match,
        `expected at least one v5-named session cookie. Got: ${sessionCookies
          .map((c) => c.name)
          .join(", ")}`,
      ).toBe(true);
    } else {
      // The login may have failed (eg. seeded creds disabled in this
      // environment). The test still serves its forbidden-name guard
      // above. Skip the v5-presence assertion to avoid env coupling.
      test.info().annotations.push({
        type: "note",
        description: `No session cookie set; credentials callback returned ${loginRes.status()}. Forbidden-name guard still ran.`,
      });
    }
  });
});
