# Real data and daily operations — go / no-go

Readiness spec v3 §13 verdict document. Prepared 30 Sep 2026 (Italy time) for Noe. **Candidate: `{{FINAL_SHA}}` (local, unpushed). Deployed: the old build (`90868eb` last known) — none of this is live.**

## The two conclusions (spec §2)

**1. Existing-feature verification coverage: INCOMPLETE.** Every route, page, job and setting is in `FUNCTION-REGISTER.md` with a disposition, and the critical journeys pass on a production build. Not complete because: the independent security/data review never ran (BLOCKED), Stripe card journeys, kiosk/QR scanning, email delivery and two-factor on a phone were not exercised end to end locally, and a second browser engine was not run.

**2. Readiness for the agreed daily-operations launch (Sean runs the club in MatFlow while TeamUp bills): NO-GO — today.** The engineering is built and independently confirmed, and Noe's two product decisions are implemented (`60d3979`, `d2adaee`). What stops it now is four authorisations that are not the code's to give (below). With those settled, the remaining gates are G1 (deploy) and a real import into the review-locked club.

## What works (independently confirmed on a production build, restricted database role)
- Signing in, roles, sessions, forced password change for owner-set passwords; normal sign-in with every test bypass off (8/8 over https).
- The member portal at phone width: waivers (the text recorded is the text shown — adult and child), family check-in, emergency contact, retries that never duplicate a member, child, waiver or payment.
- The desk: register (marks only on Enter or a tap; asks before admitting a member without a waiver or on hold), members, holds and resumes (owner and manager), timetable, kiosk; cash payments with a £10,000 cap and lost-response safety.
- Imports: roster/membership and attendance with exact reconciliation, same-file refusal, interrupted re-run, honest failure, rollback of only untouched rows.
- **The TeamUp bridge:** every imported member is marked billed by TeamUp with the export date; card subscriptions, packs and card charges are refused for them; the weekly status refresh previews, changes only TeamUp-owned fields, never lifts a MatFlow hold, lists exceptions, and rolls back; staff see a stale-standing warning after 8 days that never refuses a check-in.
- Review mode: every card path refused while the club is under review.
- Audit: member actions are now recorded (they were silently dropped).

## What fails or is unverified
| Item | State | Owner |
|---|---|---|
| New members showed "Paid" with no payment; no £ totals | **FIXED `60d3979`, `d2adaee`** (Noe's decision): desk members start "No payment yet", listed under Outstanding; "Collected today / this month" on Payments; resuming a hold restores it. Not yet re-walked by an end-user round | — |
| Adults could check into kids classes; "Next class" showed kids classes to adults | **FIXED `60d3979`** (Noe's decision): a "Kids class" switch; adults refused at self and kiosk; the register asks; next class skips kids classes for adults. Not yet re-walked by an end-user round | — |
| Independent security/data review | BLOCKED — the safety classifier stopped it twice before any attack ran | **Noe — go** |
| Real people (Sean + a desk user) | BLOCKED | **Noe — authorisation to contact** |
| Production database role (BYPASSRLS?) and a point-in-time restore rehearsal | BLOCKED | **Noe** |
| TeamUp operating contract (field ownership, weekly refresh, 8-day warning) | PROPOSED | **Noe and Sean — sign-off** |
| Email delivery (invites, magic links) | BLOCKED until `RESEND_FROM` + DMARC; the magic link is spent on GET (mail scanners) — fix deferred to G3 | Noe (DNS), lead (code at G3) |
| Stripe card journeys, Standard Connect onboarding | BLOCKED until G1 and Sean's Stripe sign-in; not needed for the bridge (TeamUp bills) | G4 |
| Kiosk/QR scanning, two-factor on a phone, a second browser engine | NOT RUN in the end-user rounds (covered by the assess suite, not by an unaided journey) | lead, next round |

## Exact launch limits (if the decisions are made and G1 passes)
Cash at the desk only for new money; TeamUp bills every existing membership; standing refreshed weekly by a named operator; no member invitations until Sean signs off the imported data (G3) and mail is set up; attendance history may follow the roster in a later reconciled import.

## Candidate and deployed versions
Candidate `{{FINAL_SHA}}` — {{UNPUSHED}} commits and 8 migrations ahead of `origin/main`, all additive and wrapped in a transaction (atomicity test). Deployed: the old build. Gates on the candidate: {{GATES}}.

## Remaining authorisations, in order
1. Go for the security/data review.
2. The production role query and a restore rehearsal.
3. "Push" (G1) — deploy runbook `docs/runbooks/DEPLOY-2026-10.md`.
4. Sean's fresh exports, then the real import into the review-locked club.
5. Contact Sean and a desk user for the real-people sessions; sign-off of the TeamUp contract.
6. `RESEND_FROM` + DMARC, then invitations (G3).

**All currently unblocked work completed: {{CLOSING_DONE}}**

Code changes, deployment and operational observation are separate: everything above is code and local evidence; nothing is deployed and no real session has been observed.
