# Member Home

> **Status:** ✅ Working · greeting + Next class card + Sign In to Class + Today's Classes + Announcements + onboarding wizard CTA.

## Purpose

The member's landing page on every login. Tells them three things at a glance: (1) when their next subscribed class is, (2) what's running today, (3) any new announcements. Plus a "Sign In to Class" shortcut for the in-gym workflow and an onboarding modal for first-time users.

## Surfaces

| Surface | Path |
|---|---|
| Page | [/member/home](../app/member/home/page.tsx) |
| Bottom nav | [MobileNav](../components/layout/MobileNav.tsx) — Home / Schedule / Progress / Profile |
| Onboarding modal (first login) | Inline in `home/page.tsx` (lines ~194-759 — 7-step wizard) |
| Announcement modal | [AnnouncementModal](../components/member/AnnouncementModal.tsx) — pops if there's an unseen pinned announcement |

## Page sections (top to bottom)

1. **Greeting** — "Good morning/afternoon/evening, {firstName}" + today's date
2. **Next class card** — derived from `Member.subscriptions` ∩ next ClassInstance. Shows class name + relative date ("Tomorrow · 10:00–11:00") + coach + location. Tapping it links to `/member/schedule`.
3. **Sign In to Class** button — opens a quick-pick of today's classes the member is subscribed to (or in walking range of) + redeems a class pack credit if owed
4. **Today's Classes** widget — every class running today, with capacity / coach / location
5. **Announcements** — list of recent posts (latest first); auto-shows pinned ones in the modal on first visit per post
6. **"Welcome to the gym!" onboarding CTA** — only visible while `Member.onboardingCompleted=false`

## API routes consumed

- [`GET /api/member/me`](../app/api/member/me/route.ts) — name, belt, membershipType, stats, **next class** computed server-side
- [`GET /api/member/schedule`](../app/api/member/schedule/route.ts) — used as fallback for "today's classes" if `/api/member/me` doesn't surface them
- [`GET /api/announcements`](../app/api/announcements/route.ts) — returns tenant announcements + `unseenCount` based on `Member.lastAnnouncementSeenAt`
- [`POST /api/member/me/mark-announcements-seen`](../app/api/member/me/mark-announcements-seen/route.ts) — stamps the seen-at timestamp when the modal is dismissed
- [`POST /api/checkin`](../app/api/checkin/route.ts) — fired by Sign In to Class

## Onboarding wizard (7 steps)

A modal that runs on first login (gated by `Member.onboardingCompleted=false` AND localStorage `bjj_onboarded` key absent):

1. Belt selection (5-belt grid for BJJ tenants, configurable per discipline) → stripe count 0-4
2. Classes you want to follow (multi-select from tenant's class list)
3. Gi preference (Gi / No-Gi / Both)
4. How did you hear about us? (dropdown)
5. Do you have children training here? (yes/no with brief explanation)
6. Health & Emergency Contact (DOB optional; emergency name + phone required; medical conditions multi-select)
7. Liability waiver — full waiver scroll + tickbox + drawn signature

On finish: `PATCH /api/member/me` writes preferences, `POST /api/waiver/sign` records the signed waiver (see [waiver-system.md](waiver-system.md)). `Member.onboardingCompleted` flips to true.

## Security

- All routes require an authed member session
- Tenant-scoped queries
- Onboarding waiver step uses the same secured `/api/waiver/sign` endpoint as the standalone waiver — magic-byte PNG check, Vercel Blob storage, audit-logged
- localStorage gate is convenience-only; server `onboardingCompleted` is authoritative

## Known limitations

- **Onboarding bypassable on a new device** — localStorage is per-browser, so a logged-in member on a fresh device sees the wizard again until they hit Skip / Finish.
- **No deep-link to the wizard** — once dismissed and `onboardingCompleted=true`, there's no UI to re-run it. Owner can reset via `/api/owner/reset-onboarding` route (untested in walkthrough).
- **Sign In to Class** doesn't surface a clear "you're not subscribed to any class today" empty state.
- **Greeting time-of-day** uses local browser time — no TZ awareness if a user travels across zones with a stale tab open.

## Files

- [app/member/home/page.tsx](../app/member/home/page.tsx) — page + onboarding modal
- [components/member/AnnouncementModal.tsx](../components/member/AnnouncementModal.tsx)
- [components/layout/MobileNav.tsx](../components/layout/MobileNav.tsx)
- [app/api/member/me/route.ts](../app/api/member/me/route.ts)
- [app/api/member/schedule/route.ts](../app/api/member/schedule/route.ts)
- [app/api/announcements/route.ts](../app/api/announcements/route.ts)
- [app/api/member/me/mark-announcements-seen/route.ts](../app/api/member/me/mark-announcements-seen/route.ts)
- [app/api/owner/reset-onboarding/route.ts](../app/api/owner/reset-onboarding/route.ts)
