// Independent verifier lane 1 (sign-in, roles), 30 Sep 2026, production build:
// D-1 the club-code box overrode react-hook-form's onChange, so Continue/Enter
//     never submitted what was typed and a 3-character code could never work;
// D-3 an operator reset did not keep the replaced password in history, so the
//     owner could choose it again on /set-password;
// D-4 a replaced invite link said "already been used … sign in" to a member
//     with no password;
// D-5 Promotions bounced coaches/admins silently instead of with the notice;
// plus: /set-password accepted weaker passwords than the other two doors.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("D-1 — the club code reaches the form", () => {
  it("spreads the registered field and chains its onChange", () => {
    const s = src("app/login/page.tsx");
    expect(s).toMatch(/const codeField = register\("code"\)/);
    expect(s).toMatch(/void codeField\.onChange\(e\)/);
    expect(s).toMatch(/\{\.\.\.codeField\}/);
    expect(s).not.toMatch(/\{\.\.\.register\("code"\)\}/);
  });
});

describe("D-3 — the replaced password goes into history", () => {
  it("writes the current hash to PasswordHistory before overwriting it", () => {
    const s = src("app/api/admin/customers/[id]/force-password-reset/route.ts");
    const hist = s.indexOf("tx.passwordHistory.create");
    const upd = s.indexOf("passwordHash: hash");
    expect(hist).toBeGreaterThan(-1);
    expect(hist).toBeLessThan(upd);
  });
});

describe("D-4 — a replaced invite says so", () => {
  it("distinguishes a voided link (no password yet) from a used one", () => {
    const s = src("app/api/members/accept-invite/route.ts");
    expect(s).toMatch(/replaced by a newer one/);
    expect(s).toMatch(/This invite has already been used\. Please sign in\./);
  });
});

describe("D-5 — Promotions uses the shared role gate", () => {
  it("calls requireRole with owner and manager", () => {
    const s = src("app/dashboard/promotions/page.tsx");
    expect(s).toMatch(/requireRole\(\["owner", "manager"\]\)/);
    expect(s).not.toMatch(/redirect\("\/dashboard"\)/);
  });
});

describe("one password rule on every door", () => {
  it.each(["app/api/auth/set-password/route.ts", "app/api/members/accept-invite/route.ts"])("%s requires upper, lower and a digit", (p) => {
    const s = src(p);
    expect(s).toMatch(/\[A-Z\]/);
    expect(s).toMatch(/\[a-z\]/);
    expect(s).toMatch(/\[0-9\]/);
  });
});
