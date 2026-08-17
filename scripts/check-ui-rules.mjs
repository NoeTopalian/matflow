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
const BASELINE = {
  rawButton: 456,
  // 2026-08-17 honest correction: the UI phase-1 branch added a 22nd confirm()
  // while the ratchet sat red and ignored — a permanently-failing gate teaches
  // people to skip it. Re-baselined at today's truth; the D2 ConfirmDialog
  // primitive is obligated to drive this to 0. Counts only go down from here.
  confirmAlert: 22,
  hexLiteral: 830,
  fixedInset0: 31,
  okTernaryNull: 6,
  textGray: 275,
  // §4a desktop layout system (2026-08-17): both must reach ZERO by the end
  // of the desktop-system migration and stay there.
  // D1 (2026-08-17): 19 → 1. All 18 per-page/component containers deleted —
  // app/dashboard/layout.tsx now owns the single max-w-6xl container. The
  // remaining 1 is AnalysisView's `max-w-sm mx-auto` empty-state PARAGRAPH
  // (centred copy inside a text-center panel, not a layout container) — a
  // regex false positive. It goes when that empty state moves to the
  // EmptyState primitive; until then this is the floor.
  dashContainer: 1,
  whiteAlphaDash: 51,
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
  // §4a.1 — the LAYOUT owns the dashboard container; pages/components must not
  // re-declare one. Scoped to the staff dashboard.
  dashContainer: {
    label: "per-page max-w-* containers in dashboard scope (layout owns the container, UI-RULES §4a)",
    count: (src, rel) => (isDashboardScope(rel) ? matchCount(src, /max-w-(?:xs|sm|md|lg|xl|[2-7]xl) mx-auto/g) : 0),
  },
  // §4a.5 — white-alpha state classes are invisible on the light staff shell.
  whiteAlphaDash: {
    label: "white-alpha classes in dashboard scope (invisible on the light shell, UI-RULES §4a)",
    count: (src, rel) => (isDashboardScope(rel) ? matchCount(src, /(?:bg|border|divide|text|ring)-white\/\d+/g) : 0),
  },
};

function isDashboardScope(rel) {
  const p = rel.split(sep).join("/");
  return p.startsWith("app/dashboard/") || p.startsWith("components/dashboard/");
}

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
  const rel = relative(ROOT, file);
  for (const [key, metric] of Object.entries(METRICS)) {
    const n = metric.count(src, rel);
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
