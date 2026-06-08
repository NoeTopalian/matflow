/**
 * Static guard (Phase 2 of feat/member-tickable-notes).
 *
 * `dangerouslySetInnerHTML` is the canonical React XSS escape hatch. The
 * audit baseline (2026-06-01) had exactly ONE call site in the codebase, and
 * it injects a CSS string built from server-validated branding hex values —
 * nothing user-typed flows in. This test pins that invariant.
 *
 * Why this matters here: free-text "notes" fields (Member.notes, Task.body,
 * RankHistory.notes, GymApplication.notes) are sanitised at the request
 * boundary in lib/schemas/notes-sanitiser.ts, but the sanitiser deliberately
 * does NOT HTML-escape — it expects the renderer to escape. React text nodes
 * escape automatically. `dangerouslySetInnerHTML` does NOT. If any future
 * change starts rendering one of those fields through dangerouslySetInnerHTML,
 * angle-bracket payloads would execute. This tripwire forces a deliberate
 * review of every new call site instead of letting one slip in silently.
 *
 * To add a NEW dangerouslySetInnerHTML call site, update the allow-list
 * below AND add a comment explaining why the content is provably safe.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "lib", "auth.ts", "middleware.ts"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "generated",
  "playwright-report",
  "test-results",
  ".worktrees",
]);
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Each entry is a file path (forward-slash, relative to repo root) where
// dangerouslySetInnerHTML is permitted, paired with a justification that
// must remain present in the file's source.
const ALLOWLIST: Array<{ file: string; justificationSubstring: string }> = [
  {
    file: "app/member/layout.tsx",
    // The CSS string is built from server-validated hex colors + a static
    // template; no user-typed text reaches __html. The validators
    // (isHexColor, isSafeFontFamily) gate the inputs at the top of the
    // component.
    justificationSubstring: "lightModeCSS",
  },
];

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXTS.has(name.slice(dot))) out.push(full);
    }
  }
}

function collectSourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of SCAN_DIRS) {
    const full = join(ROOT, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walk(full, files);
      else if (st.isFile()) files.push(full);
    } catch {
      // Path doesn't exist — fine, ignore.
    }
  }
  return files;
}

function toRelPosix(absPath: string): string {
  return absPath.slice(ROOT.length + 1).replace(/\\/g, "/");
}

describe("dangerouslySetInnerHTML allow-list (Phase 2 XSS tripwire)", () => {
  const matchingFiles: string[] = [];
  for (const file of collectSourceFiles()) {
    const text = readFileSync(file, "utf8");
    // Match actual JSX usage, not comment mentions.
    if (/dangerouslySetInnerHTML\s*=\s*\{/.test(text)) {
      matchingFiles.push(toRelPosix(file));
    }
  }

  it("set of files using dangerouslySetInnerHTML equals the allow-list", () => {
    const found = new Set(matchingFiles.sort());
    const allowed = new Set(ALLOWLIST.map((a) => a.file).sort());
    expect([...found]).toEqual([...allowed]);
  });

  it("each allow-listed file still contains its justification anchor", () => {
    for (const { file, justificationSubstring } of ALLOWLIST) {
      const abs = join(ROOT, file);
      const text = readFileSync(abs, "utf8");
      expect(
        text.includes(justificationSubstring),
        `expected ${file} to contain "${justificationSubstring}" — the marker that ties the dangerouslySetInnerHTML call to its justification`,
      ).toBe(true);
    }
  });

  it("no source file feeds a `notes` or task `body` field into dangerouslySetInnerHTML", () => {
    // Catches the regression we actually fear: someone writes
    //   <div dangerouslySetInnerHTML={{ __html: member.notes }} />
    // or the same for task.body. The regex is permissive about whitespace so
    // a reformat doesn't accidentally pass the gate.
    const RISKY = /dangerouslySetInnerHTML\s*=\s*\{\s*\{[^}]*__html\s*:\s*[^}]*\b(notes|body)\b/;
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      const text = readFileSync(file, "utf8");
      if (RISKY.test(text)) offenders.push(toRelPosix(file));
    }
    expect(offenders).toEqual([]);
  });
});
