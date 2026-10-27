# TeamUp ↔ MatFlow operating contract (daily operations while TeamUp bills)

Status: **PROPOSED — awaiting Noe's and Sean's confirmation** (readiness spec v3 §7). Prepared 30 Sep 2026. Until both confirm the field table and the refresh procedure, daily operations on real data are **NO-GO** (spec §7: "a billing split without an agreed maintenance procedure is a daily-operations NO-GO").

> **Later uploads (decided 25 Oct 2026).** Noe, in his words: "A later upload must not silently overwrite
> existing MatFlow values. Add genuinely new records, skip exact duplicates, and show conflicting or ambiguous
> records for an authorised person to resolve. Where previous ownership or edit history is unknown, preserve the
> current value and flag the conflict." And: "Keep the existing role permissions… Imported records should be
> editable through the same authorised workflows as equivalent MatFlow-created records." (24 Oct: once imported,
> "all that information should be taken as Matflow information".) §2, §3 and §5 below state the behaviour that
> follows; it is built on branch `sean/c1-import` (not yet merged).

## 1. What this contract covers
During the bridge, Total BJJ runs its day in MatFlow — roster, classes, check-in, attendance, waivers, holds, cash taken at the desk — while **TeamUp and Sean's Stripe keep collecting every existing recurring membership**. MatFlow must never start, change or stop that collection, and must never suggest it has.

**There is no automatic TeamUp → MatFlow sync.** TeamUp offers no integration MatFlow uses. A fresh TeamUp memberships export can be **checked** against MatFlow (a *status refresh*): the owner uploads it, previews it and runs it, and it lists who differs. It changes nobody; staff change a member by hand if the export is right.

## 2. Who owns each field (proposed)

| Data / action | Owner during the bridge | How it reaches the other system | Safeguard in MatFlow |
|---|---|---|---|
| Existing recurring collection (card, Direct Debit) | **TeamUp** | — | Card subscriptions started by the member, a parent or staff are refused for any member marked *billed by TeamUp* (`409 billed_elsewhere`). The membership migration is the one sanctioned way to move a member to MatFlow billing (gate G4, per cohort, per the cutover manifest); on success it marks the member *billed by MatFlow*. It stays unavailable during the bridge because review mode refuses it and the club is not connected to Stripe in MatFlow. |
| Payment standing (paid / overdue / on hold / cancelled) and plan | **MatFlow** once imported (TeamUp keeps the billing) | The first import sets them; a later export is only compared | A later upload lists every difference in the import history for the owner, with the file's value beside MatFlow's current one; nothing is written. Staff change the member through the normal edit, with its normal permissions. |
| New memberships, plan changes, cancellations of billing | **TeamUp** for the billing; **MatFlow** for the member record | Staff make the change in both | The member page says TeamUp still bills the member and a MatFlow edit stays in MatFlow. |
| Cash taken at the desk | **MatFlow** (Record payment) | — (Sean reconciles against TeamUp manually) | One payment per request id; the payment is recorded in MatFlow only and does not tell TeamUp. |
| Holds and resumes (access) | **MatFlow for access; TeamUp for billing** | Sean pauses in TeamUp as well | The hold dialog for a TeamUp-billed member says: "This pauses access in MatFlow only. Pause the membership in TeamUp too, or TeamUp keeps collecting." |
| Contact details, emergency contact, medical notes, date of birth, photo, waiver | **MatFlow** (edited by staff or the member) | — | A status refresh does not touch these. |
| Class timetable, bookings, attendance from day one | **MatFlow** | — | The switch date is recorded; attendance before it arrives only through the attendance import. |
| Member messages about money | **TeamUp** | — | MatFlow's manual "chase" for a TeamUp-billed member warns that TeamUp sends its own reminders. MatFlow sends no automatic money reminders. |
| Invitations and MatFlow logins | **MatFlow** | — | Only after Sean signs off the imported data (gate G3). |

