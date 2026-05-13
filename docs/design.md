# MatFlow — Design System

> **This document describes the design system as built**, not a prescription for a future one.
> The live tokens are in [`app/globals.css`](../app/globals.css). If this doc and that file disagree, the CSS wins; update this doc.

**Status:** living doc — last revised 2026-05-14.
**Audience:** humans + every AI agent (Claude Code / Cursor / Codex) generating UI for this codebase.

---

## 0. How to use this document

- Reading this is the **first step** before any UI change.
- Every component decision answered here is the law: don't invent alternatives mid-PR.
- If a question isn't answered here — make the decision, **add it to this doc**, then implement.
- The tokens are defined in `app/globals.css`. Change the CSS to evolve the system; this doc tracks the result.

---

## 1. Two-layer brand model

MatFlow has **two distinct brand layers**. Confusing them is the #1 cause of inconsistent UI.

### Layer A — MatFlow product chrome (this doc)

The colours / typography / layout of **MatFlow itself**, consistent for every gym, on every page:
- Marketing site (`matflow.studio`)
- Login / auth pages
- Super-admin pages (`/admin/*`)
- Onboarding wizard
- Settings pages

This layer is **dark-first** (body bg `#07090e`) with a surface-depth hierarchy and white-alpha text. iOS/macOS-modern aesthetic with glass effects and tactile micro-interactions.

### Layer B — Tenant brand (per-gym customisation)

Each gym's own colours / logo / font, applied **only** to tenant-facing surfaces:
- Owner dashboard accents (active nav state, brand-coloured CTAs in tenant context)
- Member portal (top-bar logo + brand-coloured progress / accents)
- Kiosk check-in screen
- Transactional emails

**Tenant fields on `Tenant`:** `logoUrl`, `logoSize`, `primaryColor`, `secondaryColor`, `textColor`, `bgColor`, `fontFamily`. The default `primaryColor` for new tenants is `#3b82f6` (see seed + `app/member/layout.tsx`). Existing tenants: `totalbjj` = `#1d4ed8`, `noetest` = `#be123c`.

**Where tenant brand lands in CSS:** the `--color-primary` token (default = oklch greyscale `0.205`) is overridden at runtime in tenant-facing layouts from the session's `primaryColor`. The focus-ring rule explicitly falls back to `#3b82f6` if no tenant override is present.

**Rule:** MatFlow chrome surfaces (super-admin, marketing, login) never inherit tenant brand — they always render the dark surface system below.

---

## 2. MatFlow brand — what's actually in `app/globals.css`

### 2.1 Voice / personality

- **Direct.** No fluff, no marketing-speak.
- **British English.** Colour, behaviour, optimise. Never optimize / color / neighborhood.
- **Strong but not loud.** Combat-sport heritage; confident, never aggressive.
- **Reads like a coach.** Imperative voice in CTAs ("Save changes", "Add member"); encouraging in empty states.
- **Numbers matter.** Show real metrics. No fake "10x your gym" claims.

### 2.2 Colour tokens

Two layered systems coexist in `globals.css`. **Both are live.**

#### A. shadcn primitives (oklch greyscale)

Shadcn components read these. They're defined as oklch values — convert mentally to "near-black on near-white" for light mode, inverted for dark.

```css
:root {
  --background:           oklch(1 0 0);          /* white */
  --foreground:           oklch(0.145 0 0);      /* near-black */
  --card:                 oklch(1 0 0);
  --card-foreground:      oklch(0.145 0 0);
  --primary:              oklch(0.205 0 0);      /* dark grey ≈ #2c2c2c */
  --primary-foreground:   oklch(0.985 0 0);      /* off-white */
  --secondary:            oklch(0.97 0 0);
  --muted:                oklch(0.97 0 0);
  --muted-foreground:     oklch(0.556 0 0);
  --accent:               oklch(0.97 0 0);
  --destructive:          oklch(0.58 0.22 27);   /* red */
  --border:               oklch(0.922 0 0);
  --input:                oklch(0.922 0 0);
  --ring:                 oklch(0.708 0 0);
  --radius:               0.625rem;              /* 10px base */
}

.dark { /* shadcn dark — used by primitives only */
  --background:           oklch(0.145 0 0);
  --foreground:           oklch(0.985 0 0);
  --primary:              oklch(0.87 0 0);       /* light grey */
  --destructive:          oklch(0.704 0.191 22);
  /* …rest mirrors light by inversion */
}
```

#### B. MatFlow surface system (dark-first, OLED-optimised)

The product's actual visual identity. Body is `--sf-bg` regardless of the shadcn `.dark` toggle.

```css
:root {
  /* Surface depth scale — deepest at bg, lifting through cards / modals / tooltips */
  --sf-bg:  #07090e;   /* body */
  --sf-0:   #0b0e15;   /* sidebar, navigation */
  --sf-1:   #0f1219;   /* primary cards */
  --sf-2:   #141720;   /* hover on cards */
  --sf-3:   #1a1d28;   /* modals, drawers */
  --sf-4:   #1f2330;   /* tooltips, popovers */

  /* Border scale — subtle white-alpha so depth comes from the surface beneath */
  --bd-default: rgba(255,255,255,0.06);
  --bd-hover:   rgba(255,255,255,0.11);
  --bd-active:  rgba(255,255,255,0.18);

  /* Text scale — alpha-on-dark, hierarchical */
  --tx-1: rgba(255,255,255,0.95);  /* headings, body */
  --tx-2: rgba(255,255,255,0.60);  /* secondary, metadata */
  --tx-3: rgba(255,255,255,0.35);  /* placeholders, disabled */
  --tx-4: rgba(255,255,255,0.20);  /* faintest hints */

  /* Glass */
  --glass-bg:   rgba(255,255,255,0.04);
  --glass-blur: 14px;
}
```

Utility classes (already in `globals.css`):
- `.sf-0` … `.sf-3` — set background to that surface
- `.glass` — frosted background with `backdrop-filter: blur(14px)` and `--bd-default` border; hover lifts to `--bd-hover`

#### C. Tenant brand integration

The shadcn `--primary` token is the **same slot tenant brand lands in** when a tenant-context layout overrides it from the session. So:
- Super-admin / marketing / login → `--primary` stays at default (near-black greyscale)
- Owner dashboard / member portal / kiosk → `--primary` overridden by `session.user.primaryColor` (default `#3b82f6`)

