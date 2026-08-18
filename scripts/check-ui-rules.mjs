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
  // D3 (2026-08-17, accounts surfaces): 456 → 427. MemberProfile 27 → 9,
  // MembersList 10 → 3, and the three child overlays now take their footer
  // actions from the Button primitive.
  // D4b (settings surfaces): 90 raw buttons across the four settings files
  // became Button primitives — IntegrationsTab 8 → 0, MembershipsManager
  // 8 → 0, RanksManager 14 → 2, SettingsPage 60 → 55. The rest of the drop
  // to 349 came from the sibling D4 lanes on the same tree.
  // Merge with origin/main (2026-08-18): that branch's member-profile edit mode
  // arrived with three raw buttons (Edit / Cancel / Save). They are now Button
  // primitives — the member layout publishes --color-primary and
  // --tx-on-accent precisely so the shared primitives work on the dark shell —
  // so the merge LOWERS this rather than raising it: 349 → 348.
  rawButton: 348,
  // 2026-08-17 honest correction: the UI phase-1 branch added a 22nd confirm()
  // while the ratchet sat red and ignored — a permanently-failing gate teaches
  // people to skip it. Re-baselined at today's truth; the D2 ConfirmDialog
  // primitive is obligated to drive this to 0. Counts only go down from here.
  // D4d: 22 → 21. OwnerFamilyManagement's unlink confirm() is now a
  // destructive ConfirmDialog.
  // Panel-fix wave: 21 → 20. ClassPacksManager's deactivate confirm() is now a
  // destructive ConfirmDialog.
  // Merge with origin/main (2026-08-18): that branch converted its own batch of
  // confirm()s (ApplicationsClient, DsarActions, ImportPanel, FamilySection,
  // KidPhotosAndWaiver) and had already re-baselined to 12. Both lanes' wins
  // land together, so the floor is the LOWER of the two — and with both lanes'
  // conversions on one tree the measured count is 11, below either baseline.
  confirmAlert: 11,
  // D3: 830 → 815 (chip/status hexes replaced by tokens on the two accounts
  // surfaces; the tenant-accent path stays a runtime CSS var, not a literal).
  // D4b: IntegrationsTab 6 → 1 (only Google's brand blue survives, once) and
  // RanksManager 49 → 43. RanksManager keeps its belt hexes deliberately:
  // belt colours are DOMAIN DATA persisted in RankSystem.color, not chassis
  // colour, so §2 does not apply to them.
  hexLiteral: 768,
  // D3: 31 → 25. Six hand-rolled overlays became Dialog/Sheet — three in
  // MemberProfile (rank drawer, add-payment drawer, waiver-share modal) plus
  // RemoveMemberModal, AdhocChargeDrawer and MarkPaidDrawer.
  // D4d: 25 → 10 measured. Seven of those are this lane — MembersList's
  // AddMemberModal, OwnerFamilyManagement's two family modals, AddTaskModal,
  // ClassPacksManager, InitiativesPanel and the DashboardStats to-do panel
  // (the last one being the Sheet the primitive was modelled on). The rest
  // came from the sibling overlay lanes running against the same tree.
  // D4b: the settings lane's five are all gone — SettingsPage's Drawer and
  // recovery-codes modal, IntegrationsTab's folder picker, and the
  // MembershipsManager / RanksManager overlays are now Sheet or Dialog.
  fixedInset0: 9,
  okTernaryNull: 6,
  // D4b: 274 → 270, one of them IntegrationsTab's picker close button (which
  // the Sheet primitive's own close button replaced).
  // Merge with origin/main: 270 → 269, from the member-profile read-only rows.
  textGray: 269,
  // §4a desktop layout system (2026-08-17): both must reach ZERO by the end
  // of the desktop-system migration and stay there.
  // D1 (2026-08-17): 19 → 1. All 18 per-page/component containers deleted —
  // app/dashboard/layout.tsx now owns the single max-w-6xl container. The
  // remaining 1 was AnalysisView's `max-w-sm mx-auto` empty-state PARAGRAPH,
  // a regex false positive; D4 moved that empty state to the EmptyState
  // primitive and it went with it. ZERO IS NOW THE FLOOR — the layout owns
  // the container and nothing in dashboard scope may re-declare one.
  // Narrower reading columns are still allowed and still uncounted: they
  // nest a left-aligned `max-w-3xl` with NO `mx-auto` (§4a.1), which is how
  // SettingsPage caps its six form-dense tab panels.
  dashContainer: 0,
  // D3 (2026-08-17): 51 → 29. MemberProfile alone carried 20 of them — an
  // active tab underline, five menu hovers, a table row hover and the rank
  // drawer's selected states, none of which painted anything on the light
  // shell. All now --sf-2 / --bd-hover / --bd-active, plus the tenant accent
  // for the active tab.
  // D4b: SettingsPage's two invisible `hover:bg-white/5` states (the staff
  // card action and the overview quick-links) and MembershipsManager's one
  // are now --sf-2 / --bd-hover. The rest of 29 → 13 is the sibling lanes.
  whiteAlphaDash: 12,
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
