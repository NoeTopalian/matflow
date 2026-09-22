import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * CSV escaping — RFC-4180 quoting AND the spreadsheet formula-injection guard —
 * lives ONLY in lib/csv.ts (csvCell/csvRow). Any other source file that
 * hand-rolls the quote-doubling escape (`replace(/"/g, '""')`) has almost
 * certainly skipped the formula guard: that was exactly the operator tenants
 * export bug (a gym owner's "=cmd()" ownerName executing in the operator's
 * exported sheet). This pins the single-writer invariant so it cannot regress.
 * Red-on-revert: restore any hand-rolled CSV quoting and this fails.
 */
const ROOT = join(__dirname, "..", "..");
const SKIP = new Set([
  "node_modules", ".next", ".git", "generated", "test-results", "playwright-report", ".worktrees",
]);
const ALLOWED = new Set(["lib/csv.ts"]);
const HANDROLLED = /replace\(\s*\/"\/g\s*,\s*['"]""['"]\s*\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("CSV escaping is single-writer (lib/csv.ts only)", () => {
  it("no source file hand-rolls CSV quote-doubling outside lib/csv.ts", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (ALLOWED.has(rel)) continue;
        if (HANDROLLED.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
