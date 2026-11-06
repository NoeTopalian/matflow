import { describe, it, expect } from "vitest";
import { classifyIdentity, isSameIndividual } from "@/lib/member-same-individual";

// PR 3 (Noe, 6 Nov 2026): staff adding the same individual as an archived member restores them. Same individual =
// same email AND same full name (case-insensitive, trimmed, inner spaces collapsed), and no conflicting dates of birth.
describe("isSameIndividual", () => {
  const archived = { email: "jane@example.test", name: "Jane Smith", dateOfBirth: new Date("1990-04-15T00:00:00Z") };

  it("same email, name AND date of birth, case and spacing aside, is certain", () => {
    expect(isSameIndividual({ email: " JANE@example.test ", name: "  jane   SMITH ", dateOfBirth: "1990-04-15" }, archived)).toBe(true);
    expect(classifyIdentity({ email: " JANE@example.test ", name: "  jane   SMITH ", dateOfBirth: "1990-04-15" }, archived)).toBe("same");
  });
  it("same email and name with a date of birth missing on either side is only possible: staff are asked (review L1)", () => {
    expect(classifyIdentity({ email: "jane@example.test", name: "Jane Smith" }, archived)).toBe("possible");
    expect(classifyIdentity({ email: "jane@example.test", name: "Jane Smith", dateOfBirth: "1990-04-15" }, { ...archived, dateOfBirth: null })).toBe("possible");
    expect(isSameIndividual({ email: "jane@example.test", name: "Jane Smith" }, archived)).toBe(false);
  });
  it("a different name at the same address is a different person (families share addresses)", () => {
    expect(classifyIdentity({ email: "jane@example.test", name: "John Smith", dateOfBirth: "1990-04-15" }, archived)).toBe("different");
  });
  it("a different address is not", () => {
    expect(isSameIndividual({ email: "jane2@example.test", name: "Jane Smith" }, archived)).toBe(false);
  });
  it("conflicting dates of birth are a different person", () => {
    expect(classifyIdentity({ email: "jane@example.test", name: "Jane Smith", dateOfBirth: "1991-04-15" }, archived)).toBe("different");
  });
  it("an empty name or address never matches", () => {
    expect(isSameIndividual({ email: "", name: "Jane Smith" }, { ...archived, email: "" })).toBe(false);
    expect(isSameIndividual({ email: "jane@example.test", name: " " }, { ...archived, name: " " })).toBe(false);
  });
});
