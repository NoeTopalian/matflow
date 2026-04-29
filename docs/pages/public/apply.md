# /apply

| | |
|---|---|
| **File** | app/apply/page.tsx |
| **Section** | public |
| **Auth gating** | PUBLIC_PREFIXES includes `/apply` — no auth required |
| **Roles allowed** | unauthenticated (public) |
| **Status** | ✅ working |

## Purpose
Public gym-owner application form. Collects gym name, owner name, email, phone, primary discipline (dropdown of 9 sports), approximate member count, and an optional message. On submit, POSTs to `/api/apply` which stores the application and (when email is configured) sends a notification. On success, shows a confirmation screen. Submission depends on `RESEND_API_KEY` being set for email notification to reach the MatFlow team.

## Inbound links
- [/login](login.md) — "Apply for Account Creation" button on the club-code step

## Outbound links
- [/login](login.md) — "Back to sign in" link on success screen and header back button

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/apply | Submit gym owner application |

## Sub-components
— (all UI inline in page file, uses react-hook-form + zod)

## Mobile / responsive
- White background, max-width 520 px centred. Email + phone fields use `grid-cols-1 sm:grid-cols-2` — stacked on mobile, side-by-side on sm+.

## States handled
- Loading spinner on submit button.
- Inline field-level validation errors (zod).
- API error banner below form.
- Success screen replaces form after submission.

## Known issues
- **P3 open** — No CAPTCHA or rate limiting on `/api/apply`; spam submissions possible — see OWNER_SITE_SUMMARY.md pending feature section.

## Notes
The ToS/Privacy links at the bottom (`<span>` elements) are non-functional — they do not navigate anywhere. Should link to `/legal/terms` and `/legal/privacy`.