## 3. Later uploads: what each does (25 Oct 2026)
- **Members import (Add people) of a later file:** a genuinely new person is added; an exact duplicate (every compared value equal) is skipped and counted; a person who differs, or who could be more than one member, is **listed**, and nothing is written to anyone already in MatFlow. Compared values: name, email, phone, date of birth, account type, plan, status, payment status, cancellation date, join date, emergency contact. Not compared (decided exclusions): notes, next due date, guardian links.
- **Uncertain matches are never guessed:** two members match; the email points at one member and the TeamUp record at another; a member already carries a different TeamUp record; a no-email person matched by name alone; a TeamUp record whose key carries no email and whose date of birth does not match; one email held by a member with a different name.
- **Status refresh (a check):** the same file, matched by the TeamUp record the first import stored. It writes nothing; it lists who differs (status, payment standing, cancellation date, plan) and the usual exceptions (not in MatFlow, not in the file, billed by MatFlow, holds kept). Nothing to roll back.
- **Where the list is:** Settings → Import → Import history → "Review N people" on the job. Each person shows what the file said and what MatFlow holds **now**, and links to their member page; there is no "apply" button. Owner only, this club only. A member deleted or erased since is shown with no name or values, and their entries are scrubbed from the stored import record.
- **Plans:** an exact plan-name match (trimmed, any case) sets the plan. The TeamUp export carries a plan **name only** — no price, billing period or currency — so the decided four-way match (name, period, price, currency) cannot be met from a TeamUp file, and nothing is invented to fill the gap. A name two MatFlow plans share matches neither. A clear new person whose plan matches no single MatFlow plan is **imported without a plan and listed** ("Imported without a plan") until staff set one; plan-restricted classes may refuse them until then (decided 25 Oct: import and flag).
- **Preview equals commit:** the preview classifies with the same code as the commit, so its counts (will import, same as MatFlow, to review — differs / uncertain, staff login refused, child without parent) are what the run then does.
- **Matching key:** the person key the first import stored (email + name). A person whose name or email changed in TeamUp is listed, never matched by a guess, never created twice.

- **Holds:** a check never lifts or sets a hold. A member on hold in MatFlow whom TeamUp reports as active is listed ("TeamUp says paid") for staff to resume in MatFlow if that is right.

## 4. Door policy on stale standing — DECIDED (owner, 27 Oct 2026)
- Staleness alone **never refuses** a check-in.
- Decided 27 Oct 2026: imports no longer update an existing member, so the date never moves. "Billed by TeamUp · status as of <date>" now reads "Billed by TeamUp · Imported from TeamUp on <date>", and the 8-day "Billing status last updated" warning (`BILLING_STATUS_STALE_AFTER_DAYS`) is removed; left in, it would have stayed on for good. Who bills the member, and that MatFlow does not charge them, are unchanged.
- A standing that TeamUp reported as overdue or on hold behaves exactly as MatFlow's own overdue and hold rules do today (self and kiosk refuse a hold; staff may override with a reason).

## 5. Acceptance contract for the implementation (P1)
| Item | Expected | Refused / side effects | Test method |
|---|---|---|---|
| Mark a member as billed by TeamUp | Set by the TeamUp import (`billedBy = teamup`, `billingStatusAsOf` = export time, `billingStatusSource` = import job) | Nothing else changes | unit (commit writes the three fields); rehearsal on a synthetic club |
| Card subscription for a TeamUp-billed member | Refused with 409 `billed_elsewhere` and the sentence in §2 | No Stripe call, no row | unit per route (member self, parent for child, staff), before any provider call |
| Membership migration (G4 cutover) | A migrated member becomes `billedBy = matflow` with the TeamUp standing cleared | Refused while the club is in review; needs Stripe connected | unit on the apply writes |
| Later upload (import or check) | Writes no existing member; new people added; exact duplicates skipped; differences and uncertain matches listed with current values; preview counts equal the commit's | No member update, no invitations, emails, charges or subscriptions | unit (`import-conflicts`, `import-teamup-refresh`, `sec-d-import-security-state`); DB `import-conflicts-db` and `contact-email-change-imports-db` (both roles); browser journey `import-review` |
| Staleness warning | Removed 27 Oct 2026 (§4): no surface shows a stale state | — | unit (`billed-elsewhere-guard`, `billed-by-teamup-screens` at 10 and 90 days) |
| Honest screens | Profile, members list and register say "Billed by TeamUp · Imported from TeamUp on <date>"; hold dialog and chase carry the TeamUp sentences | — | component tests; e2e cell |
| Recovery | A check has nothing to roll back; a refresh recorded before 25 Oct 2026 still rolls back, restoring the previous standing | — | unit (legacy rollback) |

## 6. Open decisions (Noe / Sean)
1. Confirm the field table in §2.
2. ~~"Status as of" and the 8-day staleness warning after 25 Oct 2026 (§4): retire or reword.~~ Decided 27 Oct 2026: reworded to "Imported from TeamUp on <date>"; the warning is removed.
3. Confirm "cash at the desk only" for new money in MatFlow during the bridge.
4. Confirm the switch date from which attendance is recorded in MatFlow.
