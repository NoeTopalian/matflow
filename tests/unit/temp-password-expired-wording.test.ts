// E2E cosmetic finding (6 Oct 2026): the server log for an expired temporary
// password said "Ask MatFlow support…" while the login screen says "Ask whoever
// gave it to you…" — a temporary password can come from MatFlow support (owner)
// or from the club's owner (staff). One wording, pinned on both sides.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const WORDS = "This temporary password has expired. Ask whoever gave it to you for a new one.";

describe("temp_password_expired wording", () => {
  it("auth.ts and the login screen say the same thing", () => {
    const authSrc = readFileSync(path.join(process.cwd(), "auth.ts"), "utf8");
    const loginSrc = readFileSync(path.join(process.cwd(), "app/login/page.tsx"), "utf8");
    expect(loginSrc).toContain(WORDS);
    expect(authSrc).toContain(`super("${WORDS}")`);
    expect(authSrc).not.toContain("Ask MatFlow support for a new one");
  });
});
