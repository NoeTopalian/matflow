// A sticky or fixed bar must not be see-through, or content scrolls visibly
// through it instead of behind it.
//
// Found on a phone photo of the Settings → Branding tab: the dark theme-preset
// cards were sliding up THROUGH the tab pills. The rail was
//
//     sticky top-0 z-20
//     background: linear-gradient(to bottom,
//                   var(--sf-bg) 0%, var(--sf-bg) 70%, transparent 100%)
//     backdrop-filter: blur(12px)
//
// so the bottom 30% of a sticky bar had no background at all. A backdrop filter
// does not rescue that: blur smears what is behind, it does not hide it, which
// is exactly why it reads as "phasing through" rather than as a soft edge.
//
// Every other sticky/fixed bar in the product was checked by hand at the same
// time and is fine — the member top bar is fully opaque and carries a comment
// explaining why, the two bottom tab bars are 92% opaque with a 20px backdrop
// blur (deliberate glass, and legible), the landing nav is transparent only
// while nothing has scrolled under it yet, and the member-detail rail uses a
// solid `bg-[var(--sf-bg)]`. This test exists so the NEXT one is caught by the
// suite rather than by a photograph.
//
// It is a source scan rather than a rendered check on purpose: the defect is
// "somebody wrote a fading background on a sticky element", which is visible in
// the source of any file, including ones no e2e spec happens to visit.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["components", "app"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(p, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Background declarations that fade to nothing.
 *
 * Matches a `background`/`backgroundImage` whose value contains a `transparent`
 * or `…, 0)` colour stop — the shapes that leave part of the element see-through.
 */
