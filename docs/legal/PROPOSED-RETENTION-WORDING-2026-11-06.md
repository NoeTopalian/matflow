# Proposed retention wording — Deferred by Noe, 6 Nov 2026, not live

Noe, 6 Nov 2026, 11:51: "remove for now but make note". The live legal pages (`app/legal/privacy/page.tsx`,
`app/legal/terms/page.tsx`) are unchanged from main. This file holds the wording proposed for them, so it can be
picked up later. Nothing here is published.

## The mismatch, stated plainly

Since PR "Keep every club record: no automatic deletion, Activity shows all history" (branch
`fix/activity-permanent`), MatFlow keeps everything (`docs/RULES.md` §5d). The live pages still say otherwise:

- **Privacy §6 says** audit logs are kept "twelve months, then deleted by a scheduled job that runs daily", email
  delivery logs "twelve months", expired sign-in and reset links are "purged daily, within 24 hours of expiry", and a
  closed gym is "recoverable for 30 days, after which its records are permanently erased".
- **The code keeps** audit logs, email delivery logs, sign-in records, expired links, import files and closed gyms,
  with no end date. Nothing is deleted automatically. A closed gym is erased only when it asks in writing
  (`scripts/erase-closed-club.mjs`, run by hand).
- **Terms §8 says** that on cancellation the data "is retained for 30 days … after which it is deleted on request". The
  code keeps it until the gym asks in writing.

Until the pages change, the published policy promises deletions that do not happen. Under UK GDPR, keeping records
with no end date also needs a stated purpose; the proposal below states one.

## Proposed privacy §6 lines

| Live today | Proposed |
|---|---|
| Audit logs — twelve months, then deleted by a scheduled job that runs daily | Audit logs (the gym's Activity history), email delivery logs, sign-in records and import files — kept for as long as the gym uses MatFlow, for the gym's own records and to resolve disputes. Nothing is deleted automatically. |
| Email delivery logs — twelve months, deleted by the same daily job | (merged into the line above) |
| Expired sign-in links and password-reset links — purged daily, within 24 hours of expiry | Expired sign-in links and password-reset links — kept, and unusable once expired |
| Closed gyms — a gym marked for deletion is recoverable for 30 days, after which its records are permanently erased | Closed gyms — kept with sign-in disabled so the gym can reopen. When the gym asks in writing, we erase the gym, its members' records and every file it stored; a record that the erasure happened and the gym's audit log are kept as evidence |
| (none) | Erasure requests — when a gym asks us to erase a member, we remove that member's details everywhere we hold them, including kept import files and photos |

## Proposed terms §8

- Live today: "On cancellation, your data is retained for 30 days so you can export it or reactivate, after which it
  is deleted on request to legal@matflow.studio while automated post-cancellation deletion is rolled out."
- Proposed: "On cancellation, your gym and its data are kept, with sign-in disabled, so you can reactivate at any time
  or ask us for an export. Nothing is deleted automatically: your data is kept until you ask in writing for it to be
  erased, at legal@matflow.studio. Erasure removes your gym, its members' records and every file it stored; a record
  that the erasure happened and your gym's audit log are kept as evidence."

## Not legal text (already live on the branch)

The hub's Danger Zone (operator UI) says "Close gym — Logins are refused and the gym leaves the active list.
Everything is kept; it can be reopened at any time."
