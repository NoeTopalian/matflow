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
  CHILD_FIELDS_MEMBERS_MAY_NEVER_SET,
  FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET,
  FamilyAuthorityError,
  MAY_MUTATE_FAMILY,
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

  it("names only the authority columns on a member's own record", () => {
    // accountType is absent on purpose: app/member/home PATCHes
    // { accountType: "parent" } as the supported way to declare you have
    // children, and refusing it broke that flow (lf-1 J52, 2 Oct 2026).
    // tenantId is absent because the route derives it from the session and has
    // always ignored a body value.
    expect([...FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET]).toEqual([
      "parentMemberId",
      "guardianConfirmedAt",
      "guardianSuggestedBy",
    ]);
  });

  it("a child's record additionally protects accountType and tenantId", () => {
    expect([...CHILD_FIELDS_MEMBERS_MAY_NEVER_SET]).toEqual([
      "parentMemberId",
      "guardianConfirmedAt",
      "guardianSuggestedBy",
      "accountType",
      "tenantId",
    ]);
  });
});
