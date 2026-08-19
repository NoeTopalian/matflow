/**
 * UI-RULES §2a / RULES §7 — text on the tenant's accent colour.
 *
 * Owner branding is an INPUT, not a theme we control. A gym can pick white,
 * pale yellow, or near-black as its accent, and whatever we paint on top of
 * that fill has to stay legible in all three cases. `text-white` on a fill the
 * owner chose is therefore not a style preference, it is a bet that the owner
 * chose a dark colour.
 *
 * Two guards here, and they fail for different reasons:
 *
 *  1. `readableOn()` returns the MORE readable of its two candidates and
 *     clears the 4.5:1 AA floor at every accent §2a names. The contrast maths
 *     is reimplemented from the WCAG 2.1 definition rather than imported from
 *     lib/color.ts on purpose — importing the implementation under test would
 *     make the assertion vacuous, and this helper has already shipped one bug
 *     of exactly that shape (it thresholded BT.601 luma, which disagrees with
 *     WCAG across a wide mid-tone band and returned the LESS readable colour
 *     there: white at 3.68:1 on #3b82f6 where dark slate scores 4.85:1).
 *
 *  2. No element in the tree pairs a hardcoded white foreground with a SOLID
 *     tenant-accent fill. That is a static property; nothing at runtime can
 *     catch it, because the seed gym's accent is a mid-blue where white is
 *     merely poor (3.68:1) rather than absent. It only becomes visible on a
 *     tenant nobody tested with — which is to say, on a prospect's screen.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { readableOn } from "@/lib/color";

// ── WCAG 2.1, reimplemented ──────────────────────────────────────────────────

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The accents UI-RULES §2a requires every change to be checked against, plus the seed. */
const ACCENTS = {
  "pure white": "#ffffff",
  "pale yellow": "#ffe14d",
  "near black": "#111111",
  "seed blue": "#3b82f6",
};

describe("readableOn() — foreground for the tenant accent (UI-RULES §2a)", () => {
  for (const [label, accent] of Object.entries(ACCENTS)) {
    it(`clears the 4.5:1 AA floor on ${label} (${accent})`, () => {
      const ratio = contrast(readableOn(accent), accent);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it(`beats hardcoded white on ${label} (${accent})`, () => {
      const chosen = contrast(readableOn(accent), accent);
      const white = contrast("#ffffff", accent);
      expect(chosen).toBeGreaterThanOrEqual(white);
    });
  }

  it("is not simply always-dark — a near-black accent still gets white", () => {
    expect(readableOn("#111111").toLowerCase()).toBe("#ffffff");
  });

  it("falls back to white for an unparseable value rather than throwing", () => {
    expect(readableOn("not a colour").toLowerCase()).toBe("#ffffff");
  });
});

// ── Static guard ─────────────────────────────────────────────────────────────

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "generated", "playwright-report",
  "test-results", ".worktrees",
]);

/**
 * Files allowed to pair a hardcoded white with an accent fill, each with the
 * reason. Adding to this list should require the same argument the entries
 * below make.
 */
const ALLOWLIST: Array<{ file: string; why: string }> = [
  {
    file: "app/preview/page.tsx",
    why:
      "A static design mock. Its 'accent' comes from a hardcoded PRESETS list " +
      "of five dark colours, not from any tenant, so no owner input can make " +
      "the white illegible. (It ships fabricated members and stats and is a " +
      "candidate for deletion under UI-RULES §7 — but that is not this guard's " +
      "business.)",
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

/** Every JSX opening tag in `src`, brace/paren/string aware. */
function openingTags(src: string): Array<{ text: string; line: number }> {
  const tags: Array<{ text: string; line: number }> = [];
  const re = /<[A-Za-z][\w.]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
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
      else if (c === ">" && brace === 0 && paren === 0) break;
      i++;
    }
    const text = src.slice(m.index, i + 1);
    if (text.length <= 4000) {
      tags.push({ text, line: src.slice(0, m.index).split("\n").length });
    }
  }
  return tags;
}

const WHITE_FG = /text-white\b|text-\[#fff(?:fff)?\]|color:\s*["'](?:#fff(?:fff)?|white)["']/i;
/**
 * A SOLID accent fill — the bare tenant value or the CSS variable it feeds.
 * Deliberately excludes derivatives like `hex(primaryColor, 0.12)` and
 * `tint(primaryColor, 30)`: a 12% tint of the accent over a dark shell is
 * still a dark surface, and white on it is correct.
 */
const SOLID_ACCENT =
  /(?:background|backgroundColor)\s*:\s*(?:\{?\s*)?(?:[A-Za-z_$][\w.]*\s*\?\s*)?\b(?:primaryColor|tenant\.primaryColor|accentColor|primary)\b(?!\s*\()|(?:background|backgroundColor)\s*:\s*["']var\(--color-primary\)["']/;

describe("no hardcoded white sits on a solid tenant-accent fill (UI-RULES §2a)", () => {
  const files = [join(ROOT, "app"), join(ROOT, "components")].flatMap((d) => walk(d));
  const allowed = new Set(ALLOWLIST.map((a) => a.file));

  it("scans a non-trivial number of files (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no offending element outside the allow-list", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (allowed.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const tag of openingTags(src)) {
        if (WHITE_FG.test(tag.text) && SOLID_ACCENT.test(tag.text)) {
          offenders.push(`${rel}:${tag.line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still detects the pattern where it is knowingly allowed", () => {
    // Proves the detector works rather than the tree merely being empty of
    // anything it can see — the failure mode a static guard dies of quietly.
    for (const { file } of ALLOWLIST) {
      const src = readFileSync(join(ROOT, file), "utf8");
      const hits = openingTags(src).filter(
        (t) => WHITE_FG.test(t.text) && SOLID_ACCENT.test(t.text),
      );
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it("every allow-list entry names a file that exists and carries a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(statSync(join(ROOT, entry.file)).isFile()).toBe(true);
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });
});
