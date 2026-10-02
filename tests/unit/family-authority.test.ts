/**
 * 2 Oct 2026 — administrator-controlled families.
 *
 * Parent/child relationships are created, corrected and removed by authorised
 * club administrators. A member may still ADD a child through the welcome flow
 * (that path predates this rule and is how a parent self-serves at signup), but
 * the link it makes is SUGGESTED and confers no access until an administrator
 * confirms it. Nothing a member sends may reach a relationship or identity
 * column.
 */
import { describe, it, expect } from "vitest";
import {
  assertMayMutateFamily,
  DEPENDENT_EDITABLE_FIELDS,
  FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET,
  FamilyAuthorityError,
  MAY_MUTATE_FAMILY,
  SUGGESTED_BY_MEMBER,
  pickDependentFields,
} from "@/lib/family-authority";

describe("who may change a relationship", () => {
  it("allows an owner and a manager", () => {
    expect(() => assertMayMutateFamily("owner")).not.toThrow();
    expect(() => assertMayMutateFamily("manager")).not.toThrow();
  });

  it("refuses a coach, an admin, a member and an absent role", () => {
    for (const role of ["coach", "admin", "member", "", undefined]) {
      expect(() => assertMayMutateFamily(role), `role ${String(role)}`).toThrow(FamilyAuthorityError);
    }
  });

  it("names only the two administrative roles", () => {
    expect([...MAY_MUTATE_FAMILY]).toEqual(["owner", "manager"]);
  });
});

describe("a member-made link is suggested, never confirmed", () => {
  it("leaves guardianConfirmedAt null and records who suggested it", () => {
    expect(SUGGESTED_BY_MEMBER).toEqual({
      guardianConfirmedAt: null,
      guardianSuggestedBy: "member",
    });
  });

  it("never carries a confirmation timestamp", () => {
    expect(SUGGESTED_BY_MEMBER.guardianConfirmedAt).toBeNull();
  });
});

describe("what a parent may edit on an assigned child", () => {
  it("never includes a relationship, identity or confirmation column", () => {
    for (const forbidden of [
      "parentMemberId",
      "accountType",
      "guardianConfirmedAt",
      "guardianSuggestedBy",
      "tenantId",
      "id",
      "email",
      "passwordHash",
      "status",
    ]) {
      expect(DEPENDENT_EDITABLE_FIELDS, `must not allow ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("drops every key outside the allow-list, keeping the permitted ones", () => {
    const picked = pickDependentFields({
      name: "Ada",
      medicalConditions: ["asthma"],
      parentMemberId: "some-other-adult",
      accountType: "adult",
      guardianConfirmedAt: new Date().toISOString(),
      tenantId: "another-club",
    });
    expect(picked).toEqual({ name: "Ada", medicalConditions: ["asthma"] });
  });

  it("returns an empty object when a body carries nothing permitted", () => {
    expect(pickDependentFields({ parentMemberId: "x", tenantId: "y" })).toEqual({});
  });

  it("lists every field a member must never set", () => {
    expect([...FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET]).toEqual([
      "parentMemberId",
      "accountType",
      "guardianConfirmedAt",
      "guardianSuggestedBy",
      "tenantId",
    ]);
  });
});