`ThemeProvider` (`components/layout/ThemeProvider.tsx`) injects `--color-primary`, `--color-secondary`, `--color-text`, plus derived helpers like `--color-primary-dim` (low-alpha tint used for active-nav backgrounds, glow shadows, badge backgrounds).

**Practical rule for components:** read `bg-primary text-primary-foreground` for CTAs — they auto-adapt across MatFlow chrome vs tenant brand contexts.

#### D. Dashboard-layout override (owner chrome)

`app/dashboard/layout.tsx` re-declares the `--sf-*` / `--tx-*` / `--bd-*` / `--glass-bg` vars **inline** with slightly different values (deeper body bg `#0a0b0e`, softer text alpha 90% / 60% / 35% / 15%, more saturated surfaces). Treat the dashboard as its own variant of the dark theme — values in section 2.2 are the *global base*; the owner-side chrome lifts them. If you change the global tokens, also check the inline override block in the layout.

#### E. Member portal — parallel token system (`--member-*`)

The member portal does **not** use the `--sf-*` / `--tx-*` system directly. It has its own theme-aware tokens declared on `#member-app`, computed at runtime based on the tenant's `bgColor`:

```css
--member-text             /* primary text (≈ #0f172a in light mode, #ffffff dark) */
--member-text-muted       /* secondary text */
--member-text-dim         /* placeholders, tertiary */
--member-surface          /* card / panel bg */
--member-border           /* borders */
--member-hr               /* hairline dividers */
--member-inactive         /* inactive nav icons / labels */
--member-elevated         /* elevated card bg */
--member-elevated-border  /* elevated card border */
```

These adapt at runtime to a light or dark scheme. **Member pages should reference `--member-*`, not `--sf-*`.** Components meant to render in both owner and member contexts must read from both or be re-skinned.

#### F. Tenant brand input sanitisation

Tenant-controlled values are sanitised at the layout level before being interpolated into CSS — critical defence against CSS / style injection via brand fields:

```ts
isHexColor(s)         // /^#[0-9a-fA-F]{3,8}$/
isSafeFontFamily(s)   // /^[A-Za-z0-9 ,'"_-]+$/ AND length < 100
```

When you build any new feature that accepts tenant-controlled values that flow into style props (logos, colours, fonts), apply the same validator pattern. **Never interpolate raw tenant values into a `style={}` prop without validation.**

### 2.3 Typography

**Owner dashboard, marketing, login, kiosk, super-admin:**
- **Sans:** Geist (Vercel) via `next/font/google`, exposed as `--font-geist-sans` and `--font-sans`
- **Mono:** Geist Mono, exposed as `--font-geist-mono` and `--font-mono`

`html` has `font-sans` applied. Body inherits.

**Member portal — tenant-driven font selection:**

The member portal **dynamically loads** the font specified in the tenant's `fontFamily` field. The supported set is whitelisted in `app/member/layout.tsx`:

`Inter`, `Montserrat`, `Oswald`, `Plus Jakarta Sans`, `Barlow`, `Space Grotesk`, `DM Sans`, `Teko`, `Poppins`, `Outfit`, `Raleway`, `Saira`.

Font is injected as a Google Fonts `<link>` tag on first render, after passing the `isSafeFontFamily` regex. If a tenant has chosen a font outside the whitelist or set an invalid value, the layout falls back to `'Inter', sans-serif`.

When adding a new supported font: update the `FONT_IMPORTS` map in `app/member/layout.tsx` AND the settings UI font picker. Don't add fonts to one without the other.

**Scale (Tailwind defaults):**

| Token | Size / line | Use |
|-------|-------------|-----|
| `text-xs` | 12 / 16 | Badges, helper text, timestamps |
| `text-sm` | 14 / 20 | Table cells, form labels, secondary text |
| `text-base` | 16 / 24 | Body text, input values (default) |
| `text-lg` | 18 / 28 | Card titles |
| `text-xl` | 20 / 28 | Page section titles |
| `text-2xl` | 24 / 32 | Page titles |
| `text-3xl` | 30 / 36 | Dashboard hero numbers, marketing headers |
| `text-5xl` | 48 / 56 | Marketing hero only |

**Rules:**
- Body ≥ 16 px outside explicit metadata zones.
- Two weights max per page: **600 (semibold)** for headings, **400 (regular)** for body.
- Numbers in tables / financial contexts: `font-variant-numeric: tabular-nums`.

### 2.4 Spacing

Tailwind defaults (4 px grid). Use `space-1` through `space-16`. No arbitrary values.

### 2.5 Radius / shadow / motion (matches `app/globals.css`)

```css
/* Radius (MatFlow custom + shadcn-derived) */
--r-sm:  8px;   /* badges, small chips */
--r-md:  12px;  /* buttons, inputs */
--r-lg:  16px;  /* cards */
--r-xl:  20px;  /* modals, large cards */

/* shadcn radius scale, derived from --radius (10px) */
--radius-sm:  6px;     /* calc(--radius * 0.6) */
--radius-md:  8px;     /* calc(--radius * 0.8) */
--radius-lg:  10px;    /* --radius */
--radius-xl:  14px;    /* calc(--radius * 1.4) */
--radius-2xl: 18px;
--radius-3xl: 22px;
--radius-4xl: 26px;

/* Motion — three speeds + custom curves */
--dur-fast:    150ms;   /* button states, toggles, touch feedback */
--dur-normal:  250ms;   /* dropdowns, tooltips, card transitions */
--dur-slow:    400ms;   /* modals, page entrances, large reveals */

--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);    /* iOS-style decel, used for most entrances */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* deliberate spring — sparingly, for delight moments */
```

Pre-built animation utilities in `globals.css`:
- `.animate-fade-up` — 400 ms ease-out, 10 px translate
- `.animate-fade-in` — 250 ms ease-out
- `.animate-scale-in` — 250 ms ease-out, 0.96 → 1
- `.animate-slide-from-right` / `.animate-slide-from-left` — 220 ms, used for day-of-schedule swiping
- `.stagger-1` through `.stagger-4` — 30 / 60 / 90 / 120 ms delays for staggered list entrances
- `.skeleton` — 1.4 s shimmer for loading content (preferred over spinners)
- `.animate-pulse` — 1.5 s soft pulse

`@media (prefers-reduced-motion: reduce)` disables `.animate-fade-up`, `.animate-fade-in`, `.animate-scale-in` automatically.

