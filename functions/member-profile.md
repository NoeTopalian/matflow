# Member Profile

> **Status:** ✅ Working · gym branding header w/ socials modal · journey milestones · curriculum card · family · personal details (Save persists) · membership card (owner-managed billing default) · notification toggles (UI only) · data & privacy.

## Purpose

The member's "everything about me" page — identity, journey, family, plan, preferences. Membership/billing is intentionally read-only by default (owner-managed; see [stripe-portal.md](stripe-portal.md) for the self-billing toggle).

## Surfaces

- Page: [/member/profile](../app/member/profile/page.tsx)
- Bottom nav: 4th tab

## Sections (top to bottom)

1. **Gym branding header** — logo + name + website domain. Tap → modal showing all configured gym socials (Instagram, Facebook, TikTok, YouTube, Twitter, website).
2. **Avatar** — initials, primary-color gradient, change-pic button (placeholder)
3. **My Journey** — horizontal milestone scroll (currently demo array of 6 — White Belt / 1st Stripe / 2nd Stripe / First Competition / Blue Belt / 1st Blue Stripe). NOT backed by an API yet — pure client constants.
4. **Beginner Foundations** — collapsible curriculum card with 4 categories × N techniques + ✓ checkboxes. Data is client-side constants (`BEGINNER_CARD` array).
5. **Family** — [FamilySection](../components/member/FamilySection.tsx) — see [member-family.md](member-family.md). Empty state CTA points to gym billing email.
6. **Personal Details** — Name (editable), Email (read-only, disabled), Phone (editable). Save button → `PATCH /api/member/me`. Persists to DB.
7. **Membership** — current plan + member-since date + "Manage subscription" link to `Tenant.websiteUrl`. Manage Billing button only renders if `Tenant.memberSelfBilling=true` (default OFF — see [stripe-portal.md](stripe-portal.md)).
8. **Notifications** — 3 toggles (Class reminders / Belt promotions / Gym announcements). UI-only today — no PATCH on toggle.
9. **Data & Privacy** — gym is the data controller; shows configured privacy contact email + privacy policy URL.
10. **Links** — Privacy Policy / Terms of Service / Help & Support (all link to gym website with sub-paths).
11. **Sign Out** — calls NextAuth `signOut({ callbackUrl: "/login" })`.

## API consumed

- [`GET /api/me/gym`](../app/api/me/gym/route.ts) — gym name, logoUrl, branding, socials, billing-contact email/URL, privacy contact, self-billing flag
- [`GET /api/member/me`](../app/api/member/me/route.ts) — name, email, phone, belt, membership type, member-since
- [`GET /api/member/me/payments`](../app/api/member/me/payments/route.ts) — last 100 payments (rendered inside `MemberBillingTab`)
- [`GET /api/member/class-packs`](../app/api/member/class-packs/route.ts) — owned + available packs (rendered inside `ClassPacksWidget`)
- [`GET /api/member/me/children`](../app/api/member/me/children/route.ts) — linked children for parent accounts
- [`PATCH /api/member/me`](../app/api/member/me/route.ts) — Save Personal Details
- (Notifications toggles do NOT POST today — known limitation below)

## Sub-components

- [MemberBillingTab](../components/member/MemberBillingTab.tsx) — payment history table + Manage Billing button (gated by `memberSelfBilling`)
- [ClassPacksWidget](../components/member/ClassPacksWidget.tsx) — owned packs + available packs to buy
- [FamilySection](../components/member/FamilySection.tsx) — children list
- `BeginnerCard` (inline in `profile/page.tsx`) — curriculum checklist
- `GymSocialsModal` (inline) — full-screen modal for socials

## Security

- All routes member-authed
- Tenant-scoped via `session.user.memberId` → `Member.tenantId`
- Email field disabled — members cannot self-rename their account email (would require re-verification flow)
- Self-billing button only renders behind `memberSelfBilling=true` flag — owner-managed billing is the default per project policy

## Known limitations

- **Notifications toggles are UI-only.** Switches flip locally but no PATCH fires. Schema field `Member.notificationsPrefs` (or per-subscription `notificationsEnabled`) exists but UI doesn't write it.
- **Journey milestones are hardcoded demo data.** Should be derived from `RankHistory` + custom milestone events (first competition, first seminar). Feature not built.
- **Beginner Foundations curriculum is hardcoded.** Should be `Tenant.curriculum: Json` editable in Settings → Waiver-equivalent tab. Not implemented.
- **Avatar upload not wired.** Camera button does nothing. Need member-side upload route (could reuse `/api/upload` with a `member: true` flag).
- **Phone field initially appears empty until fetch resolves** — can briefly look like the field is unbound (caught in walkthrough; turned out to be load-timing).

## Test coverage

- No vitest specifically for the page — relies on the underlying API tests + manual verification.

## Files

- [app/member/profile/page.tsx](../app/member/profile/page.tsx) — main page + sub-components
- [components/member/MemberBillingTab.tsx](../components/member/MemberBillingTab.tsx)
- [components/member/ClassPacksWidget.tsx](../components/member/ClassPacksWidget.tsx)
- [components/member/FamilySection.tsx](../components/member/FamilySection.tsx)
- [app/api/me/gym/route.ts](../app/api/me/gym/route.ts) — gym branding + socials + privacy
- [app/api/member/me/route.ts](../app/api/member/me/route.ts) — GET + PATCH
- See also [stripe-portal.md](stripe-portal.md), [member-family.md](member-family.md), [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md)
