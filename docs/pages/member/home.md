# /member/home

| | |
|---|---|
| **File** | app/member/home/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required; proxy blocks non-members from `/member` (staff redirected to `/dashboard`) |
| **Roles allowed** | member |
| **Status** | ✅ working |

## Purpose
Primary member dashboard. Shows a personalised greeting, today's classes (fetched from `/api/member/schedule?date=<today>` filtered to today's day-of-week), a gym announcements feed (from `/api/announcements`), and a prominent "Sign In to Class" CTA button. On first visit (no `bjj_onboarded` localStorage key) a 7-step onboarding modal fires automatically: belt selection, class preferences, gi preference, referral source, children question, health/emergency contact, and liability waiver with drawn signature. Falls back to demo data if API calls fail.

## Inbound links
- [/login](../public/login.md) — `router.push("/member/home")` for role `member`
- [/member](root.md) — redirect
- proxy — redirects authenticated members away from `/dashboard` here

## Outbound links
- [/member/schedule](schedule.md) — announcement internal link (`href="/member/schedule"`) shown in demo data
- [/member/home](home.md) — "Sign In to Class" sheet (self-referential after sign-in success)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/member/me | Fetch member name, primaryColor, onboardingCompleted |
| GET | /api/member/schedule?date= | Fetch today's classes with classInstanceId for self check-in |
| GET | /api/announcements | Fetch gym announcements (pinned-first) |
| POST | /api/checkin | Self check-in to a class (from Sign-In sheet) |
| PATCH | /api/member/me | Save onboarding data (belt, emergency contact, medical conditions, DOB) |
| GET | /api/waiver | Fetch waiver title + content for the waiver step |
| POST | /api/waiver/sign | Submit signed waiver with drawn signature and typed name |

## Sub-components
- `AnnouncementCard` (inline) — expandable announcement card with image + links
- `OnboardingModal` (inline) — 7-step member onboarding bottom-sheet
- `SignInSheet` (inline) — class-selection bottom-sheet for self check-in
- `SignaturePad` ([components/ui/SignaturePad.tsx](../../../components/ui/SignaturePad.tsx)) — canvas-based drawn signature capture

## Mobile / responsive
- Mobile-first full-screen layout. Safe-area padding for iPhone notch/home indicator on the onboarding modal navigation buttons (`env(safe-area-inset-bottom)`). All sections stack vertically.

## States handled
- Loading: demo data shown until API calls resolve.
- Error: red banner with Retry button if any fetch fails (`loadError` state).
- Onboarding: auto-shown on first visit; skippable.
- Sign-in: success state with checkmark, auto-closes after 1800 ms.
- Class full / almost-full badge indicators.

## Known issues
- **P2 open** — Notification preference toggles in OnboardingModal (class reminders, promotions, announcements) are UI-only; no API call persists them.
- **P3 open** — `inputMode` missing on OTP-style fields in onboarding — see docs/AUDIT-2026-04-27.md WP-G.

## Notes
The onboarding step count displayed is "Question X of 5" for steps 1–5, then "Step 6 of 7" and "Step 7 of 7" for the health and waiver steps — a minor copy inconsistency. The `ONBOARDING_KEY = "bjj_onboarded"` localStorage flag gates the modal; clearing localStorage re-triggers it.
