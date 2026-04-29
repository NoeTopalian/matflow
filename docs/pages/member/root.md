# /member

| | |
|---|---|
| **File** | app/member/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required (not in PUBLIC_PREFIXES); proxy also redirects staff roles away from `/member` to `/dashboard` |
| **Roles allowed** | member |
| **Status** | ✅ working |

## Purpose
Entry-point redirect for the member section. Contains a single `redirect("/member/home")` call — no UI rendered. Ensures that any navigation to `/member` lands on the member home page.

## Inbound links
— (not directly linked; used as a canonical entry point)

## Outbound links
- [/member/home](home.md) — unconditional server-side redirect

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | — | — |

## Sub-components
— (no components rendered)

## Mobile / responsive
— (no UI rendered)

## States handled
— (single redirect)

## Known issues
— none

## Notes
The proxy (proxy.ts lines 51–53) redirects any staff role away from `/member/*` to `/dashboard`. Members visiting `/member` are served this redirect component which sends them to `/member/home`.
