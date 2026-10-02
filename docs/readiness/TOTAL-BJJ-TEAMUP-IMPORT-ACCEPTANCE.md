# Total BJJ — TeamUp import, independent acceptance (Phase F, 2 Oct 2026)

The brief's twelve scenarios, walked by an **independent reviewer who did not build the importer** (a separate agent given only the brief's scenario table, the running production build and read-only database access), against the real Total BJJ data imported in the rehearsal (`…-REHEARSAL.md`). Evidence was the words on screen plus the saved rows; the reviewer's own result file (restricted, PII-free, under the session scratchpad) is the source of every line here. Fixer and reviewer were different agents throughout; the re-verification after the fixes was targeted and is labelled as such.

## 1. Verdict as delivered by the reviewer (before any fix)

> "Would I let this import run against production as it stands? **No.** The data landed correctly (1,082 rows accounted for, no duplicates after the resume, no debt, no provider calls), but the portal shows children to unconfirmed guardians the importer guessed, and the owner's headline numbers count 219 placeholder guardians as active new members."

Scenarios: **PASS 7** (S1, S3, S4, S5, S8, S9, S11) · **FAIL 4** (S2, S6, S10, S12) · **NOT TESTABLE 1** (S7 — the source has no active member without an email; the closest real case behaved as expected). Within S8, concurrent submit and lost response were not exercised (they need a commit on the live job, which the reviewer was forbidden).

## 2. Scenario table

