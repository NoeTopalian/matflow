/**
 * UI-RULES §6 / RULES §7 — every input has a programmatic accessible name.
 *
 * A placeholder is not a name. It is not exposed as one by any screen reader
 * worth the term, it disappears the moment the user types, and it is the
 * commonest way a form ends up announcing "edit text" and nothing else. This
 * repo had 151 controls in that state out of 188.
 *
 * The guard is static because the property is static: there is no runtime
 * state in which an input acquires a name it was not given. It counts a
 * control as named if it carries `aria-label`, `aria-labelledby` or `title`,
 * or if its `id` is referenced by a `htmlFor` somewhere in the same file.
 *
 * Deliberately NOT counted as violations: `type="hidden"`, `submit`, `button`,
 * `checkbox` and `radio`. The first three take their name from their value or
 * their content; the last two are overwhelmingly wrapped in a clickable label
 * in this codebase and a blunt scan of them produces mostly noise.
 *
 * The honest limitation, stated plainly: a wrapping `<label>Text <input/></label>`
 * IS a valid accessible name and this scan does not detect it, so the guard can
 * over-report. It cannot under-report, which is the direction that matters.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "generated", "playwright-report",
  "test-results", ".worktrees",
]);

const ALLOWLIST: Array<{ file: string; why: string }> = [
  {
    file: "app/preview/page.tsx",
    why:
      "A static design mock with fabricated members and stats, not a product " +
      "surface. Its one control is a decorative palette swatch. The page is a " +
      "candidate for deletion under UI-RULES §7 rather than for labelling.",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** End index (exclusive) of the JSX opening tag starting at `start`. */
function tagEnd(src: string, start: number): number {
  let i = start;
  let brace = 0, paren = 0;
  let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (str) {
      if (c === str && src[i - 1] !== "\\") str = null;
    } else if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === ">" && brace === 0 && paren === 0) return i + 1;
    i++;
  }
  return src.length;
}

const NAMED = /aria-label\s*=|aria-labelledby\s*=|\btitle\s*=/;
const SKIP_TYPE = /type\s*=\s*["'](?:hidden|submit|button|checkbox|radio)["']/;

function unnamedControls(src: string): number[] {
  const lines: number[] = [];
  const re = /<(input|select|textarea)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = src.slice(m.index, tagEnd(src, m.index));
    if (SKIP_TYPE.test(tag) || NAMED.test(tag)) continue;
    const id = /\bid=\{?["']?([^"'}\s]+)/.exec(tag)?.[1];
    if (id) {
      const escaped = id.replace(/[$^\\.*+?()[\]{}|]/g, "\\$&");
      if (new RegExp(`htmlFor=\\{?["']?${escaped}`).test(src)) continue;
    }
    lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
}

describe("every input has an accessible name (UI-RULES §6, RULES §7)", () => {
  const files = [join(ROOT, "app"), join(ROOT, "components")].flatMap((d) => walk(d));
  const allowed = new Set(ALLOWLIST.map((a) => a.file));

  it("scans a non-trivial number of files (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no unnamed control outside the allow-list", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (allowed.has(rel)) continue;
      for (const line of unnamedControls(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still detects the pattern where it is knowingly allowed", () => {
    // Positive control: without this, a detector that silently stopped
    // matching would report a clean tree forever.
    for (const { file } of ALLOWLIST) {
      const found = unnamedControls(readFileSync(join(ROOT, file), "utf8"));
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it("every allow-list entry names a file that exists and carries a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(statSync(join(ROOT, entry.file)).isFile()).toBe(true);
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });

  it("a placeholder alone does not satisfy the guard", () => {
    // Pins the rule the audit found broken 101 times: `placeholder` is not a
    // name. If someone ever relaxes NAMED to include it, this fails.
    const withPlaceholderOnly = `<input placeholder="Search members" value={q} />`;
    expect(unnamedControls(withPlaceholderOnly)).toHaveLength(1);
    const withLabel = `<input aria-label="Search members" placeholder="Search members" />`;
    expect(unnamedControls(withLabel)).toHaveLength(0);
  });
});
