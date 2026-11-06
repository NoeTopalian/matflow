import { describe, it, expect } from "vitest";
import { isSameIndividual } from "@/lib/member-same-individual";

// PR 3 (Noe, 6 Nov 2026): staff adding the same individual as an archived member restores them. Same individual =
// same email AND same full name (case-insensitive, trimmed, inner spaces collapsed), and no conflicting dates of birth.
describe("isSameIndividual", () => {
  const archived = { email: "jane@example.test", name: "Jane Smith", dateOfBirth: new Date("1990-04-15T00:00:00Z") };

  it("same email and name, case and spacing aside, is the same individual", () => {
    expect(isSameIndividual({ email: " JANE@example.test ", name: "  jane   SMITH " }, archived)).toBe(true);
  });
  it("a different name at the same address is not (families share addresses)", () => {
    expect(isSameIndividual({ email: "jane@example.test", name: "John Smith" }, archived)).toBe(false);
  });
  it("a different address is not", () => {
    expect(isSameIndividual({ email: "jane2@example.test", name: "Jane Smith" }, archived)).toBe(false);
  });
  it("conflicting dates of birth are not; one missing date is no conflict", () => {
    expect(isSameIndividual({ email: "jane@example.test", name: "Jane Smith", dateOfBirth: "1991-04-15" }, archived)).toBe(false);
    expect(isSameIndividual({ email: "jane@example.test", name: "Jane Smith", dateOfBirth: "1990-04-15" }, archived)).toBe(true);
    expect(isSameIndividual({ email: "jane@example.test", name: "Jane Smith", dateOfBirth: null }, archived)).toBe(true);
    expect(isSameIndividual({ email: "jane@example.test", name: "Jane Smith", dateOfBirth: "1991-01-01" }, { ...archived, dateOfBirth: null })).toBe(true);
  });
  it("an empty name or address never matches", () => {
    expect(isSameIndividual({ email: "", name: "Jane Smith" }, { ...archived, email: "" })).toBe(false);
    expect(isSameIndividual({ email: "jane@example.test", name: " " }, { ...archived, name: " " })).toBe(false);
  });
});
