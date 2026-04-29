# /legal/aup

| | |
|---|---|
| **File** | app/legal/aup/page.tsx |
| **Section** | legal |
| **Auth gating** | PUBLIC_PREFIXES includes `/legal` — no auth required |
| **Roles allowed** | unauthenticated (public) |
| **Status** | ✅ working |

## Purpose
Acceptable Use Policy for MatFlow (effective 2026-04-27). Three sections: a list of ten prohibited activities (Stripe restricted-business categories, illegal activities, credential sharing, spam, MLM schemes, storing card data, uploading malware, scraping, misrepresenting merchant-of-record, sanctions-list support); enforcement policy (suspension/termination with or without notice); and an abuse reporting contact (`abuse@matflow.io`). References the Platform Terms of Service and Stripe's own restricted-business list. Rendered inside the shared legal layout.

## Inbound links
- [/legal/terms](terms.md) — inline link in section 3 of Terms

## Outbound links
- [/legal/terms](terms.md) — preamble cross-reference

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | — | — |

## Sub-components
— (pure static content; layout provided by app/legal/layout.tsx)

## Mobile / responsive
- `max-w-3xl mx-auto px-6` container — readable on all screen sizes.

## States handled
— (static page, no states)

## Known issues
— none

## Notes
The AUP explicitly prohibits storing card numbers/CVVs through MatFlow (Stripe-hosted UI only). Egregious violations are reported to authorities and Stripe per the Enforcement section.
