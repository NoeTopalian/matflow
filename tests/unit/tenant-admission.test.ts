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
import {
  tenantAdmission,
  tenantAdmitsSignIn,
  admissionMessage,
  admissionErrorCode,
} from "@/lib/tenant-admission";

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

/**
 * Refusing is only half the job — the person has to be TOLD.
 *
 * `app/login/page.tsx:58-72` renders exactly four error codes and falls through
 * to "Incorrect email or password." for anything else. The password door
 * translates an admission reason into that vocabulary; the magic-link door
 * emitted `tenant_${reason}` raw, so `tenant_suspended` fell through and a
 * member of a paused club was told their password was wrong — sent off to reset
 * a credential that was never the problem, which is the exact defect the
 * comment at the top of this file says was fixed.
 *
 * One translation, exported, so a fourth door cannot get it wrong either.
 */
describe("what the login page is told", () => {
  it("translates every reason into a code the login page actually renders", () => {
    expect(admissionErrorCode("suspended")).toBe("tenant_paused");
    expect(admissionErrorCode("cancelled")).toBe("tenant_paused");
    expect(admissionErrorCode("deleted")).toBe("tenant_closed");
  });

  it("emits only codes the login page has a case for", () => {
    const page = readFileSync("app/login/page.tsx", "utf8");
    for (const reason of ["suspended", "cancelled", "deleted"] as const) {
      const code = admissionErrorCode(reason);
      expect(page, `app/login/page.tsx has no case for ${code}`).toContain(`case "${code}"`);
    }
  });

  it("no door builds the error code by hand", () => {
    // `tenant_${admission.reason}` is how this broke. Interpolating the reason
    // produces three codes the page has never heard of.
    for (const file of ["auth.ts", "app/api/magic-link/verify/route.ts"]) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} interpolates the admission reason into an error code`)
        .not.toMatch(/tenant_\$\{/);
    }
  });

  it("the magic-link door decides admission BEFORE it consumes the token", () => {
    // A refusal that burns the link punishes the member for their club's
    // billing. The tenant lookup must appear before the consuming updateMany.
    const code = readFileSync("app/api/magic-link/verify/route.ts", "utf8");
    const admissionAt = code.indexOf("tenantAdmission(");
    const consumeAt = code.indexOf("magicLinkToken.updateMany(");
    expect(admissionAt, "verify/route.ts consults tenantAdmission").toBeGreaterThan(-1);
    expect(consumeAt, "verify/route.ts consumes with updateMany").toBeGreaterThan(-1);
    expect(admissionAt, "admission is checked before the token is consumed").toBeLessThan(consumeAt);
  });
});
