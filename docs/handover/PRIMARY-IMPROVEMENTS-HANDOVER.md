# MatFlow — primary improvements handover

**Written:** 2026-08-18 · **Repo:** `c:\Users\NoeTo\Desktop\matflow` · **Branch:** `main` · **Baseline commit:** `7acd2e4`

This document is self-contained. You do not need the conversation that produced it. It carries four things: **operational constraints you must respect**, **root-cause traces for the bugs Noe reported**, **paste-ready fixes**, and **the current state of the gates**.

---

## 0. Operational constraints — read before touching anything

These are not style preferences. Breaking one of them destroys someone's work.

### 0.1 Another Claude session owns 29 files right now

A parallel session is restyling the staff dashboard. As of this writing it had modified `Sidebar.tsx` and `Topbar.tsx` twenty minutes prior, so treat it as live. **Do not edit these files** unless you have confirmed that session has committed and stopped:

```
app/dashboard/layout.tsx          components/dashboard/MarkPaidDrawer.tsx
app/globals.css                   components/dashboard/MemberProfile.tsx
app/layout.tsx                    components/dashboard/MembersList.tsx
components/dashboard/AddTaskModal.tsx        components/dashboard/MembershipsManager.tsx
components/dashboard/AdhocChargeDrawer.tsx   components/dashboard/OwnerFamilyManagement.tsx
components/dashboard/AdminCheckin.tsx        components/dashboard/PaymentsTable.tsx
components/dashboard/AnnouncementsView.tsx   components/dashboard/RemoveMemberModal.tsx
components/dashboard/AttendanceView.tsx      components/dashboard/ReportsView.tsx
components/dashboard/ClassPacksManager.tsx   components/dashboard/SettingsPage.tsx
components/dashboard/CoachRegister.tsx       components/dashboard/SetupBanner.tsx
components/dashboard/DashboardStats.tsx      components/dashboard/TimetableManager.tsx
components/dashboard/InitiativesPanel.tsx    components/dashboard/WeeklyCalendar.tsx
components/dashboard/IntegrationsTab.tsx     components/layout/Recommend2FABanner.tsx
components/layout/Sidebar.tsx     components/layout/Topbar.tsx     docs/UI-RULES.md
```

Refresh this list yourself with `git status --porcelain` before you start — it will have changed.

### 0.2 Port 3847 belongs to a different worktree

`c:\Users\NoeTo\Desktop\matflow-storage-fixes` runs its own dev server on **3847**. Do not kill it and do not start anything on it.

This matters more than it looks: `playwright.config.ts` sets `reuseExistingServer: !CI`, so pointing Playwright at 3847 silently tests **that worktree's uncommitted code**. Use a private port:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3999 npx playwright test <spec>
```

The config now derives the dev-server port from `PLAYWRIGHT_BASE_URL`, so this starts and reuses your own server correctly.

### 0.3 One test process at a time

vitest, Playwright and dev servers corrupt each other on this Windows box, **including across worktrees** — a run was already lost this way when the other worktree's Playwright reset shared auth state mid-run and the owner auth setup failed, blocking 58 tests. Before a Playwright run, check for competing processes:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'playwright|vitest' } |
  Select-Object ProcessId, CommandLine
```

Kill only leaked processes from your own runs. Never kill anything whose command line mentions `claude` or `matflow-storage-fixes`.

### 0.4 Repo rules that bite

- **Never `git add -A`** — sensitive files live in the repo root. Always commit an explicit file list.
- The repo `.env` points at the **production** Neon database. Playwright specs mutate data and reset TOTP. `.env.test` must be loaded (the config force-loads it with `override: true`); specs hard-refuse the prod branch `ep-bold-wave`.
- British English in all user-facing copy.
- `docs/UI-RULES.md` is the ratified UI rulebook and **overrides existing code patterns**.
- **Belt promotion doctrine is inviolable: coaches decide belts.** No class-count threshold may promote anyone or be presented as progress toward a belt. Attendance thresholds may only *surface candidates for a coach to review*.

---

## 1. BUG — the phone preview gets stuck in the top menu

