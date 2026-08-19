# MatFlow — Brand Assets Commissioning Brief

> **What this is.** A commissioning document for custom artwork. Each section names a real screen, the exact moment a user sees it, the size and format to produce, and a **ready-to-paste prompt** for an AI image generator (Midjourney, DALL·E, Firefly, Ideogram — all work). Paste the prompt as-is; it is written to need no editing.
>
> **Who it's for.** A smart non-designer commissioning the work — no design vocabulary assumed.
>
> **Everything below is grounded in what the app actually renders today.** Screens, file paths and copy are quoted from the codebase, not invented. Where something does not exist yet, it says so.
>
> Read alongside [`docs/UI-RULES.md`](UI-RULES.md), which is the ratified UI rulebook. Where the two disagree, UI-RULES wins.

---

## Contents

1. [The five rules every asset must obey](#1-the-five-rules-every-asset-must-obey)
2. [The house style — fix it once, hold it forever](#2-the-house-style--fix-it-once-hold-it-forever)
3. [Asset 1 — Empty states (highest value)](#3-asset-1--empty-states-highest-value)
4. [Asset 2 — Milestone art for Your Journey](#4-asset-2--milestone-art-for-your-journey)
5. [Asset 3 — Class-type marks](#5-asset-3--class-type-marks)
6. [Asset 4 — Onboarding and kiosk welcome art](#6-asset-4--onboarding-and-kiosk-welcome-art)
7. [Asset 5 — Landing hero and feature imagery](#7-asset-5--landing-hero-and-feature-imagery)
8. [Asset 6 — Email header art](#8-asset-6--email-header-art)
9. [Asset 7 — 404 and error companions](#9-asset-7--404-and-error-companions)
10. [How to check it worked](#10-how-to-check-it-worked)
11. [What not to commission — the icon set is already generated](#11-what-not-to-commission--the-icon-set-is-already-generated)

---

## 1. The five rules every asset must obey

These are non-negotiable. An asset that breaks one gets thrown away, however good it looks. Each rule is repeated inside the individual prompts, because generators forget instructions that only appear once.

### 1.1 Nothing may imply a belt is earned by turning up

In MatFlow, **coaches decide promotions. Always.** The product is explicit about this in code: `lib/member-stats.ts` carries the comment *"Deliberately no promotion/rank badges: promotions are the coach's call"*, and the Your Journey timeline in `app/member/progress/page.tsx` deliberately shows **no next-rank node, no elapsed counter and no pace indicator** for the current rank. The landing page states the position plainly: *"Set minimum sessions and minimum months per rank. The promotion queue runs itself. **You confirm; MatFlow provides the evidence.**"* (`components/landing/FeaturesGrid.tsx`).

So: **no belts filling up, no progress bars that end in a belt, no belt-coloured ladders, staircases, level-up arrows, XP meters or "next rank" ghosts.** A member looking at artwork must never infer that attendance alone promotes them. This is the single most likely way for a commissioned set to be unusable.

Safe metaphors instead: consistency, repetition, showing up, time on the mat, the room, the routine.

### 1.2 The artwork must survive tenant branding

Gym owners recolour the entire app — accent colour, background, font (see UI-RULES §2a, "Holistic customisation"). The onboarding wizard alone ships twelve preset palettes ranging from `#3b82f6` blue through `#be123c` crimson to `#16a34a` green, and owners can pick any colour outside those.

**In plain terms:** if you bake MatFlow's blue into the picture, then a gym running a red brand gets a red app with blue drawings in it, and it looks broken.

**The safe answer is monochrome art.** Commission each asset as a single-colour drawing — pure black lines on transparent (or pure white) background, no other colours at all. The app then tints it at runtime by setting the drawing's colour to a token (`var(--color-primary)` on member surfaces, `var(--tx-3)` on staff surfaces). One drawing, every gym's colour, automatically. The technical name for this is a *currentColor SVG*; you do not need to understand it, only to insist the artwork arrives as flat single-colour line work with no gradients, no shading and no second colour.

Where a second tone genuinely helps (a foreground and a background element), allow **exactly two tones of the same colour** — full strength and a 20 % wash — and nothing more.

### 1.3 It must work on a light screen and a dark screen

MatFlow has two shells with opposite polarity (UI-RULES §1):

| Surface | Theme | Where |
|---|---|---|
| Staff dashboard | **Light** — `#f5f6f8` page, white cards | `app/dashboard/**` |
| Member portal | **Dark, tenant-branded** — `#111111` base | `app/member/**` |
| Kiosk | Dark, tenant background | `app/kiosk/**` |
| Landing / public | Dark marketing look, cream `#ede8df` text | `components/landing/**` |

Line art in a single tintable colour solves this for free — it is dark on the light dashboard and light on the dark portal, from one file. **Art that relies on a white fill, a drop shadow or a soft background glow will fail on one of the two.** If a piece genuinely needs a filled treatment, commission two variants and label them `-light` and `-dark`.

### 1.4 No photorealistic faces, no martial-arts cliché

Two separate reasons, both hard limits.

**No faces.** MatFlow stores children's records (`MembershipTier.isKids`, kids' parent-linkage, signed waivers). Illustrated people are fine — but as simple abstracted figures with **no facial features at all**: no eyes, no mouths, no identifiable individuals, no photorealism, and nothing that reads as a photograph of a real child. This is a data-protection and optics posture, not a stylistic preference.

**No cliché.** The audience are practitioners. Snarling tigers, dragons, flaming fists, gothic lettering, kanji-as-decoration, clenched fists, "warrior" iconography and eagle-and-flag energy will make them wince and will make the product look cheap. Aim for the register of Whoop, Nike Training Club, Linear and Stripe — quiet, confident, understated. If in doubt, draw the *room* rather than the *fight*: mats, tape lines on the floor, a clock, a bench, a door, a folded gi, a mat-panel grid.

### 1.5 One style across the whole set

The fastest way to look assembled from free stock is inconsistent line weight. **Decide once and hold it for every asset in the set:**

- **Line weight:** 2 px at a 24 px nominal grid (scale proportionally — so 8 px stroke on a 96 px drawing, 85 px on a 1024 px render).
- **Caps and joins:** round. This matches the existing brand mark, which is drawn as a round-capped, round-joined stroke (`scripts/generate-brand-icons.mjs`).
- **Corner radius:** 12 px at a 96 px drawing size — the same feel as `--r-md: 12px`, the app's standard radius.
- **Detail level:** an object should be recognisable as a silhouette at 24 px. If it needs more than about a dozen strokes, it is too detailed.
- **Perspective:** flat, straight-on or gently isometric. Pick one for the whole set. Straight-on is recommended — it survives being scaled down.
- **No:** gradients, drop shadows, textures, outlines-plus-fills, 3D renders, glassmorphism, sketchy or hand-wobble lines.

Paste the **Style block** below into every prompt (it is already embedded in each ready-to-paste prompt in this document):

> Flat single-colour line illustration. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows, no texture. Uniform 8px stroke weight at 96px scale, round line caps and round joins, 12px corner radius on rectangular forms. Minimal — under a dozen strokes. Straight-on flat perspective, generous empty space, centred composition with clear margins. Human figures, if any, are simplified featureless silhouettes with no facial features. Calm, understated, editorial; the visual register of Linear, Stripe and Whoop. No martial-arts clichés — no tigers, dragons, flames, fists, kanji, gothic type or warrior imagery. No text, no letters, no numbers, no logos, no watermark.

---

## 2. The house style — fix it once, hold it forever

**Format.** Generators produce raster images (PNG/JPEG). The app wants **SVG** so art scales cleanly and can be tinted with a token. The workflow is:

1. Generate at **1024 × 1024 px** (or 1536 × 1024 for wide pieces), black on white.
2. Trace to SVG — Illustrator *Image Trace → Black and White Logo*, or the free tool **vectorizer.io** / Inkscape's *Trace Bitmap*.
3. Clean up: delete the white background rectangle, set every path's `fill`/`stroke` to `currentColor`, remove `width`/`height` attributes, keep `viewBox`.
4. Save to `public/art/<name>.svg`.

That step-3 line — *set the colour to `currentColor`* — is the whole trick behind rule 1.2. It means the drawing has no colour of its own and simply takes the colour of the text around it, which is already the tenant's colour.

**If SVG conversion is too much:** ship PNG at **3× the display size with a transparent background** (e.g. a 96 px slot needs a 288 × 288 PNG). Accept that it cannot be recoloured per tenant, and therefore commission it in a neutral grey (`#8a8f98`) that is legible on both light and dark. This is the fallback, not the plan.

**Naming.** `public/art/empty-members.svg`, `public/art/milestone-first-class.svg`, `public/art/class-nogi.svg` — lowercase, hyphenated, describing the slot not the picture.

---

## 3. Asset 1 — Empty states (highest value)

**Why this is first.** A brand-new gym signs up, lands on the dashboard, and *every single screen is empty*. Today every one of those screens is text only — no illustration anywhere. This is the first ninety seconds of the product and it currently looks like a bug.

**Where they appear (verified in code):**

| Slot | File | Exact copy on screen today |
|---|---|---|
| No members | `components/dashboard/MembersList.tsx:459` | "No members yet" |
| No classes | `components/dashboard/TimetableManager.tsx:83–87` | "No classes yet — an owner or manager can add the first one." |
| No payments (staff) | `components/dashboard/PaymentsTable.tsx:188` | "No payments yet. Stripe events will populate this table automatically." |
| No attendance | `components/dashboard/AttendanceView.tsx:145` | "No attendance records found" |
| No announcements | `components/dashboard/AnnouncementsView.tsx:174` | "No announcements yet" |
| No membership tiers | `components/dashboard/MembershipsManager.tsx:182` | "No membership tiers yet" |
| No classes today (check-in desk) | `components/dashboard/AdminCheckin.tsx:309`, `components/dashboard/CoachRegister.tsx:284` | "No classes today" / "No classes today. Check back tomorrow, or open the timetable to schedule one." |
| No payments (member) | `components/member/MemberBillingTab.tsx:177` | "No payments yet. They'll appear here once your first invoice clears." |

**The slot already exists.** `components/ui/EmptyState.tsx` takes an `icon` prop rendered above the title:

```tsx
{icon ? <div aria-hidden="true">{icon}</div> : null}
```

Drop the artwork in there. Note honestly: **that primitive currently has no call sites** — the screens above each hand-roll their own empty block, and `TimetableManager.tsx` even defines a private local `EmptyState` function. Adopting the primitive is a prerequisite for the art appearing everywhere, and is separate work from commissioning it.

**Emotional job.** Not "sorry, nothing here". These states are **the first instruction**: this screen is waiting for you, and here is the one thing to do. Calm, quietly optimistic, never apologetic, never cute. It must also never be mistaken for a broken screen — UI-RULES §7 is explicit that an HTTP error is never rendered as an empty state, so the illustration must read as *"not yet"* and never as *"something went wrong"*.

**Dimensions and format.** Displayed at **96 × 96 px** (centred above the title, inside a card with `py-10` padding). Generate 1024 × 1024, deliver **SVG, `currentColor`**, viewBox `0 0 96 96`. On the staff dashboard it will be tinted `var(--tx-3)`; on member surfaces `var(--color-primary)` at reduced opacity.

**Eight pieces to commission.** Each is one object or one small scene, drawn in the identical style:

1. **No members** — an empty membership card / lanyard, or two empty seats.
2. **No classes** — an empty weekly grid with one faint cell outlined.
3. **No payments** — an empty receipt with a fold, no figures on it.
4. **No attendance** — a clipboard with a blank register grid.
5. **No announcements** — a pinboard with a single empty pin.
6. **No membership tiers** — three empty stacked cards of ascending height.
7. **No classes today** — a wall clock and an empty mat, quiet-hours feeling.
8. **Search found nothing** *(covers "No members match…", `MembersList.tsx:472`)* — a magnifier over an empty list rule.

### Ready-to-paste prompt — empty states

> A set of eight matching minimalist illustrations for an empty screen in a gym management app, drawn in one consistent style, one subject per image:
> (1) an empty membership card on a lanyard; (2) an empty weekly timetable grid with one cell faintly outlined; (3) a blank paper receipt with a fold, no writing on it; (4) a clipboard holding a blank attendance register grid; (5) a cork pinboard with a single pushpin and no notes; (6) three empty stacked cards of ascending height; (7) a plain wall clock above an empty exercise mat; (8) a magnifying glass over an empty list of horizontal rules.
>
> Flat single-colour line illustration. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows, no texture. Uniform 8px stroke weight at 96px scale, round line caps and round joins, 12px corner radius on rectangular forms. Minimal — under a dozen strokes each. Straight-on flat perspective, generous empty space, centred composition with clear margins, square format. Calm and quietly optimistic — this is a screen waiting to be filled in, not an error and not an apology. Understated editorial register, in the visual language of Linear, Stripe and Whoop.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No faces and no photorealistic people — any human form is a simplified featureless silhouette. No martial-arts clichés: no tigers, dragons, flames, fists, kanji, gothic type, warriors or belts. Nothing suggesting ranks, levels, progress bars or promotion. No brand colours — the artwork must be recolourable, so a single flat black is the only colour used.

---

## 4. Asset 2 — Milestone art for Your Journey

**Where.** `app/member/progress/page.tsx` — the member portal's **Progress** tab, in the card headed **"Milestones"** (a three-column grid), sitting beneath the **Your Journey** rank-lineage timeline. The member is on their phone, dark screen, in their gym's colours, usually checking after training.

**The nine real milestones** (defined in `lib/member-stats.ts`, all computed from actual check-in rows — nothing fabricated):

| Label | Description shown | Earned when |
|---|---|---|
| First class | "Your first check-in" | 1 check-in |
| 10 classes | "10 check-ins" | 10 |
| 25 classes | "25 check-ins" | 25 |
| 50 classes | "50 check-ins" | 50 |
| 100 classes | "100 check-ins" | 100 |
| 250 classes | "250 check-ins" | 250 |
| 4-week streak | "Train every week for a month" | 4 consecutive training weeks |
| 12-week streak | "Train every week for three months" | 12 consecutive training weeks |
| Comeback | "Back after 30+ days away" | a check-in after ≥30 days away |

**Today** each tile shows a generic lucide icon — `Medal` for counts, `Flame` for streaks, `RotateCcw` for Comeback (`badgeIcon()`, `app/member/progress/page.tsx:191`). Three icons for nine milestones: hitting 250 classes looks exactly like hitting 10. That is the gap.

**Two visual states, both already built.** Earned tiles are filled gold — `rgba(185,138,46,·)` fill and edge, gold date text. Locked tiles are a **dashed outline** with a progress bar in the tenant accent. So each milestone needs artwork that reads at **both** full strength and dimmed/outline strength.

**Emotional job.** Earned recognition for *consistency*, not rank. Quiet pride, the feeling of a stamped card, not a video-game trophy explosion. **Critically: none of these touch belts.** The art must never resemble a belt, a stripe, a rank ladder or a level-up. Comeback in particular must feel *welcoming*, never a scold about time off — the code deliberately shows no progress bar for it, because "counting days away is not something we nudge".

**Dimensions and format.** The icon slot renders at **16 × 16 px** inside a tile roughly 96 px wide. That is genuinely tiny, so the artwork must be legible as a silhouette. Generate 1024 × 1024, deliver **SVG, `currentColor`**, viewBox `0 0 24 24`, drawn on a 24 px grid with a 2 px stroke. Nine files: `milestone-first-class`, `milestone-10`, `milestone-25`, `milestone-50`, `milestone-100`, `milestone-250`, `milestone-streak-4`, `milestone-streak-12`, `milestone-comeback`.

**Design logic to give the artist:** the six count milestones should be **one family that visibly escalates** — e.g. a single mat tile, then a small stack, then a fuller stack, then a dense grid — so that 250 obviously outranks 10 at a glance without any number being drawn. The two streak milestones are a second family (a continuous chain or an unbroken row of marks; 12 is visibly longer than 4). Comeback is its own mark: a door, or a path returning.

### Ready-to-paste prompt — milestone marks

> A set of nine matching minimalist milestone icons for a fitness app, designed as three visual families that escalate, one subject per icon:
> Family A, six icons showing increasing accumulation, all built from the same repeating unit: (1) one single square tile; (2) a small neat stack of tiles; (3) a taller stack; (4) a wider block of tiles; (5) a dense grid of tiles; (6) a very dense full grid of tiles.
> Family B, two icons showing an unbroken continuous run: (7) a short chain of four connected links in a row; (8) a longer chain of twelve connected links in a row.
> Family C, one icon: (9) an open doorway with a simple path leading back through it — warm and welcoming, a return.
>
> Flat single-colour line icons. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows. Drawn on a 24-pixel grid with a uniform 2-pixel stroke, round line caps and round joins, small rounded corners. Extremely simple — each icon must stay readable at 16 pixels. Straight-on flat perspective, centred, square format, even margins.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No trophies, cups, stars, medals, ribbons, crowns or laurel wreaths. **Nothing resembling a martial-arts belt, a coloured stripe, a rank badge, a level meter, a ladder or an upward arrow — promotions in this product are decided by a coach and never by attendance, so any imagery implying levelling up is wrong.** No faces or people. No tigers, dragons, flames, fists or kanji. Single flat black only, because the artwork will be recoloured per client.

---

## 5. Asset 3 — Class-type marks

**Read this before commissioning — an honest caveat.** MatFlow has **no fixed list of class types**. In `prisma/schema.prisma`, `Class` has a free-text `name` and an optional `color` hex chosen by the owner; there is no enum and no type field. The familiar names come from templates the onboarding wizard offers (`CLASS_TEMPLATES` in `components/onboarding/OwnerOnboardingWizard.tsx:89`) and from seed data:

- **BJJ:** Beginner BJJ, Intermediate BJJ, Advanced BJJ, No-Gi, Open Mat, Kids BJJ, Competition Prep
- **Other disciplines** ship their own lists (Boxing, Muay Thai, MMA, Kickboxing, Wrestling, Judo, Karate)
- Seeded classes: "Fundamentals BJJ", "No-Gi", "Open Mat" (`prisma/seed.ts`)

So a mark can only be attached by **matching the class name** (e.g. name contains "no-gi" → No-Gi mark), with a neutral default for anything unmatched. Commission the six requested marks plus a generic fallback, and expect many gyms' classes to land on the fallback. That is fine; it degrades gracefully.

**Where they would appear.** The weekly grid (`components/dashboard/WeeklyCalendar.tsx`, `components/dashboard/TimetableManager.tsx` — cells are already sized to fit names like "Fundamentals BJJ"), the coach register (`components/dashboard/CoachRegister.tsx`), the member schedule (`app/member/schedule/page.tsx`), and the kiosk class picker under the heading **"Pick your class"** (`components/kiosk/KioskPage.tsx:376`), where a member is standing at a tablet by the door with wet hands, choosing fast.

**Emotional job.** Pure wayfinding. Recognise the class in a quarter of a second in a crowded grid. These carry almost no emotion and must not try to.

**Dimensions and format.** **20 × 20 px** displayed in dense timetable cells; up to 32 px on the kiosk. Generate 1024 × 1024, deliver **SVG, `currentColor`**, viewBox `0 0 24 24`, 2 px stroke. Seven files: `class-gi`, `class-nogi`, `class-openmat`, `class-fundamentals`, `class-kids`, `class-competition`, `class-default`.

**Important:** these must **not** be recoloured to belt colours, and must not be confused with rank. They sit alongside the owner's own per-class `color`, so they must read as monochrome marks that the class colour surrounds — not as coloured badges of their own.

### Ready-to-paste prompt — class-type marks

> A set of seven matching minimalist pictogram icons for a class timetable in a gym app, one subject per icon, all clearly siblings:
> (1) a neatly folded uniform jacket with a visible lapel; (2) a plain fitted training top, no lapel, short sleeves; (3) an open square mat area with a simple dotted boundary, informal; (4) three simple building blocks stacked as a base, foundational; (5) a small figure beside a taller figure, both simplified and featureless; (6) a stopwatch with a single clean tick mark; (7) a plain neutral square mat tile as a generic fallback.
>
> Flat single-colour line pictograms. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows. Drawn on a 24-pixel grid with a uniform 2-pixel stroke, round line caps and round joins, small rounded corners. Ruthlessly simple — each must be identifiable at 20 pixels in a crowded grid. Straight-on flat perspective, centred, square format, matched optical weight so no icon looks heavier than the others.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No faces — figures are featureless silhouettes. **No belts, no coloured stripes, no rank insignia, no medals, no podiums and nothing implying levels or progression** — rank in this product is awarded by a coach, never by attending a class. No tigers, dragons, flames, fists, kanji, gothic type or aggressive imagery. Single flat black only, because each icon is recoloured to the client's own brand colour.

---

## 6. Asset 4 — Onboarding and kiosk welcome art

Two related pieces, both first-contact moments.

### 6a. Onboarding — "Set up your gym" and "Your gym is ready!"

**Where.** `components/onboarding/OwnerOnboardingWizard.tsx`, a nine-step wizard on a dark, already-tenant-coloured screen. Two slots currently filled by **emoji in a rounded tinted square**, which is the tell that this is unfinished:

- **Step 1** (`:686`) — a 56 × 56 px rounded square containing the emoji 🏋️, above *"Welcome, {first name}"* / **"Set up your gym"** / "Let's get your gym ready in just a few steps. Start with the basics."
- **Final step** (`:1624`) — an 80 × 80 px rounded square containing 🎉, above **"Your gym is ready!"** and a row of green-tick summary pills ("✓ 3 ranks set up", "✓ 5 classes added").

**Emotional job.** Step 1: *this will be quick and you are in safe hands* — an owner who has just paid is deciding whether they have made a mistake. Final step: earned completion, a handover of keys. Restrained, not confetti.

**Dimensions and format.** Two SVGs, `currentColor`, viewBox `0 0 48 48`, 2.5 px stroke — they render inside 56 px and 80 px tinted squares against the tenant accent, so single-colour is mandatory. Files: `onboarding-start.svg`, `onboarding-complete.svg`.

### 6b. Kiosk welcome

**Where.** `components/kiosk/KioskPage.tsx` — a tablet by the door, running the gym's own background colour and font, full screen. The header shows the gym's logo (or its initial) with the subtitle **"Class check-in"**, then **"Pick your class"**. On success it shows **"Welcome, {first name}!"** before resetting after a delay; when nothing is scheduled it shows **"No classes scheduled today."**

**Emotional job.** The success screen is the single most-seen moment in the whole product — every member, every session. It should feel like a nod from the front desk: brief, warm, unmistakably *you're in*. It must be readable from about two metres away, and it must survive the gym's own background colour, which may be near-white (`#f8fafc`) or near-black (`#050d12`).

**Dimensions and format.** One large confirmation mark, **160 × 160 px** displayed, SVG `currentColor`, viewBox `0 0 64 64`, 3 px stroke; plus a quiet-hours piece at the same size for "No classes scheduled today". Files: `kiosk-checked-in.svg`, `kiosk-no-classes.svg`.

### Ready-to-paste prompt — onboarding and kiosk

> A set of four matching minimalist illustrations for a gym management app, one subject per image, all clearly from the same family:
> (1) an empty building interior seen straight on, with a doorway and a single floor mat, ready to be set up; (2) a simple key resting in an open hand-shaped tray, handover of a finished space; (3) a large clean tick mark inside a soft rounded square, confident and calm; (4) a wall clock above an empty rolled mat, a quiet closed room.
>
> Flat single-colour line illustration. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows, no texture. Uniform stroke weight throughout with round line caps and round joins, 12px-equivalent rounded corners on rectangular forms. Very simple, under a dozen strokes each, readable from two metres away on a wall-mounted tablet. Straight-on flat perspective, centred in a square format with generous margins.
>
> Tone: warm, calm and welcoming — a nod from the front desk, not a celebration. Understated editorial register in the visual language of Linear, Stripe and Whoop. No confetti, no fireworks, no party imagery, no exclamation energy.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No faces and no photorealistic people — any human form is a simplified featureless silhouette. No martial-arts clichés: no tigers, dragons, flames, fists, kanji, gothic type or warriors. **No belts, stripes, ranks, medals, podiums, level meters or progression imagery of any kind.** Single flat black only, because the artwork is recoloured to each client's own brand colour and sits on backgrounds ranging from near-white to near-black.

---

## 7. Asset 5 — Landing hero and feature imagery

**Where.** `components/landing/**` — a dark marketing page with its own fixed palette that **does not** get recoloured per tenant (this is MatFlow's own site, so MatFlow blue is correct here and only here):

- background: dark; body text cream `#ede8df`
- brand blue `#3d8bff`; a warm accent `#e8b86d`
- headline: *"The gym software / **built for the mat.**"* (`components/landing/Hero.tsx:191`)
- the right-hand column currently holds `BeltTrackerMockup`, an in-code UI mockup — not artwork
- `components/landing/FeaturesGrid.tsx` lists six numbered features under *"Six things every BJJ academy needs. All of them in production."*: Belt & stripe tracking · Kiosk check-in · Branded member portal · Attendance-driven promotions · Payments that reconcile · Reports that actually run. It is currently **type only, no imagery**.

**Emotional job.** Credibility with a gym owner who has been burned by generic fitness SaaS. The page's own claim is *"Every feature above is live in production today — not a roadmap item"*, so the imagery must look **specific and operational**, not stock-marketing. Restraint sells here.

**Careful on feature 04, "Attendance-driven promotions."** The body copy is precise — *"You confirm; MatFlow provides the evidence."* Any illustration here must show **evidence being handed to a person who decides**, never a member auto-levelling. A tick-list beside a signature line is right; a belt filling up is wrong and unusable.

**Dimensions and format.**

- **Hero piece** — one wide illustration, displayed around 600 × 600 px on desktop and hidden or shrunk on mobile. Generate 1536 × 1536. Because the landing palette is fixed, this one **may** use the landing colours: cream lines on dark, with blue `#3d8bff` used sparingly for a single focal element. Deliver SVG if possible, otherwise transparent PNG at 1200 × 1200.
- **Six feature marks** — 48 × 48 px displayed beside each numbered feature. SVG `currentColor`, viewBox `0 0 32 32`, 2 px stroke, so they inherit the cream body colour. Files: `feature-ranks`, `feature-kiosk`, `feature-portal`, `feature-promotions`, `feature-payments`, `feature-reports`.

### Ready-to-paste prompt — landing hero

> A wide minimalist line illustration for the homepage of software used by Brazilian jiu-jitsu academies: a straight-on cutaway view of a training room — a large square mat marked out in panel lines, a wall clock, a bench along one wall, a doorway with a small wall-mounted check-in tablet beside it, and two simplified featureless human silhouettes standing calmly at the edge of the mat, not fighting.
>
> Flat line illustration in warm off-white cream lines on a very dark near-black background, with exactly one small element picked out in a clear blue as the focal point; no other colours, no gradients, no shading, no drop shadows, no texture. Uniform medium stroke weight, round line caps and round joins, softly rounded corners. Clean, architectural and calm, with generous empty space. Square format, centred, straight-on flat perspective.
>
> Tone: quiet, precise and operational — real equipment in a real room, in the visual register of Linear, Stripe and Whoop. Not energetic, not aspirational, not stock-photo fitness marketing.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No faces, no photorealism, no identifiable people — figures are featureless silhouettes. No sparring, grappling or combat poses. No martial-arts clichés: no tigers, dragons, flames, fists, kanji, gothic type or warriors. **No belts, stripes, ranks, medals, podiums, trophies, level meters, progress bars or upward arrows — nothing that implies a student is promoted by attending.**

### Ready-to-paste prompt — six feature marks

> A set of six matching minimalist pictogram icons for a software feature list, one subject per icon, all clearly siblings:
> (1) a simple filing card with a small tab, representing a member record; (2) a wall-mounted tablet on a bracket beside a doorway; (3) a phone handset showing a plain rounded app screen; (4) a short checklist beside a signature line, representing evidence presented to a person who decides; (5) two curved arrows forming a closed reconciliation loop around a small card; (6) a simple bar chart of four ascending bars on a baseline.
>
> Flat single-colour line pictograms. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows. Drawn on a 32-pixel grid with a uniform 2-pixel stroke, round line caps and round joins, small rounded corners. Simple and evenly weighted so no icon looks heavier than the others. Straight-on flat perspective, centred, square format.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No faces or people. **No belts, stripes, rank insignia, medals, podiums, trophies or level meters — icon 4 must show evidence being reviewed by a decision-maker, never a student levelling up automatically.** No tigers, dragons, flames, fists or kanji. Single flat black only, so the icons can be recoloured.

---

## 8. Asset 6 — Email header art

**Where.** `lib/email.ts`, function `shell()` — every transactional email in the product shares one wrapper: a `#f5f6f8` page, a **560 px wide white card** with a 16 px radius and a soft shadow, headline at 20 px in `#111827`, a hairline `#e5e7eb` rule, and the footer line *"Sent by MatFlow on behalf of your gym. If you didn't expect this email, you can safely ignore it."*

There are around twenty templates on this shell — `welcome`, `receipt`, `refund_processed`, `payment_failed`, `password_reset`, `magic_link`, `invite_member`, `rank_promoted`, `kiosk_waiver`, `dispute_created` and more. **There is currently no header image at all**, just the headline text.

**Emotional job.** Deliverability and trust, in that order. These emails include payment receipts and password resets; they must look like a bank's email, not a newsletter's. A large decorative banner would actively damage the product — it looks promotional, which is what spam filters and recipients both punish.

**Recommendation: commission a restrained header strip, not a banner.** One narrow band across the top of the white card: the gym's logo (already stored per tenant as `logoUrl`) or its initial on the left, and a very quiet repeating mat-panel line motif filling the rest. It should be almost invisible — a texture that says "designed", not a picture.

**Dimensions and format.** **1120 × 160 px PNG** (that is 560 × 80 at 2× for retina; email clients cannot use SVG reliably, so PNG is correct here). Set the `<img>` to `width:560; height:80; display:block`. Produce **two versions**: `email-header-light.png` on `#ffffff` for the card, and a spare on `#f5f6f8`. Always give it `alt=""` so screen readers skip it, and never put words in the image — many clients block images by default, so any text inside would simply vanish.

### Ready-to-paste prompt — email header strip

> A very subtle decorative header strip for a transactional email, seven times wider than it is tall, extremely restrained. The design is a quiet horizontal band of a repeating geometric pattern of interlocking square mat panels, drawn as fine thin lines in a pale warm grey on a pure white background, fading gently to nothing towards the right-hand side. Roughly the left fifth of the strip is left completely empty white as a clear space for a logo to be placed later.
>
> Flat, minimal and understated. Thin uniform hairline strokes, no gradients, no shading, no drop shadows, no texture, no colour beyond the single pale grey. It must read as a barely-there texture, not as a picture or a banner — this sits at the top of a payment receipt and must look like a bank's email, never like a marketing newsletter.
>
> Strict exclusions: no text, letters, numbers, logos or watermarks. No people, no faces, no photographs. No martial-arts imagery of any kind — no belts, stripes, ranks, tigers, dragons, flames, fists or kanji. Nothing celebratory or promotional. Wide banner aspect ratio, edge to edge, no border.

---

## 9. Asset 7 — 404 and error companions

**Honest state of play.** There is **no `app/not-found.tsx` and no `app/error.tsx` anywhere in the app** — `notFound()` is called in five places (`app/kiosk/[token]/page.tsx`, `app/dashboard/members/[id]/page.tsx` and others) and falls through to Next.js's stock black-and-white page, which carries none of MatFlow's branding and is white-on-white wrong for the member portal. UI-RULES §7 already flags this: *"Every route segment gets an `error.tsx` (today: zero in the entire app)."*

So this asset is commissioned **ahead of** the pages that will use it. That is fine — the art is cheap and the pages are quick once it exists.

**Emotional job.** Defuse, orient, offer the way back. The copy standard is set in UI-RULES §10: humane British English, no exclamation marks in errors, never blaming the user, never exposing internals — *"Couldn't load — tap to retry"*. The picture has the same job: the tone of a receptionist pointing down the corridor. **Not** a sad face, not a broken robot, not a 404-in-huge-numerals cliché.

Three variants are worth having:

1. **404 — page not found:** a door in a corridor that opens onto nothing, or a wall sign with a blank face.
2. **Error — something failed:** an unplugged cable, or a clock with no hands. Calm, mechanical, clearly temporary.
3. **Offline / no connection:** relevant because the member portal is an installable web app with a service worker (`public/sw.js`). A closed shutter, or a signal mast with a break in it.

**Dimensions and format.** **160 × 160 px** displayed, SVG `currentColor`, viewBox `0 0 64 64`, 3 px stroke. Must work on the light staff dashboard and the dark member portal from the same file. Files: `error-404.svg`, `error-failed.svg`, `error-offline.svg`.

### Ready-to-paste prompt — error companions

> A set of three matching minimalist illustrations for error screens in an app, one subject per image, all clearly siblings:
> (1) a plain doorway standing alone in an empty corridor with nothing behind it; (2) a power cable with its plug lying just beside an empty socket, unplugged; (3) a simple roller shutter pulled most of the way down over an opening.
>
> Flat single-colour line illustration. Pure black lines on a plain white background, no other colours anywhere, no gradients, no shading, no drop shadows, no texture. Uniform 3-pixel stroke at 64-pixel scale, round line caps and round joins, softly rounded corners. Very simple, under a dozen strokes each. Straight-on flat perspective, centred, square format, generous margins.
>
> Tone: calm, matter-of-fact and reassuring — the visual equivalent of a receptionist pointing you down the right corridor. The situation is temporary and fixable. Not sad, not apologetic, not comic, not alarming.
>
> Strict exclusions: no text, letters, numbers or digits of any kind — especially not "404". No sad faces, crying characters, broken robots, warning triangles, exclamation marks or skulls. No faces or people at all. No martial-arts imagery, belts, ranks or progression. No logos or watermarks. Single flat black only, because the artwork is recoloured and must work on both a light background and a dark one.

---

## 10. How to check it worked

Do this for **every** asset before accepting it. It takes about three minutes each and catches the failures that only show up in the app.

**Step 1 — drop it in.**

1. Save the file to `public/art/<name>.svg`.
2. Open the SVG in a text editor and confirm every `fill` and `stroke` says `currentColor` — if you see a hex code like `#000000`, replace it. Confirm there is no white background rectangle (look for a `<rect>` covering the whole canvas near the top; delete it).
3. Render it where it belongs. For empty states that is the `icon` prop of `components/ui/EmptyState.tsx`; for milestones it is `badgeIcon()` in `app/member/progress/page.tsx`.

**Step 2 — look at it in four situations.** Each one has killed a real asset before.

| Check | How | What fails |
|---|---|---|
| **Light shell** | A staff dashboard screen (`/dashboard/members` with no members) | Art that relied on a white fill disappears into the white card; art that was designed pale becomes invisible |
| **Dark shell** | The member portal (`/member/progress`) | Art with baked-in dark lines vanishes into the `#111111` background |
| **Extreme tenant accent** | Set the tenant's primary colour to each of `#ffffff`, `#ffe14d` and `#111111` — the three worst cases named in UI-RULES §2a | Anything with a hidden second colour, or lines too thin to survive a pale yellow tint |
| **Mobile** | 375 px wide viewport (the app's stated floor) and, for milestones, the real 16 px icon slot | Detail that dissolves into mush; a drawing that is charming at 200 px and unreadable at 16 px |

**Step 3 — the doctrine check.** Ask, of every single asset: *could a member look at this and conclude that turning up enough times gets them promoted?* If the answer is anything other than a flat no, reject it. This is the failure that is hardest to spot and most expensive to ship.

**Step 4 — the set check.** Put every asset side by side on one page at the same size. They should look like they were drawn by one person in one afternoon. If one has thicker lines, sharper corners or noticeably more detail, send that one back rather than letting the set drift — mixed line weights are exactly what makes software look assembled from stock.

**Step 5 — the standard gate.** Anything touching UI still has to clear the project's definition of done (UI-RULES §12) — `npm run lint && npm test && npm run build`.

---

## 11. What not to commission — the icon set is already generated

**Do not hand-draw, re-draw or regenerate the app icon, favicon or PWA icons.** They are produced from a single source definition by:

```
node scripts/generate-brand-icons.mjs
```

That script emits the browser-tab favicon, `public/apple-touch-icon.png` and `public/icons/icon-192.png` / `icon-512.png` from one mark — a skinny "M" drawn as a round-capped stroked polyline in brand blue `#3d8bff` on white, with size-aware stroke weights (heavier at 16 px so the mark does not disappear) and a maskable-safe 22 % corner radius.

It exists precisely because these surfaces had drifted apart before: the favicon was switched to blue while the PWA and iOS icons stayed on an old black placeholder, so an installed app still showed black. Editing any of them by hand recreates that bug.

**If the mark itself ever changes,** change it once inside `markSvg()` in that script and re-run it. Never touch the output files.

Everything else in this brief is new artwork and is safe to commission.

---

*Grounded in the codebase as at August 2026. Screen names, copy and file paths were read from source; where a feature does not exist (a class-type enum, a custom 404 page, an email header image) this document says so rather than assuming.*
