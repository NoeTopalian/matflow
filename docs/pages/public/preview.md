# /preview

| | |
|---|---|
| **File** | app/preview/page.tsx |
| **Section** | public |
| **Auth gating** | PUBLIC_PREFIXES includes `/preview` — no auth required |
| **Roles allowed** | unauthenticated (public) |
| **Status** | ✅ working |

## Purpose
Interactive branding preview page for prospective gym owners and the sales/marketing site. Renders a full pixel-accurate mock of the MatFlow dashboard shell (sidebar, topbar, stat cards, today's classes, recent activity) with static/demo data. Five preset themes (Total BJJ, Red Dragon MMA, Gold Standard, Emerald Judo, Navy Combat) and three colour pickers (primary, secondary, text) allow live theme customisation. No backend calls — entirely client-side with hardcoded demo data.

## Inbound links
— (intended to be linked from the MatFlow marketing site; no inbound links from within the app)

## Outbound links
— (no outbound links; self-contained preview)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | — | — |

## Sub-components
— (all inline; sidebar, topbar, stat cards, class list, activity feed rendered inline with no external component imports)

## Mobile / responsive
- The preview shell is fixed at max-width 1100 px and height 640 px — designed for desktop viewing only. The controls panel wraps on small screens but the app shell itself may overflow on mobile viewports. Not intended for mobile use.

## States handled
- Preset selection updates all three colour state values simultaneously.
- Colour pickers update individually.

## Known issues
— none

## Notes
This page uses only inline styles (no Tailwind classes for the shell itself) for precise pixel rendering of the demo UI. The gym name in the sidebar updates when a preset is selected. The page footer notes "Preview only — colours are fully customisable per gym in Settings".
