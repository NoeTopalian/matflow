# Total BJJ — TeamUp import contract (mapping `teamup-2@2026-10-02`)

Phase A deliverable of the brief "MatFlow — real TeamUp import, family accounts and billing integrity" (2 Oct 2026). This document is the field-by-field agreement between the TeamUp *Memberships* report export and MatFlow. It extends `TEAMUP-OPERATIONS-CONTRACT.md` §2 (field ownership during the bridge) and is what the rehearsal (`…-REHEARSAL.md`) and the acceptance (`…-ACCEPTANCE.md`) are checked against. It contains no personal data: every figure is an aggregate computed independently of the product by `scripts/readiness/teamup-controls.mjs` (pure CSV, RFC-4180, no product code).

## 1. Source files in hand

| | Newer export (the candidate) | Older export (the refresh/delta pair) |
|---|---|---|
| File | `report-download-hdJocCUxn3aEXNGBdg22Dc.csv` | `report-download-HwnBEVtzVYW6gZEQgRS7W3.csv` |
| SHA-256 | `90693f95228db57f39b9fd596e694fa62b57107fd63b6aa546a9275bf0aaed22` | `389ac61f…` (recorded in the restricted ledger) |
| Records (header excluded) | 1,082 | 1,065 |
| Encoding / shape | UTF-8 with BOM, 26 columns, one row per membership ever held | same |
| Export time | **absent from the file.** Provisional as-of = file mtime, 2 Oct 2026 12:27 UK — flagged provisional on every date-sensitive decision until Sean confirms the export time | 24 Sep 2026 (provisional) |

The export carries **no** customer id, next-payment date, price, cycle, attendance, waiver or timetable data. Nothing in those categories is imported or inferred.

## 2. Column contract (all 26 columns)

Destination "—" means the value is read for a rule but not stored. "Ledger" = `ImportedMembership` (one row per CSV record, kept whole). "Member" = the person row. Ownership: **T** = TeamUp-owned (a status refresh may overwrite), **M** = MatFlow-owned after import (a refresh never touches it), **L** = ledger only.

| # | Column | Meaning | Destination | Transformation | Missing / conflict rule | Own |
|---|---|---|---|---|---|---|
| 1 | Customer Name | Person's name | Member.name; part of the identity key | trimmed; key = lower(email)\|lower(name) → `externalRef = teamup:<key>` | blank with "(Deleted Customer)" → row **excluded**, counted; otherwise required | M (name), key immutable |
| 2 | Customer Email | Account email at TeamUp — for a child, the **payer's** email | Member.email for the adult who keeps it; identity key | lower-cased; an adult keeps it as login; a child **never** keeps it; a second adult on a taken address gets a synthesised login and the address in `unverifiedEmail` | blank → synthesised non-contactable login + note; a kid under 13 with no email and no adult → row **quarantined** (`quarantined:kid_without_parent`) | M |
| 3 | Other Active | TeamUp's own note that another membership is live | Ledger.otherActive | kept verbatim | **evidence only** — never used to pick a plan, create a membership or link people | L |
| 4 | Membership Name | Plan label | Ledger.planLabel; Member.membershipType for the **current** row; tier by exact (case-insensitive) label match | none | label with no tier → tier null, label kept, exception `plan_without_tier`; never a free or guessed tier | T |
| 5 | Type | recurring / prepaid | Ledger.type | lower-cased | used only to tell a completed prepaid course (→ `inactive`) from a cancellation | L |
| 6 | Status | active / hold / upgraded / downgraded / cancelled / completed | Ledger.status; drives entitlement (§3) | see §3 | unknown status → history | T |
| 7 | Payment Processor | "Stripe" or blank | Ledger.processor | none | blank on a current row → note "No payment processor recorded at TeamUp". **Creates nothing in Stripe.** | L |
| 8 | Purchase Date | date-only | Ledger.purchaseDate | `YYYY-MM-DD` kept as a date, never a timestamp | blank allowed | L |
| 9 | Start Date | date-only | Ledger.startDate; Member.joinedAt = earliest start of the person | date-only | blank → treated as started (cannot be scheduled) | L / M(joinedAt) |
| 10 | Expiration Date | date-only | Ledger.expiryDate | date-only | blank = open-ended | L |
| 11 | Cancelled Date | date-only | Ledger.cancelledDate; Member.cancelledAt **only** from here | date-only | blank on a cancelled person → `cancelledAt` null, exception `cancelled_without_date`. No end date is manufactured from expiry or completion. | T |
| 12 | Is First Membership | Yes/No | Ledger.isFirst | boolean | — | L |
| 13 | Completed At | timestamp with offset | Ledger.completedAt | kept as an instant (ISO) | used as the end of a completed prepaid course in notes; never as `cancelledAt` | L |
| 14–19 | Address Line 1/2, City, Region, Postcode, Country | postal address | **not imported** (data minimisation) | — | preserved only in the restricted, uncommitted row ledger for reconciliation | — |
| 20 | Marketing Preference | consent text | note only | a refusal ("No, do not send…") → note "Marketing: declined — do not send marketing" | blank = unknown, **not** consent | M |
| 21 | Phone | phone | Member.phone | trimmed | blank allowed; formula-prefixed values are data, escaped on export | M |
| 22 | Gender | — | **not imported** | — | — | — |
| 23 | Date of birth | date-only | Member.dateOfBirth; age band | age on the as-of date: <13 `kids`, 13–17 `junior`, else adult; a plan containing "Kids" with no DOB → `kids` | implausible values are imported as given and show in the ledger; nothing is corrected silently | M |
| 24 | Emergency Contact Name | | Member.emergencyContactName | current row's value wins; a conflict within one person is noted (`emergencyContactConflicts`) | — | M |
| 25 | Emergency Contact Phone | | Member.emergencyContactPhone | as above | — | M |
| 26 | Emergency Contact Relationship | | Member.emergencyContactRelation | as above | **never a guardian by itself** (§4) | M |