### 2.6 Tactile / mobile feel (already baked into `globals.css`)

- **Active-state scale:** every `button`, `a`, `[role="button"]` gets `transform: scale(0.97)` on `:active` with 150 ms transition. Native-app tactile feedback.
- **Min touch target:** 44 × 44 px enforced globally on `button, a, input, select, textarea, [role="button"]` (WCAG 2.5.5).
- **Webkit tap-highlight** removed (`* { -webkit-tap-highlight-color: transparent }`).
- **Overscroll** on body disabled (`overscroll-behavior-y: none`) — no rubber-band on page-level scrolls.
- **Font smoothing:** `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility`.
- **Safe-area insets** supported: utility classes `.pb-safe`, `.pt-safe`; member portal has `--member-nav-clearance` (`env(safe-area-inset-bottom) + 64px`) for the fixed bottom nav.
- **Scrollbars:** thin (4 px), themed `rgba(255,255,255,0.08)` thumb, transparent track.
- **Focus rings:** `2 px solid var(--color-primary, #3b82f6)` outline with `2 px` offset, shown only via `:focus-visible`. Tenant brand colours flow into focus naturally.

---

## 3. Surfaces — what each looks like

The four (plus kiosk) share components but differ in density and brand-presence.

### 3.1 Marketing site — `matflow.studio` (public)

**Job:** convince a gym owner to sign up.

- Dark-mode aesthetic by default (matches the product). Hero on `--sf-bg`.
- Sections alternate `--sf-0` and `--sf-1` for subtle depth rhythm.
- One primary CTA above the fold ("Start free trial" or "Book a demo", not both).
- Use **real product screenshots** in feature sections — not abstract illustrations.
- Pricing: 3 tiers as cards — Starter £99 / Pro £149 / Elite £199. Highlight Pro as "Most popular".
- Customer logo strip (when there are customers). Logos rendered as `text-tx-2` text or low-contrast SVG.
- Footer on deepest surface (`--sf-bg`).

### 3.2 Login / auth — `/login`, `/login/totp`, `/login/accept-invite`, `/password-reset`

**Job:** get the right person into the right tenant fast.

- Centred single-column layout. Max-width 420 px. Card on `--sf-1` over `--sf-bg` body.
- MatFlow wordmark top of card.
- Page-specific heading `text-2xl font-semibold`, `text-tx-1`.
- Form fields stacked, full-width. Primary button full-width.
- "Forgot password?" / "Use magic link" as secondary text links below the button (`text-tx-2`).
- Brand cue is the focus ring (default `#3b82f6`) and the primary button.
- Errors: red inline banner below the field that errored, never a toast.
- Loading: button shows spinner + label like "Signing in".
- Mobile: card edge-to-edge on screens < 420 px.
- **No split layouts with marketing copy beside the form** — pulls attention away from the task. (The 2026-05-09 ChatGPT redesign of accept-invite went this route and was reverted for exactly this reason.)

### 3.3 Owner dashboard — `/dashboard/*`

**Job:** the gym owner / staff operates from here. **Density and speed > polish.**

#### Desktop chrome (`md` and up)

- **Sidebar** — `w-60` (**240 px**), single width (no collapsed/icon-only mode), full-height, hidden below `md`. Background `var(--sf-0)`, right border `var(--bd-default)`.
  - Top: tenant logo + tenant name + plan badge (if present, in `--color-primary-dim` background).
  - Body: two-section nav — `Main` and `Admin`. Section labels are `text-[10px] uppercase tracking-widest text-tx-4`.
  - Active nav item: background `var(--color-primary-dim)`, text `var(--color-primary)`, **2 px left border `var(--color-primary)`**, left padding compensated to 10 px so the icon doesn't shift.
  - Inactive nav item: text `var(--tx-3)`, hover lifts to `var(--tx-2)` and `bg-white/5`.
  - Footer: "MatFlow" wordmark + version, both in `--tx-4`.
- **Topbar** — 64 px (`h-16`), gradient background `linear-gradient(180deg, rgba(14,16,20,0.96), rgba(10,11,14,0.92))` + 18 px backdrop blur, `border-b var(--bd-default)`.
  - **Left:** 36 × 36 tenant logo + 2-line label — eyebrow "Back Office" (`text-[10px] uppercase tracking-[0.18em] text-tx-4`) above current page title (`text-[15px] font-semibold text-tx-1`). The page title is computed from the URL path against a `pageTitles` map.
  - **Right:** **unified role + account pill** — a single button combining the role badge and the account avatar+name, separated by a 1 px divider. Opens a dropdown with the account summary, "Sign out all devices", and "Sign out".
  - **No search input in the topbar.** Command palette (when added) is the search affordance, not a header input.
- **Tenant brand applies to:** sidebar active nav state, primary buttons, logo placeholder bg, account avatar gradient, focus rings.
- **Page content area:** `flex-1 overflow-y-auto p-6`. Page header (title + optional description + primary action) follows, then toolbar row (if applicable), then cards / tables / lists.
- **Data density is OK.** `text-sm` in table rows, tight card padding, no oversized whitespace.

#### Mobile chrome (below `md`)

`app/dashboard/layout.tsx` renders an **entirely separate mobile layout**, not a responsive collapse of the desktop one.

- **Mobile header** — fixed top, safe-area-aware, blurred (20 px). Three-column grid: 36 × 36 tenant logo (left) / centred tenant name `text-sm text-tx-1` / 32 × 32 avatar circle in `--color-primary` with initials (right).
- **Main content area** — `flex-1 overflow-y-auto px-4 py-5 pb-28` (bottom padding clears the nav bar).
- **Bottom tab bar** (`components/layout/MobileNav.tsx`):
  - **4 primary tabs** by role: Home, Schedule, Members, Mark Attendance.
  - **"Mark Attendance" is a floating circular FAB**, lifted with `-mt-4`, 56 × 56 (`w-14 h-14`), filled with tenant `primaryColor`, glow shadow `0 4px 20px ${primaryColor}60`. The action-priority pattern — check-in is the most common staff action.
  - **"More" trigger** (`MoreHorizontal` icon) opens a bottom sheet with overflow nav items (Attendance, Ranks, Notifications, Reports, Analysis, Settings) plus Sign Out.
  - More sheet: dark backdrop `bg-black/60`, sheet background `#0e1013`, rounded top corners (20 px), slide-up transition 300 ms ease-out.
  - Active tab: icon and label use tenant `primaryColor`; inactive use `rgba(255,255,255,0.35)`.
  - Active-tap feedback: `active:scale-90` on all tabs.
