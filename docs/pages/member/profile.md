# /member/profile

| | |
|---|---|
| **File** | app/member/profile/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required; proxy blocks non-members from `/member` |
| **Roles allowed** | member |
| **Status** | ⚠️ partial — children section, journey milestones, and beginner card use static demo data |

## Purpose
Member self-service profile page. Sections: gym branding banner (links to gym website), avatar with belt/stripes display, billing tab (`MemberBillingTab`), class packs widget (`ClassPacksWidget`), "My Journey" horizontal milestone scroll (demo data), "Beginner Foundations" technique checklist (demo data), "My Children" parent-account section (demo data + local state), personal details form (name editable, email read-only, phone editable), membership info (type + member-since + manage-subscription link), notification preference toggles (UI-only, not persisted), and a sign-out button.

## Inbound links
- MobileNav member layout — "Profile" tab (primary navigation)
- [/member/purchase/pack/[id]](purchase-pack-id.md) — "Back to profile" link in PurchasePackClient

## Outbound links
— (external links to gym website only; no in-app navigation)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/me/gym | Fetch gym name for the branding banner |
| GET | /api/member/me | Fetch member name, email, phone, belt, membershipType, joinedAt |
| PATCH | /api/member/me | Save updated name and phone |

## Sub-components
- MemberBillingTab ([components/member/MemberBillingTab.tsx](../../../components/member/MemberBillingTab.tsx)) — subscription status and Stripe portal link
- ClassPacksWidget ([components/member/ClassPacksWidget.tsx](../../../components/member/ClassPacksWidget.tsx)) — lists active class packs for the member
- `BeginnerCard` (inline) — expandable technique checklist (static demo data)
- `ChildrenSection` (inline) — add/remove child profiles (local state only, not persisted)

## Mobile / responsive
- Mobile-first, `px-4` padded scroll view. All sections stack vertically. Avatar centred at top.

## States handled
- Load error: red retry banner.
- Save: loading spinner + success/error inline message (auto-dismisses after 3 s).

## Known issues
- **P2 open** — Journey milestones (My Journey section) use hardcoded `MILESTONES` demo data — not fetched from API.
- **P2 open** — Beginner card technique checklist uses hardcoded `BEGINNER_CARD` demo data — not fetched from API.
- **P2 open** — Children section uses local component state only; additions/removals are not persisted to the backend.
- **P2 open** — Notification toggles (class reminders, belt promotions, announcements) are UI-only; no API call persists preferences.
- **P2 open** — Camera button on avatar is a stub — no photo upload implemented.

## Notes
The "Manage subscription" link opens the gym's external website (`gymWebsite` from `/api/me/gym`), not a Stripe portal, for App Store compliance (no in-app payment UI). Email field is `readOnly disabled` — members cannot change their email address self-service.
