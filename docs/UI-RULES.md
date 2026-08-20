# MatFlow UI Rules

> **The authoritative UI rulebook.** Produced by the 2026-08-15 deep-dive UI audit; design language ratified by Noe the same day. Keep it under ~350 lines forever. `docs/design.md` is superseded for rules — reference only.
>
> **Why this file exists:** the audit found the last design doc failed not because it was wrong but because nothing routed anyone to it — CLAUDE.md never mentioned it, no primitive embodied it, no check enforced it. This file is short, wired into CLAUDE.md, embodied in `components/ui/`, and enforced by CI greps. If a rule here conflicts with existing code, the rule wins and the code is debt.

## 0. Enforcement (what makes this file different)

1. `CLAUDE.md` MUST contain a "UI" section pointing here: *"Before writing or changing any UI, read `docs/UI-RULES.md`. Its rules override existing code patterns."*
2. A CI script (`scripts/check-ui-rules.mjs`, run in `npm run lint`) fails the build on **new** violations of the greppable rules below (ratchet: counts may only go down; baseline stored in the script).
3. When `app/globals.css` tokens change, this file changes in the same commit, or the PR does not merge.
4. Every PR that touches UI states in its description which primitives it used; "hand-rolled X because Y" requires a sentence of justification.

## 1. The five surfaces and their canonical themes

| Surface | Theme | Shell background token |
|---|---|---|
| Staff dashboard (`app/dashboard`) | **Light** (settled: the Jun 2026 migration direction; finish it, never re-litigate) | `var(--sf-bg)` |
| Member portal (`app/member`) | **Dark, tenant-branded** | `var(--member-surface)` |
| Kiosk (`app/kiosk`) | Tenant-branded dark | tenant `bgColor` |
| Public (landing, legal, login, apply) | Dark marketing look | its own palette, defined once per surface |
| Operator console (`app/admin`) | Light | `admin-theme.ts` |

- No component may hardcode a polarity assumption (`text-white`, `bg-white/5`, white-alpha borders) — shared components must be **token-driven** so they render correctly on both light and dark shells. (Audit: 20 files still carry invisible `bg-white/5` overlays on light surfaces; the shared Toast is white-on-white.)
- The `.dark` class system and `dark:` variants are **dead — do not extend them**. Theme is per-surface via tokens, not per-user toggle. Delete the dead `.dark` block when convenient.

### 1.5 Design language (ratified by Noe, 2026-08-15 — settled; veto requires Noe)

1. **Staff dashboard = light workspace.** `--sf-bg #f5f6f8`, white `#ffffff` cards, hairline `rgba(0,0,0,.08)` borders. Feel: Linear / Stripe Dashboard. The June migration gets finished, never re-litigated.
2. **Member portal + kiosk = dark, gym-branded.** `#111111` base; the tenant's accent colour and font carry the identity. Feel: Whoop / Nike Training Club.
3. **Personality = understated premium.** Geist type, quiet neutrals, `--r-md` (12px) radius, hairline borders, no glow or gradients. Colour appears ONLY on primary actions and the tenant's brand accent — the chassis stays quiet so every gym's colour looks intentional.
4. **Density = dense tables, calm shell.** Data screens (Members, Payments, Timetable, Attendance): ~36px rows (`py-2`), `text-[13px]`, keyboard-fast. Dashboards, settings, nav: spacious (`p-6` cards). Like Stripe's payments table inside an otherwise calm app.
5. **Controls always look proper.** A switch thumb always fits its track; buttons never stretch. See §5a Control geometry.

## 2. Colour and tokens

