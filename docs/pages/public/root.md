# /

| | |
|---|---|
| **File** | app/page.tsx |
| **Section** | public |
| **Auth gating** | Not in PUBLIC_PREFIXES — proxy redirects unauthenticated requests to `/login`; authenticated users hit this only momentarily before `redirect("/dashboard")` fires |
| **Roles allowed** | all authenticated roles (redirect fires before any role check) |
| **Status** | ✅ working |

## Purpose
Entry-point for the root URL. Contains a single `redirect("/dashboard")` call so any request to `/` is immediately forwarded to the dashboard. There is no rendered UI.

## Inbound links
— (no page links here; users land via direct URL or bookmark)

## Outbound links
- [/dashboard](../dashboard/home.md) — unconditional server-side redirect

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | — | — |

## Sub-components
— (no components rendered)

## Mobile / responsive
— (no UI rendered)

## States handled
— (single redirect, no states)

## Known issues
— none

## Notes
Because `/` is not in PUBLIC_PREFIXES, unauthenticated visitors are redirected to `/login` by the proxy before this component is ever invoked. Authenticated visitors land on the server component which immediately issues `redirect("/dashboard")`. The net result is that `/` never renders anything.
