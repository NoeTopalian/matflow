// Security lane B (9 Oct 2026) — SEC-026 normalisation mismatch.
//
// Every login address is written through `emailField` (trim + toLowerCase in
// JavaScript) and compared by the claim lock in Postgres with
// lower(btrim("email")). The two lower-casings agree only for ASCII: JavaScript
// and Postgres fold some non-ASCII letters differently (dotted İ, the Kelvin
// sign, ß). This pins that the schema refuses every non-ASCII address before
// either folding runs, so the two forms cannot disagree, and that the claim
// query still compares on the folded stored value.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { emailField, normaliseEmail } from "@/lib/email-normalise";

const f = emailField(254);

describe("SEC-026 email normalisation", () => {
  it("ASCII: case and surrounding whitespace fold to one canonical form", () => {
    expect(f.parse("  Owner.Name+Club@Example.TEST ")).toBe("owner.name+club@example.test");
    expect(normaliseEmail(" A@B.TEST")).toBe("a@b.test");
    // plus tags and dots are NOT stripped (different mailboxes at many providers)
    expect(f.parse("a.b+c@x.test")).not.toBe(f.parse("ab@x.test"));
  });

  it("non-ASCII addresses are refused before any case folding (no JS/Postgres disagreement possible)", () => {
    for (const e of [
      "İnfo@example.test", // dotted capital I: JS → "i̇nfo", Postgres lower() depends on collation
      "KKelvin@example.test", // Kelvin sign
      "straße@example.test",
      "á@example.test", // combining accent
      "ＡＢＣ@example.test", // full-width
      "user@exämple.test",
      "user@xn--exmple-cua.test​", // zero-width space
    ]) {
      expect(f.safeParse(e).success, JSON.stringify(e)).toBe(false);
    }
  });

  it("the claim lock compares on lower(btrim(stored)) — legacy mixed-case rows still collide", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "lib", "login-email.ts"), "utf8");
    expect(src).toMatch(/lower\(btrim\("email"\)\) = ANY\(\$\{emails\}::text\[\]\)/);
    expect(src.match(/lower\(btrim\("email"\)\) = ANY/g)?.length).toBe(2); // User and Member
  });
});
