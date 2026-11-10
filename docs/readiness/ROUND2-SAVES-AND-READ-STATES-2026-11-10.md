# Round 2: saves that don't overwrite, reads that don't pretend (10 Nov 2026)

Baseline `origin/main` 33592fe0. Branch `fix/round2-saves`. This is separate from Round 1 (`fix/round1-trust`), which is verified but neither pushed nor merged. Each lead came from the 9 Nov site tour and was traced in the current code before any change. No permission, schema, query scope or business rule changed. The facts below hold as of 10 Nov 2026.

## A. Branding across browsers and devices

| | Before | Now |
|---|---|---|
| Editor's App Background and club font | Started from hard-coded `#111111` and Inter (`SettingsPage.tsx` state). Only this browser's `gym-settings` cache could change that. The page never passed the club's saved `Tenant.bgColor` / `fontFamily`, although it loads the whole tenant row. | `app/dashboard/settings/page.tsx` passes `bgColor` and `fontFamily` from the row it already reads. The editor starts from them, so there is no new request or query. |
| Browser cache | Overrode colours, font, logo and size in the editor, so a stale browser showed values the club never had. | It no longer overrides any server field. It supplies only the two choices that exist nowhere else: the logo background fill and the preset name, and only for the same club slug. |
| Save Branding | Sent every field, so a fresh or stale browser wrote its own background and font over the club's. | Sends only the fields that differ from the values the server last confirmed (`brandingChanges`). The PATCH schema leaves an omitted field untouched. With nothing changed, it sends nothing. |
| Failed save | Already said it failed (earlier fix). On no reply it said "members still see the previous look", which is not known. | On no reply it says it isn't known whether the save happened. The choices stay in the editor; nothing is marked saved, so the next Save resends them. |

**Not covered:** concurrent edits. Two owners saving different fields keep both. Two owners saving the same field: the last save wins. There is no stale-write check.

## B. Onboarding saves

Draft PR #35 (`fix/onboarding-batch1`, head 79f3795d) already makes every wizard save checked, keeps a failed step in place, sends only changed fields and guards against double submission. Main's wizard has not changed since #35 branched. Round 2 does not re-implement it. Whether to bring #35 forward is Noe's decision.

## C. Unavailable is not empty

| Section | Before | Now |
|---|---|---|
| Settings → Revenue → Subscription Plans | A failed `/api/stripe/subscription-plans` read showed "No plans yet". A thrown request left the spinner on forever. | Four states: loading, plans, "No plans yet", and "Couldn't load your plans. They haven't been changed." with Retry (a re-read). |
| Staff member profile: 2FA card and comp-class roster | `.catch` turned a failed read into "no 2FA" and "no roster", which hid both sections as if they did not apply. | `lib/member-profile-extras.ts` returns `extrasUnavailable`. The page shows "…couldn't be loaded, so they aren't shown. Nothing about them has changed." with Reload. 2FA is mentioned only to the owner and manager, who could see the reset card. The reset card still needs a confirmed `totpEnabled`; a failure enables nothing. |

## D. What the screen says is saved where
- **Logo Background Fill** now says: "Saved on this device only; members and other browsers don't see this choice." That matches the code: it is stored in `localStorage` and there is no Tenant column for it.
- **Club branding** (colours, background, font, logo, size, name) is saved for the club and shown as "Branding saved — member app updated" only after the PATCH succeeds.

## Retained, and found but out of scope
- The staff theme (`components/layout/ThemeProvider.tsx`), the login page and the member app still prefer this browser's `gym-settings` cache over the server's colours. This round fixed only the editor and its save.
- Choosing a logo writes the unsaved preview into that cache before Save. The member app and login page in that browser can then show a logo the club hasn't saved.

## Verification
See the completion report for the commit each check ran on.
- Unit: `tests/unit/round2-settings-truth.test.tsx` and `tests/unit/member-profile-extras.test.tsx`.
- Browser: `round2-settings-truth` journey.
