# Round 2: saves that don't overwrite, reads that don't pretend (10 Nov 2026)

Baseline `origin/main` 33592fe0. Branch `fix/round2-saves`. This is separate from Round 1 (`fix/round1-trust`), which is verified but neither pushed nor merged. Each lead came from the 9 Nov site tour and was traced in the current code before any change. No permission, schema, query scope or business rule changed. The facts below hold as of 10 Nov 2026.

**Status key:** **Implemented** = in code on this branch. **Verified** = shown by the checks named. **Deferred** = found, left for later. **Blocked** = could not be checked.

## A. Branding across browsers and devices: implemented, verified

| | Before | Now |
|---|---|---|
| Editor's App Background and club font | Started from hard-coded `#111111` and Inter. Only this browser's `gym-settings` cache could change that. The page never passed `Tenant.bgColor` / `fontFamily`. | `app/dashboard/settings/page.tsx` passes both from the row it already reads, and the editor starts from them. |
| Browser cache in the editor | Overrode colours, font, logo and size. | Overrides none of them. It supplies only the logo background fill and preset name, which exist only in this browser, and only for the same club slug. |
| Save Branding | Sent every field. | Sends only fields that differ from the values the server last confirmed (`brandingChanges`). With nothing changed, it sends nothing. |
| What the save publishes | The cache and the staff colours were written **before** the PATCH. A failure removed the whole cache, including this browser's own preferences. | Written only after the server confirms, and with the confirmed values. A refused or lost save publishes nothing and leaves the cache as it was. |
| Failed save | No reply said "members still see the previous look", which isn't known. | No reply says it isn't known whether the save happened. The choices stay in the editor. |

**How unsaved changes are tracked.** The baseline is a ref, `savedBranding`, holding the values the server last confirmed.
- **Successful save:** the baseline takes the sent fields, so a later edit is compared with them.
- **Refused or lost save:** the baseline is unchanged, so the next Save resends the same change. Each field is simply set to a value, so resending is safe.
- **Logo:** an uploaded logo replaces the editor's preview immediately, so a retry reuses the stored URL rather than uploading again.

**Concurrency (not handled).** Two editors saving *different* fields both keep their changes, because only changed fields are sent. Two editors saving the *same* field: the last save wins. There is no stale-write check, and no claim of one.

## 2. An unsaved logo stays in the editor: implemented, verified
Picking a logo used to write it straight into this browser's `gym-settings` cache. The login page and member app read that cache, so the unsaved logo appeared there with no Save. It is now a preview in the editor only, and it is published once the server confirms.

## 3. Server first in the three cache readers: implemented, verified
| Reader | Before | Now |
|---|---|---|
| Login page (`lib/login-branding.ts`, moved out of the page file) | The cache overrode the server's logo, colours, background and font. | The server wins. The cache fills only a field the server did not send, and only for the same club. A saved "no logo" (null) stays no logo. |
| Staff theme (`components/layout/ThemeProvider.tsx`) | Cached accent, secondary and text colours overrode the club's. | The club's colours (props from the tenant row) win. The cache fills only an empty one. |
| Member app (`app/member/layout.tsx`) | The API already won, except for the logo: a club with no saved logo answers `null`, which was dropped, so a cached logo (possibly an unsaved preview) showed. | Once `/api/me/gym` answers, its logo wins, including null. Before it answers, the cache is still used as the loading fallback. |

Kept as before (legitimate local preferences or fallbacks): the logo background fill (this browser only, and labelled as such), the preset name, and the cache as a loading fallback before the API answers.

## B. Onboarding saves: implemented, verified
On main, steps 1, 5 and 6 and Finish awaited `/api/settings` without checking the result, and a thrown request advanced as well. Now:
- Each step advances only once the server confirms. Skip on the last step completes onboarding only once that save is confirmed.
- A refused save keeps the owner on the step with what they entered:
  - 4xx with a reason: "That wasn't saved: {reason}. Check what you entered…"
  - 401: "You've been signed out…"
  - Anything else: a generic "That wasn't saved…", with no server internals.
- No reply says the outcome is unknown and never says "nothing was saved".
- A second press while the save is out sends nothing (`busyRef`).
- Step 5's theme colour and summary are applied only after its save is confirmed.

**Relationship to PR #35.** This follows the approach of draft PR #35 (onboarding batch 1, 16 Oct 2026) and is narrowed to the live defect. #35's step 1, 5 and 6 code depends on its wider "send only changed fields when the wizard is reopened" policy: new saved-value props from its page changes (`savedName`, `savedAnswers`, `answersUnknown`, `savedLogoSize`), `stepFailure` UI and timed messages. Taking those would import that policy, so they were not extracted. The rest of #35 (CSV hand-off, class-save recovery, setup gaps) stays in #35. Merging #35 later will conflict on this file and needs a reconcile.

Not changed: step 3 (ranks), step 4 (classes) and the CSV hand-off. Their partial-failure handling is the part of #35 not taken here.

