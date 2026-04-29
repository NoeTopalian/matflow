# /legal/terms

| | |
|---|---|
| **File** | app/legal/terms/page.tsx |
| **Section** | legal |
| **Auth gating** | PUBLIC_PREFIXES includes `/legal` — no auth required |
| **Roles allowed** | unauthenticated (public) |
| **Status** | ✅ working |

## Purpose
Platform Terms of Service for MatFlow (effective 2026-04-27). Ten sections covering: what MatFlow is, payments and merchant-of-record (gym is MoR, not MatFlow), acceptable use, indemnity, limitation of liability, service availability, data/privacy/sub-processors, subscription/billing/termination, governing law (England and Wales), and contact. Rendered as a static `<article>` inside the shared legal layout (`app/legal/layout.tsx`) which provides the dark-themed header and cross-links to the other three legal pages.

## Inbound links
- [/legal/aup](aup.md) — cross-reference link in AUP preamble
- [/dashboard/settings](../dashboard/settings.md) — Stripe Connect ToS gate links here (via OWNER_SITE_SUMMARY.md reference)

## Outbound links
- [/legal/aup](aup.md) — inline link in section 3 (Acceptable Use)
- [/legal/privacy](privacy.md) — inline link in section 7
- [/legal/subprocessors](subprocessors.md) — inline link in section 7

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | — | — |

## Sub-components
— (pure static content; layout provided by app/legal/layout.tsx)

## Mobile / responsive
- `max-w-3xl mx-auto px-6` container — readable on all screen sizes. No special breakpoints needed.

## States handled
— (static page, no states)

## Known issues
— none

## Notes
The legal layout (`app/legal/layout.tsx`) adds a footer note: "This document is a draft pending legal review." All four legal pages share this layout. The `<Link href="/">` in the layout header points to `/`, which redirects to `/dashboard` for authenticated users and to `/login` for unauthenticated users.