- **Theme override:** the layout inline-overrides the `--sf-*` / `--tx-*` / `--bd-*` tokens for the dashboard scope (see §2.2.D). These don't bleed into the member portal.

#### Cross-cutting

- **Impersonation banner** (`components/layout/ImpersonationBanner.tsx`) — fixed-position when super-admin is impersonating, renders above all chrome.
- **2FA-recommend banner** (`components/layout/Recommend2FABanner.tsx`) — appears for any staff role with `totpEnabled: false`. Disappears once enrolled.
- **Role colour identity** — see new §5.

### 3.4 Member portal — `/member/*`

**Job:** members check in, see schedule, view progress, manage profile. **Clarity and tenant-brand presence > density.**

#### Theme model — NOT dark-first

The member portal is **mode-agnostic** — it adapts at runtime to the tenant's `bgColor`. Luminance check (`bgLuma > 160`) flips the entire surface to light mode with a CSS overlay (`#member-app .text-white`, `.bg-white/X`, `.border-white/X` selectors all get inverted to dark equivalents).

- **Light tenant:** body `bgColor`, text `#0f172a`, surfaces `rgba(0,0,0,0.04)`, borders `rgba(0,0,0,0.08)`
- **Dark tenant:** body `bgColor`, text `#ffffff`, surfaces `rgba(255,255,255,0.04)`, borders `rgba(255,255,255,0.07)`

Member pages should use the `--member-*` tokens (see §2.2.E) so they adapt automatically.

#### Top bar

- Fixed top, safe-area-aware, **20 px backdrop blur**, semi-transparent `${appBg}ee`, theme-aware border.
- **Three-column grid:** 36 px spacer (left) / centred tenant brand (logo or gym name) / 36 px **Shop bubble** (pinned right).
- Tenant logo: rendered with optional `logoBg` ("none" / "black" / "white") frame, height 44 px, max-width fitted. Falls back to a 36 × 36 tenant-primary square with the first two letters of the gym name when no logo set.
- Shop bubble: 36 × 36 circular button → `/member/shop`, theme-aware bg, theme-aware border, `active:scale-90`.

#### Bottom tab bar

- **Fixed bottom**, 4 tabs: **Home, Schedule, Progress, Profile**.
- 20 px backdrop blur, theme-aware bg (`${appBg}f5` light / `rgba(10,11,14,0.97)` dark), theme-aware top border, safe-area bottom padding.
- Active tab: icon + label in tenant `primaryColor`, stroke-width 2.5; inactive: theme-aware muted colour, stroke 1.75.
- Active-tap feedback: `active:scale-90`.
- Page content area pads bottom by `--member-nav-clearance` (`env(safe-area-inset-bottom) + 64px`) so content clears the bar.

#### Page-level behaviour

- Cards have `rounded-xl` and more padding than owner dashboard.
- "Check in" / "Book class" are the largest, most prominent CTAs — tenant-primary background, full-width on mobile.
- Belt rank visible in profile header and any member-listing context.
- Group-chat URL (if configured) shown as a tappable card on the home page.
- Schedule day-switching uses `.animate-slide-from-right` / `.animate-slide-from-left`.
- 2FA-recommend banner (member variant) renders below the top bar for password-bearing members who haven't enrolled.

#### Branding refresh

Tenant brand is hydrated in three layers, in this order:

1. `DEFAULT_GYM` fallback — `#3b82f6` primary, `#111111` bg, Inter font, "Total BJJ" name. Renders instantly.
2. `localStorage.gym-settings` — read on mount, populates immediately for repeat visitors.
3. `/api/me/gym` — fetched fresh; **source of truth**. Overrides localStorage and updates it.

Cross-tab updates from the admin settings page propagate via the `storage` event listener — members see brand changes without a refresh.

#### Rule

**No MatFlow branding visible to members.** Members see their gym; the platform is invisible. (Operator and admin chrome shows MatFlow branding; the member layer hides it.)

### 3.5 Kiosk — `/kiosk/[token]`

**Job:** in-gym tablet for self-check-in. **Big buttons, big text, no chrome.**

- Full-screen. No nav, no header, no sidebar.
- Tenant logo top centre.
- Search bar auto-focused. Type name → click. That's the flow.
- Post-check-in: full-screen success state, 5 s auto-dismiss. Large checkmark animation (`.animate-scale-in`), member name, class, "Welcome back".
- Tablet portrait primary.
- All text ≥ 18 px. All buttons ≥ 64 px tall.

---

## 4. Component library

MatFlow uses **shadcn/ui** primitives layered on **base-ui/react** (the new MatFlow stack — `components/ui/button.tsx` imports `Button` from `@base-ui/react/button`). Don't rebuild primitives; use the shipped `Button`, `Toast`, `Skeleton`, etc.

### 4.1 Buttons (`components/ui/button.tsx`)

Variants (from `buttonVariants` cva):

| Variant | Class basis | Use |
|---------|-------------|-----|
| `default` | `bg-primary text-primary-foreground` (hover ~80%) | Single most important action; auto-adapts to tenant brand in tenant context |
| `outline` | `border-border bg-background hover:bg-muted` | Common actions; multiple OK per page |
| `secondary` | `bg-secondary text-secondary-foreground hover:bg-secondary/80` | Alternative to outline for slightly more visual weight |
| `ghost` | `hover:bg-muted hover:text-foreground` | Tertiary actions, icon buttons |
| `destructive` | `bg-destructive/10 text-destructive hover:bg-destructive/20` (**light tint, not solid**) | Destructive (delete, force-logout) |
| `link` | `text-primary underline-offset-4 hover:underline` | Inline text actions |

Sizes:

| Size | Spec |
|------|------|
| `default` | `h-8 gap-1.5 px-2.5` |
| `xs` | `h-6 gap-1 px-2 text-xs` + smaller icon |
| `sm` | `h-7 gap-1 px-2.5 text-[0.8rem]` |
| `lg` | `h-9 gap-1.5 px-2.5` |
| `icon` | `size-8` |
| `icon-xs` | `size-6` |
| `icon-sm` | `size-7` |
| `icon-lg` | `size-9` |

Radius: `rounded-lg` default; xs/sm/icon-xs/icon-sm use `rounded-[min(var(--radius-md),10px)]`.

