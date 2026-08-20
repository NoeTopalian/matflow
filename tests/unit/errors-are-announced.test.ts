/**
 * UI-RULES §8 / RULES §7 — validation and action errors are announced.
 *
 * An error that only renders is an error a screen-reader user never learns
 * about. React swaps the message into the DOM with no focus change and no
 * announcement, so the form simply appears not to submit.
 *
 * Two acceptable shapes, and the difference matters:
 *
 *  - FIELD-level: the message carries an `id`, and its control points at it
 *    with `aria-describedby` plus `aria-invalid`. The error is then read as
 *    part of the field, wherever the user reaches it from. This is the pattern
 *    `app/member/profile/page.tsx` already uses on its personal-details form.
 *  - FORM/ACTION-level: the message is a live region (`role="alert"` or
 *    `aria-live`). Nothing owns it, so it announces on appearance instead.
 *
 * This guard asserts that every conditionally-rendered error message is one or
 * the other. It deliberately does NOT assert which — "Couldn't save, try
 * again" belongs to the submit, not to a field, and forcing it onto one would
 * be worse.
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
      "surface. Nothing in it submits anything, so nothing in it can fail.",
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

/** `{somethingError && <p …>` / `{errors.x && (<span …>` */
const CONDITIONAL_ERROR =
  /\{\s*([\w.$[\]"']*(?:[eE]rror|Err)[\w.$[\]"']*)\s*(?:&&|\?)\s*\(?\s*<(p|span|div|li)(?=[\s>])/g;

export function unannouncedErrors(src: string): number[] {
  const lines: number[] = [];
  const re = new RegExp(CONDITIONAL_ERROR.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tagStart = src.indexOf("<" + m[2], m.index);
    const tag = src.slice(tagStart, tagEnd(src, tagStart));
    // Live region: announces on appearance.
    if (/\brole\s*=\s*["']alert["']/.test(tag) || /aria-live\s*=/.test(tag)) continue;
    // Or a describedby target: read as part of its field.
    const id = /\bid=\{?[`"']?([^`"'}\s]+)/.exec(tag)?.[1];
    if (id) {
      const escaped = id.replace(/[$^\\.*+?()[\]{}|]/g, "\\$&");
      if (new RegExp(`aria-describedby[^\\n]*${escaped}`).test(src)) continue;
    }
    lines.push(src.slice(0, tagStart).split("\n").length);
  }
  return lines;
}

describe("validation and action errors are announced (UI-RULES §8, RULES §7)", () => {
  const files = [join(ROOT, "app"), join(ROOT, "components")].flatMap((d) => walk(d));
  const allowed = new Set(ALLOWLIST.map((a) => a.file));

  it("scans a non-trivial number of files (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no unannounced error message outside the allow-list", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (allowed.has(rel)) continue;
      for (const line of unannouncedErrors(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("accepts the field-level shape (id + aria-describedby + aria-invalid)", () => {
    const src = `
      <input aria-invalid={!!errors.email} aria-describedby={errors.email ? "f-err-email" : undefined} />
      {errors.email && <p id="f-err-email">{errors.email.message}</p>}
    `;
    expect(unannouncedErrors(src)).toEqual([]);
  });

  it("accepts the form-level shape (role=\"alert\")", () => {
    expect(unannouncedErrors(`{error && <p role="alert">{error}</p>}`)).toEqual([]);
  });

  it("rejects a bare error message with neither", () => {
    // The exact shape this sweep found 53 times.
    expect(unannouncedErrors(`{error && <p className="text-xs">{error}</p>}`)).toHaveLength(1);
  });

  it("rejects an id that nothing points at", () => {
    // An `id` alone is not an announcement — something has to reference it.
    expect(
      unannouncedErrors(`{error && <p id="orphan-err">{error}</p>}`),
    ).toHaveLength(1);
  });

  it("every allow-list entry names a file that exists and carries a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(statSync(join(ROOT, entry.file)).isFile()).toBe(true);
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });
});
