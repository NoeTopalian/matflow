#!/usr/bin/env node
/**
 * UI-RULES ratchet (docs/UI-RULES.md §0/§11).
 *
 * Counts greppable anti-patterns across app/**\/*.tsx and components/**\/*.tsx
 * (excluding components/ui/) and compares against the BASELINE below.
 *
 *  - A count ABOVE its baseline fails the build (exit 1) and lists offenders.
 *  - A count BELOW its baseline prints a congrats line: lower the baseline
 *    number in this file in the same PR to lock in the win.
 *
 * Counts may only go down. No new violations, ever.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ── Ratchet baseline ─────────────────────────────────────────────────────────
// Re-run `node scripts/check-ui-rules.mjs` after lowering any of these to
// confirm the new floor holds.
// Each floor is the MAXIMUM of the current working tree and HEAD, so lowering
// one can never break a checkout that predates the in-flight UI work.
const BASELINE = {
  rawButton: 459,
  confirmAlert: 12,
  hexLiteral: 820,
  fixedInset0: 31,
  okTernaryNull: 6,
  textGray: 269,
};

// ── Metric definitions ───────────────────────────────────────────────────────
const METRICS = {
  rawButton: {
    label: "raw <button> outside components/ui/ (use the Button primitive)",
    count: (src) => matchCount(src, /<button\b/g),
  },
  confirmAlert: {
    label: "window.confirm()/confirm()/alert() (use ConfirmDialog / Toast)",
    count: (src) =>
      matchCount(src, /window\.confirm\(/g) +
      matchCount(src, /(?<![\w.])confirm\(/g) +
      matchCount(src, /(?<![\w.])alert\(/g),
  },
  hexLiteral: {
    label: "6-digit hex literals in .tsx (use tokens / tenant CSS vars)",
    count: (src) => matchCount(src, /#[0-9a-fA-F]{6}/g),
  },
  fixedInset0: {
    label: '"fixed inset-0" hand-rolled overlays (use Dialog/Sheet)',
    count: (src) => matchCount(src, /fixed inset-0/g),
  },
  okTernaryNull: {
    label: "r.ok ? r.json() : null patterns (use explicit error state)",
    count: (src) =>
      src
        .split("\n")
        .filter((line) => /\.ok\s*\?/.test(line) && /:\s*null/.test(line))
        .length,
  },
  textGray: {
    label: "text-gray-* classes (use text-tx-* tokens)",
    count: (src) => matchCount(src, /text-gray-/g),
  },
};

function matchCount(src, re) {
  return (src.match(re) ?? []).length;
}

// ── File collection ──────────────────────────────────────────────────────────
const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components"];
const EXCLUDE = `components${sep}ui${sep}`;

function collectTsx(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (rel.startsWith(EXCLUDE)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectTsx(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => collectTsx(join(ROOT, d)));

// ── Count ────────────────────────────────────────────────────────────────────
const totals = Object.fromEntries(Object.keys(METRICS).map((k) => [k, 0]));
const perFile = Object.fromEntries(Object.keys(METRICS).map((k) => [k, new Map()]));

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const [key, metric] of Object.entries(METRICS)) {
    const n = metric.count(src);
    if (n > 0) {
      totals[key] += n;
      perFile[key].set(relative(ROOT, file).split(sep).join("/"), n);
    }
  }
}

// ── Compare against baseline ─────────────────────────────────────────────────
let failed = false;
let dropped = false;

for (const [key, metric] of Object.entries(METRICS)) {
  const total = totals[key];
  const base = BASELINE[key];
  if (total > base) {
    failed = true;
    console.error(`\n✗ ${metric.label}`);
    console.error(`  ${total} found — baseline is ${base}. New violations are banned (UI-RULES §11).`);
    console.error("  Offending files:");
    const sorted = [...perFile[key].entries()].sort((a, b) => b[1] - a[1]);
    for (const [file, n] of sorted) console.error(`    ${file}: ${n}`);
  } else if (total < base) {
    dropped = true;
    console.log(`✦ ${metric.label}: ${total} (baseline ${base}) — nice, it dropped. Lower the baseline in scripts/check-ui-rules.mjs to lock it in.`);
  } else {
    console.log(`✓ ${metric.label}: ${total} (at baseline)`);
  }
}

if (failed) {
  console.error("\nUI-RULES ratchet failed. Fix the new violations (docs/UI-RULES.md) — counts may only go down.");
  process.exit(1);
}

if (dropped) {
  console.log("\nAll ratchets at or below baseline. Remember to commit lowered baselines.");
} else {
  console.log("\nAll ratchets at baseline. No new UI-rule violations.");
}