States (most are global from `globals.css`):
- `:hover` — bg darkens ~10–20% via variant class
- `:active` — `scale(0.97)` (global rule), bg darkens further
- `:focus-visible` — `border-ring ring-3 ring-ring/50` (3 px ring, not 2 px)
- `:disabled` — `pointer-events-none opacity-50`
- `aria-invalid` — destructive border + ring (form validation)

Rules:
- **One `default` (primary) per visible area.** Two equally important means one of them isn't.
- Destructive actions require confirmation modal with explicit action: "Delete member" not "Delete".
- Icon-only buttons (`icon` size variants) need `aria-label`.
- Global rule (in `globals.css`) enforces `min-height: 44px` on `button, a, input, select, textarea, [role="button"]` — the `h-8` button is visually taller than its size token suggests on mobile. Don't fight this; the touch-target floor is enforced at the body-style level.
- For mobile-prominent CTAs (member portal, kiosk), prefer larger explicit padding via the `size="lg"` variant or custom classes.

### 4.2 Inputs

```
bg-sf-1 border-bd-default rounded-md px-3 py-2.5 text-base
text-tx-1 placeholder:text-tx-3
focus-visible: ring-2 ring-primary/30 border-primary
error: ring-2 ring-destructive/30 border-destructive
disabled: opacity-50 cursor-not-allowed
```

Label above input: `text-sm font-medium text-tx-1 mb-1.5`.
Helper text: `text-sm text-tx-2 mt-1`.
Error message: `text-sm text-destructive mt-1`.

Rules:
- **No placeholder-only inputs.** Labels mandatory. Placeholders can show format hints.
- Required fields marked `*` next to label, OR mark optional ones "(optional)" — pick one approach per form.
- First input of a form autofocused.
- Inline validation on blur, not every keystroke.

### 4.3 Cards

```
bg-sf-1 border border-bd-default rounded-lg shadow-none
hover (interactive cards only): bg-sf-2
padding: p-4 mobile, p-6 desktop
header: flex justify-between items-center pb-4 border-b border-bd-default (when needed)
body: pt-4
footer: pt-4 border-t border-bd-default flex justify-end gap-3
```

For overlay/elevated cards (modals etc.) use `.glass` for the frosted backdrop effect.

### 4.4 Tables

```
header:  bg-sf-2 text-xs uppercase tracking-wider text-tx-2 font-medium
row:     border-b border-bd-default hover:bg-sf-2 py-3 px-4
cell:    text-sm; primary text-tx-1, secondary text-tx-2
actions: right-aligned icon buttons or dropdown
sortable: header clickable with arrow indicator
```

Rules:
- Horizontal scroll below `md` (not stacked cards) unless explicitly better.
- Sticky header on scroll.
- Empty state: "No [items] found" + small illustration + CTA.
- Bulk-action toolbar appears above the table when ≥1 row selected.

### 4.5 Modals / dialogs

```
overlay:   bg-black/60 backdrop-blur-sm
container: bg-sf-3 border border-bd-default rounded-xl
sizes:     sm (max-w-md), md (max-w-lg), lg (max-w-2xl)
header:    text-lg font-semibold text-tx-1, close X top-right
footer:    flex justify-end gap-3 pt-4 border-t border-bd-default
animation: .animate-scale-in on open
```

Rules:
- Close on `Escape`.
- Close on overlay click EXCEPT for forms with unsaved changes (confirm first).
- Focus trapped inside.
- Destructive confirmations: action + consequence in the title — "Delete Sean Coates — this cannot be undone".

### 4.6 Badges

```
sm: text-xs px-2 py-0.5 rounded-full
md: text-sm px-2.5 py-1 rounded-full

semantic:
  active:   bg-success/15 text-success
  pending:  bg-warning/15 text-warning
  inactive: bg-sf-2 text-tx-2
  expired:  bg-destructive/15 text-destructive
  info:     bg-info/15 text-info
```

### 4.7 Toasts

- Position: top-right desktop, top-centre mobile.
- Duration: 3–5 s auto-dismiss; persistent only for errors with required action.
- Types: success / error / warning / info — colours via semantic tokens.
- Structure: icon + message + optional action link + close button.
- Animation: `.animate-fade-up` in, fade out.

### 4.8 Empty states

Every list / table / dashboard area has an empty state:
1. Small illustration (~80×80), neutral
2. One-line heading (`text-tx-1 font-semibold`): what's missing
3. Two-line description (`text-tx-2`): what to do about it
4. Primary CTA button

Build empty states alongside the populated state, not after.

---

## 4.9 Role colour identity (owner-side chrome only)

The owner dashboard topbar uses a per-role colour map to make role-context glanceable. Defined in `components/layout/Topbar.tsx`:

| Role | Accent | Soft bg (badge) | Border | Glow |
|------|--------|-----------------|--------|------|
| owner | `#f59e0b` (amber) | `rgba(245,158,11,0.14)` | `rgba(245,158,11,0.34)` | `0 0 24px rgba(245,158,11,0.20)` |
| manager | `#a78bfa` (violet) | `rgba(167,139,250,0.14)` | `rgba(167,139,250,0.32)` | `0 0 24px rgba(167,139,250,0.18)` |
| coach | `#38bdf8` (sky) | `rgba(56,189,248,0.14)` | `rgba(56,189,248,0.30)` | `0 0 24px rgba(56,189,248,0.16)` |
| admin | `#34d399` (emerald) | `rgba(52,211,153,0.14)` | `rgba(52,211,153,0.30)` | `0 0 24px rgba(52,211,153,0.16)` |
| member | `#60a5fa` (blue) | `rgba(96,165,250,0.12)` | `rgba(96,165,250,0.26)` | `0 0 20px rgba(96,165,250,0.12)` |

**Where this lands:**
- Topbar role badge (always visible)
- Dropdown menu role pill (when open)
- Role-context cues elsewhere in the dashboard if added

**Rule:** these are **chrome accents only**, not the tenant primary. Don't reuse them for CTAs / interactive states — those use `--color-primary` (tenant brand).

---

## 5. BJJ-specific components

### Belt rank

