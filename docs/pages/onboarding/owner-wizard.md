# /onboarding

| | |
|---|---|
| **File** | app/onboarding/page.tsx |
| **Section** | onboarding |
| **Auth gating** | PUBLIC_PREFIXES includes `/onboarding` (proxy lets through); page-level: `auth()` → redirects to `/login` if no session; redirects to `/dashboard` if `role !== "owner"`; redirects to `/dashboard` if `tenant.onboardingCompleted === true` |
| **Roles allowed** | owner only |
| **Status** | ✅ working |

## Purpose
Multi-step wizard shown to a new gym owner after their account is first created. Six steps: (1) gym name confirmation, (2) discipline selection, (3) rank presets from templates, (4) class creation, (5) branding (logo upload, colour picker), (6) operational Q&A (gym size, goals, referral source). Completing the wizard calls several APIs to persist each step, then sets `Tenant.onboardingCompleted = true`. The wizard is also reachable any time via "Reset onboarding" in `/dashboard/settings` (POST `/api/owner/reset-onboarding`). Rendered as a full-screen bottom-sheet overlay (`fixed inset-0 z-50`).

## Inbound links
- [/dashboard](../dashboard/home.md) — dashboard layout redirects owner here when `tenant.onboardingCompleted === false`
- [/dashboard/settings](../dashboard/settings.md) — "Reset onboarding" action navigates back here

## Outbound links
- [/dashboard](../dashboard/home.md) — `router.push("/dashboard")` on wizard completion (OwnerOnboardingWizard.tsx line 983)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| PATCH | /api/settings | Save gym name, branding, colours, onboardingAnswers |
| POST | /api/ranks | Create rank templates (called per preset) |
| POST | /api/classes | Create initial class definitions |
| POST | /api/upload | Upload gym logo (Vercel Blob) |
| POST | /api/instances/generate | Generate class instances after classes are created |

## Sub-components
- OwnerOnboardingWizard ([components/onboarding/OwnerOnboardingWizard.tsx](../../../components/onboarding/OwnerOnboardingWizard.tsx)) — full wizard UI with step state management, form validation (zod), and all API calls

## Mobile / responsive
- `fixed inset-0 z-50` full-screen overlay — works on all screen sizes. Bottom-sheet handle and scrollable content area.

## States handled
- Step progression managed locally in `OwnerOnboardingWizard`.
- Form validation per step (zod).
- Loading states per API call.
- Error states with inline messages.

## Known issues
- **P0 ✅ Resolved** — Earlier misclassified as a P0 (route requiring public access). `/onboarding` correctly requires a session; unauthenticated requests 307→`/login` is intentional behaviour (see OWNER_SITE_SUMMARY.md).

## Notes
The page passes `tenantName`, `ownerName`, and `primaryColor` from the session to `OwnerOnboardingWizard`. Resetting onboarding via Settings does **not** delete any existing members, classes, ranks, branding, attendances, payments, or waivers — it only flips the `onboardingCompleted` flag and clears `onboardingAnswers`.