| # | Scenario | Reviewer verdict | What was seen (aggregates) | Disposition after the walk |
|---|---|---|---|---|
| 1 | Historical + current plan | PASS (member) / P1 on Reports | History card: 1 current + 5 past rows worded "Imported, not purchased here"; Outstanding "Nobody owes you right now"; Reports overdue 0. **P1:** Reports "531 Active members" and "226 New this month +1514 %" — 219 guardian drafts counted as members | **Fixed**: `TRAINING_MEMBER` (parent accounts excluded) on every population count in Reports and the dashboard home; `ADULT_ACCOUNT_TYPES` no longer includes `parent`. Re-verified: Reports active = 312 = DB training members |
| 2 | Concurrent memberships | FAIL | Profile: "Two plans active at TeamUp — A and B. MatFlow has not chosen one"; register: only "WALK-IN", no "staff decide" signal; kiosk not reachable without a write | **Fixed**: register row pill "PLAN UNDECIDED · STAFF DECIDE" for a TeamUp-billed member with no plan (unit-pinned; register payload re-verified). Kiosk copy for the same case shipped earlier (`TEAMUP_NO_PLAN_REFUSAL`, unit-pinned) |
| 3 | Future transition | PASS | Current plan shown; "Starts later at TeamUp: … from 5 Oct 2026. A status refresh after that date moves them onto it." P3: nothing reminds the owner to run that refresh | Open P3 — operator runbook step (weekly refresh) |
| 4 | Active + held | PASS | Hold stays on the held row; member active on the current plan; 0 Stripe events, 0 payments, 0 member emails | — |
| 5 | Two adults, one email | PASS | Two records; the second adult has no address or password (cannot sign in as the first); P3 not verified: whether Edit → add the first adult's address would be accepted | Open P3 — unique `(tenantId, email)` refuses it at the database; worth a pinned test |
| 6 | Children on a payer email | **FAIL — P0** | APIs refuse before confirmation and show one child after confirming one link; **but the server-rendered page `/member/family/<childId>` showed the unconfirmed children's name, age, waiver, counters and next class** | **Fixed**: the page's loader now requires `CONFIRMED_GUARDIAN`; a scan test fails on any parent→child `where` without the gate across the member portal and member APIs (red without the fix, naming that page). Re-verified: the unconfirmed child's page renders the "We couldn't find that page … it isn't part of your account" view with no child data; the confirmed child's page renders |
| 7 | Missing-email active member | NOT TESTABLE | 0 such people in this export (the 4 missing-email rows are under-13s, quarantined); proxy: an active non-contactable second adult shows an honest sign-in limitation, no fabricated contact | — |
| 8 | Duplicate / re-upload / concurrent / lost response | PASS (partial) | Same file refused 409 naming the prior run; job detail consistent after reload. P3: five same-named entries in history make the message ambiguous | Concurrent/lost-response proven in the rehearsal (kill-mid-commit, same-file-twice, live-claim 409) — not by this reviewer |
| 9 | Partial failure + resume | PASS (data) / P2 (count) | DB exact after the resume; **P2:** the job card said "447 members imported" for a run that created 922 (resume recorded only in the manifest) | **Fixed**: `importedRows` = the whole run's creations after a resume (unit-pinned). The live rehearsal job keeps its historical 447; new runs are right |
| 10 | Refresh after local edits / confirmed guardianship | FAIL — P2 | Activity log recorded both actions correctly; the Status-refresh copy did not say whether staff-edited internal notes or guardian links are touched; no field-ownership record | **Fixed (copy)**: the refresh copy and the confirm dialog now state that internal notes, guardian links (suggested or confirmed), contact, medical, waivers and holds are never touched and that an older export is refused; the behaviour was already unit-pinned (`REFRESH_OWNED_FIELDS`). P3 "Details history" omits notes edits by design (notes are never logged) — open as copy |
| 11 | Rollback before/after edits | PASS | Copy states touched rows are kept with reasons; not executed. P2: the irreversible dialog gave no count | **Fixed**: the dialog names the number of people the run created and the export date, and lists "confirmed a guardian" among the reasons a row is kept |
| 12 | Other tenant / family / role | FAIL (family only) | Every cross-tenant and cross-role API refused without leaking (second club's owner: 404s; parent session: no child data from APIs); failed only because of S6 | **Fixed with S6** |

Activity/history: one event per action; "Can't undo" with a sentence on the notes edit; import rows lacked provenance (P2) → **fixed**: import, refresh and rollback events carry file name, export time, mapping and counts, and the Activity row shows them.

## 3. Findings not fixed in this loop (open, with owner)

| Sev | Finding | Disposition |
|---|---|---|
| P3 | Profile header still offers "Mark paid manually / Start membership / Ad-hoc charge" on a TeamUp-billed member (server refuses card actions; review mode blocks sign-ups) | UI affordance; next UX pass |
| P3 | Importer-authored text in Internal Notes ("Estimated next charge … UNVERIFIED", "DECISION NEEDED …", "Scheduled at TeamUp …") is staff-visible prose authored by a machine | By design (the only free-text channel); labelled; candidate for a structured "standing" field later |
| P3 | Timetable list did not refresh after "Create class" until reload | Pre-existing UI defect, outside this brief |
| P3 | `/member/family` (no id) is a framework 404 | Pre-existing; add a redirect to the family card |
| P3 | Confirming a guardian is one click with no confirm step | Design choice (undoable from Activity); revisit if owners ask |
| P3 | Nothing reminds the owner to run the weekly status refresh | Runbook + operator checklist |
| P3 | Same-file refusal names file + date only | Add the import history entry id to the sentence |

## 4. Re-verification after the fixes (targeted, by the fixer — not a second independent pass)

On the rebuilt isolated production build against the same real data: unconfirmed child page → not-found view, no child data; confirmed child page renders; Reports active members 312 (= DB training members; 219 drafts excluded); register payload carries the undecided-plan signal for the decision member; import events now carry provenance. Unit pins: `member-population-counts`, `guardianship-gate-scan`, `billed-by-teamup-screens` (register pill), `import-commit-integrity` (resume count), all red on revert.

## 5. Verdicts

- **IMPORTER VERIFIED** — stands (rehearsal) and now includes the acceptance fixes.
- **DATA RECONCILED / DECISIONS REQUIRED** — stands; the decision list is in the rehearsal document and the exceptions CSV.
- **Independent acceptance:** the reviewer's answer on the tree they saw was **No**, for the P0 and P1 above. Both are fixed and re-verified by targeted checks; **a second independent walk of S1, S2, S6, S9, S10, S12 on the fixed tree is owed before READY FOR PRODUCTION IMPORT can be claimed**, together with the items blocked on Noe and Sean (release package §7a).