| Belt | Display colour |
|------|----------------|
| White | `bg-white text-sf-bg` with `border border-bd-active` |
| Blue | `#1D4ED8` |
| Purple | `#7E22CE` |
| Brown | `#92400E` |
| Black | `#0F172A` (with subtle `border-bd-default` so it's visible on `--sf-bg`) |

Stripes: 1–4 small marks inset to the belt pill. Coral belts (8th+ dan) deferred until needed.

Used in: member cards, profiles, leaderboards, attendance lists, roster gating UI.

### Class card

```
Time         (text-xl text-tx-1, prominent)
Class name   (text-base font-semibold text-tx-1)
Instructor   (text-sm text-tx-2)
Spots: X/Y   (badge, status colour)
[Book]  or  [Full — Join waitlist]
```

### Check-in confirmation (kiosk)

Full-screen overlay on `--sf-bg`. Large `.animate-scale-in` check icon, member name (`text-4xl text-tx-1`), class name, pack credits remaining (if applicable). 3 s auto-dismiss. Subtle success colour wash on the surface, no over-the-top confetti.

### Member profile card

```
Avatar       rounded-full, 64 px (owner view) / 80 px (member view)
Name         text-lg font-semibold text-tx-1
Belt rank    pill
Status       badge: active / paused / expired
Joined       text-sm text-tx-2
Last seen    text-sm text-tx-2
```

---

## 6. Responsive breakpoints

Tailwind defaults. Don't customise.

| Token | px | Notes |
|-------|----|-----|
| `sm` | 640 | Large phones landscape |
| `md` | 768 | Tablets portrait |
| `lg` | 1024 | Small laptops, tablets landscape |
| `xl` | 1280 | Desktops |
| `2xl` | 1536 | Large desktops |

Rules:
- Design **mobile-first**.
- Sidebar hidden below `lg`. Bottom tab bar shown below `lg` on member portal. Hamburger menu shown below `lg` on owner dashboard.
- Tables horizontal scroll below `md`.
- Cards: 1 col mobile → 2 cols `md` → 3–4 cols `lg`.
- Page max-width `max-w-7xl` (1280 px) centred. Marketing site can break wider.

---

## 7. Motion (recap of what's defined)

The MatFlow motion language is already coded into `globals.css`. Use the pre-built classes:

| Pattern | Class | Spec |
|---------|-------|------|
| Default entrance | `.animate-fade-up` | 400 ms ease-out, 10 px translate |
| Subtle entrance | `.animate-fade-in` | 250 ms ease-out |
| Modal / element scale-in | `.animate-scale-in` | 250 ms ease-out, 0.96 → 1 |
| Day swipe (schedule) | `.animate-slide-from-{right,left}` | 220 ms custom cubic |
| Stagger (lists) | `.stagger-1` through `.stagger-4` | 30 / 60 / 90 / 120 ms delays |
| Loading content | `.skeleton` | shimmer, preferred over spinners |
| Button / link tap | global `:active` `scale(0.97)` | 150 ms ease |

Custom curves available: `--ease-out` (iOS-style decel), `--ease-spring` (deliberate spring, sparingly).

Respect `@media (prefers-reduced-motion: reduce)` — the listed `.animate-*` classes disable automatically.

---

## 8. Dark / light mode

- **Body is dark by default** (`body { background: var(--sf-bg) }`). The MatFlow product runs dark.
- The shadcn `.dark` class toggles shadcn primitive colours (cards, forms, etc.) — used when components inside a tenant-light theme need dark variants.
- Tenant brand layouts can re-skin the chrome via `bgColor` / `textColor` / `primaryColor` but the underlying `--sf-*` surface scale stays available for cards and modals.

---

## 9. Accessibility floor

- [ ] Keyboard-navigable (Tab, Shift+Tab, Enter, Escape)
- [ ] Visible focus ring on every focusable element (global `:focus-visible` rule)
- [ ] Contrast ratio ≥ 4.5:1 body, ≥ 3:1 large (verify each new colour pairing)
- [ ] All images have `alt`
- [ ] All icon buttons have `aria-label`
- [ ] Form errors announced (`aria-live="polite"`)
- [ ] Modal focus trapped
- [ ] Skip-to-content link on every page
- [ ] No information conveyed by colour alone
- [ ] Touch targets ≥ 44 × 44 (global rule already enforces minimum)

---

## 10. Anti-patterns (the "no AI slop" list)

These catch generic AI UI generation that doesn't match the live system.

- **Light-mode-by-default screens** that drop the dark `--sf-bg` body. The product is dark; new pages should be too unless explicitly an exception (marketing landing).
- **Purple → pink gradients** on hero or buttons.
- **"Background lights" / animated mesh blobs** behind content. The `.animate-fade-up` + surface depth do the visual work.
- **Hardcoded hex** in components. Always use the tokens (`bg-sf-1`, `text-tx-1`, `bg-primary`, etc.).
- **Pure black `#000` or pure white `#fff`** for chrome. Use `--sf-bg` (`#07090e`) for dark, `--tx-1` (white at 95%) for text.
- **Skipped surface depth** — cards directly on body bg without surface lift. Use `--sf-1` (or `.glass`).
- **Cramped padding** (< 12 px on cards or buttons).
- **Touch targets < 44 px**.
- **Skipped heading levels** (`h1` then `h3`).
- **Lorem ipsum** in committed code.
- **Multi-line buttons** (label too long, or button too narrow).
- **Three+ font weights** in one view.
- **Both icon and emoji** in the same UI.
- **Split layouts (image left, copy right)** on a single-purpose page like login. They divide attention.
- **Tailwind opacity modifiers with leading zeros** — `bg-white/05`, `border-black/08` are NOT generated by Tailwind; the utility is silently dropped and the element falls back to solid colour. Use `/5` / `/10` / etc. (no leading zero). Caught once in `components/dashboard/MemberProfile.tsx` where `inputCls` used `bg-white/05` + `text-white` and produced invisible-text-on-white-box inputs — fixed in commit `93c40a6`.

When generating UI with Claude / Cursor, pair this doc with the **`impeccable`** skill (anti-slop critic) — see `60-Reference/ai/claude-tools-codeburn-impeccable.md` in the vault.

---

## 11. File / folder structure (as built)

```
app/
  globals.css          ← all tokens live here (shadcn + MatFlow surface system)
  layout.tsx           ← Geist fonts wired in; SessionProvider + ToastProvider
  dashboard/           ← owner pages
  member/              ← member portal
  admin/               ← super-admin
  kiosk/[token]/       ← kiosk
  login/               ← auth pages
  api/

components/
  ui/                  ← shadcn primitives (don't rebuild)
    Toast.tsx          ← custom toast provider used app-wide
  dashboard/           ← owner-side components
  onboarding/          ← OwnerOnboardingWizard etc.
  layout/
  …
```

---

## 12. Tech-stack alignment

MatFlow uses **Next.js 16 + TypeScript + Tailwind v4 + shadcn/ui** (per `CLAUDE.md`).

- shadcn primitives via the `shadcn/tailwind.css` import in `globals.css`.
- Tailwind v4 with `@theme inline` mapping CSS vars → utility classes.
- Geist + Geist Mono via `next/font/google`.
- Radix UI primitives (via shadcn) handle accessibility.
- **Do not install additional UI libraries** — the existing stack covers everything.

---

## 13. Documented exceptions

These surfaces deliberately depart from the dark-first MatFlow token system. Each is print-document territory (legible on paper, signed in person, archived as PDF) where a dark theme actively hurts comprehension.

| Surface | File | Mode | Reason |
|---------|------|------|--------|
| Supervised waiver signing | `components/dashboard/SupervisedWaiverPage.tsx` | Light (`#f8f9fa` body, `text-gray-900`) | Legal document — read & signed by parents/guests in person, often printed/archived. Dark theme reduces signature contrast and reads as informal. Kept intentionally light. |

**Rule:** if you need to add another light-mode exception, document it here with the same justification structure first, *then* build it.

---

## 14. When this doc isn't enough

If a design decision isn't covered here:

1. Don't invent in code first. Decide.
2. Add the decision to this doc with a one-line rationale, AND update `app/globals.css` if it introduces a new token.
3. Now build it.

If the brand needs a major change (different primary scheme, different font family, new product surface), change `app/globals.css` first — every component below 4 inherits automatically because everything references tokens.

---

## 15. Kids family + photo evidence patterns (shipped 2026-05-12 → 2026-05-14)

These patterns were added when the parent-side kids feature went out (Session E commits `c2aa855` → `5ce489b`) plus the photo + waiver follow-ups (commits `f8a06cd`, `3b48e09`, Phase 4 `9534e83` / `38f4144`, Phase 5 `931351c` / `b0d3904` / `75835ae`). They're documented here because three of them are now used across multiple surfaces.

### 15.1 Member-portal kid roster card (parent home)

`/member/home` renders a "Your kids" feed above the Next-class hero when `accountType === "parent"` AND the parent has ≥1 kid. Source: `app/member/home/page.tsx` (search `Your kids`).

- Section header: `text-white text-sm font-bold` left + a "Manage →" link right in tenant `primaryColor`.
- Each kid card: `rounded-2xl border p-4`, background `hex(primaryColor, 0.06)`, border `hex(primaryColor, 0.2)` — i.e. the tenant-brand tinted variant of the standard `--member-surface` card.
- Card layout: 44 × 44 initials avatar (gradient from `primaryColor` → `primaryColor 60% opacity`) + name + belt pill + "N classes" meta + chevron icon. Whole card is a `<a href="/member/family/[id]">`.
- Hidden entirely (no empty state) when `accountType !== "parent"` or `kidsRoster.length === 0` — regression-tested in `tests/unit/member-home-parent-mode.test.tsx`.

### 15.2 Kid detail page (`/member/family/[childId]`)

Server-rendered. Composed of (top to bottom):

1. **Back link** to `/member/profile`
2. **Header** — kid name (`text-xl font-bold`) + "Age N · Kids" subline
3. **Belt + Waiver row** — two-tile grid (`grid-cols-2 gap-3`), each `rounded-2xl border p-4`, border `--member-border`
4. **Stats grid (4 tiles)** — `grid-cols-2 gap-3 mb-5`, each tile `rounded-2xl border p-4` showing: This week / This month / Streak (wk) / All time. Each tile = small uppercase label (`text-gray-500 text-xs uppercase tracking-wider`) over a `text-white text-2xl font-bold` number. Streak tile has a "wk" suffix in muted small caps.
5. **Next class panel** — renders only when `nextClass !== null`. Single `rounded-2xl border p-4` card with class name + day/time/coach + optional location icon row.
6. **Photo grid + waiver-sign block** — see §16.4
7. **Recent attendance list** — `rounded-2xl border overflow-hidden` with last-20 check-ins, one row per attendance, top border per row

Stats source: `lib/member-stats.ts` `computeMemberStats(tx, { memberId, tenantId })` — the same helper backs `/api/member/me` and `/api/member/children/[id]`. **If the parent's own dashboard renders a new stat, mirror it in the kid detail page using this helper. Don't re-implement the calculation.**

### 15.3 List-row "…" action menu pattern (FamilySection)

The parent's "My Family" section on `/member/profile` (`components/member/FamilySection.tsx`) introduced the pattern for row-level edit/remove on a member-portal list. Reusable everywhere a parent or member needs to manage their own children/dependents.

- Each row is a `<div>` (NOT a `<button>`) containing a left-side `<button>` that takes most of the row + a right-side 8 × 8 "…" button.
- "…" button: 32 × 32 `rounded-full` with `MoreHorizontal` icon, `text-gray-500`, background `var(--member-surface)`.
- Tapping "…" opens an inline-positioned menu (`absolute right-3 top-12 z-10`), `rounded-xl shadow-lg overflow-hidden w-44`, background `var(--member-elevated)`, border `var(--member-elevated-border)`.
- Menu items: full-width buttons, `px-3 py-2.5 text-sm`, gap-2 with a lucide icon (`Pencil` / `Trash2`). Destructive item uses `text-red-400 hover:bg-red-500/10`.
- Tapping the row itself (not "…") closes any open menu and navigates.
- Destructive action triggers `confirm(...)` — toast / modal-style confirmation is *not* used here because the inline menu is already a soft commit ("you opened a menu, then you tapped Remove").

### 15.4 Photo grid pattern (member + staff surfaces)

Shared 3-column photo grid used in two places:

- **Member portal**: `components/member/KidPhotosAndWaiver.tsx` — inside `/member/family/[childId]`. Wrapped in a `rounded-2xl border` card. Header row has a "+ Add photo" CTA right-aligned. Empty state: `"No photos yet — tap \"Add photo\" to upload one."` Each photo: `aspect-square overflow-hidden rounded-md`, `bg var(--member-surface)`, with a hover-only `Trash2` icon in a `bg-black/60` circle top-right (opacity 0 → 100 on `group-hover`).
- **Dashboard chrome**: `components/dashboard/MemberProfile.tsx` `PhotosTabPanel` — Photos tab in the staff member detail page. Same `grid grid-cols-3 gap-2 p-2` + `aspect-square object-cover rounded-md` cards but without delete affordance (staff use the parent-side flow if they need to remove). Empty + loading states use `text-sm py-8 text-center` with `var(--tx-3)`.

**Source of truth for photo data:** `MemberPhoto` (schema). FK `memberId` is `ON DELETE CASCADE` — photos cascade-clean automatically when a Member is deleted via `lib/member-delete.ts`. Optional FK `memberRankId` links promotion photos back to their `MemberRank` row.

**Visibility rules (enforced server-side, not in CSS):**
- Parent sees photos for their own kids via `GET /api/member/children/[id]/photos`
- Staff sees photos for any member in their tenant via `GET /api/members/[id]/photos`
- Cross-family / cross-tenant attempts return 404 (never 403 — same opacity as adjacent Session E routes)

### 15.5 Sign-waiver modal pattern

`/member/family/[childId]` includes an in-app waiver-sign flow when `child.waiverAccepted === false`. The pattern lives in `components/member/KidPhotosAndWaiver.tsx` `SignWaiverModal` and is the template for any future parent/guardian e-signature surface.

- **Trigger surface**: an amber-tinted banner (`borderColor: rgba(245,158,11,0.25)`, `background: rgba(245,158,11,0.06)`) above the photo grid with an `AlertTriangle` icon, "Waiver missing for [name]" label, and a "Sign waiver" pill button.
- **Modal**: fixed inset, `bg-black/70` overlay, sheet at `bottom` on mobile / `center` on `md+`. `bg-[var(--member-elevated)]` with `border-[var(--member-elevated-border)]` and `rounded-t-3xl md:rounded-3xl`. Max-width `md:max-w-md`.
- **Form**: signer-name input + agree checkbox + drawable `<canvas>` signature pad + "Clear signature" link + primary submit button.
- **Submit** posts to `/api/waiver/sign-for-child` with `{ childMemberId, signatureDataUrl, signerName, agreedTo: true }`. The data URL is a PNG generated via `canvas.toDataURL("image/png")`.
- **Once signed**: the amber banner is replaced by a green "Waiver signed for [name]" pill (`emerald-400 / emerald-300` palette over `rgba(34,197,94,0.06)` background).

### 15.6 Shared create-or-edit modal (EditChildModal)

`components/member/EditChildModal.tsx` is the canonical pattern for a single modal that handles both Create AND Edit of the same row type.

- Props: `kid: EditableChild | null` — `null` means create, populated means edit.
- Title: `"Add a child"` (create) / `"Edit child"` (edit).
- Submit label: `"Add child"` / `"Save changes"` — matched to the title's verb.
- On submit, the same handler branches on `kid === null` and either POSTs to the create endpoint or PATCHes the edit endpoint.
- Auto-focuses the first input on open. `Escape` closes. Save button disabled until name has content.

**Rule:** when adding a new "row-edit" entity (e.g. "Add another household contact"), build ONE modal with `null`/value props rather than two separate Add/Edit modals. Reuse the visual treatment: title in `text-white font-bold text-base`, close-X top-right (32 × 32 rounded-full), submit button full-width.

### 15.7 Identity-field edit warning (staff editable email)

Pattern introduced in commit `100434b` for the Edit Staff Member modal. Applies whenever an editable input changes an *identity* field that JWTs depend on (email, username, etc.).

- Helper text *immediately below the input* (not as a tooltip, not in a separate banner): `text-tx-3 text-[11px] mt-1`, copy along the lines of `"Changing the email will sign this staff member out of any current sessions."`
- Server bumps `sessionVersion` on the User row when the field changes — invalidates pre-rename JWTs at next request.

If you add another identity-field edit surface (e.g. editable member email), copy this pattern verbatim — same helper-text styling, same `sessionVersion` bump.

### 15.8 Settings number inputs (check-in window pattern)

`components/dashboard/SettingsPage.tsx` "Check-in Window" block (in the Waiver tab) introduced the canonical pattern for bounded numeric configuration fields.

- Label: `text-gray-400 text-xs uppercase tracking-wider block mb-1`
- Input: `type="number"`, `min` / `max` set, `className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm"`
- Value bound to a local state that initialises from `settings?.fieldName ?? defaultValue`
- DB has matching CHECK constraint (`>= 0 AND <= 180` in this case) — server side mirrors the HTML `min`/`max` so a CSRF-bypassing client can't write out-of-range values

When adding another bounded numeric config (e.g. "max kids per parent", "session timeout"), reuse this exact class string + CHECK pattern. Don't introduce a slider, a stepper, or a custom number control.

### 15.9 Cross-cutting: shared library for parity

When a server route returns a shape that another route should also return identically, factor the shape into a `lib/*.ts` helper rather than re-implementing both sides:

- `lib/member-stats.ts` `computeMemberStats(tx, { memberId, tenantId })` — used by `/api/member/me` AND `/api/member/children/[id]` so the parent's own stats and any kid's stats are byte-identical in shape.
- `lib/member-delete.ts` `deleteMemberCascade(tx, where)` — used by `/api/members/[id]` (staff) AND `/api/member/children/[id]` (parent) so member deletion is FK-RESTRICT-safe regardless of who initiates it.

**Rule:** any time two routes need to return or operate on the same shape, the helper is the single source of truth. Tests assert shape parity (`tests/integration/member-children-stats.test.ts`) so future edits to one route can't accidentally drift from the other.

---

## 16. Related docs

- [`app/globals.css`](../app/globals.css) — the live source of truth for all tokens
- `40-Projects/matflow/design-system.md` (vault) — earlier proto-thinking; superseded by this doc
- `60-Reference/ai/visual-language-skill-pattern.md` (vault) — SKILL.md pattern for marketing-asset generation (separate from this doc; for graphics, not app UI)
- `60-Reference/ai/ui-ux-pro-max-skill.md` (vault) — Claude Code skill for generator-side UI; pair with impeccable
- `60-Reference/ai/claude-tools-codeburn-impeccable.md` (vault) — impeccable, the anti-slop critic
- `docs/RUNBOOK.md` — operational runbook (not design)
- `docs/MATFLOW-RANK-ACCESS-PLAN-2026-05-09.md` — rank/roster feature plan
