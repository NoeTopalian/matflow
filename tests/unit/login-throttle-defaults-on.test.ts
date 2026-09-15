// The sign-in throttle must default ON, and must not be switchable by editing a
// constant.
//
// On 15 Sep it became a hard-coded `const LOGIN_THROTTLE_ENABLED = false`,
// because live-portal testing kept tripping "too many sign in attempts". That
// is a real annoyance and it was the wrong trade: the constant shipped to
// production, where the throttle is the only brake in FRONT of the account
// lockout. Lockout still stops someone grinding one account; nothing then
// throttled password-spraying across many. And the commit message described it
// as `LOGIN_THROTTLE_ENABLED=false`, which reads like an environment variable
// it was not — so turning it back on needed a code change and a deploy, at the
// moment you would least want to wait for one.
//
// Two assertions, because either alone is weak. The first pins the SEMANTICS:
// only the exact string "false" disables it, so absent/empty/typo all leave it
// on. The second pins the SOURCE: `auth.ts` reads the environment rather than a
// literal, so a future "just for today" edit back to a hard-coded false fails
// here instead of shipping.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** The exact expression auth.ts uses, so the semantics are testable. */
function throttleEnabled(env: Record<string, string | undefined>): boolean {
  return env.LOGIN_THROTTLE_ENABLED !== "false";
}

function authSource(): string {
  return readFileSync("auth.ts", "utf8");
}

describe("login throttle default", () => {
  it("is ON when the variable is absent — the production case", () => {
    expect(
      throttleEnabled({}),
      "an unset variable must leave the throttle ON; production must never lose it by omission",
    ).toBe(true);
  });

  it("is ON for empty, 'FALSE', '0' and anything else — only exact 'false' disables", () => {
    for (const value of ["", "FALSE", "False", "0", "no", "off", "true", " false"]) {
      expect(throttleEnabled({ LOGIN_THROTTLE_ENABLED: value }), `value ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("is OFF only for the exact string 'false'", () => {
    expect(throttleEnabled({ LOGIN_THROTTLE_ENABLED: "false" })).toBe(false);
  });
});

describe("auth.ts wiring", () => {
  it("reads the environment rather than a hard-coded literal", () => {
    const src = authSource();
    expect(
      /const LOGIN_THROTTLE_ENABLED\s*=\s*process\.env\.LOGIN_THROTTLE_ENABLED\s*!==\s*"false"/.test(src),
      "auth.ts must derive the throttle from the environment with an ON default",
    ).toBe(true);
  });

  it("does not assign the throttle a boolean literal anywhere", () => {
    // The exact regression: `const LOGIN_THROTTLE_ENABLED = false;`
    const src = authSource();
    expect(
      /const LOGIN_THROTTLE_ENABLED\s*=\s*(true|false)\s*;/.test(src),
      "the throttle is hard-coded again — it must come from the environment so it can be changed without a deploy, and so production keeps it by default",
    ).toBe(false);
  });

  it("still guards the sign-in rate-limit block it is supposed to guard", () => {
    // Guards against the flag being made correct and then quietly unused.
    const src = authSource();
    expect(src).toMatch(/if\s*\(\s*LOGIN_THROTTLE_ENABLED\s*&&\s*!skipRateLimit\s*\)/);
  });
});
