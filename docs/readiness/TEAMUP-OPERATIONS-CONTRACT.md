# TeamUp ↔ MatFlow operating contract (daily operations while TeamUp bills)

Status: **PROPOSED — awaiting Noe's and Sean's confirmation** (readiness spec v3 §7). Prepared 30 Sep 2026. Until both confirm the field table and the refresh procedure, daily operations on real data are **NO-GO** (spec §7: "a billing split without an agreed maintenance procedure is a daily-operations NO-GO").

## 1. What this contract covers
During the bridge, Total BJJ runs its day in MatFlow — roster, classes, check-in, attendance, waivers, holds, cash taken at the desk — while **TeamUp and Sean's Stripe keep collecting every existing recurring membership**. MatFlow must never start, change or stop that collection, and must never suggest it has.

**There is no automatic TeamUp → MatFlow sync.** TeamUp offers no integration MatFlow uses. Billing standing reaches MatFlow only through a **controlled status refresh**: a fresh TeamUp memberships export, uploaded by a named operator, previewed, then committed.

## 2. Who owns each field (proposed)

| Data / action | Owner during the bridge | How it reaches the other system | Safeguard in MatFlow |
|---|---|---|---|
| Existing recurring collection (card, Direct Debit) | **TeamUp** | — | Card subscriptions started by the member, a parent or staff are refused for any member marked *billed by TeamUp* (`409 billed_elsewhere`). The membership migration is the one sanctioned way to move a member to MatFlow billing (gate G4, per cohort, per the cutover manifest); on success it marks the member *billed by MatFlow*. It stays unavailable during the bridge because review mode refuses it and the club is not connected to Stripe in MatFlow. |
| Payment standing (paid / overdue / on hold / cancelled) and plan | **TeamUp** | status refresh import | Each member carries the date of the export it came from ("status as of"). Staff see a warning when it is older than 8 days. A refresh never overwrites a MatFlow-owned field. |
| New memberships, plan changes, cancellations of billing | **TeamUp** | next status refresh | MatFlow screens for a TeamUp-billed member say the change must be made in TeamUp. |
| Cash taken at the desk | **MatFlow** (Record payment) | — (Sean reconciles against TeamUp manually) | One payment per request id; the payment is recorded in MatFlow only and does not tell TeamUp. |
| Holds and resumes (access) | **MatFlow for access; TeamUp for billing** | Sean pauses in TeamUp as well | The hold dialog for a TeamUp-billed member says: "This pauses access in MatFlow only. Pause the membership in TeamUp too, or TeamUp keeps collecting." |
| Contact details, emergency contact, medical notes, date of birth, photo, waiver | **MatFlow** (edited by staff or the member) | — | A status refresh does not touch these. |
| Class timetable, bookings, attendance from day one | **MatFlow** | — | The switch date is recorded; attendance before it arrives only through the attendance import. |
| Member messages about money | **TeamUp** | — | MatFlow's manual "chase" for a TeamUp-billed member warns that TeamUp sends its own reminders. MatFlow sends no automatic money reminders. |
| Invitations and MatFlow logins | **MatFlow** | — | Only after Sean signs off the imported data (gate G3). |

## 3. Status refresh procedure (proposed)
- **Who:** Noe (named operator) until handed to Sean in writing.
- **How often:** weekly, Monday before the first class; and on the day of any bulk change in TeamUp.
- **Steps:** export TeamUp memberships (all statuses) → note the export time → Settings → Import → TeamUp → *Status refresh* → read the preview: counts changed, exceptions → commit → read the exception list and resolve each (usually a name or email changed in TeamUp).
- **What it changes:** status, payment standing, cancellation date, plan, "status as of". Not the hold date: the TeamUp export carries no resume date, so a hold end is set in MatFlow. A refresh upload needs the export time; without it the standing would read "as of unknown". **What it never changes:** anything in the MatFlow-owned rows above.
- **Matching:** by the same person key the first import used (email + name, stored as the member's external reference). A person whose name or email changed in TeamUp is listed as an exception — never matched by a guess, never created twice.
- **Workload:** about 10 minutes a week plus exceptions.
- **Last successful refresh:** shown on the import history; staff see the staleness warning once it is more than 8 days old.

- **Holds (confirmed by the functional reviewer, 30 Sep 2026):** a refresh never lifts a hold. A TeamUp cancellation still ends the membership. A member on hold in MatFlow whom TeamUp now reports as active is listed as an exception ("TeamUp says paid") for staff to resume in MatFlow. **Limitation:** this includes members who were on hold *at TeamUp* when first imported — MatFlow does not yet record who placed a hold, so staff resume those by hand when TeamUp's hold ends. Proposed follow-up: record the hold's origin so a TeamUp-origin hold ends with TeamUp's. **Open (P3, F9):** the preview does not yet list the holds it will keep; they appear after commit.

## 4. Door policy on stale standing (proposed)
- Staleness alone **never refuses** a check-in.
- Staff see "Billing status last updated <date>" on the register and the member profile when the standing is more than 8 days old.
- A standing that TeamUp reported as overdue or on hold behaves exactly as MatFlow's own overdue and hold rules do today (self and kiosk refuse a hold; staff may override with a reason).

## 5. Acceptance contract for the implementation (P1)
| Item | Expected | Refused / side effects | Test method |
|---|---|---|---|
| Mark a member as billed by TeamUp | Set by the TeamUp import (`billedBy = teamup`, `billingStatusAsOf` = export time, `billingStatusSource` = import job) | Nothing else changes | unit (commit writes the three fields); rehearsal on a synthetic club |
| Card subscription for a TeamUp-billed member | Refused with 409 `billed_elsewhere` and the sentence in §2 | No Stripe call, no row | unit per route (member self, parent for child, staff), before any provider call |
| Membership migration (G4 cutover) | A migrated member becomes `billedBy = matflow` with the TeamUp standing cleared | Refused while the club is in review; needs Stripe connected | unit on the apply writes |
| Status refresh | Updates only TeamUp-owned fields (status, payment standing, cancellation date, plan/tier, status-as-of); lists unmatched and conflicting rows; preview before commit; same file twice refused | MatFlow-owned fields untouched; no invitations, emails, charges | unit (field ownership); rehearsal: import → edit contact in MatFlow → refresh → contact kept, status changed, exception listed |
| Staleness warning | Shown to staff when `billingStatusAsOf` is more than 8 days before now (club time) | Never blocks | unit with a frozen clock at 7 d 23 h and 8 d 1 h |
| Honest screens | Profile, members list and register say "Billed by TeamUp · status as of <date>"; hold dialog and chase carry the TeamUp sentences | — | component tests; e2e cell |
| Recovery | A bad refresh is rolled back by the import rollback, restoring the previous standing | — | rehearsal |

## 6. Open decisions (Noe / Sean)
1. Confirm the field table in §2.
2. Confirm the weekly refresh, its operator and the 8-day threshold.
3. Confirm "cash at the desk only" for new money in MatFlow during the bridge.
4. Confirm the switch date from which attendance is recorded in MatFlow.