> Noe: *"the mobile display should never! get stuck in the top menu ensure this doesnt happen"*

**Where:** staff Settings → Branding tab. The member-app phone preview scrolls up under the sticky tab strip, its top is clipped, and it cannot be scrolled back into view.

### Root cause — two compounding defects

**`components/dashboard/SettingsPage.tsx:1554`** (single line, verbatim):

```tsx
<div className="w-[300px] shrink-0 hidden lg:flex" style={{ position: "sticky", top: 0, height: "calc(100vh - 120px)", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
```

**(a) Two sticky siblings both claim `top: 0` in the same scrollport.** The Settings tab strip at `SettingsPage.tsx:1133` is `sticky top-0 z-20`, opaque (`var(--sf-0)`) with `backdropFilter: blur(12px)`, and roughly 56–60px tall. The preview pins to the *identical* line with **no z-index at all**, so it renders underneath the strip and is both covered and blurred.

**(b) The height maths cannot fit the content.** The box is `calc(100vh - 120px)` with `justifyContent: "center"`, but its content is ~606px of un-shrinkable height (a 26px caption plus a 580px phone frame carrying `flexShrink: 0`). On any viewport shorter than about 726px the centred content overflows **both** ends equally — the top escapes above the sticky box's own origin, where `main`'s `overflow-y-auto` clips it. Because a sticky box travels with the scrollport, that clipped region is unreachable at any scroll position.

The `120` is a magic number matching nothing real. The actual chrome is 64px Topbar + 48px `main` padding = 112px, before the tab strip and before any banner.

### Supporting facts you will need

- **The scroll container is not the window.** `app/dashboard/layout.tsx:60` is `h-screen overflow-hidden`; the only scrollport is `<main className="flex-1 overflow-y-auto p-6">` at `:73`.
- **The Topbar is not sticky.** `components/layout/Topbar.tsx:98` is `h-16 … shrink-0 border-b relative z-10` — a flex sibling *outside* the scrollport. So the preview never actually paints over it; it gets clipped at that boundary, which is what "stuck in the top menu" looks like.
- **`position: sticky` creates a stacking context**, so the phone notch's `z-30` at `:1577` is trapped inside the preview and cannot be raised to escape. Do not try to fix this by bumping the notch.
- **`ImpersonationBanner`** (`components/layout/ImpersonationBanner.tsx:26-28`, `sticky top:0 zIndex:100`) renders *outside* the `h-screen` shell, so when active it pushes the whole 100vh shell down and makes the maths worse.

### The fix

```tsx
// components/dashboard/SettingsPage.tsx:1554
<div
  className="w-[300px] shrink-0 hidden lg:flex flex-col items-center"
  style={{
    position: "sticky",
    top: "var(--staff-tabbar-h)",        // clear the sticky tab strip — never 0
    zIndex: 10,                           // explicitly below the strip's z-20
    maxHeight: "calc(100dvh - var(--staff-topbar-h) - var(--staff-tabbar-h) - 3rem)",
    justifyContent: "flex-start",         // never centre un-shrinkable content
    overflow: "hidden",
  }}
>
```

Four changes, each load-bearing: the offset clears the strip; the explicit z-index ends the paint fight; `flex-start` makes upward overflow impossible; `100dvh` replaces `100vh` (already mandated by UI-RULES §9). If the frame still cannot fit on short viewports, scale it with `transform: scale()` rather than letting it overflow.

Note the inline `style={{}}` carrying static values is itself on the UI-RULES §11 anti-pattern blacklist — moving these to classes is the tidier landing.

### Add the chrome-height tokens (`app/globals.css`, beside lines 337-341)

The staff side has **no** header-height constant. `h-16` at `Topbar.tsx:98` is the only source of truth, and ten places hardcode a duplicate of it. The member side already proves the pattern works:

```css
--member-nav-clearance: calc(env(safe-area-inset-bottom) + 64px);
--member-header-clearance: calc(max(env(safe-area-inset-top), 14px) + 59px);
```

Add the staff equivalents and consume them everywhere:

```css
--staff-topbar-h: 64px;          /* components/layout/Topbar.tsx h-16 — change one, change the other */
--staff-tabbar-h: 56px;          /* SettingsPage.tsx:1133 sticky tab strip */
--staff-nav-clearance: calc(env(safe-area-inset-bottom) + 60px);  /* MobileNav.tsx:131 */
```

### The wider class of bug (Noe said "ensure this doesn't happen")

This is one instance of a systemic gap. An audit of every sticky and fixed element found:

- **Only 6 sticky elements exist**, and every one uses `top: 0`. Five are legitimately top-level bars owning y=0 in their own scrollport. `SettingsPage.tsx:1554` is the *only* content sitting beneath another sticky bar — and it copied `top: 0` from the pattern anyway.
- **Ten hardcoded pixel offsets duplicate a chrome height** and will drift. The worst: `components/ui/Toast.tsx:98` uses `bottom: calc(env(safe-area-inset-bottom) + 96px)` — a hand-copied guess at "nav + margin" that ignores `--member-nav-clearance` entirely, and Toast is global, so that one number must simultaneously be right on staff mobile (60px nav), member (64px nav) and desktop (no nav). It is wrong on at least two of the three.
- **z-index is ad-hoc** with real collisions: `ImpersonationBanner` and `Toast` both claim z-100 (resolved only by DOM order); ~25 elements share z-50 including MobileNav's More sheet and every modal; and two *dropdown menus* (`MemberProfile.tsx:733`, `FamilySection.tsx:224`) sit at z-40, the value used for *modal backdrops* — `FamilySection`'s kebab menu therefore paints over the member bottom nav and header.
- **`app/dashboard/layout.tsx:81`** sets `z-20` on a statically-positioned element, where z-index is inert. The staff mobile header is also not sticky (its parent uses `min-h-screen`, so the document scrolls and the header scrolls away) — asymmetric with the member header, which is sticky.
- **`components/member/EditChildModal.tsx:89`** is the one member sheet missing `paddingBottom: var(--member-nav-clearance)`; its actions can land under the tab bar.

**Add to `docs/UI-RULES.md` §5** — the mirror of the already-ratified bottom rule at line 69:

> **Sticky content clears the chrome above it.** A sticky element inside a scrollport that already contains a sticky bar must offset by that bar's height via a token (`--staff-tabbar-h`, `--staff-topbar-h`), never `top: 0`, and must declare a z-index below it. Never centre un-shrinkable content in a viewport-derived box — it overflows upward where the scrollport clips it and no scroll position can recover it. (ratified 2026-08-18)

---

## 2. BUG — "no change vs last month looks a bit ugly"

**Where:** the report metric cards. `components/dashboard/ReportsView.tsx`.

### Root cause

`trendText()` at `:72-78` returns the bare string `"No change"` when delta is zero, and the `Trend` pill at `:171-179` renders:

```tsx
<span
  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold"
  style={{ color, background: tone === "flat" ? "var(--sf-2)" : hex(color, 0.12) }}
>
  <Icon className="w-3 h-3" />
  {trendText(current, previous)} {label}
</span>
```

"No change" plus the label "vs last week" is 22 characters in an `11px` pill with **no `whitespace-nowrap`**, sitting in a `xl:grid-cols-6` grid beside a 32px icon chip. It wraps to three lines and the `rounded-full` pill deforms into a lumpy blob — exactly what Noe screenshotted.

### The fix

A badge whose entire message is "nothing happened" is not worth a badge. Render nothing when flat, and keep the pill for actual movement:

```tsx
function Trend({ current, previous, label }: { current: number; previous: number; label: string }) {
  const tone = trendTone(current, previous);
  if (tone === "flat") return null;          // silence beats a three-line "No change"

  const Icon = tone === "up" ? ArrowUpRight : ArrowDownRight;
  const color = tone === "up" ? "var(--hue-success)" : "var(--hue-warning)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{ color, background: hex(color, 0.12) }}
    >
      <Icon className="w-3 h-3" />
      {trendText(current, previous)}
      <span className="font-normal" style={{ color: "var(--tx-3)" }}>{label}</span>
    </span>
  );
}
```

