# /legal/privacy

| | |
|---|---|
| **File** | app/legal/privacy/page.tsx |
| **Section** | legal |
| **Auth gating** | PUBLIC_PREFIXES includes `/legal` — no auth required |
| **Roles allowed** | unauthenticated (public) |
| **Status** | ✅ working |

## Purpose
Privacy Policy for MatFlow (effective 2026-04-27). Nine sections covering: data controller/processor roles (MatFlow is controller for staff accounts, processor for member data), what is stored (name, email, phone, DOB, medical/emergency info, Stripe IDs, attendance, audit logs — never card numbers), UK GDPR lawful bases, sub-processors, retention schedule, data-subject rights (including ICO complaint route), international transfers (UK IDTA / EU SCCs), security measures (TLS, AES-256-GCM OAuth tokens, bcrypt passwords), and contact. Rendered inside the shared legal layout.

## Inbound links
- [/legal/terms](terms.md) — cross-reference link in section 7 of Terms
- [/legal/subprocessors](subprocessors.md) — cross-reference

## Outbound links
- [/legal/subprocessors](subprocessors.md) — inline link in section 4

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
Section 7 confirms sub-processors Vercel, Neon, and Resend transfer data under UK IDTA or EU SCCs. Section 8 confirms card data never reaches MatFlow servers.
