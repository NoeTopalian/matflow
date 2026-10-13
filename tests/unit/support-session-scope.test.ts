// Edit-scope support sessions (hub club edit access, 13 Oct 2026).
//
// The matrix below is the feature's security boundary: a VIEW session behaves
// exactly as the read-only session always has; an EDIT session may make only
// the routine mutations in SUPPORT_EDIT_MUTATION_ALLOWLIST; and the families
// that stay with their separately protected workflows refuse in BOTH scopes.
import { describe, it, expect } from "vitest";
import {
  SUPPORT_EDIT_MUTATION_ALLOWLIST,
  SUPPORT_EDIT_NOT_COVERED_MESSAGE,
  SUPPORT_READ_ONLY_MESSAGE,
  SUPPORT_OPERATOR_PLANE_MESSAGE,
  supportRequestDecision,
} from "@/lib/support-session";
import { verifyImpersonationToken, signImpersonationToken } from "@/lib/impersonation";

const ALLOWED_EDITS: Array<[string, string]> = [
  ["POST", "/api/classes"],
  ["PATCH", "/api/classes/c1"],
  ["POST", "/api/classes/c1/instances"],
  ["PATCH", "/api/classes/c1/instances/i1"],
  ["POST", "/api/classes/c1/roster"],
  ["POST", "/api/members"],
  ["PATCH", "/api/members/m1"],
  ["POST", "/api/members/m1/rank"],
  ["POST", "/api/members/m1/rank/demote"],
  ["POST", "/api/checkin"],
  ["POST", "/api/ranks"],
  ["PATCH", "/api/ranks/r1"],
  ["PATCH", "/api/settings"],
];

// One representative per family that must never be reachable from an edit
// session. Every row refuses in BOTH scopes.
const NEVER_UNDER_SUPPORT: Array<[string, string, string]> = [
  ["POST", "/api/account/password", "own-account credentials"],
  ["POST", "/api/account/login-email", "own login email"],
  ["POST", "/api/auth/totp/verify", "authenticator"],
  ["POST", "/api/auth/totp/setup", "authenticator enrolment"],
  ["POST", "/api/member/totp/setup", "member authenticator"],
  ["POST", "/api/members/m1/totp-reset", "member MFA reset"],
  ["POST", "/api/staff", "staff management"],
  ["PATCH", "/api/staff/s1", "staff management"],
  ["POST", "/api/staff/s1/transfer-ownership", "ownership transfer"],
  ["POST", "/api/stripe/checkout", "payments"],
  ["POST", "/api/members/m1/charge", "charging a member"],
  ["POST", "/api/members/m1/hold", "membership hold (billing-adjacent)"],
  ["POST", "/api/members/m1/invite-link", "credential-bearing link minting"],
  ["POST", "/api/members/m1/waiver-link", "credential-bearing link minting"],
  ["POST", "/api/members/m1/waiver/sign", "signing a legal document for someone"],
  ["POST", "/api/members/m1/guardian", "family authority"],
  ["POST", "/api/members/m1/link-child", "family authority"],
  ["POST", "/api/members/m1/promote-to-adult", "account type"],
  ["POST", "/api/members/m1/unlock", "lockout control"],
  ["POST", "/api/settings/display", "display token minting"],
  ["POST", "/api/settings/kiosk", "kiosk token minting"],
  ["DELETE", "/api/members/m1", "destructive"],
  ["DELETE", "/api/classes/c1", "destructive"],
  ["DELETE", "/api/ranks/r1", "destructive"],
  ["DELETE", "/api/classes/c1/roster/m1", "destructive"],
  ["DELETE", "/api/checkin", "destructive"],
  ["POST", "/dashboard/members", "a page POST (Server Action)"],
  ["POST", "/dashboard/settings", "a page POST (Server Action)"],
];

describe("edit scope allows exactly the routine allowlist", () => {
  for (const [method, path] of ALLOWED_EDITS) {
    it(`${method} ${path} allowed in edit scope`, () => {
      expect(supportRequestDecision(method, path, "edit")).toEqual({ allowed: true });
    });
    it(`${method} ${path} still refused in view scope`, () => {
      const d = supportRequestDecision(method, path, "view");
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.message).toBe(SUPPORT_READ_ONLY_MESSAGE);
    });
  }
  it("every allowlist rule is matched by at least one case above (no untested rule)", () => {
    for (const rule of SUPPORT_EDIT_MUTATION_ALLOWLIST) {
      const hit = ALLOWED_EDITS.some(([m, p]) => m === rule.method && rule.path.test(p));
      expect(hit, `untested allowlist rule: ${rule.method} ${rule.path}`).toBe(true);
    }
  });
});

describe("protected families refuse in both scopes", () => {
  for (const [method, path, why] of NEVER_UNDER_SUPPORT) {
    for (const scope of ["view", "edit"] as const) {
      it(`${method} ${path} refused in ${scope} scope (${why})`, () => {
        const d = supportRequestDecision(method, path, scope);
        expect(d.allowed).toBe(false);
        if (!d.allowed && scope === "edit" && !path.startsWith("/api/admin/")) {
          expect(d.message).toBe(SUPPORT_EDIT_NOT_COVERED_MESSAGE);
        }
      });
    }
  }
  it("the operator plane stays refused in edit scope", () => {
    const d = supportRequestDecision("GET", "/admin/tenants/t1", "edit");
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.message).toBe(SUPPORT_OPERATOR_PLANE_MESSAGE);
    expect(supportRequestDecision("POST", "/api/admin/impersonate", "edit").allowed).toBe(false);
  });
  it("refused reads (exports, TOTP-minting GETs) stay refused in edit scope", () => {
    expect(supportRequestDecision("GET", "/api/payments/export.csv", "edit").allowed).toBe(false);
    expect(supportRequestDecision("GET", "/api/auth/totp/setup", "edit").allowed).toBe(false);
  });
  it("laundering: duplicate slashes cannot dodge the deny", () => {
    expect(supportRequestDecision("POST", "//api//staff", "edit").allowed).toBe(false);
  });
  it("scope defaults to view when absent", () => {
    expect(supportRequestDecision("POST", "/api/classes", undefined as never).allowed).toBe(false);
  });
});

describe("token scope (payload v3)", () => {
  const base = {
    adminUserId: "op-1", opSv: 1, targetUserId: "u-1", targetTenantId: "t-1",
    tsv: 1, reason: "scope test", n: "nonce-0123456789abcdef",
  } as const;
  it("a v3 edit token verifies and carries its scope", () => {
    const v = verifyImpersonationToken(signImpersonationToken({ ...base, scope: "edit" }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.scope).toBe("edit");
  });
  it("a junk scope is refused as malformed", () => {
    const raw = signImpersonationToken({ ...base, scope: "edit" });
    const [body] = raw.split(".");
    const tampered = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    tampered.scope = "root";
    // Re-signing is not available to an attacker; this asserts the VALIDATOR
    // shape by signing a junk-scope payload through the real signer's type
    // escape hatch instead.
    const forged = signImpersonationToken({ ...base, scope: "root" as never });
    const v = verifyImpersonationToken(forged);
    expect(v.ok).toBe(false);
  });
  it("a v2-era token (old HMAC domain) is refused", () => {
    // v3 bumped the HMAC domain, so any token signed before the bump fails the
    // signature check outright; simulate with a tampered version field.
    const raw = signImpersonationToken({ ...base, scope: "view" });
    const [body, sig] = raw.split(".");
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    p.v = 2;
    delete p.scope;
    const forgedBody = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
    expect(verifyImpersonationToken(`${forgedBody}.${sig}`).ok).toBe(false);
  });
});