## C. Unavailable is not empty: implemented, verified (C2/C3 partly)
| Section | Before | Now |
|---|---|---|
| Settings → Revenue → Subscription Plans | A failed read showed "No plans yet". A thrown request spun forever. | Loading, plans, "No plans yet", or "Couldn't load your plans. They haven't been changed." with Retry (a re-read). |
| Staff member profile: 2FA card and comp-class roster | `.catch` turned a failure into "no 2FA" and "no roster". | `lib/member-profile-extras.ts` returns `extrasUnavailable`, and a notice with Reload is shown. 2FA is mentioned only to the owner and manager, who could see the reset card. The reset card needs a confirmed `totpEnabled`; on failure `totpRow` is null, so nothing is enabled. |

**C2/C3 coverage.**
- **Unit tests cover:**
  - the helper: success, empty, failure, and tenant scope on both queries;
  - the notice: wording per role, the Reload link, and no raw error text.
- **Not shown in a browser:** the failure state. The read happens on the server and a browser can't make it fail. No test-only fault switch was added, and a production-reachable one is not allowed.
- **Also not checked in a browser:** the genuinely-absent state on the member profile (no notice when there is simply no roster or 2FA).

## D. What the screen says is saved where: implemented, verified
- **Logo Background Fill:** "Saved on this device only; members and other browsers don't see this choice." It is stored in `localStorage`, and there is no Tenant column for it.
- **Club branding:** "Branding saved — member app updated" appears only after the PATCH succeeds.

## Regression tests reject the old behaviour (mutation proof)
Each old defect was put back behind the new interfaces, the matching test file was run, and the file was restored (`scratchpad/mutations.py`, run on 10 Nov 2026).
- **Result: 11 of 11 caught.**
- **First run:** 10 caught and 1 missed. The double-press test let React re-render between presses, so the button was already disabled when the second press arrived.
- **Fix:** the test now fires three presses in one batch.
- **Re-run:** that mutation is caught too.

| Defect put back | Test file | Result |
|---|---|---|
| Save sends every field | round2-settings-truth | 4 of 8 fail |
| Editor background from a hard-coded default | round2-settings-truth | 3 of 8 fail |
| Cache overrides the saved background in the editor | round2-settings-truth | 1 of 8 fail |
| Failed plan read shown as empty | round2-settings-truth | 2 of 8 fail |
| Failed extras read returned as "none" | member-profile-extras | 1 of 5 fail |
| Step 1 advances on a refused save | round2-onboarding-saves | 3 of 6 fail |
| A second press sends a second save | round2-onboarding-saves | 1 of 6 fail (after the test fix) |
| Finish shows done on a refused completion | round2-onboarding-saves | 1 of 6 fail |
| Picked logo written to the cache | round2-branding-cache | 2 of 6 fail |
| Login cache overrides server | round2-branding-cache | 2 of 6 fail |
| Staff theme cache overrides server | round2-branding-cache | 1 of 6 fail |

The member-app null-logo rule has no unit test. It is checked in the browser instead (journey L5).

## Verification by commit
| Check | Commit | Result |
|---|---|---|
| Full `npm test`, DB URLs unset (first pass, A/C/D) | f8824fd1 | 658 files passed, 123 skipped; 9,349 passed, 901 skipped, 3 todo; exit 0 |
| Full `npm test`, DB URLs unset (close-out) | 3899353c | **660 files passed, 123 skipped; 9,361 passed, 901 skipped, 3 todo; exit 0** |
| New and neighbouring unit files (10 files) | 3899353c (contents identical) | 64/64 |
| Mutation proof | 3899353c tree, restored after each | 11 of 11 caught (one only after the test fix noted above) |
| Typecheck and lint | 3899353c and the final docs-only head | tsc exit 0; eslint 0 errors; every UI ratchet at baseline. A first lint run failed the hex-literal ratchet (702 against a baseline of 701) on the new onboarding error banner; it now uses palette classes. |
| Production build | 3899353c | `BUILD EXIT 0`, tree clean |
| Journey `round2-settings-truth` (owner and member, desktop 1440 and phone 390, keyboard for Save, Retry and Continue) | 3899353c, run rmwa9h250e071ce | **20 PASS / 0 FAIL / 0 NOTE**; teardown left 0 rows. An earlier run on 213cf5af gave 10/0/0 for the first ten checks. |

The 123 skipped files are the DB integration files, which skip without a database URL. No DB suite was run: no database code or query changed. The two member-profile reads moved into a helper unchanged.

L6 note: the test environment has no blob storage, so the upload failed and the editor saved the logo through its existing data-URL fallback. L6 checks that the cache then holds exactly the saved value. A successful upload (one upload, then the stored URL reused on retry) is covered by `round2-branding-cache` only.

## Deferred
- **Settings remaining on the old cache.** `app/member/schedule/page.tsx` and `app/member/shop/page.tsx` read `primaryColor` from the cache with a default and no server value. The member layout refreshes that cache from `/api/me/gym`, so they settle after the first member page load. Not changed.
- **Onboarding steps 3 and 4 and the CSV hand-off.** Partial-failure handling stays in PR #35.
- **Branding concurrency.** There is no stale-write check (see above).