Three things changed and each earns its place: **flat renders nothing**, so a quiet week is quiet; **`whitespace-nowrap`** guarantees the pill can never deform again regardless of grid width; and the **label drops to normal weight in muted ink** so the number leads and the comparison recedes.

If a flat state must stay visible for reassurance, the correct treatment is a muted `—` in the card's detail line, not a pill.

Note the hardcoded `#22c55e` / `#f59e0b` at `:170` and `:553` are hex literals in `.tsx`, which the CI ratchet counts (`scripts/check-ui-rules.mjs`) and UI-RULES §2 forbids — replace with `--hue-*` tokens while you are in there. Do not raise a ratchet baseline to accommodate them; counts may only go down.

---

## 3. Icons — the blue skinny M

> Noe: *"can we make it so the blue M appears here"* (browser tab) and *"for the blue M i prefer the skinny M we used in the previous ascii font"*

### Current state, verified by opening each file

| File | State |
|---|---|
| `app/favicon.ico` | Switched to blue in commit `860e78e` |
| `public/icons/icon-192.png` | **Black placeholder, heavy M** |
| `public/icons/icon-512.png` | **Black placeholder, heavy M** |
| `public/apple-touch-icon.png` | **Black placeholder, heavy M** |

`app/manifest.ts:17-40` advertises the two `icons/*` files for every PWA surface, including `purpose: "maskable"`. So the installed app, the Android home screen and several browser surfaces still show black — which is why Noe still sees a dark M despite the favicon commit.

### What to do

1. Use the **skinny M letterform** — the thin-stroke mark from the earlier wordmark, not the heavy M currently in those PNGs. Confirm the letterform against a rendered preview before shipping; do not guess at "skinny".
2. Regenerate all four assets from **one** source so they can never drift again, and add `app/icon.png` so Next.js serves a high-resolution tab icon rather than relying on the legacy `.ico`.
3. **Maskable safe zone:** Android crops maskable icons to a circle. The M must sit within the central 80%, or the strokes get clipped.
4. Verify by opening each written file as an image and confirming the blue skinny mark — not by trusting the write succeeded. Favicon caching is aggressive, so verify the deployed tab in a fresh profile or with a cache-busting query.

---

## 4. Detailed error reports

> Noe: *"include detailed error reports in case an error occurs so i can properly asses what the error is"*

Today a failure shows the user a friendly message and gives Noe nothing to diagnose with. `lib/api-error.ts` deliberately withholds internals from the client — that is correct and must not change, because leaking stack traces to gym members is a security regression. The gap is that **nothing correlates what the user saw with what the server logged**.

Design:

- Generate a short **error reference** at the point of failure (e.g. `MF-7Q2K4A`). Log it server-side alongside the full stack, route, tenant id, user id and timestamp. Return it to the client as an opaque id and nothing more.
- Surface it in `components/ui/ErrorState.tsx` and the segment `error.tsx` boundaries with one-tap copy, so Noe can quote a reference and it maps to an exact server log line.
- Tag the Sentry scope with `tenantId` and the same reference — this also closes the "no tenant observability" gap the earlier audit raised.
- A staff-visible recent-errors view is the natural follow-on. Scope it as a decision, do not build it blind.

Build and test this like a feature, not a logging tweak. The error-reference must appear in the response body, the log line and the UI, and a test should assert that a 500 never leaks a stack trace to the client.

---

## 5. Brand assets — what imagery to generate

> Noe: *"i have access to AI to make custom image icons for my app… what kind of images i could provide"*

MatFlow's weakest visual moments are **empty states, first-run and celebration screens**. That is where generated art pays off, in value order:

