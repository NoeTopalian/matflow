import { describe, it, expect } from "vitest";
import { ELEVATED_ROLES, isElevatedRole, requiresTotpEnrolment } from "@/lib/mfa-policy";

/**
 * Mandatory-authenticator policy (1 Oct 2026). Red on revert: narrow
 * ELEVATED_ROLES back to ["owner"] and the manager/admin cases fail.
 */
describe("lib/mfa-policy — who must enrol an authenticator", () => {
  it("owner, manager and admin are elevated; coach and member are not", () => {
    expect([...ELEVATED_ROLES].sort()).toEqual(["admin", "manager", "owner"]);
    expect(isElevatedRole("owner")).toBe(true);
    expect(isElevatedRole("manager")).toBe(true);
    expect(isElevatedRole("admin")).toBe(true);
    expect(isElevatedRole("coach")).toBe(false);
    expect(isElevatedRole("member")).toBe(false);
    expect(isElevatedRole(undefined)).toBe(false);
  });

  it.each(["owner", "manager", "admin"])("%s without TOTP must enrol", (role) => {
    expect(requiresTotpEnrolment({ role, totpEnabled: false, testingMode: false })).toBe(true);
    expect(requiresTotpEnrolment({ role, totpEnabled: null, testingMode: false })).toBe(true);
  });

  it.each(["owner", "manager", "admin"])("%s with TOTP enrolled is not held", (role) => {
    expect(requiresTotpEnrolment({ role, totpEnabled: true, testingMode: false })).toBe(false);
  });

  it("a coach is never held at enrolment (optional 2FA)", () => {
    expect(requiresTotpEnrolment({ role: "coach", totpEnabled: false, testingMode: false })).toBe(false);
  });

  it("TESTING_MODE suppresses the requirement for every role", () => {
    expect(requiresTotpEnrolment({ role: "owner", totpEnabled: false, testingMode: true })).toBe(false);
    expect(requiresTotpEnrolment({ role: "manager", totpEnabled: false, testingMode: true })).toBe(false);
  });
});
