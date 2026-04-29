# /legal/subprocessors

| | |
|---|---|
| **File** | app/legal/subprocessors/page.tsx |
| **Section** | legal |
| **Auth gating** | PUBLIC_PREFIXES includes `/legal` — no auth required |
| **Roles allowed** | unauthenticated (public) |
| **Status** | ✅ working |

## Purpose
Lists all third-party sub-processors used by MatFlow (updated 2026-04-27). Renders a table with seven rows: Vercel (hosting), Neon (PostgreSQL database, EU eu-west-2), Stripe (payment processing), Resend (transactional email), Vercel Blob (file storage), Anthropic/Claude (optional AI monthly report), and Google Cloud Drive API (optional owner opt-in folder indexing). Each row shows provider, purpose, data handled, and region. Notes 30-day advance notice for material changes. Rendered inside the shared legal layout.

## Inbound links
- [/legal/terms](terms.md) — cross-reference in section 7
- [/legal/privacy](privacy.md) — cross-reference in section 4

## Outbound links
— (no outbound links)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | — | — |

## Sub-components
- `Row` helper function (inline in same file) — renders a `<tr>` with provider, purpose, data, region cells

## Mobile / responsive
- `max-w-3xl mx-auto px-6` container. Table may overflow horizontally on very narrow screens (no responsive scroll wrapper present).

## States handled
— (static page, no states)

## Known issues
— none

## Notes
Anthropic (Claude) and Google Drive entries are marked as "optional, gym opt-in" — these sub-processors are only engaged when `ANTHROPIC_API_KEY` and `GOOGLE_CLIENT_ID/SECRET` are configured and the owner has enabled the feature.
