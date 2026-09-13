// Suspending a club must close every door, not one of three.
//
// MatFlow has three ways in — password, magic link, Google OAuth — and only the
// password one asked about the club's account state. `auth.ts`'s credentials
// provider refused a suspended or soft-deleted tenant. `magic-link/verify` and
// the Google `signIn` callback resolved the tenant, checked it EXISTED, and let
// everyone through.
//
// So an operator suspending a club locked the front door and left two others
// open — and the owner could walk in through either and read a dashboard that
// told them they were suspended.
//
// This was never a policy question. The policy was decided and written down; it
// was enforced in one place out of three.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tenantAdmission, tenantAdmitsSignIn, admissionMessage } from "@/lib/tenant-admission";

describe("who gets in", () => {
  it("refuses a suspended club", () => {
    expect(tenantAdmission({ subscriptionStatus: "suspended", deletedAt: null }))
      .toEqual({ admits: false, reason: "suspended" });
  });

  it("refuses a soft-deleted club, whatever its subscription says", () => {
    expect(tenantAdmission({ subscriptionStatus: "active", deletedAt: new Date() }))
      .toEqual({ admits: false, reason: "deleted" });
  });

  it("refuses a cancelled club", () => {
    // Nothing writes this state yet — it is documented in MATFLOW-PIPELINES and
    // has no writer. Closing the door before it opens costs nothing; noticing
    // later that a newly-reachable state admits logins costs a great deal.
    expect(tenantAdmission({ subscriptionStatus: "cancelled", deletedAt: null }).admits)
      .toBe(false);
  });

  it("admits a trial and an active club", () => {
    expect(tenantAdmitsSignIn({ subscriptionStatus: "trial", deletedAt: null })).toBe(true);
    expect(tenantAdmitsSignIn({ subscriptionStatus: "active", deletedAt: null })).toBe(true);
  });

  it("ADMITS a past-due club, and flags it", () => {
    // A club behind on MatFlow's own fee still has members turning up to train
    // tonight, and locking the owner out is how you guarantee they never pay.
    expect(tenantAdmission({ subscriptionStatus: "past_due", deletedAt: null }))
      .toEqual({ admits: true, flagged: true });
  });

  it("admits a club whose status was never set", () => {
    expect(tenantAdmitsSignIn({ subscriptionStatus: null, deletedAt: null })).toBe(true);
    expect(tenantAdmitsSignIn({})).toBe(true);
  });

  it("is not fooled by casing or padding in a free-text column", () => {
    // Tenant.subscriptionStatus has no CHECK constraint — it is a plain String
    // column, so what is in it is whatever a writer put there.
    expect(tenantAdmitsSignIn({ subscriptionStatus: " Suspended ", deletedAt: null })).toBe(false);
  });
});

describe("what the person at the door is told", () => {
  it("does not tell a member about their club's commercial standing", () => {
    const msg = admissionMessage("suspended", "member");
    expect(msg).toContain("paused");
    expect(msg.toLowerCase()).not.toContain("matflow");
  });

  it("tells staff who can actually fix it", () => {
    expect(admissionMessage("suspended", "staff")).toContain("MatFlow");
    expect(admissionMessage("deleted", "staff")).toContain("closed");
  });
});

describe("every door asks", () => {
  it("all three sign-in paths use the shared helper", () => {
    // A scan rather than a review: this defect WAS the gap between a rule
    // written in one file and the two files that never read it.
    for (const file of ["auth.ts", "app/api/magic-link/verify/route.ts"]) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} does not consult tenant admission`).toContain("tenantAdmission(");
    }

    // auth.ts holds two doors — credentials and the Google signIn callback —
    // so one call there is not enough.
    const authCode = readFileSync("auth.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect([...authCode.matchAll(/tenantAdmission\(/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("no door re-implements the rule by hand", () => {
    // The original shape: `if (tenant.subscriptionStatus === "suspended")`.
    // One of those is how the rule ends up enforced in one place again.
    for (const file of ["auth.ts", "app/api/magic-link/verify/route.ts"]) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} hand-rolls the suspension check`)
        .not.toMatch(/subscriptionStatus\s*===/);
    }
  });
});
