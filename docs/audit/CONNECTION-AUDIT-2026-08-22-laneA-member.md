# Lane A — Member-facing pathway connection-point audit

Date: 2026-08-22 · Method: static analysis (grep/read) of the working tree at `c:\Users\NoeTo\Desktop\matflow`.
Scope: app/member/**, app/login/**, app/waiver/open, app/kiosk/[token], components/member/**, components/kiosk/**, components/onboarding/TotpEnrollmentStep, components/ui/* used by them, plus every API route those surfaces call. Known in-flight announcement-expiry work excluded per brief.

## Summary counts

| Severity | Count |
|---|---|
| BROKEN | 4 |
| RISK | 9 |
| DEBT | 8 |

Every fetch() in scope resolves to an existing route file with a matching exported method — there are **zero missing-route/missing-method failures**. All the damage is one level deeper: wrong table behind a shared endpoint, guards that don't admit the caller the UI sends, flows with no exit, and payload fields that go nowhere.

---

## BROKEN (ranked)

### B1 — Member with TOTP enabled is locked out of password login (hard loop, no exit)
The member 2FA enrolment surface is live (`app/member/profile/page.tsx:569` "Set up" → `/login/totp/setup`; layout banner `components/layout/Recommend2FABannerMember.tsx:63` links there too; `app/login/totp/setup/page.tsx:37` correctly drives the member mirror `/api/member/totp` for enrolment). But the **login-time verify** is not member-aware:

1. `auth.ts:376` sets `totpPending: true` on login for a password-bearing member with `totpEnabled` (token carries `memberId`, and `token.id` = the **Member** row id, `auth.ts:361`).
2. `proxy.ts:187-189` pins any `totpPending` session to `/login/totp` (every other page and every non-public API redirects there).
3. `app/login/totp/page.tsx:20` posts **only** to `/api/auth/totp/verify` for all roles.
4. `app/api/auth/totp/verify/route.ts:42-51` looks up `tx.user.findUnique({ where: { id: token.id } })` — a member's id is not in the User table → `400 "TOTP not enabled"` on **every attempt, forever**.
5. Compounding: the mirror `app/api/member/totp/verify/route.ts` (whose own comment, lines 5-6, claims it is "Hit by the existing /login/totp page") has **zero callers** — and even a fixed client couldn't reach it, because `/api/member/totp/verify` is not in `proxy.ts` `PUBLIC_PREFIXES` (only `/recover` is, line 30), so the `totpPending` gate at `proxy.ts:187` 307-redirects the POST itself to `/login/totp`.

**User sees:** signs in with correct password, enters a correct 6-digit code, gets "TOTP not enabled", and cannot leave `/login/totp` except "Sign out". Only escape is the magic-link flow (`app/api/magic-link/verify/route.ts:86` forces `totpPending=false`). Masked in every test environment because `auth.ts` gates `totpPending` behind `!isTestingMode()` and TESTING_MODE is currently on (memory note + `tests/e2e/auth/member-totp-enrol.spec.ts:164` skips under it).

Fix surface (for whoever picks this up): role-aware endpoint choice in `/login/totp`, member branch in the verify route (or role-based dispatch), and a proxy exemption for `/api/member/totp/verify`.

### B2 — Kiosk waiver-gate self-destructs after 10 seconds; the "wait for signature" flow can never complete
`components/kiosk/KioskPage.tsx:74` `PICKER_IDLE_RESET_MS = 10_000`; the idle-reset effect at lines 187-191 explicitly covers `step === "waiver-gate"` with deps `[step, query]` — `query` never changes in that step, so `resetToClassPicker()` fires **10 seconds** after entering the gate. The gate's own design (lines 497-545) sends an email waiver link and promises "This screen will advance automatically once they're done", polling `/api/waiver/kiosk-status` every 5s (lines 161-179) — i.e. at most two polls before the whole flow is wiped back to the class picker. Receiving an email, opening it and signing in under 10 seconds is not physically possible, so the auto-continue check-in path (line 169 `doCheckin`) is unreachable. The member signs on their phone (that half works — `/api/waiver/open` verified end-to-end) but the kiosk has long since reset and never checks them in; they must re-search their name, and only then does check-in proceed (waiverOk now true). Everything on screen during those 10 seconds is a broken promise.

### B3 — Recovery codes are issued but there is no UI anywhere to redeem them
`components/onboarding/TotpEnrollmentStep.tsx` generates 8 codes, tells the user "each of these codes can be used once to recover access", offers Copy/Download (lines 164-183, 314-318). The redemption endpoints exist and are deliberately public (`/api/auth/totp/recover` [POST], `/api/member/totp/recover` [POST], `proxy.ts:30`) — but a repo-wide grep finds **zero UI callers** for either. `/login/totp` (the only page a locked-out user can reach) offers exactly: code input + "Sign out and use a different account" (`app/login/totp/page.tsx:98-104`). No "lost your device? use a recovery code" path exists on any surface. This is follow-up #3 in `docs/UI-AUDIT-2026-08.md:52` — verified **still open**. Combined with B1, a member's 2FA promise chain is broken at both links.

### B4 — Emergency-contact black hole blocks self-serve waiver signing and never resolves its own action item
- `lib/member-actions.ts:106-113`: system action "Add an emergency contact" → `href: "/member/profile"`.
- `/member/profile`'s only editable fields are name / email / phone (`app/member/profile/page.tsx:440-478`). **No emergency-contact fields exist anywhere in the member portal** outside the one-shot onboarding wizard (home page step 6), which never reopens once `Member.onboardingCompleted` is true.
- `POST /api/waiver/sign` (`route.ts:88-93`) and `POST /api/waiver/sign-for-child` (`route.ts:110-115`) return `400 "Emergency contact name, phone, and relation are required before signing"` when the trio is missing.

**User sees:** a staff-created/imported member (or parent) with no trio taps the "Sign your waiver" action → profile → `SignWaiverSection` → fills everything, draws a signature, submits → error banner naming fields that appear nowhere in the app. The same wall hits a parent signing for a kid on `/member/family/[childId]`. Both the waiver action and the emergency-contact action then sit in the list forever. (Members created through the member-side `POST /api/member/children` are exempt — kids don't sign; but adult imports typically arrive with `onboardingCompleted` unset, so exposure depends on import defaults — flagged under "could not verify".)

---

## RISK

### R1 — Sign-in sheet reports success without recording anything when today's class has no instance
`app/member/home/page.tsx:956-992`: `if (cls.classInstanceId) { POST /api/checkin ... } setDone(true)` — when `classInstanceId` is null the POST is skipped entirely and the member still sees "Signed in!". `lib/member-home.ts:376` only resolves an instance when one exists for today with a **matching startTime**; a missed cron run, a cancelled-then-recreated instance, or a schedule/instance startTime drift yields null → silent fake success, attendance never recorded, streaks/stats quietly wrong.

### R2 — Onboarding questions 2-4 are theatre: answers are never sent
`finish()` at `app/member/home/page.tsx:289-314` submits `belt`/`stripes`/trio/DOB/medical/`hasKidsHint` — but the collected `classes` (step 2), `style` (step 3) and `heard` (step 4) state variables appear in no payload, and `/api/member/me` PATCH (`route.ts:288-310`) has no such fields. Three of the five "questions" a new member answers are dropped on the floor; the gym never sees them.

### R3 — Parent kid-photo upload can never use `/api/upload`; it silently base64s into Postgres instead
`components/member/KidPhotosAndWaiver.tsx:81` posts `/api/upload` with **no purpose and no targetMemberId** → `authoriseUpload` (`app/api/upload/route.ts:84-90`) routes it to `requireApiOwner()` → 401/403 for every parent. Even the "correct" call (`purpose=member-photo&targetMemberId=<kid>`) would fail: the guard's member branch only accepts `callerMemberId === targetMemberId` (lines 113-124) — there is **no parent-of-kid branch**. The component's fallback (lines 88-92) then data-URL-encodes the image into `POST /api/member/children/[id]/photos` (3.5MB cap). Net effect: the feature "works", but 100% of parent-uploaded kid photos are stored as base64 blobs in the DB, the Vercel Blob path is dead code for this surface, and any future upload-route failure is invisible (the fallback swallows it). Photos >3.5MB post-downscale fail with a generic error.

### R4 — Progress page "Your Classes" copy contradicts its data source
`/api/member/classes` derives the list from **attendance records** (`route.ts:30-56`), but `app/member/progress/page.tsx:418-421` renders the empty state as "No subscribed classes yet / Go to Schedule to subscribe to classes". Subscribing changes nothing here; only attending does. A member who follows the instruction sees no result and concludes subscribe is broken.

### R5 — Completing onboarding doesn't refresh the home payload
`OnboardingModal onDone` → `setShowOnboarding(false)` only (`app/member/home/page.tsx:1749`); `loadPageData()` is not re-invoked. Kids created in step 5 and `accountType: "parent"` don't reach `kidsRoster`/`accountType` state, so the "Your kids" feed (gate at line 1450) and the SignInSheet kid picker stay absent until a full reload. First-session parents think adding kids failed.

### R6 — Shop CTA is platform-scoped while checkout mode is tenant-scoped (KNOWN — UI-AUDIT follow-up #7, still open)
`app/member/shop/page.tsx:44` `PAY_AT_DESK = !NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (build-time, whole deployment) vs server logic keyed on `STRIPE_SECRET_KEY` + per-tenant `stripeAccountId` (`app/api/member/checkout/route.ts:104,145-152`). On the production deployment a tenant without Stripe still shows "Pay · £x" with the Apple icon; the POST answers 400 "This gym has not connected Stripe yet". Also the post-Stripe success screen reuses "show this to staff at the front desk to collect" copy for an already-paid order (`shop/page.tsx:74-77,152`).

### R7 — Class-pack Stripe return is unacknowledged
`app/api/member/class-packs/buy/route.ts:77-78` sends the member back to `/member/profile?pack=success|cancel`; nothing anywhere reads the `pack` param (repo-wide grep). Confirmation depends on the webhook having landed before `ClassPacksWidget` mounts; otherwise the member paid and sees nothing new, with no message either way.

### R8 — KidBillingCard subscribe ends in deliberate limbo
`POST /api/member/subscriptions/start-for-kid` returns a PaymentIntent `clientSecret` (`route.ts:157-165`) that the card never confirms (no Stripe.js on the page); `components/member/KidBillingCard.tsx:120-127` tells the parent "speak to gym staff to confirm the first payment" and the sub sits `incomplete` at Stripe until it expires. Documented as intentional in-code, but as a connection point the flow cannot complete in-app and depends on a manual staff step that has no staff-side prompt.

### R9 — Closing one announcement marks ALL announcements seen
`app/member/home/page.tsx:1755-1762`: `AnnouncementModal onClose` fires `POST /api/member/me/mark-announcements-seen`, which stamps `lastAnnouncementSeenAt = now` — every other unseen announcement's `unseen` flag is cleared without ever being shown (the auto-open only surfaces the first unseen one, line 1333-1336).

---

## DEBT

1. **Orphan routes:** `/api/member/totp/verify`, `/api/auth/totp/recover`, `/api/member/totp/recover` have no callers (see B1/B3). `/api/member/totp/recovery-codes` + `/api/auth/totp/recovery-codes` are called only during enrolment; the "regenerate anytime from **Settings → Account**" promise in `TotpEnrollmentStep.tsx:138,388` names a surface that does not exist for members (staff have SettingsPage PP-003; members have nothing).
2. **Announcement `links` UI is unreachable:** the `Announcement` model has no `links` column (`prisma/schema.prisma:515-534`), and the home-page mapping (`home/page.tsx:1322-1330`) wouldn't forward one anyway — the link-rendering blocks in `AnnouncementCard` (163-192) and `AnnouncementModal` (126-141) are dead code behind a type that lies.
3. **Fabricated footer links on profile:** `app/member/profile/page.tsx:612-616` invents `${gymWebsite}/terms` and `${gymWebsite}/support` — dead links for any gym whose site lacks those paths.
4. **Stripe portal return target mismatch:** `app/api/stripe/portal/route.ts:55` returns to `/member/profile`, but the "Manage billing" button lives on `/member/billing`.
5. **`/waiver/open` error state has no retry** (`app/waiver/open/page.tsx:90-95`) — a transient network failure requires a manual browser reload; every member surface elsewhere got retry banners.
6. **FamilySection row menu has no outside-click/Escape dismissal** (`components/member/FamilySection.tsx:220-268`) — menu stays open until another explicit tap (KNOWN — UI-AUDIT follow-up #9).
7. **ClassPacksWidget `buying` never resets** if the `window.location.href` navigation is interrupted (`ClassPacksWidget.tsx:66-71`) — all Buy buttons stay disabled (KNOWN — follow-up #9).
8. **KidBillingCard reads `stripePriceId` through an untyped cast** (`KidBillingCard.tsx:100`) while the billing GET does return it (`app/api/member/family/[id]/billing/route.ts:62-73`) — works today, drifts silently the day the select changes. Shop page also derives its accent solely from `localStorage["gym-settings"]` (`shop/page.tsx:31-37`), defaulting to blue on first-ever visit.

---

## Connection-point matrix (problem rows only)

| Client call (file:line) | Route + method | Verdict |
|---|---|---|
| `app/login/totp/page.tsx:20` POST `/api/auth/totp/verify` | exists, POST ✓ | **BROKEN for members** — route reads User table only; member ids 400 (B1) |
| *(intended)* member verify | `/api/member/totp/verify` POST | **Orphan** — no caller; middleware would redirect the POST anyway (B1) |
| *(none)* | `/api/auth/totp/recover`, `/api/member/totp/recover` POST | **Orphan** — recovery codes unredeemable (B3) |
| `components/kiosk/KioskPage.tsx:165` GET `/api/waiver/kiosk-status` | exists ✓, shapes match | **Flow-broken** — 10s idle reset kills the polling step (B2) |
| `components/member/SignWaiverSection.tsx:86` POST `/api/waiver/sign` | exists ✓, schema matches | **Dead-ends** on 400 emergency-contact precondition with no UI to satisfy it (B4) |
| `components/member/KidPhotosAndWaiver.tsx:300` POST `/api/waiver/sign-for-child` | exists ✓ | Same B4 dead end for parents |
| `components/member/MemberActionsPanel` system action `emergency_contact_missing` → `/member/profile` | page exists | **Dead end** — target page has no emergency-contact fields (B4) |
| `app/member/home/page.tsx:972` POST `/api/checkin` | exists ✓, member-self allowed | Skipped when `classInstanceId` null → fake "Signed in!" (R1) |
| `app/member/home/page.tsx:295` PATCH `/api/member/me` (onboarding) | exists ✓ | `classes`/`style`/`heard` never sent, no server fields either (R2) |
| `components/member/KidPhotosAndWaiver.tsx:81` POST `/api/upload` (no purpose) | exists ✓ | Guard = owner-only → always 401/403; silent data:-URL fallback (R3); no parent-of-kid branch even with `purpose=member-photo` |
| `app/member/progress/page.tsx:278` GET `/api/member/classes` | exists ✓ | Attendance-derived data under "subscribed classes" copy (R4) |
| `app/member/shop/page.tsx:108` POST `/api/member/checkout` | exists ✓, schema matches | CTA mode (build-env) vs server mode (tenant) mismatch (R6) |
| `components/member/PurchasePackClient.tsx:45` POST `/api/member/class-packs/buy` | exists ✓ | Success/cancel redirect param `?pack=` unhandled on `/member/profile` (R7) |
| `components/member/KidBillingCard.tsx:105` POST `/api/member/subscriptions/start-for-kid` | exists ✓, schema matches | `clientSecret` never confirmed client-side (R8) |
| `app/member/home/page.tsx:1759` POST `/api/member/me/mark-announcements-seen` | exists ✓ | Marks all seen on closing one (R9) |

Verified clean (fetch → route → schema → response shape → guard all consistent): `/api/member/home`, `/api/member/me` GET/PATCH (+`?fields=security`), `/api/me/gym`, `/api/member/schedule`, `/api/member/me/subscriptions`, `/api/member/class-subscriptions/[classId]` POST/DELETE, `/api/member/me/children` (+PATCH/DELETE/[id]), `/api/member/children` POST (accepts `dateOfBirth: null`), `/api/member/children/[id]/photos` GET/POST/[photoId] DELETE, `/api/member/family/[id]/billing` (+portal), `/api/member/subscriptions/cancel-for-kid`, `/api/member/class-packs` (+buy schema), `/api/member/products`, `/api/member/tasks` (+complete), `/api/member/me/payments`, `/api/member/me/recent-demotion`, `/api/members/[id]/profile-picture` PUT/DELETE (member-self branch present), `/api/upload?purpose=profile-pic` (self branch works for own avatar), `/api/upload/delete-orphan`, `/api/waiver` GET, `/api/waiver/open` GET/POST, `/api/waiver/kiosk-request`, kiosk `classes`/`members`/`checkin` (instance ids, `waiverOk`/`selfTrainable`/`linkedKids` all present), `/api/members/accept-invite` (+ page auto-sign-in + `/login?email=` fallback), `/api/magic-link/request`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/account/pending-tenant`, `/api/tenant/[slug]`. All nav targets (`router.push`/`href`) resolve to existing pages; proxy role-gates route members ↔ staff correctly post-TOTP.

---

## What I could not verify statically (needs runtime/e2e)

1. **B1 end-to-end on production config** — TESTING_MODE forces `totpPending=false` (`auth.ts:335,376`), so no local/e2e run exercises the member second-factor challenge; the lockout is inferred from code paths. A prod-config probe (TESTING_MODE off, member with `totpEnabled=true`, password login) is the definitive confirmation. The e2e specs (`member-totp-enrol.spec.ts:164` skip; recovery spec is API-level only) do not cover the `/login/totp` UI round-trip for members.
2. **Exact fetch behaviour of the 307** from `proxy.ts:187` on `POST /api/member/totp/verify` (redirect-follow semantics of `fetch` on a page-route POST) — direction of failure is certain, the exact status the client sees is not.
3. **R1 frequency** — how reliably `api/cron/class-instances` materialises today's instances (and whether schedule startTime always matches instance startTime after edits). Determines whether the fake-success branch is rare or routine.
4. **B4 exposure size** — whether the CSV/staff member-creation paths set `onboardingCompleted=true` (bypassing the wizard, hence the trio). `POST /api/member/children` does (`route.ts:100`); the staff/import routes are Lane B/C territory.
5. **Webhook latency window for R7** (pack credit appears only after `checkout.session.completed` lands).
6. **Kiosk email delivery latency for B2** — the 10s reset is broken regardless, but real Resend latency defines how visibly.
7. **`sharp` upload route behaviour on data:-fallback caps** for R3 (photos between the downscale output size and the 3.5MB JSON cap).
