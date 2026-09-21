import { describe, it, expect } from "vitest";
import { csvCell, csvRow } from "@/lib/csv";

describe("csvCell — formula-injection guard", () => {
  // Red-on-revert: remove the `/^[=+\-@\t\r]/` prefix in lib/csv.ts and every
  // case in this block fails. A spreadsheet executes each of these on open.
  it("neutralises a leading = with an apostrophe", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
  });
  it("neutralises a leading @ (Lotus/Excel formula)", () => {
    expect(csvCell("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
  });
  it("neutralises a leading + and -", () => {
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1+1")).toBe("'-1+1");
  });
  it("neutralises a leading tab (prefix only — tab is not an RFC-4180 quote trigger)", () => {
    expect(csvCell("\t=danger")).toBe("'\t=danger");
  });
  it("neutralises a leading CR and quotes it (CR IS a quote trigger)", () => {
    expect(csvCell("\r=danger")).toBe('"\'\r=danger"');
  });
  it("neutralises the classic DDE payload even when it also needs quoting", () => {
    // Contains a comma → must be quoted AND apostrophe-prefixed.
    expect(csvCell("=cmd|'/c calc'!A1,x")).toBe("\"'=cmd|'/c calc'!A1,x\"");
  });
});

describe("csvCell — RFC-4180 quoting", () => {
  it("quotes and doubles quotes inside a value", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });
  it("quotes commas and newlines", () => {
    expect(csvCell("Smith, John")).toBe('"Smith, John"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("leaves a plain string untouched", () => {
    expect(csvCell("totalbjj@example.test")).toBe("totalbjj@example.test");
  });
});

describe("csvCell — numbers and nullish", () => {
  it("renders numbers as-is, never apostrophe-prefixed (negatives stay numeric)", () => {
    expect(csvCell(-50)).toBe("-50");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(1234)).toBe("1234");
  });
  it("renders null and undefined as an empty cell", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("csvRow", () => {
  it("joins escaped cells with commas", () => {
    expect(csvRow(["a", "=b", 3, null, "c,d"])).toBe("a,'=b,3,,\"c,d\"");
  });
});
