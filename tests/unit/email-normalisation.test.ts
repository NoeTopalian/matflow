// Addresses are stored the way they are searched for.
//
// The product was already half-committed to lowercase and the halves
// disagreed, which is worse than either: `magic-link/request`,
// `auth/forgot-password` and `auth/reset-password` all look up
// `lower(trim(email))`, while staff create, staff update, member create/update
// and the LOGIN lookup itself used the raw string.
//
// So a member added as "Noe@example.com" could sign in with that exact
// spelling and could never recover the account. Both recovery routes answer a
// deliberate 200 with "if that address exists, we've sent a link" — precisely
// so they cannot be used to enumerate addresses — so the member saw a success
// message and no email ever arrived. Nothing failed loudly anywhere, which is
// why this survived.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normaliseEmail, emailField } from "@/lib/email-normalise";
import { memberCreateSchema, memberUpdateSchema } from "@/lib/schemas/member";

describe("normaliseEmail", () => {
  it("lowercases", () => {
    expect(normaliseEmail("Noe@Example.COM")).toBe("noe@example.com");
  });

  it("trims — the other half of this defect, and CSV import is how a roster arrives", () => {
    expect(normaliseEmail("  sam@example.com ")).toBe("sam@example.com");
  });

  it("leaves an already-normal address alone", () => {
    expect(normaliseEmail("sam@example.com")).toBe("sam@example.com");
  });
});

describe("emailField", () => {
  it("validates the shape and then normalises", () => {
    expect(emailField().parse(" Noe@Example.com ")).toBe("noe@example.com");
  });

  it("still refuses something that is not an address", () => {
    expect(emailField().safeParse("not-an-email").success).toBe(false);
  });
});

describe("the write paths normalise", () => {
  it("member create stores a lowercase address", () => {
    const parsed = memberCreateSchema.parse({ name: "Sam", email: "Sam@Example.com" });
    expect(parsed.email).toBe("sam@example.com");
  });

  it("member update stores a lowercase address", () => {
    const parsed = memberUpdateSchema.parse({ email: "  SAM@EXAMPLE.COM " });
    expect(parsed.email).toBe("sam@example.com");
  });
});

describe("no write path may take a raw address", () => {
  it("uses emailField everywhere an address is stored", () => {
    // A scan, not a review. "Remember to normalise" is the instruction that
    // produced the original split in the first place.
    const offenders: string[] = [];
    for (const file of [
      "auth.ts",
      "app/api/staff/route.ts",
      "app/api/staff/[id]/route.ts",
      "lib/schemas/member.ts",
    ]) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/\bz\.string\(\)\.email\(/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
