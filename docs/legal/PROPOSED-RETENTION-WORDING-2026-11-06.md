# Retention wording — Published with #72, approved by Noe 6 Nov 14:08

Noe, 6 Nov 2026, 11:51: "remove for now but make note" (deferred). Noe, 6 Nov 2026, 14:08: "Yes, publish it with
#72." The wording below is in `app/legal/privacy/page.tsx` (§6) and `app/legal/terms/page.tsx` (§8) in PR #72
("Keep every club record: no automatic deletion, Activity shows all history"), live once that PR is merged and
deployed. The "Before" column records the text it replaces.

## The mismatch it closed

Since PR "Keep every club record: no automatic deletion, Activity shows all history" (branch
`fix/activity-permanent`), MatFlow keeps everything (`docs/RULES.md` §5d). The pages said otherwise before this change:

- **Privacy §6 says** audit logs are kept "twelve months, then deleted by a scheduled job that runs daily", email
  delivery logs "twelve months", expired sign-in and reset links are "purged daily, within 24 hours of expiry", and a
  closed gym is "recoverable for 30 days, after which its records are permanently erased".
- **The code keeps** audit logs, email delivery logs, sign-in records, expired links, import files and closed gyms,
  with no end date. Nothing is deleted automatically. A closed gym is erased only when it asks in writing
  (`scripts/erase-closed-club.mjs`, run by hand).
- **Terms §8 says** that on cancellation the data "is retained for 30 days … after which it is deleted on request". The
  code keeps it until the gym asks in writing.

Before this change, the published policy promised deletions that do not happen. Under UK GDPR, keeping records
with no end date also needs a stated purpose; the proposal below states one.

## Privacy §6 lines (published)

| Before | Published |
|---|---|
| Audit logs — twelve months, then deleted by a scheduled job that runs daily | Audit logs (the gym's Activity history), email delivery logs, sign-in records and import files — kept for as long as the gym uses MatFlow, for the gym's own records and to resolve disputes. Nothing is deleted automatically. |
| Email delivery logs — twelve months, deleted by the same daily job | (merged into the line above) |
| Expired sign-in links and password-reset links — purged daily, within 24 hours of expiry | Expired sign-in links and password-reset links — kept, and unusable once expired |
| Closed gyms — a gym marked for deletion is recoverable for 30 days, after which its records are permanently erased | Closed gyms — kept with sign-in disabled so the gym can reopen. When the gym asks in writing, we erase the gym, its members' records and every file it stored; a record that the erasure happened and the gym's audit log are kept as evidence |
| (none) | Erasure requests — when a gym asks us to erase a member, we remove that member's details everywhere we hold them, including kept import files and photos. True as of #72: the erasure also rewrites kept import files (rows found by the member's current and earlier addresses and names) and redacts the personal values recorded on the member's own Activity rows (`lib/audit-redact.ts`) |

## Terms §8 (published)

- Before: "On cancellation, your data is retained for 30 days so you can export it or reactivate, after which it
  is deleted on request to legal@matflow.studio while automated post-cancellation deletion is rolled out."
- Published: "On cancellation, your gym and its data are kept, with sign-in disabled, so you can reactivate at any time
  or ask us for an export. Nothing is deleted automatically: your data is kept until you ask in writing for it to be
  erased, at legal@matflow.studio. Erasure removes your gym, its members' records and every file it stored; a record
  that the erasure happened and your gym's audit log are kept as evidence."

## Not legal text (operator UI, same PR)

The hub's Danger Zone (operator UI) says "Close gym — Logins are refused and the gym leaves the active list.
Everything is kept; it can be reopened at any time."
