// Product findings from triaging the red e2e cells on the candidate, 30 Sep 2026:
// P1 a 20 MB import upload answered 500 (the platform truncates the body at
//    10 MB, so formData() threw before the route's own size check);
// P3 the Stripe webhook queued payment_failed to a child's synthesised address;
// P4 import error rows were numbered by index after blank lines were dropped,
//    so every error after a blank line cited the wrong line.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseImport, parseCSV, csvRowLine } from "@/lib/importers";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("P4 — import errors cite the file's real line", () => {
  it("counts blank lines and multi-line quoted cells", () => {
    const csv = ["name,email", "Ada,ada@example.test", "", "Ben,", '"Cara\nSmith",not-an-email', "Dan,dan@example.test"].join("\n");
    const { errors } = parseImport("generic", csv);
    // Ben is on line 4 (line 3 is blank); Cara's row starts on line 5.
    expect(errors).toEqual([
      { row: 4, reason: "Missing email" },
      { row: 5, reason: "Invalid email: not-an-email" },
    ]);
  });
  it("falls back to the index when a row carries no line", () => {
    expect(csvRowLine(["x"], 2)).toBe(3);
    const rows = parseCSV("a\n\nb");
    expect(rows.map((r, i) => csvRowLine(r, i))).toEqual([1, 3]);
  });
});

describe("P1 — an oversized upload is a 413/400, never a 500", () => {
  it("checks the declared length before parsing, and maps an unreadable body to 400", () => {
    const s = src("app/api/admin/import/upload/route.ts");
    const lenCheck = s.indexOf('req.headers.get("content-length")');
    const parse = s.indexOf("await req.formData()");
    expect(lenCheck).toBeGreaterThan(-1);
    expect(lenCheck).toBeLessThan(parse);
    expect(s).toMatch(/status: 413/);
    expect(s).toMatch(/Couldn't read the upload/);
  });
});

describe("P3 — no failed-payment email to a child's placeholder", () => {
  it("routes a child's payment_failed to the paying parent, never the synthesised address", () => {
    const s = src("app/api/stripe/webhook/route.ts");
    expect(s).toMatch(/isSynthesisedEmail\(memberFull\.email\)/);
    expect(s).toMatch(/memberFull\?\.parent\?\.email/);
    expect(s).toMatch(/to: failedTo,/);
  });
});
