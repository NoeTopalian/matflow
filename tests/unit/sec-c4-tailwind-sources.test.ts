/**
 * SF-110 / review R6-N4 (security campaign iteration 2, lane C4, 10 Oct 2026).
 *
 * Tailwind v4 scans files for class candidates and, by default, that means EVERY non-gitignored file in the
 * project. A committed evidence log held a Windows path whose segment after a backslash began with hex digits;
 * Tailwind read it as a CSS escape (code point 0x1CC670, above U+10FFFF) and the production build died with
 * "RangeError: Invalid code point". The first fix excluded docs/ only; R6 planted the same file in tests/,
 * scripts/readiness/, the repo root and components/ and the build broke each time.
 *
 * app/globals.css now imports Tailwind with `source(none)` and lists the application source explicitly. This test
 * rebuilds the scanner configuration EXACTLY as @tailwindcss/postcss does (compile → root/sources → oxide Scanner;
 * see node_modules/@tailwindcss/postcss/dist/index.js, "Setup scanner") — without running a build — and plants a
 * synthetic evidence-style file in tests/ and scripts/ to prove the scanner never reads them.
 *
 * The detector is itself checked: the SAME plant is visible to the pre-fix configuration (auto-detection with only
 * docs/ excluded), so a regression to the old shape turns this file red.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const ROOT = process.cwd();
const CSS_PATH = path.join(ROOT, "app", "globals.css");
const BS = String.fromCharCode(92);
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// The shape that broke the build: <backslash><hex digits>… inside a Windows scratchpad path. Written as a TS
// comment so a .ts plant is still valid TypeScript for the instant it exists.
const PLANT = `// ${["C:", "Users", "secc4", "AppData", "Local", "Temp", "claude", "1cc670be-8e50-4bc6-9b9d-aa84aee7df8f", "scratchpad", "x.log"].join(BS)}\n`;
const PLANTS = [
  path.join(ROOT, "tests", `zz-secc4-plant-${STAMP}.txt`),
  path.join(ROOT, "tests", `zz-secc4-plant-${STAMP}.ts`),
  path.join(ROOT, "scripts", `zz-secc4-plant-${STAMP}.txt`),
  path.join(ROOT, "scripts", "readiness", `zz-secc4-plant-${STAMP}.mjs`),
];

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

async function scannerFor(css: string) {
  const compiler = await compile(css, { base: path.dirname(CSS_PATH), from: CSS_PATH, onDependency: () => {} });
  // Mirrors @tailwindcss/postcss: root "none" → no automatic source; root null → the whole base; else the root.
  const sources = (
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base: ROOT, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }]
  ).concat(compiler.sources);
  const scanner = new Scanner({ sources });
  const candidates = scanner.scan();
  return { compiler, scanner, candidates, files: scanner.files.map(rel) };
}

beforeAll(() => {
  for (const p of PLANTS) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, PLANT);
  }
});

afterAll(() => {
  for (const p of PLANTS) fs.rmSync(p, { force: true });
  expect(PLANTS.filter((p) => fs.existsSync(p))).toEqual([]);
});

describe("SF-110: Tailwind scans an explicit allow-list (app, components, lib) — never tests/, scripts/, docs/", () => {
  it("globals.css turns automatic detection off and lists only application source", () => {
    const css = fs.readFileSync(CSS_PATH, "utf8");
    expect(css).toMatch(/@import\s+"tailwindcss"\s+source\(none\)\s*;/);
    const sources = [...css.matchAll(/^@source\s+(not\s+)?"([^"]+)"\s*;/gm)].map((m) => `${m[1] ? "not " : ""}${m[2]}`);
    expect(sources).toEqual(["../app/**/*.{ts,tsx}", "../components/**/*.{ts,tsx}", "../lib/**/*.{ts,tsx}"]);
  });

  it("the scanner the build constructs reads application files (positive control) and nothing outside app/, components/, lib/", async () => {
    const { compiler, files } = await scannerFor(fs.readFileSync(CSS_PATH, "utf8"));
    expect(compiler.root).toBe("none");
    expect(files).toContain("app/layout.tsx");
    expect(files.some((f) => f.startsWith("components/"))).toBe(true);
    expect(files.some((f) => f.startsWith("lib/"))).toBe(true);
    const outside = files.filter((f) => !/^(app|components|lib)\//.test(f) || !/\.(ts|tsx)$/.test(f));
    expect(outside).toEqual([]);
    for (const p of PLANTS) expect(files).not.toContain(rel(p));
    expect(files.filter((f) => /^(tests|scripts|docs|\.omc)\//.test(f))).toEqual([]);
  });

  it("with evidence planted in tests/ and scripts/, no candidate carries the backslash-hex escape and the CSS still builds", async () => {
    const { compiler, candidates } = await scannerFor(fs.readFileSync(CSS_PATH, "utf8"));
    expect(candidates.filter((c) => c.includes("1cc670"))).toEqual([]);
    expect(() => compiler.build(candidates)).not.toThrow();
  });

  it("detector check: the pre-fix configuration (auto-detect, docs/ excluded) DOES read the plants", async () => {
    const old = `@import "tailwindcss";\n@source not "../docs";\n`;
    const { compiler, files } = await scannerFor(old);
    expect(compiler.root).toBeNull();
    for (const p of PLANTS) expect(files).toContain(rel(p));
  });
});

describe("SF-110: .vercelignore keeps evidence, tests and tooling out of the deployment upload", () => {
  const lines = fs
    .readFileSync(path.join(ROOT, ".vercelignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("lists docs/, tests/, scripts/ and .omc/ and still ships the one script the build command runs", () => {
    for (const entry of ["docs/", "tests/", ".omc/", ".env"]) expect(lines).toContain(entry);
    expect(lines).toContain("scripts/*");
    expect(lines).toContain("!scripts/maybe-migrate.mjs");
    const build = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.build as string;
    expect(build).toContain("node scripts/maybe-migrate.mjs");
    // The only scripts/ file the build references is the re-included one.
    expect([...build.matchAll(/scripts\/[\w./-]+/g)].map((m) => m[0])).toEqual(["scripts/maybe-migrate.mjs"]);
  });
});