const FADING_BACKGROUND =
  /background(?:Image)?\s*:\s*["'`][^"'`]*(?:linear-|radial-)gradient\([^"'`]*(?:transparent|,\s*0\s*\))[^"'`]*["'`]/g;

/** `sticky`/`fixed` as a Tailwind position class, not the word in prose. */
const STICKY_CLASS = /\b(sticky|fixed)\b[^"'`]*\b(top|bottom|inset)-/;

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

/** Drop `//` and block comments, so prose about the bug is not mistaken for it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Find fading backgrounds that belong to a sticky/fixed element.
 *
 * Scans back to the opening of the JSX tag the background sits in, rather than a
 * fixed number of lines. A line window looked reasonable and was not: adding a
 * comment between `className` and `style` pushed the position classes out of it,
 * so the guard silently stopped guarding. Caught by mutation — restoring the
 * original gradient failed the named test and NOT this one, which is precisely
 * the shape of a test that reports a clean bill of health it never earned.
 *
 * The element region is comment-stripped, so prose ABOUT a transparent
 * background is never mistaken for one.
 */
function findFadingStickyBackgrounds(): Finding[] {
  const findings: Finding[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      FADING_BACKGROUND.lastIndex = 0;
      while ((m = FADING_BACKGROUND.exec(src))) {
        const before = src.slice(0, m.index);
        // The opening of the tag this style belongs to.
        const tagStart = before.search(/<[a-zA-Z][^<]*$/);
        const element = stripComments(
          tagStart === -1 ? before.slice(-800) : before.slice(tagStart),
        );
        if (STICKY_CLASS.test(element)) {
          findings.push({
            file: relative(process.cwd(), file).replace(/\\/g, "/"),
            line: before.split("\n").length,
            snippet: m[0].slice(0, 120),
          });
        }
      }
    }
  }
  return findings;
}

describe("sticky and fixed bars are opaque", () => {
  it("no sticky or fixed element has a background that fades to transparent", () => {
    const findings = findFadingStickyBackgrounds();
    const report = findings.map((f) => `${f.file}:${f.line} — ${f.snippet}`);
    expect(
      report,
      "a sticky/fixed bar with a fading background lets scrolled content show THROUGH it. Use a solid background (the member-detail rail and the member top bar both do) and put any fade in a separate strip below the bar.",
    ).toEqual([]);
  });

  it("the Settings tab rail specifically is solid", () => {
    // Named because this is the one that was found in the wild, on the exact
    // screen a prospective customer is most likely to be shown.
    const src = readFileSync("components/dashboard/SettingsPage.tsx", "utf8");
    const railIndex = src.indexOf("staff-settings-rail");
    expect(railIndex, "the settings rail element has moved or been renamed").toBeGreaterThan(-1);

    // Strip comments first. The element carries a long explanation of this very
    // bug, and the word "transparent" appears in it — so a naive text search
    // would fail on the prose describing the fix rather than on the code.
    const rail = stripComments(src.slice(railIndex, railIndex + 3000));

    expect(rail, "the settings rail no longer sets a solid background").toMatch(
      /background:\s*["'`]var\(--sf-bg\)["'`]/,
    );
    expect(
      /transparent/.test(rail.split(">")[0] ?? ""),
      "the settings rail background is see-through again",
    ).toBe(false);
  });

  it("detects the original defect, so the scan is not vacuous", () => {
    // Without this, a regex that matched nothing would pass the first case
    // forever and report a clean bill of health it never earned.
    const original =
      'className="staff-settings-rail sticky top-0 z-20"\n' +
      '        style={{\n' +
      '          background: "linear-gradient(to bottom, var(--sf-bg) 0%, var(--sf-bg) 70%, transparent 100%)",\n' +
      "        }}";
    FADING_BACKGROUND.lastIndex = 0;
    expect(FADING_BACKGROUND.test(original)).toBe(true);
    expect(STICKY_CLASS.test(original)).toBe(true);
  });
});

describe("the scrollport must not carry top padding", () => {
  // The SECOND cause of the same bug, and until now it had no unit-level guard
  // at all — a supervisor audit moved the padding back onto <main> and the
  // entire unit suite stayed green at 1370 passed. The only thing that caught
  // it was an e2e hit-test in tests/e2e/campaign/demo-sweep.spec.ts, and NO
  // AUTOMATED GATE RUNS THAT: ci.yml has no Playwright step, and e2e.yml is
  // nightly-cron-only and has never had a green run. So in practice the fix was
  // unguarded.
  //
  // Why it matters: <main> is the scrollport. A scrollport's padding is part of
  // the scrolling area — content scrolls THROUGH it — and a `sticky top-0` child
  // cannot rise into it, because it cannot escape its containing block. With
  // padding on <main> the settings tab rail pinned at 161px while <main>'s box
  // top was 129px, leaving a 32px band of bare page above the tabs. That is the
  // defect Noe photographed.
  //
  // Source assertion rather than a rendered one on purpose: this has to run in
  // the gate that actually runs, and the property is structural.
  const LAYOUT = "app/dashboard/layout.tsx";

  /** The <main> opening tag. */
  function mainTag(): string {
    const src = stripComments(readFileSync(LAYOUT, "utf8"));
    const m = /<main[^>]*>/.exec(src);
    if (!m) throw new Error("no <main> element in " + LAYOUT);
    return m[0];
  }

  /** The wrapper immediately inside <main>. */
  function wrapperTag(): string {
    const src = stripComments(readFileSync(LAYOUT, "utf8"));
    const after = src.slice(src.indexOf("<main"));
    const m = /<div[^>]*max-w-6xl[^>]*>/.exec(after);
    if (!m) throw new Error("no max-w-6xl wrapper inside <main>");
    return m[0];
  }

  /**
   * Tailwind classes on a tag, as tokens.
   *
   * Token comparison rather than a regex, deliberately: the first version of
   * these three cases used regexes whose backslashes were lost in transit, so
   * they read /px-d/ and looked for a literal "px-d" that cannot exist. Two
   * failed against correct source and the third would have passed for ever
   * against anything. Splitting on whitespace has nothing to escape.
   */
  function classes(tag: string): string[] {
    const key = "className=" + String.fromCharCode(34);
    const i = tag.indexOf(key);
    if (i === -1) return [];
    const rest = tag.slice(i + key.length);
    const j = rest.indexOf(String.fromCharCode(34));
    if (j === -1) return [];
    return rest.slice(0, j).split(" ").map((s) => s.trim()).filter(Boolean);
  }

  /** Classes setting one of these padding properties, at any breakpoint. */
  function setsPadding(tag: string, prefixes: string[]): string[] {
    return classes(tag).filter((c) => {
      const bare = c.includes(":") ? c.slice(c.lastIndexOf(":") + 1) : c;
      return prefixes.some((p) => {
        if (!bare.startsWith(p)) return false;
        const next = bare.charAt(p.length);
        return next >= "0" && next <= "9";
      });
    });
  }

  it("<main> has no top padding, at any breakpoint", () => {
    expect(
      setsPadding(mainTag(), ["pt-", "py-"]),
      "<main> is the scrollport; top padding on it is scrolled THROUGH, and a sticky child cannot cover it. Put the spacing on the wrapper inside.",
    ).toEqual([]);
  });

  it("the wrapper inside it does", () => {
    // The converse, so "remove the padding" cannot pass by deleting the page
    // spacing from the product entirely.
    expect(
      setsPadding(wrapperTag(), ["pt-", "py-"]).length,
      "the page spacing vanished rather than moving inside the scrollport",
    ).toBeGreaterThan(0);
  });

  it("<main> keeps its horizontal and bottom padding", () => {
    // Only the TOP edge is load-bearing for sticky. Stripping the rest would be
    // a silent layout regression this test must not bless.
    const tag = mainTag();
    expect(setsPadding(tag, ["px-"]).length, "horizontal page padding was lost").toBeGreaterThan(0);
    expect(setsPadding(tag, ["pb-"]).length, "bottom padding (mobile nav clearance) was lost").toBeGreaterThan(0);
  });
});
