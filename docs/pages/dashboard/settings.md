# /dashboard/settings

| | |
|---|---|
| **File** | app/dashboard/settings/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; inline check: `if (session.user.role !== "owner") redirect("/dashboard")` |
| **Roles allowed** | owner only |
| **Status** | ⚠️ partial — Google Drive integration throws without env vars |

## Purpose
Tenant configuration hub for the gym owner. Organised into tabs: Branding (logo upload, colours, font, logo size), Waiver (editable title + content with gym-name interpolation), Staff roster (add/edit/delete users; role changes bump `sessionVersion` to invalidate existing JWTs), Stripe Connect (connect/disconnect with ToS gate), TOTP setup/verify/disable, Google Drive integration, and subscription details. The "Reset onboarding" button flips `Tenant.onboardingCompleted = false` so the wizard fires again on next dashboard visit.

## Inbound links
- Sidebar ([components/layout/Sidebar.tsx](../../../components/layout/Sidebar.tsx)) — "Settings" nav item (owner only)
- MobileNav ([components/layout/MobileNav.tsx](../../../components/layout/MobileNav.tsx)) — "Settings" in the More drawer

## Outbound links
- [/onboarding](../onboarding/owner-wizard.md) — "Reset onboarding" navigates owner back to wizard on next dashboard load
- [/legal/terms](../legal/terms.md) — Stripe Connect ToS gate links here

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.tenant.findUniqueOrThrow | Fetch tenant data + member/staff/class counts (server-side) |
| — | prisma.user.findMany | Fetch staff roster (server-side) |
| — | prisma.member.groupBy | Member status counts (server-side) |
| — | prisma.user.findUnique | Current user TOTP enabled flag (server-side) |
| PATCH | /api/settings | Update branding, colours, waiver content |
| POST | /api/staff | Create a new staff account |
| PATCH | /api/staff/[id] | Update staff role/details (bumps sessionVersion on role change) |
| DELETE | /api/staff/[id] | Remove a staff account |
| POST | /api/auth/totp/setup | Initiate TOTP enrollment |
| POST | /api/auth/totp/verify | Verify TOTP setup code |
| POST | /api/stripe/connect | Initiate Stripe Connect OAuth |
| POST | /api/stripe/disconnect | Disconnect Stripe account |
| POST | /api/drive/connect | Connect Google Drive (requires GOOGLE_CLIENT_ID/SECRET) |
| POST | /api/owner/reset-onboarding | Flip onboardingCompleted = false |
| POST | /api/upload | Upload logo to Vercel Blob |

## Sub-components
- SettingsPage ([components/dashboard/SettingsPage.tsx](../../../components/dashboard/SettingsPage.tsx)) — largest component in the codebase; all tabs, forms, and sub-forms

## Mobile / responsive
- Mobile-aware with tab visibility fixes in recent commit. Tab scroll on small screens.

## States handled
- DB error: empty/null settings passed to SettingsPage (DB error silently caught).
- Each action has its own loading/error/success state within SettingsPage.

## Known issues
- **P1 open** — Google Drive `POST /api/drive/connect` throws 500 "OAuth not configured" when `GOOGLE_CLIENT_ID/SECRET` are absent — see PRODUCTION_QA_AUDIT.md.
- **P2 open** — `Tenant.memberSelfBilling` flag deferred; any authenticated member can discover and hit `/api/stripe/portal` directly — see OWNER_SITE_SUMMARY.md.
- **P2 open** — Sidebar accepts an unused `plan?: string` prop — dead code — see OWNER_SITE_SUMMARY.md.

## Notes
Staff role changes call `sessionVersion` bump so existing sessions for that staff member are immediately invalidated — they must re-login. TOTP enrollment is owner-only; once enrolled every login requires the TOTP step at `/login/totp`. Waiver content interpolates `{{gymName}}` placeholder via `buildDefaultWaiverTitle/Content` in `lib/default-waiver.ts`.
