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
  // §7 error-state lane (2026-08-18): 348 → 347. ClassPacksWidget's
  // hand-rolled red "Retry" box became the ErrorState primitive, and its raw
  // button went with it.
  // Image-visibility lane (2026-08-19): 347 → 345. The member profile page's
  // hand-rolled copy of the avatar upload flow was deleted in favour of
  // <AvatarUploader>; its Camera and "Remove picture" buttons went with it.
  rawButton: 345,
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
  //
  // Accessibility sweep (2026-08-19): 11 → 0, the number §5.4 always asked for.
  // The 11 were only NINE real call sites: this metric does not strip comments,
  // so two of them were prose in OwnerFamilyManagement DESCRIBING the confirm()
  // that lane had already removed. Those two comments are reworded rather than
  // deleted (the documentation is worth keeping), so the 0 below is a genuine
  // zero under the UNCHANGED metric, not a definitional win.
  //
  // The nine: AdminCheckin (remove check-in), InitiativesPanel (delete),
  // TimetableManager (archive class), SettingsPage ×5 (Stripe legal
  // acknowledgement, remove staff, remove product, reset waiver, reset kids'
  // waiver), Topbar (sign out all devices). All now go through
  // useConfirmDialog(), and tests/unit/confirm-dialog-migrations.test.tsx
  // holds the gate: `await ask()` does not block the way `confirm()` did, so a
  // dropped `if (!confirmed) return;` type-checks and silently un-gates a
  // destructive action. Three such mutants were run; all three were caught
  // there and by nothing else in the suite.
  //
  // ZERO IS NOW THE FLOOR. Suggestion for whoever next trips this on a
  // comment: `stripComments()` already exists in this file and okTernaryNull
  // uses it for exactly this reason.
  confirmAlert: 0,
  // D3: 830 → 815 (chip/status hexes replaced by tokens on the two accounts
  // surfaces; the tenant-accent path stays a runtime CSS var, not a literal).
  // D4b: IntegrationsTab 6 → 1 (only Google's brand blue survives, once) and
  // RanksManager 49 → 43. RanksManager keeps its belt hexes deliberately:
  // belt colours are DOMAIN DATA persisted in RankSystem.color, not chassis
  // colour, so §2 does not apply to them.
  // §7 error-state lane (2026-08-18): 768 → 765. Same swap — the three
  // #f87171 / rgba red literals in ClassPacksWidget's hand-rolled error box
  // are gone now the token-driven ErrorState renders it.
  // Image-visibility lane (2026-08-19): 764 → 762. Both came off the member
  // profile page with the hand-rolled avatar block — the #0b0c0f circle behind
  // the picture and the #f87171 upload-error text. AvatarUploader owns both
  // now, and components/ui/ is outside this scan.
  // Accessibility sweep (2026-08-19): 762 → 761. app/member/layout.tsx's gym
  // initials tile had `color: "#ffffff"` painted straight onto the tenant's
  // accent; it now reads --tx-on-accent, which that same file publishes three
  // hundred lines above.
  // Same sweep, second wave (2026-08-19): 761 → 758. Three more whites written
  // as the value half of a ternary — `color: mode === "staff" ? "#ffffff" :
  // …` in AddTaskModal ×2 and SettingsPage's billing-interval toggle — all on
  // a `background: primaryColor`. That SHAPE was the sweep's own blind spot:
  // the first pass matched `text-white` and a bare `color: "#fff"` and walked
  // straight past nine conditional ones. tests/unit/text-on-tenant-accent.test.ts
  // now matches the ternary form too.
  // Merge of origin/main (2026-08-20): 758 → 747. The parallel session's
  // SetupBanner strip and the --cat-* action-item tokens replaced literals on
  // both sides of the merge; locked in rather than left as slack.
  hexLiteral: 747,
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
  // Honesty pass (2026-08-18). This metric only ever matched `.ok ?` AND
  // `: null`, so it read 6 while the real population of "a non-ok response
  // silently becomes a benign-looking value" was 15 — the `: []`, `: {}` and
  // `: SOME_CONSTANT` fallbacks were invisible to it, including the two worst:
  // AdhocChargeDrawer's `{ card: null }` (staff take cash for a charge that
  // could have gone on the card) and SettingsPage's `EMPTY_REVENUE` (£0 MRR
  // for a solvent gym). A gate that measures a sixth of the problem and passes
  // is worse than no gate, because it certifies the rest.
  //
  // Regex widened to all four fallback shapes, comments excluded (prose ABOUT
  // the pattern is not the pattern), and re-baselined at the honest number:
  // 15 measured at HEAD → 3 now. The §7 lane fixed twelve of them.
  //
  // The three that remain are deliberate and are the floor to argue with, not
  // to quietly raise:
  //   app/login/page.tsx — tenant branding for `?club=`. Falling back to the
  //     unbranded login page is right; blocking sign-in behind a retry because
  //     a logo did not load would be worse.
  //   app/member/layout.tsx, components/layout/Recommend2FABannerMember.tsx —
  //     chrome-level lookups whose failure hides an optional prompt. Nothing
  //     is asserted to the member either way.
  //
  // Known blind spot, deliberately not papered over: this metric sees only the
  // ternary shape. The same lie written as `try { … } catch { setRows([]) }`
  // does not register, and that shape was the majority of the 27 surfaces the
  // 2026-08-18 audit found. Do not read 3 as "three left in the app".
  okTernaryNull: 3,
  // D4b: 274 → 270, one of them IntegrationsTab's picker close button (which
  // the Sheet primitive's own close button replaced).
  // Merge with origin/main: 270 → 269, from the member-profile read-only rows.
  // Honesty pass (2026-08-18): 269 → 266. The member portal's "Notifications"
  // card was deleted — its two toggles gated nothing on any send path and the
  // push channel is dormant, so the card promised delivery the product cannot
  // make (UI-RULES §7). Its three text-gray-* rows went with it.
  // Image-visibility lane (2026-08-19): 259 → 256. The member profile page's
  // hand-rolled avatar block carried three of them — the Camera icon, the
  // upload spinner and the "Remove picture" link. AvatarUploader owns all
  // three now, and components/ui/ is outside this scan.
  textGray: 256,
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
  // Honesty pass (2026-08-18): 12 → 11. AddTaskModal's push-notification
  // checkbox was a raw <input> carrying `border-white/20` — a dark-shell class
  // on the light staff shell, so it was invisible as well as inert. Deleted
  // with the control.
  // Accessibility sweep (2026-08-19): 11 → 0, the floor §4a.5 asks for. All
  // eleven measured 1.00:1 against the surface they sat on — white over white
  // paints nothing, so five hover states, three border hovers and two focus
  // rings were dead pixels. Hovers are --sf-2 / --bd-hover now; the two focus
  // rings were `focus:outline-none focus:ring-white/20`, which SUPPRESSED the
  // global `:focus-visible` outline and replaced it with nothing, so the
  // override is simply gone and globals.css paints the ring again.
  // ZERO IS NOW THE FLOOR — §4a.5 admits no exceptions.
  //
  // Known blind spot: this metric matches CLASSES only. The identical defect
  // written inline — `style={{ background: "rgba(255,255,255,0.025)" }}` — is
  // invisible to it, and 26 such values were in dashboard scope when this
  // reached zero. Do not read 0 as "no white-alpha left on the light shell".
  whiteAlphaDash: 0,
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
    label:
      "r.ok ? r.json() : null | [] | {} | CONST patterns (a non-ok response must set an error state, UI-RULES §7)",
    count: (src) =>
      stripComments(src)
        .split("\n")
        .filter((line) => OK_TERNARY_FALLBACK.test(line))
        .length,
  },
  textGray: {
    label: "text-gray-* classes (use text-tx-* tokens)",
    // app/member/layout.tsx is excluded: it is the file that FIXES these on the
    // member shell. It carries `#member-app .text-gray-N { … }` OVERRIDE RULES
    // for both polarities — counting those as violations measures the cure as
    // the disease, and would block the very change that made the dark shell
    // legible. Every other file is counted as before.
    count: (src, rel) => (isMemberShellOverride(rel) ? 0 : matchCount(src, /text-gray-/g)),
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

function isMemberShellOverride(rel) {
  return rel.split(sep).join("/") === "app/member/layout.tsx";
}

function isDashboardScope(rel) {
  const p = rel.split(sep).join("/");
  return p.startsWith("app/dashboard/") || p.startsWith("components/dashboard/");
}

function matchCount(src, re) {
  return (src.match(re) ?? []).length;
}

/**
 * `.ok ?` whose else-branch is a value that will read as ordinary emptiness:
 * `null`, `[]`, any object literal (`{ card: null }`, `{ classIds: [] }`), or
 * a SCREAMING_CASE constant (`EMPTY_REVENUE`). `[^:]*` stops the consequent
 * before the ternary's own colon, so only the fallback half is inspected.
 */
const OK_TERNARY_FALLBACK = /\.ok\s*\?[^:]*:\s*(?:null|\[\s*\]|\{[^}]*\}|[A-Z][A-Z0-9_]+)/;

/**
 * Remove comments before pattern-matching. Writing down WHY a pattern is
 * banned must not itself trip the gate — otherwise the ratchet taxes the
 * documentation that keeps it honest. Not a parser: it leaves `://` in URLs
 * alone and is content to be approximate, because a comment that survives can
 * only ever over-count, never hide a real violation.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:\\])\/\/.*$/gm, "$1");
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