- **One token vocabulary:** surfaces `--sf-bg`/`--sf-0..4`, text `--tx-1..4`, borders `--bd-*`, radius `--r-*`, motion `--dur-*`/`--ease-*` (defined once, in `app/globals.css`). The shadcn oklch variables exist only to feed `components/ui/` primitives and must be mapped onto this scale — never a second source of truth.
- **No new hex literals in `.tsx`.** (Baseline: 881 across 91 files — ratcheted down.) Colour comes from tokens or from the tenant-branding pipeline. The ONLY sanctioned raw-colour path is runtime tenant values (`primaryColor`, `bgColor`) flowing through CSS variables set by `ThemeProvider`/member layout.
- **No raw Tailwind palette classes** (`text-gray-500`, `bg-blue-500`) in new code — use `text-tx-*`, `bg-sf-*`, `border-bd-*`. (Baseline: 491.)
- **`hex()`/alpha maths comes from `lib/color.ts` only.** The 20+ inline copies are debt; delete one whenever you touch a file that has one.
- Fix on sight (known live bugs): none currently tracked. Fixed 2026-08-17 micro-pass: Geist variables moved to `<html>` (they sat on `<body>` while `font-sans` resolved at `<html>`, so the entire app rendered in the browser's default serif — Times New Roman); light text ramp recalibrated for contrast (`--tx-2 .62`, `--tx-3 .48`, `--tx-4 .38` — tx-4 is the metadata floor: faint but always legible); `--hue-warning-ink #9a6700` added — `--hue-warning #f59e0b` is a fill/icon hue and must never be used as text on light surfaces; Topbar role badge is neutral (identity, not status — the per-role accent+glow system is gone). Earlier fix-on-sight items (darkTheme block, white-alpha scrollbars/`.skeleton`/`.glass`, self-referential `--font-sans`) are done.

### 2a. Holistic customisation (ratified by Noe, 2026-08-16)

Owner branding — accent colour, font, background — is an **input**, not a theme we control. Every UI change must remain correct under ANY tenant customisation, not just the seed gym's palette.

- Text on tenant-accent fills uses `readableOn()` (`lib/color.ts`) at runtime or `var(--tx-on-accent)` in CSS — never hardcoded white.
- Both member light and dark modes must stay legible under the tenant's colours.
- Check new UI against the worst-case accents before calling it done: `#ffffff`, `#ffe14d`, `#111111`. A control that vanishes on any of them ships with a border/outline that survives (see the Switch thumb).

## 3. Typography and iconography

- Fonts: **Geist** (chrome), tenant-selected face (member portal, existing 12-font whitelist), landing's three faces stay as-is. The `FONT_IMPORTS` map is defined **once** in `lib/fonts.ts` and imported (currently duplicated in 3 files).
- Icons: **lucide-react only** (already 70 files — the one thing that's consistent; keep it). Inline SVG only inside chart components.
- No `font-${variable}` dynamic class construction — Tailwind's scanner cannot see it (this is why StatusPill's weight prop never worked). Use a static lookup map of full class names.

## 4. Layout and shells

- **Container scale:** staff dashboard pages use `max-w-6xl mx-auto` — one width, no exceptions (audit found 8 widths; the column visibly jumps four times in one nav session). Member portal is full-bleed mobile-first. Landing keeps `max-w-7xl`. The **layout** owns padding; the **page** owns nothing (`app/dashboard/layout.tsx` provides it — pages must not re-add containers).
- Page titles: one `PageHeader` primitive (title + optional description + optional action button). No per-page heading inventions.
- Navigation: staff routes are declared in **one** route manifest consumed by both `Sidebar` and `MobileNav` (today they are two independently-maintained lists — a new route silently vanishes on mobile). Member tab bar gets extracted from the layout into `components/member/MemberNav.tsx`.

## 5. Primitives (the missing layer — build once, use always)

`components/ui/` is the only place generic UI lives. Required set (build in this order; shadcn/base-nova generation is fine as a starting point, restyled to tokens):

1. `Button` (replace the 0-importer scaffold; variants: primary/secondary/ghost/destructive; loading state built in)
2. `Input`, `Label`, `Select`, `Textarea`, `Checkbox`, `Switch` (with error + hint slots, `htmlFor` wired automatically, `aria-describedby` for errors)
3. `Dialog` / `Sheet` (one implementation: `role="dialog"`, `aria-modal`, Escape, focus trap, scroll lock, bottom-sheet on mobile at the `sm:` breakpoint — kills ~30 hand-rolled overlays in 6 conventions). **Bottom sheets and popups always clear the fixed bottom nav** — member surfaces pad with `var(--member-nav-clearance)`, staff mobile with safe-area + nav height. A sheet whose actions sit under the tab bar is broken (ratified 2026-08-16).
4. `ConfirmDialog` (kills all 18 `window.confirm` and 3 `alert()` call sites; destructive actions get typed confirmation copy)
5. `Card`, `Badge`/`StatusPill` (fix the dynamic-class bug), `Skeleton` (token-driven, works on light AND dark), `EmptyState`, `ErrorState` (with retry slot), `DataTable` (mobile strategy built in: card-collapse under `sm:`)
6. `Toast` stays the one feedback system — fix its hardcoded `text-white`/hex colours to tokens, then **use it everywhere including the member portal** (today: 16 staff/onboarding importers, zero member usage).

**Sticky content always clears the chrome above it** — anything that pins inside a scrollport that already carries a sticky bar offsets by that bar's height from a token (`var(--staff-tabbar-clearance)`, `var(--member-header-clearance)`), never `top: 0`, and takes a z-index below the bar's. Its height is derived from the same chrome tokens in `dvh`, it is top-aligned, and un-shrinkable content is scaled down rather than centred: a viewport-derived box with `justify-content: center` wrapped around content taller than itself overflows **both** ends, and the top end escapes above the scroll origin where no scroll position can bring it back. Content sitting beneath the bar gets the same clearance as `scroll-margin-top`, or the first band of anything scrolled to the top of the scrollport is lost. A panel the bar paints over at every scroll position is broken (ratified 2026-08-18).

### 5a. Control geometry (ratified 2026-08-15)

Fixed-geometry controls must never be resized by context, global CSS, or text length — a stretched switch or oval checkbox is an instant "broken" signal.

- **Switch:** track `40×22px`, thumb `18px` with `2px` inset, travel `18px`, transition `var(--dur-fast) var(--ease-out)`. Hard pixel values on the element — never `em`/`min-height`-derived.
- **Checkbox/Radio:** `18×18px` visual, 2px border, `--r-sm` (checkbox) / full-round (radio).
- **Button:** fixed heights — `h-9` (36px) default, `h-8` (32px) compact for dense tables, `h-11` (44px) primary mobile CTAs. Width from content + padding; never full-width unless the layout slot demands it.
- **Hit area vs visual size:** the WCAG 44px floor is met by an **extended hit area** (padding or a `::before` overlay), never by inflating the visual control. The blanket `min-height: 44px` rule in `globals.css:286-288` must be scoped with `:not(.ui-fixed-size)`; Switch, Checkbox, Radio and compact Button set `.ui-fixed-size` and provide their own hit-area extension.
- Thumb/track and icon/button ratios are constants in the primitive — no per-usage size overrides beyond the named variants.

**Adoption policy (boy-scout ratchet, not big-bang):** all NEW UI uses primitives, no exceptions. Any PR touching a file with a hand-rolled equivalent migrates at least the parts it touches. CI ratchet counts raw `<button>`, `confirm(`, `alert(`, `fixed inset-0` and fails on increases.

## 6. Forms

- New/rewritten forms use **react-hook-form + zod** (already proven on login/apply) with the `Input`/`Label` primitives. Uncontrolled-`useState` forms are debt.
- Every input has an associated label (`htmlFor` — audit: 9 usages against 156 inputs). Placeholder is never the only label (the kiosk search input is the canonical offender).
- Submit buttons show in-flight state (primitive handles it); double-submit is prevented by the primitive, not per-form flags.

## 7. Async honesty (the highest-stakes rules in this file)

- **Never render fabricated data.** No placeholder people, gyms, milestones or curricula — `useState(null)` + skeleton until fetch resolves. (Audit P0: `/member/profile` ships hardcoded `MILESTONES` "Awarded by Coach Mike", a fake technique syllabus with false provenance, `useState("Alex Johnson")`, and `DEFAULT_GYM = "Total BJJ"` flashing on every tenant.)
- **An HTTP error is never an empty state.** The `r.ok ? r.json() : null` pattern (12 sites) is banned — non-ok responses set an error state rendering `ErrorState` with retry. A member with a broken backend must not be told "no classes today"; a DB outage must not look like an empty gym.
- Every route segment gets an `error.tsx` (today: zero in the entire app) and the two audiences' `loading.tsx` must match their shell polarity (member `loading.tsx` currently paints white bars on near-black).
- Raw `error.message` never reaches an end user; catch-all copy is humane British English ("Couldn't load — tap to retry").
- No optimistic update without rollback (profile toggles already do this correctly — keep that standard).
- Never keep stale data on a legitimately-empty refetch (member home currently keeps yesterday's classes when today has none).
- **Never ship UI for capabilities that don't exist.** No toggle, button or copy may promise something no code delivers (audit: "Class reminders — 1 hour before" toggle with no scheduler; push toggles with no registered service worker).

## 8. Accessibility floor

- Zoom is never disabled: `maximumScale`/`userScalable` restrictions are banned (currently set globally — WCAG 1.4.4 failure; remove, keep `viewportFit: "cover"`).
- All dialogs via the `Dialog` primitive (role/aria-modal/Escape/focus trap/scroll lock come free).
- Keep and never regress: global 44px touch targets, `:focus-visible` ring, `prefers-reduced-motion`, safe-area insets, `aria-current` nav.
- Async status changes announce via an `aria-live` region (Toast provides it).
- Status is never colour-only; pair with text (belt dots already carry `aria-label` — keep).

## 9. Mobile and PWA

- Member portal and kiosk are mobile-first; staff dashboard must be usable at 375px (tables card-collapse via `DataTable`; the `/admin` console is explicitly desktop-only and exempt).
- `100dvh` not `100vh`; safe-area utilities on fixed bars; `min-h-[48px]` tap targets on nav.
- **PWA truth:** until icons exist in `public/icons/` AND a service worker is registered, nothing may describe the app as installable/PWA (fix `CLAUDE.md:4` which currently claims "PWA via Serwist" — Serwist is not installed). When shipped: icons declare `purpose: "any"` as well as `maskable`, manifest `theme_color` matches the member shell.

## 10. Copy

- British English, sentence case, no exclamation marks in errors. Current copy voice is a strength — match it ("No match yet — keep typing.", "Couldn't check you in").
- Dates: one `lib/date.ts` with `formatDate`/`formatTime`/`formatWeekLabel`, always `en-GB` locale (audit: ~11 local formatters under 5 names; admin console renders US dates on US browsers via bare `toLocaleDateString()`).
- Errors state what happened and what to do next; never blame the user; never expose internals.

## 11. Anti-pattern blacklist (CI-greppable)

| Banned in new code | Use instead |
|---|---|
| raw `<button>`/`<input>`/`<select>`/`<table>` outside `components/ui/` | primitives |
| `window.confirm` / `alert()` | `ConfirmDialog` / `Toast` |
| `fixed inset-0` hand-rolled overlays | `Dialog`/`Sheet` |
| hex literals / `text-gray-*` / `bg-white/5` in `.tsx` | tokens |
| inline `style={{}}` for static values | Tailwind + tokens (runtime tenant values via CSS vars are the exception) |
| `r.ok ? r.json() : null` | explicit error state |
| placeholder people/gyms in `useState` initials | `null` + skeleton |
| dynamic class fragments (`` `font-${x}` ``) | static class maps |
| new `hex()`/date-format helpers | `lib/color.ts`, `lib/date.ts` |
| `dangerouslySetInnerHTML` for styling | CSS variables |
| `maximumScale`/`userScalable:false` | nothing — leave zoom alone |
| visually stretched controls (switch/checkbox/button inheriting global `min-height`) | primitives with `.ui-fixed-size` + hit-area extension (§5a) |

## 12. Definition of done for any UI change

Renders correctly on its surface's theme at 375px and 1440px · loading, empty, error and success states all exist and are honest · keyboard reachable, Escape closes overlays, labels wired · uses primitives and tokens (or justifies why not in the PR) · `npm run lint && npm test && npm run build` green.
