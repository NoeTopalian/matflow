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
- Fix on sight (known live bugs): duplicated token block in `app/dashboard/layout.tsx:38-53` (misnamed `darkTheme` — delete, tokens live in globals.css), white-alpha scrollbars/`.skeleton`/`.glass` in globals.css, self-referential `--font-sans: var(--font-sans)` (should be `var(--font-geist-sans)`).

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

### 4a. Desktop layout system (ratified by Noe, 2026-08-17 — "comprehensive and holistic; everything follows it")

The 2026-08-17 desktop inventory found 7 container widths, 21 hand-rolled overlays in 5 conventions, 9 of 17 routes with zero `lg:`/`xl:` styles, and two-column grids gated at `xl:` that never fire on real laptops. These rules make the desktop a designed surface rather than a stretched phone.

1. **The layout owns the container.** `app/dashboard/layout.tsx` wraps `<main>` content in `mx-auto w-full max-w-6xl` with `p-6 xl:p-8`. Pages and dashboard components MUST NOT declare their own `max-w-* mx-auto` wrapper (ratchet-counted to zero). A page that genuinely needs a narrower reading column (long-form text only) nests `max-w-3xl` INSIDE the container, left-aligned to the grid, never centred against it.
2. **Breakpoint policy.** The desktop shell subtracts a 240px sidebar, so a 1280–1366px laptop leaves a ~1000–1100px content box: `lg:` (1024) is the threshold for STRUCTURAL splits (two-column, side rails, table-vs-cards); `xl:` (1280) is for widening only (more columns of the same thing). Every grid track that can shrink uses `minmax(0,…)` (blowout guard — ReportsView is the model). A structural split gated at `xl:` is a defect.
3. **One overlay standard, two shapes.** `Dialog` (centred, `max-w-lg` cap) for confirms and short forms; `Sheet` (right-edge slide-over `w-full max-w-[480px]` at `lg:`+, bottom-sheet below `lg:`) for anything with scrolling content or multi-field forms — modelled on the DashboardStats slide-over. Both come ONLY from `components/ui/`. Scrim is `bg-black/60`, no backdrop blur. A 448px phone-sheet centred in a greyed-out 1440px page is the exact anti-pattern this replaces.
4. **Density is real on desktop.** Data screens use the §1.5 dense spec (~36px rows, `py-2`, `text-[13px]`, sticky `<thead>`) via the `DataTable` primitive. The blanket 44px control floor is scoped: `@media (pointer: fine)` relaxes it for `.ui-fixed-size` and table-embedded controls (hit-area extension per §5a still applies on touch). Tokens `--content-max`, `--row-h-dense`, `--pad-card` encode the scale in `app/globals.css`.
   - **The sticky `<thead>` engages at `lg:` and up only, and a `DataTable` MUST NOT be wrapped in an `overflow-*` ancestor.** `position: sticky` resolves against the nearest scroll container, and `overflow: hidden` / `auto` / `scroll` all make a box one. Below `lg:` the primitive owns a local `overflow-x-auto` scroller so a wide table cannot push the page sideways; that scroller is auto-height, never scrolls vertically, and the header therefore cannot stick in the 640–1023px tablet band. Accepted. At `lg:` and up the scroller is released (`lg:overflow-x-visible`) and the nearest scrollport becomes `<main class="flex-1 overflow-y-auto">` in `app/dashboard/layout.tsx`, which genuinely scrolls — the same chain the §4a.7 sticky tab rails already rely on. All eight adopting surfaces used to wrap the table in `sm:overflow-hidden` to clip a card's rounded corners, which silently made the header inert at every desktop width. Card chrome around a table now carries the border, radius and background but **never** `overflow-hidden`: `DataTable` rounds its own corner cells (`border-separate border-spacing-0` plus `first:rounded-tl` / `last:rounded-tr` on `<th>` and the same on the final row's `<td>`s), and any filled footer inside that card rounds its own bottom with `rounded-b-[var(--r-md)]`. A dev-only effect in the primitive `console.warn`s if a clipping ancestor reappears.
5. **Light-shell states must be visible.** Any `bg-white/N`, `border-white/N`, `hover:*-white/*` state class inside `app/dashboard/**` or `components/dashboard/**` is a defect (they render invisible on the light shell — the audit found active tabs and row hovers that simply do not paint). Ratchet-counted to zero. Hover/active/selected states come from `--sf-2`/`--bd-hover`/`--bd-active` tokens.
6. **Text ramp is contrast-correct on white.** `--tx-3`/`--tx-4` are re-weighted so table headers and meta text clear contrast on `#ffffff` (old 0.35/0.18 alphas fail). One radius source of truth (`--r-*`; the shadcn `--radius-*` chain maps onto it). The dead `.dark` block is deleted, not extended.
7. **Sticky context.** Tab rails and section navs on long pages use the SettingsPage sticky-rail pattern (`sticky top-0 z-20` inside the scroll container) so context survives scroll. Tabs never rely on `overflow-x-auto scrollbar-hide` at desktop widths.

## 5. Primitives (the missing layer — build once, use always)

`components/ui/` is the only place generic UI lives. Required set (build in this order; shadcn/base-nova generation is fine as a starting point, restyled to tokens):

1. `Button` (replace the 0-importer scaffold; variants: primary/secondary/ghost/destructive; loading state built in)
2. `Input`, `Label`, `Select`, `Textarea`, `Checkbox`, `Switch` (with error + hint slots, `htmlFor` wired automatically, `aria-describedby` for errors)
3. `Dialog` / `Sheet` (one implementation: `role="dialog"`, `aria-modal`, Escape, focus trap, scroll lock, bottom-sheet on mobile at the `sm:` breakpoint — kills ~30 hand-rolled overlays in 6 conventions). **Bottom sheets and popups always clear the fixed bottom nav** — member surfaces pad with `var(--member-nav-clearance)`, staff mobile with safe-area + nav height. A sheet whose actions sit under the tab bar is broken (ratified 2026-08-16).
4. `ConfirmDialog` (kills all 18 `window.confirm` and 3 `alert()` call sites; destructive actions get typed confirmation copy)
5. `Card`, `Badge`/`StatusPill` (fix the dynamic-class bug), `Skeleton` (token-driven, works on light AND dark), `EmptyState`, `ErrorState` (with retry slot), `DataTable` (mobile strategy built in: card-collapse under `sm:`)
6. `Toast` stays the one feedback system — fix its hardcoded `text-white`/hex colours to tokens, then **use it everywhere including the member portal** (today: 16 staff/onboarding importers, zero member usage).

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