1. **Empty states** — the highest value, because a new gym sees these on day one and every one is currently text-only: no members yet, no classes scheduled, no payments taken, no attendance this week, no announcements.
2. **Milestone and achievement art** for the Your Journey progress feature: mat-hours milestones, attendance streaks, Mat Anniversary. **Hard constraint: nothing may imply belt progression by attendance.** Coaches decide belts; art suggesting otherwise breaks the product's core doctrine.
3. **Class-type marks** — Gi, No-Gi, Open Mat, Fundamentals, Kids, Competition — for the timetable and member schedule.
4. **Onboarding and kiosk welcome art** — the owner's first ten minutes, and the wall tablet members see every session.
5. **Landing hero and feature imagery** — the commercial credibility surface.
6. **Email header art** for receipts, invites and announcements.
7. **404 and error companions** so failures feel designed rather than broken.

Technical brief for the generator:

- **Transparent SVG preferred**; PNG at 1x/2x/3x otherwise. Empty-state art ~320px wide; icons on a 24px grid.
- **Must work on both surfaces** — the staff dashboard is light, the member portal is dark. Supply both variants or use art that reads on both.
- **Must survive tenant branding.** Owners recolour the app, so art must not bake in MatFlow blue where a tenant accent belongs (ratified UI-RULES §2a). Monochrome art tinted by a token is safest.
- **One consistent style** — fix the line weight, corner radius and detail level once and hold it, or the app will look assembled from stock.
- **No photorealistic faces** (data-protection optics for a product holding children's records) and **no martial-arts cliché** — the audience are practitioners who will wince.

---

## 6. Current state of the gates

Run on 2026-08-17 against `7acd2e4` plus the uncommitted work described below.

| Gate | Result |
|---|---|
| `npm run lint` | **Green.** ESLint 39 errors → **0**; UI-RULES ratchet passing |
| `npx tsc --noEmit` | **Green**, zero errors |
| `npm run build` | **Green** |
| `npm test` | **Green** — 573 passed, 0 failed, 74 skipped |
| Playwright 82-test matrix | **80 passed, 2 failed** — see below |
| `npm audit` | **30 vulnerabilities: 3 critical, 11 high** |

### The two failing tests

`/dashboard/checkin` and `/dashboard/promotions` render tests fail. Both passed earlier the same day. Both are pages the restyle session is actively editing, so this is **very likely their in-flight work rather than a shipped regression** — but it is unconfirmed, and **the tree is not releasable until it is explained**. Confirm by stashing nothing and instead testing a clean checkout of `HEAD` in a separate worktree.

### The npm audit findings — take these seriously

Two are directly relevant to a multi-tenant app handling money and children's data:

- **`@auth/core` (critical)** — email-normalisation homoglyph bypass; validation runs before Unicode normalisation.
- **`next` (high)** — Middleware/proxy bypass in App Router. This app gates routes through `proxy.ts`.

Also present: `undici` TLS cert-validation bypass, `sharp` libvips CVEs, `postcss` XSS, `ip-address` SSRF.

### Uncommitted work already on disk (mine, verified green)

Do not discard these; they are what turned lint green:

- `components/ui/ConfirmDialog.tsx` — **new primitive** (UI-RULES §5 called for it; it did not exist). Keyboard accessible, focus-trapped, destructive variant, clears the mobile bottom nav.
- Ten `confirm()`/`alert()` call sites converted to it, across `DsarActions`, `FamilySection`, `ApplicationsClient`, `member/shop`, `WhoIsTrainingPicker`, `ImportPanel`, `RanksManager`, `KidPhotosAndWaiver`.
- `scripts/check-ui-rules.mjs` — five baselines lowered to lock in real progress. Each was set to `max(working tree, HEAD)` so neither tree can fail. **Never raise a baseline.**
- 39 ESLint fixes with no suppressions and no `any`: `types/next-auth.d.ts` gained the fields `authorize()` genuinely returns, and twelve `(user as any)` casts in `auth.ts` became typed reads.
- `tests/e2e/audit/harvest.spec.ts` + `playwright.config.ts` — a screenshot/axe harvester behind an `AUDIT_HARVEST=1` gate. Without that env var the project list is byte-identical, so a bare run still yields the same 82 tests.
- `docs/runbooks/USER-ACTIONS-2026-08.md` — the things only Noe can do.

Three ESLint fixes were **behavioural** and deserve exercise: `app/member/layout.tsx` (branding load path moved to `useSyncExternalStore`), `components/transitions/PageTransition.tsx`, `app/waiver/open/page.tsx` (missing-token error state).

---

## 7. Blocked on Noe — no code can fix these

Full detail in `docs/runbooks/USER-ACTIONS-2026-08.md`. Ranked:

1. **Email DNS for matflow.studio** — no SPF, DKIM, DMARC or MX, so `lib/email.ts` falls back to the Resend sandbox sender and **a new gym owner can never be activated** (approval mints a magic link that production withholds from the API response). ~75 minutes of dashboard work. This is the single highest-value item in the repo.
2. **Production env vars in Vercel** — `RESEND_WEBHOOK_SECRET` is provably unset (live 503). Eight others unverified.
3. **Confirm `DATABASE_URL` uses the Neon pooled host** (hostname contains `-pooler`). The repo `.env` points at the non-pooler host; ~10 concurrent instances would exhaust Neon's connection limit.
4. **GitHub Actions backup secrets** — the weekly S3 backup has failed every Sunday since July. Separately, **Vercel Blob has no backup at all**, so waiver signatures (legal injury-claim evidence) and member photos are unrecoverable.
5. **Stripe webhook must be a Connect-type endpoint** — the handler requires `event.account` and 400s without it. If registered as an account-type endpoint, every handler below is dead code.
6. **MatFlow Ltd incorporation** → ICO data-protection fee.

---

## 8. Suggested order of work

1. Confirm the two failing matrix tests are the restyle session's, not a real regression. Nothing ships until this is answered.
2. Icons — self-contained, no conflicts, visible win.
3. Error references — self-contained, and it makes every later bug cheaper to diagnose.
4. The overlap regression guard (below), then the two component fixes once the restyle session lands.
5. The `npm audit` criticals.

### On the regression guard

The existing guard could never have caught the phone-preview bug, which is why it shipped. `tests/e2e/ui-audit-staff.spec.ts:130-170` probes **only the last** interactive element on a page, **only** `<button>`/`<a>`, **only** for bottom-edge obstruction, and is gated behind `if (isMobile)` — while the broken preview is `hidden lg:flex`, i.e. **desktop-only**. Every axis of the failure fell outside the net.

**This guard now exists and is proven.** `tests/e2e/ui-audit-overlap.spec.ts` runs on desktop *and* mobile across staff and member routes, probes all visible elements including non-interactive panels, decides paint order by `elementFromPoint` rather than z-index arithmetic, and asserts three things: a pinned element covered by opaque chrome, a normal-flow element covered at every scroll offset, and content clipped above its scrollport origin.

Run it with:

```bash
UI_OVERLAP_AUDIT=1 PLAYWRIGHT_BASE_URL=http://localhost:3999 \
  npx playwright test tests/e2e/ui-audit-overlap.spec.ts --project="overlap-staff-desktop"
```

It is gated behind `UI_OVERLAP_AUDIT=1`, so a bare `npx playwright test` still yields the same 82 tests and CI cannot break on it.

**Measured result against the current tree — 8 failed, 14 passed, 5 skipped.** It fails on `/dashboard/settings?tab=branding` (the reported bug) *and on all seven other Settings tabs*, while every non-Settings route passes. So this is not a false-positive machine, and the problem is **wider than the phone preview**: the sticky tab strip at `SettingsPage.tsx:1133` traps an ~18px band of content on **every** Settings tab, observed at `scrollTop: 0`.

That widens the fix. As well as the phone-preview offset, the content column beneath the tab strip needs top clearance equal to the strip's height (`--staff-tabbar-h`), or the strip needs to stop being sticky. Re-run the guard after fixing; the target is 0 failures on `overlap-staff-desktop`.

One detail worth keeping if you rewrite any of this: the strip's computed `background-color` is `rgba(0,0,0,0)` because it paints via `background: linear-gradient(...)`. A guard testing only `background-color` opacity would have missed this exact bug. It is caught by also testing `background-image` and `backdrop-filter`.