Derived, never read from the file: `billedBy = teamup`, `billingStatusAsOf = export time`, `billingStatusSource = import job id`, `mappingVersion = teamup-2@2026-10-02`, per-row `sourceFingerprint` (FNV-1a, two seeds) and `sourceRow` ordinal (header = 1).

## 3. Status semantics and entitlement at an as-of date

Entitlement is read **per membership row at an explicit as-of date in the club's timezone** (`lib/importers/as-of.ts`), never "today on the server":

| Row status | Started (start ≤ as-of) and live (no expiry or expiry ≥ as-of) | Not started | Expired |
|---|---|---|---|
| active | **current** | **scheduled** | history |
| hold | **held** (current only when it is the person's only live row) | history | history |
| upgraded / downgraded / completed / cancelled | history | history | history |

Person-level rules (decision 2 of the plan):

- One started active → current; any held row beside it is `held` history and counted (`heldAlongsideActive`).
- No started active, one or more held → the latest held is current with `paymentStatus: paused`.
- **Two or more started actives → DECISION REQUIRED.** The person is imported with no plan, both labels named in the standing note, listed in the exceptions as `decision_required`. Nothing picks a winner.
- An active row starting after the as-of date → `scheduled`; the started one stays current; a later status refresh after the start date moves them.
- History only → `status: cancelled` (`inactive` for a completed prepaid course), `paymentStatus: cancelled`, plan label kept for the record.

Money: a current TeamUp membership is written `paymentStatus: paid` meaning only "no MatFlow debt". The estimated next charge (28-day or calendar-month step from the start date) is written to the notes as UNVERIFIED and never to `nextDueAt`; the overdue derivation and the "no payment yet" rule both exclude `billedBy: teamup`; the chase route refuses them; the migration engine skips them unless a run is an explicit cutover (`includeTeamUpBilled`).

## 4. Identity, families and authority

- **Identity** = (email, name) only. Same surname, phone or address merge nobody. The key is persisted (`externalRef`) and a status refresh matches on it; a changed name or email is an exception (`notInMatFlow`), never a guess.
- **Shared email never grants access, identifies a payer or creates all-to-all relationships.** An adult on a kid's email is a *suggested* guardian (`guardianSuggestedBy: shared_email`); among several adults the one whose name matches the emergency contact is suggested, else the first with a note.
- **Emergency contacts are not guardians.** A kid with no adult on their email gets a **non-authenticated guardian draft**: `accountType: parent`, synthesised login (`@no-login.matflow.local`, excluded from invite / magic link / reset / chase), the payer address kept as `unverifiedEmail`, link `guardianSuggestedBy: emergency_contact`.
- **Every import-made link is written with `guardianConfirmedAt = NULL`.** Every parent→child route (portal children list, child profile, photos, waiver, check-in on behalf, billing portal, start/cancel subscription for a child, waiver signature image) requires a confirmed link (`lib/guardianship.ts`). The owner confirms or rejects on the Family card (`POST /api/members/[id]/guardian`), audited `member.guardian.confirmed|rejected` and undoable from Activity; confirming may adopt `unverifiedEmail` as the login only when no other member holds it. An under-13's only link cannot be rejected, only replaced by *Link existing*.
- Links made by staff or by a parent themselves are born confirmed; the migration backfilled `guardianConfirmedAt` on every pre-existing link, so nothing regressed.

## 5. Row ledger and reconciliation

Every CSV record ends as exactly one `ImportedMembership` disposition: `member_history` · `duplicate_of:<row>` · `quarantined:<reason>` · `excluded:deleted_customer`. Dispositions sum to the record count by construction; the commit's `reconciles` flag additionally requires persisted ledger rows = parsed ledger rows. The ledger is RLS-protected, cascades from its job and its member, and is purged with the tenant.

Independent controls on the 2 Oct file (aggregates only; the product's preview must reproduce them exactly in the rehearsal):

| Control | Value |
|---|---|
| Records | 1,082 |
| Distinct (email, name) candidates / distinct emails | 708 / 609 |
| Status: active / cancelled / hold / upgraded / downgraded / completed | 302 / 505 / 22 / 163 / 60 / 30 |
| Type: recurring / prepaid | 927 / 155 |
| Plan labels | 20 |
| Exact duplicate rows | 3 |
| Deleted-customer rows (excluded) | 8 |
| Missing-email rows (non-deleted + deleted) | 7 + 8 = 15 |
| People after folding: adults / juniors / kids | 707: 396 / 88 / 223 |
| Two started actives (decision required) | 2 |
| Active with a held row alongside / held only | 3 / 16 |
| Active starting after the as-of date (scheduled) | 2 |
| Cancelled persons with no cancellation date | 5 |
| Emergency-contact conflicts within one person | 1 |
| Kids: one adult on the email / several / no adult (guardian draft) / no email | 39 / 3 / 265 / 4 |
| Second adults on an already-claimed email | 6 |
| Active people with no email | 2 |

## 6. Representational gaps (stated, not papered over)

- TeamUp's export has no next-payment date, price, cycle or Stripe customer id: money stays unknown and external until the cutover contract.
- Concurrent memberships cannot be represented as two live MatFlow memberships; they are a decision for the owner, with every row kept in the ledger.
- A hold on one of two plans is recorded as `held` history rather than a per-membership pause.
- Guardianship authority is not in the export; it stays suggested until confirmed per family, or until a TeamUp Customers/guardian export arrives.
- Attendance, waivers and the timetable are absent from this file and are not imported (synthetic class fixtures only, labelled, in any rehearsal).

## 7. Refresh and rollback ownership

A status refresh (mode `refresh`) with a newer export updates only `status`, `paymentStatus`, `cancelledAt`, `membershipType`, `membershipTierId`, `billingStatusAsOf`, `billingStatusSource`; it never creates a person, never lifts a MatFlow hold, never touches contact, medical, waiver or guardian fields, and **refuses a file exported before the standing already recorded** (`olderThanRecorded`: shown at preview, 409 at commit, job marked failed, nothing written). Rollback removes only rows the import created that carry no later edit, and keeps confirmed guardian links as "edited after import".

## 8. Outward actions

An import, refresh or rollback sends no welcome, invite, reset, marketing or reminder email, no push, no checkout, charge, subscription or Stripe write of any kind. The only mail an import produces is the owner's own `import_complete` notice. `tests/unit/teamup-billed-provider-inert.test.ts` and `billed-elsewhere-guard.test.ts` fail on any provider call for a TeamUp-billed member on hold / resume / chase / migrate / subscribe / parent-subscribe / desk-subscribe / charge / checkout / packs; the webhook matches members by Stripe customer id only.

## 9. Entry point, export-time provenance, tiers and unknown money (3 Oct 2026)

**Right parser, by the file's own header.** `lib/importers/sniff.ts` names a file from its header row (BOM, CRLF, quoted cells, any case). The upload route refuses a TeamUp memberships export sent under any Source other than TeamUp, and an attendance export on the Members path, with the path to use and no job created; the attendance route names a memberships export. The Import panel reads the chosen file's first 4 KB, switches Source to TeamUp and says so ("Detected a TeamUp memberships export — Source set to TeamUp"), and disables submit for a file meant for the other import. (Before: a TeamUp file under the default "Generic CSV" gave one error, "Couldn't find name or email columns", totalRows 1; under attendance it gave "Missing required column(s): class".)

**Export time: club time, with provenance.** The panel sends the typed wall-clock time and the server reads it in the club's timezone (an owner abroad no longer shifts the as-of date; from UTC+8 a London 00:15 on 5 Oct used to become 4 Oct). `ImportJob.sourceExportedAtProvenance` is `owner_stated` (default when a time is given), `provisional` (the owner ticked "This is an estimate"), or NULL (no time). Preview `asOfIsProvisional` is true for a provisional time; manifests and the success panel say "export time provisional". A provisional time never blocks the refresh that carries the real one (it would otherwise be refused as "older than recorded" whenever the guess was late). To correct an estimate: upload the same file as a Status refresh with the real time. A refresh re-reads entitlement at the real as-of and rewrites the refresh-owned fields; it does not rewrite the ledger's per-row `entitlement`, and the 5 and 19 Oct scheduled starts only move on a refresh from an export taken on or after those dates.

**Plan labels → tiers** (`scripts/readiness/teamup-tier-plan.mjs <file> --as-of <date>`; independent cross-check: `teamup-controls.mjs` `planLabels`). 20 labels: 16 LIVE_TIER (an active or hold row), 4 HISTORY_ONLY. Create one tier per LIVE_TIER label with the label byte-for-byte as its name (matched trimmed and case-insensitive). "8 Week Beginners Course" is LIVE_TIER by status but its 3 holds all expired before 2 Oct, so nobody is on it at that as-of date; creating it is harmless. HISTORY_ONLY labels need no tier: every row is kept whole as `ImportedMembership.planLabel`, and a member's tier follows only their current / scheduled / held membership. The preview now lists, before commit, the labels a current, scheduled or held membership carries with no tier ("Create the missing tiers first"); Import stays enabled — the owner may proceed knowingly, and a later refresh links the tier.

**Unknown money.** Tier fields for every TeamUp label: price 0, billing cycle `none`, not a kids plan, no Stripe price, description "Price not yet confirmed — billed by TeamUp (every 4 weeks | monthly | one-off course)". For a `billedBy: "teamup"` member this produces no due date (cycle none seeds nothing; the import never seeds one), no overdue and no "No payment yet" (both rules exclude TeamUp-billed members), no revenue (revenue is summed from payments), no member-facing price (kids self-billing lists only kids tiers; self-start needs a Stripe price; a Stripe price of 0 is refused), and never "Free" (the import and refresh never write it). The owner's Memberships page shows such a tier as "Price not set · Billed by TeamUp". Still reading £0 (owned elsewhere): staff tier pickers (`formatTierPrice`) and the Settings → Revenue "Membership Tiers" card. A member added at the desk on a price-0 tier starts "Free" and MatFlow-billed — leave the tier empty for a TeamUp-billed child added by hand.

**Counts, kept separate** (real file, as of 2 Oct 2026): 1,082 source rows = 1,064 membership-history + 3 duplicate + 7 quarantined + 8 excluded (deleted customer). 707 people in the file = 396 adults + 307 children/juniors imported + 4 children held back. Drafts ("Will import" on an empty club) 922 = 703 people + 219 guardian records synthesised from emergency contacts — not a people count. Guardian suggestions 307 (42 shared email, 265 emergency contact), all unconfirmed. Missing email: 15 rows / 5 name|email groups raw; 7 rows / 4 groups excluding deleted-customer rows — exactly the 4 held-back children, none with an emergency contact. They are refused because `Member_kids_must_have_parent` (migration `20260515000001`) requires a parent; each is in the exceptions download by its first source row and in the ledger with no member. To add them: the parent at the desk if needed, then "Add child" on the parent's Family card (confirmed by staff, billed by MatFlow, no TeamUp key — each later refresh lists them as "not in MatFlow").
