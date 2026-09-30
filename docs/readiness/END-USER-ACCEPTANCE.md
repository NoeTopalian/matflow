# End-user acceptance (readiness spec v3 §13.3)

## Track A — independent browser simulation

**Round 1 — 30 Sep 2026, candidate `10776a4`, production build under the restricted database role, test branch.** An end-user agent with no code access drove the real screens from `/apply` on a new club (Harbour Grappling, synthetic people only). The test database was read only afterwards, to check what was saved, and never used to set anything up. Full ledger (every step: persona, viewport, time, assistance, exact words, screenshot, saved state): `scratchpad/ralph/track-a-result.md`; harness `.omc/ralph-harness/track-a/`.

| Journey | Persona / viewport | Result | Why |
|---|---|---|---|
| 1 Set up a new club | Owner, 1440 | **ASSISTED** | The activation email cannot be delivered locally (G3), so the operator used "Force password reset". Everything after it was done unaided: wizard, staff, plans, timetable, waiver. |
| 2 Run the desk | Desk manager, 1440 | **FAIL** | No way to show a member as overdue at a pay-at-desk club; manager lacked hold, resume and children; a family duplicated silently; the payment list did not update after a desk payment. |
| 3 Member and parent | Member, 375 | **ASSISTED** | Invite, waiver, timetable, self and child check-in, emergency contact all worked; checking the parent-created child in needed the desk to give the child a plan. |
| 4 Take the register | Coach, 915 | **FAIL** | Typing in the register search marked the only match in without a tap (a no-waiver adult into a kids class); a no-waiver member was admitted with only a tag. |
| 5 End of day | Owner, 1440 | **FAIL** | Attendance matched the database (5 check-ins). Money and member counts did not: 9–10 members shown "Paid" against 2 payments; Outstanding said nobody owed; counts differed between screens. |
| 6 Mistakes | Mixed | **FAIL** | An adult could check into the kids class, overlapping their own class. Undo, the refusals for hold and no-waiver, and a lost connection during a save (one row) all behaved. |

Where the screen and the database disagreed: the waiver text shown before the club's text loaded vs the text recorded (fixed `c7e48fd`); members shown "Paid" with no payment; three screens stale until reload; labels contradicting settings.

### Dispositions
| Finding | Disposition |
|---|---|
| Register search marks a person by typing alone | **FIXED `5f9122d`** — Enter or a tap marks; waiting marks nobody (tests) |
| No-waiver member admitted at the register with only a tag | **FIXED `5f9122d`** — asks "admit anyway?"; the reason (and the on-hold one, which was never recorded before) lands on the audit row |
| Waiver signed while a placeholder showed | **FIXED `c7e48fd`** — cannot sign until the club's text is on screen; server refuses a mismatch |
| Payment list stale after a desk payment | **FIXED `5f9122d`** (test); child's waiver tile and profile emergency contact refresh too (no test) |
| Labels ("ALMOST FULL" on empty classes, "30 min" vs 180, "not seen" on day one, "Finish setup" on step 5, next class skipping today) | **FIXED `5f9122d`** (tests; the wizard wording test reads source only) |
| Member totals disagree across screens | **FIXED `5f9122d`** for the member-mix centre and the missing-waiver count (one definition: active and tasters); Reports "9 active · 11 total" vs Members "10 current" kept — each is labelled with its own definition |
| Manager missing hold / resume / children | Hold/resume: server and menu allow the manager in code — **not reproduced**, re-checked live in round 2. Add/link/unlink child: the server is owner-only — **DECISION — Noe** (recommendation: allow the manager, as the role description promises) |
| New members shown "Paid" with no payment; no "who owes" at a pay-at-desk club | **DECISION — Noe.** During the TeamUp bridge TeamUp owns standing (contract §2), so this does not block the bridge; it blocks MatFlow-billed clubs. Recommendation: a new member added at the desk starts as "No payment yet", not "Paid". |
| Adults can check into kids classes and into overlapping classes | **DECISION — Noe/Sean.** A class has no kids flag today (only a tier does). Recommendation: add "kids class" to the class, refuse an adult at self and kiosk check-in (staff may override); overlapping classes stay allowed (open mat after class is normal). |
| Family duplicated when desk and parent both add the child; desk-added child stored as adult | **OPEN** — needs a duplicate warning on add and a fix to the desk's child type; not in this round |

**Round 2 — 30 Sep 2026, candidate `1672209`**, a new end-user agent (a fresh participant, so no learning effect), a new club (Kestrel Grappling). Ledger: `scratchpad/ralph/track-a-round2-result.md`; harness `.omc/ralph-harness/track-a-r2/`.

| Journey | Round 1 | Round 2 | What still stops it |
|---|---|---|---|
| 1 Set up a new club | ASSISTED | **ASSISTED** | activation email cannot be delivered locally (G3) — everything after sign-in unaided |
| 2 Run the desk | FAIL | **FAIL** | no "overdue" at a pay-at-desk club (decision); the manager cannot add or link a child, and a desk-added child is stored as an adult |
| 3 Member and parent | ASSISTED | **ASSISTED** | a parent-added child has no plan, so the desk must add one; the refusal says "Buy a pack", which a pay-at-desk club does not offer |
| 4 Take the register | FAIL | **PASS (unaided)** | — |
| 5 End of day | FAIL | **FAIL** | "who paid / who owes" (decision); attendance, member counts and waiver counts now agree with the database |
| 6 Mistakes | FAIL | **FAIL** | adults into the kids class and into overlapping classes (decision); undo, refusals and both lost-connection saves passed |

Round-1 fixes confirmed on screen: the register marks only on Enter or a tap; a no-waiver member is asked about and the override is recorded; the payment list updates; the adult waiver never shows placeholder text; the labels and totals.

New in round 2: **the guardian waiver records different words from those signed** (the phone showed the generic kids text; the record holds the club-named one) — the same flaw as the adult waiver, on the child path; register words (a cancelled member reads "No one matches"; undo promises a pack credit to a monthly member; "Last seen Never" after a check-in today); the open register does not pick up a waiver signed meanwhile; the welcome sheet returns after "Skip for now"; staff keep the temporary password the owner chose; Edit Waiver opens empty; "Next class" shows a kids class to adults (needs a kids flag on classes — decision); `AuditLog_userId_fkey` errors in the server log (audit rows lost).

## Track B — real people (Sean and a desk user)

**OPEN–BLOCKED — Noe.** Authorisation to contact Sean and a desk user has not been given. Task cards: `docs/readiness/USABILITY-KIT.md`. No agent role-play is reported as a human session.
