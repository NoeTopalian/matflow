// Lane C4 (iteration 2) — SF-110 / R6-N4 re-check, adapted from R6's zz-r6-tailwind-plant.mjs.
// Compiles a globals.css exactly as the build does (postcss + @tailwindcss/postcss, which scans the project for class
// candidates honouring @source rules and .gitignore), with a synthetic evidence-style file planted in each directory in
// turn. The plant is a Windows scratchpad path whose segment after a backslash starts with hex digits — the shape that
// Tailwind read as a CSS escape (code point 0x1CC670 > 0x10FFFF → RangeError "Invalid code point").
// The plant text is built at run time so this file itself carries no trigger.
//
// Usage (from the repo root):
//   node docs/security/evidence/C4/c4-tailwind-plant.mjs plant <css-file> <dir|none> ...
//   node docs/security/evidence/C4/c4-tailwind-plant.mjs inventory <css-file> <out.txt>
// <css-file> is compiled AS IF it were app/globals.css (relative @source paths resolve against app/), so the HEAD
// version (git show HEAD:app/globals.css > tmp) and the working version can be compared side by side.
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const BS = String.fromCharCode(92);
const PLANT = [
  "synthetic secc4 plant — evidence-style log line",
  ["C:", "Users", "secc4", "AppData", "Local", "Temp", "claude", "c--Users-secc4-Desktop-matflow",
    "1cc670be-8e50-4bc6-9b9d-aa84aee7df8f", "scratchpad", "security", "C4", "wt", "app", "admin", "page.tsx"].join(BS),
  "",
].join("\n");

const [mode, cssFile, ...rest] = process.argv.slice(2);
const css = fs.readFileSync(cssFile, "utf8");
const from = path.resolve("app/globals.css");
const compile = () => postcss([tailwind({ base: process.cwd() })]).process(css, { from });

if (mode === "plant") {
  let failures = 0;
  for (const dir of rest) {
    const target = dir === "none" ? null : path.join(dir, "zz-secc4-plant.txt");
    if (target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, PLANT); }
    let verdict;
    try {
      const out = await compile();
      verdict = { ok: true, bytes: out.css.length };
    } catch (e) {
      failures++;
      verdict = { ok: false, error: String(e && e.message).replace(/[A-Za-z]:[\\/][^\s"']*/g, "<path>").slice(0, 120) };
    } finally {
      if (target) fs.rmSync(target);
    }
    console.log(JSON.stringify({ css: cssFile.replace(/.*[\\/]/, ""), plantedIn: dir, ...verdict }));
  }
  process.exitCode = failures ? 1 : 0;
} else if (mode === "inventory") {
  const out = await compile();
  const sel = new Set();
  postcss.parse(out.css).walkRules((r) => {
    if (r.parent && r.parent.type === "atrule" && /keyframes/.test(r.parent.name)) return;
    for (const s of r.selectors) sel.add(s.trim());
  });
  fs.writeFileSync(rest[0], [...sel].sort().join("\n") + "\n");
  console.log(JSON.stringify({ css: cssFile.replace(/.*[\\/]/, ""), bytes: out.css.length, selectors: sel.size }));
} else {
  console.error("mode must be plant or inventory");
  process.exitCode = 2;
}
