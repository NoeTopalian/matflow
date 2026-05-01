# Member Onboarding Wizard

> **Status:** ✅ Working · 7-step modal on first login · captures belt + class preferences + emergency contact + waiver signature in one flow.

## Purpose

Single-pass intake the first time a member opens the app. Replaces a long paper waiver + photocopier + manual data entry with a self-serve 5-minute experience. Final step signs the liability waiver, so by the time onboarding completes the member is legally clear to train.

## Surfaces

- Modal embedded inline in [/member/home](../app/member/home/page.tsx) (lines ~194-759 — `OnboardingModal` component)
- Triggered when `Member.onboardingCompleted === false` AND localStorage `bjj_onboarded` key absent
- "Skip for now" button defers — but the home page CTA card stays visible until completed

## 7 steps

| Step | Field(s) | Stored at |
|---|---|---|
| 1 | Belt selection (5-belt grid) → stripe count (0-4) | `MemberRank` create/update |
| 2 | Classes you want to follow (multi-select) | `ClassSubscription` rows |
| 3 | Gi preference (Gi / No-Gi / Both) | `Member.giPreference` (or in `onboardingAnswers` Json) |
| 4 | How did you hear about us? (dropdown) | `Member.onboardingAnswers.howHeard` |
| 5 | Children training? yes/no with descriptions | `Member.hasKidsHint` (boolean) |
| 6 | Health & Emergency Contact (DOB optional, EC name+phone required, medical conditions multi-select) | `Member.dateOfBirth`, `Member.emergencyContactName`, `Member.emergencyContactPhone`, `Member.medicalConditions` |
| 7 | Liability waiver — full text + tickbox + drawn signature | `SignedWaiver` row + `Member.waiverAccepted=true` (see [waiver-system.md](waiver-system.md)) |

## API calls

- [`PATCH /api/member/me`](../app/api/member/me/route.ts) — writes belt + classes + gi + howHeard + hasKidsHint + dateOfBirth + emergency contact + medical
- [`POST /api/waiver/sign`](../app/api/waiver/sign/route.ts) — signs the waiver (PNG signature uploaded to Vercel Blob, immutable `SignedWaiver` row)
- On success: `Member.onboardingCompleted=true` set in the same PATCH

## Flow

1. Member logs in → home → modal pops if not done
2. Per-step "Continue" button enables when required fields are filled
3. Step 7 requires: tickbox + non-empty drawn signature + agree
4. **Finish** → PATCH /api/member/me (all preferences) → POST /api/waiver/sign (signature blob + immutable snapshot)
5. Modal closes → `Member.onboardingCompleted = true` → home CTA card disappears

## Owner onboarding (separate)

The OWNER first-run wizard lives at [/onboarding](../app/onboarding/page.tsx) + [components/onboarding/OwnerOnboardingWizard.tsx](../components/onboarding/OwnerOnboardingWizard.tsx). Triggered when `Tenant.onboardingCompleted=false`. Captures: gym name confirmation, branding (logo + colours), first class, first staff invite. Different wizard, different data, different completion flag (`Tenant.onboardingCompleted` vs `Member.onboardingCompleted`).

## Security

- Member-authed
- All writes go through standard `/api/member/me` PATCH and `/api/waiver/sign` — same security as those routes (rate limit, magic-byte validation, etc.)
- Audit-logged via the underlying routes

## Known limitations

- **localStorage-only re-show gate** — if a member completes the wizard on their phone, then logs in on desktop, the wizard pops up again until they "Skip" or finish a second time. Server flag prevents data overwrites but UI doesn't suppress.
- **No re-onboarding** — there's no UI to re-run the wizard if the member's belt or contact info changes. Owner has to use [/api/owner/reset-onboarding](../app/api/owner/reset-onboarding/route.ts) (untested in walkthrough).
- **No partial-save** — if the member closes the tab on step 4, all 4 steps' data is lost (state is in-memory).
- **Step 1 belt selection assumes BJJ** — adapts if the tenant's RankSystem has a non-BJJ discipline, but the visual presentation (5-belt grid) might confuse Karate or Boxing tenants.

## Files

- [app/member/home/page.tsx](../app/member/home/page.tsx) — `OnboardingModal` component lives inline
- [app/api/member/me/route.ts](../app/api/member/me/route.ts) — PATCH writes all preferences
- [app/api/waiver/sign/route.ts](../app/api/waiver/sign/route.ts) — final waiver signature
- [components/onboarding/OwnerOnboardingWizard.tsx](../components/onboarding/OwnerOnboardingWizard.tsx) — separate owner first-run flow
- [app/onboarding/page.tsx](../app/onboarding/page.tsx) — owner wizard host page
- See [waiver-system.md](waiver-system.md) for the waiver step's data flow
