# TeamUp plan reconciliation (design, 24 Oct 2026)

> **Superseded (25 Oct 2026).** Written before Noe's decisions of 24 Oct, 15:09–15:12 UK: imported data becomes
> MatFlow's own; a later upload never overwrites an existing member and never blocks; differences are listed
> ("TeamUp now says X; MatFlow has Y") with a per-member, audited Apply. Where §3 and §7 below let TeamUp's
> values win (rules 1, 4 and 6), they are withdrawn. The rule to implement is in the release task record §5.

Status: **proposal only — nothing here is implemented.** It replaces today's
"the refresh overwrites the plan" with one rule that reconciles four facts.
No production data; examples are synthetic.

## 1. What the code does today

- The first TeamUp import maps the plan label to a tier by name, case-folded
  (`app/api/admin/import/[id]/commit/route.ts:197-243`, `columnsFor`, through
  `lib/membership-tier.ts:64-74` `membershipTierWrite`). No match: the label is
  kept in `membershipType` and `membershipTierId` stays null. A person with two
  live plans, a plan starting later, or no single current plan gets no plan
  (`lib/importers/teamup.ts:421-461`: `membershipType = undefined` with a
  `decision`).
- A **status refresh** writes five owned columns for every matched TeamUp-billed
  member: `status`, `paymentStatus`, `cancelledAt`, `membershipType`,
  `membershipTierId` (`lib/importers/teamup-refresh.ts:23`), computed by
  `standingFromDraft` (`:146-171`) and written at
  `app/api/admin/import/[id]/commit/route.ts:805`. The plan columns are
  overwritten whatever they hold: a label that maps nowhere writes
  `membershipTierId: null`.
- Staff set the plan on the profile (`app/api/members/[id]/route.ts:411`, the
  same `membershipTierWrite`), recorded as a from→to diff on `member.update`
  (`:515-530`). Nothing marks that value as a staff choice, so the next refresh
  replaces it silently.
- Two protections already exist and stay: a refresh never moves standing
  backwards in time (`olderThanRecorded`), and a hold placed in MatFlow is kept
  when TeamUp says paid (`holdKept`) — but a TeamUp cancellation still applies.

Consequences today: a staff correction is undone by the next refresh; a
renamed TeamUp plan clears the tier (and with it every class gated on that
membership, and the allowance); an unmapped label silently removes access a
member legitimately had.

## 2. The four facts

For each TeamUp-billed member, per refresh:

| Fact | Meaning | Where it would live |
|---|---|---|
| **O** — last observed | the plan label (and the tier it mapped to) the last refresh or import read for this person | new: `Member.teamupPlanObserved` (label) + `teamupPlanObservedTierId`, `teamupPlanObservedAt` |
| **M** — current MatFlow | `membershipTierId` / `membershipType` now | existing |
| **I** — incoming | the plan label in this file, and its tier mapping (or none) | the draft |
| **S** — staff override | an explicit staff choice that MatFlow must keep against TeamUp | new: `Member.planSetBy = "staff"` + `planSetAt`, set by the profile's plan picker for a TeamUp-billed member |

Existing members start with O null and S unset (no history recorded yet).

## 3. The rule (recommended)

Evaluate in this order; the first that applies decides.

1. **Genuine ending wins over everything.** I says no live membership
   (cancelled / completed) → write the ending (status, paymentStatus,
   cancelledAt) as today. The plan columns are left as they are (history), but
   access ends because the member is cancelled; an override (S) does **not**
   preserve access after an ending. The override is cleared and listed.
2. **Unchanged at TeamUp** (I label = O label): TeamUp has said nothing new →
   **do not touch M**. This is what makes staff changes between refreshes stick
   without an override: a refresh only acts on what changed at TeamUp.
3. **Staff override set** (S) and I differs from O: keep M, write O := I, and
   raise a **conflict** ("TeamUp changed this member's plan from O to I; staff
   set M on <date>"). No access is removed.
4. **I maps to a tier** and I differs from O: write M := tier(I), O := I.
   This is the normal case: TeamUp moved the member.
5. **I maps to nothing** (unmapped, renamed, two plans, scheduled start):
   **keep M**, write O := I, raise an exception "plan label not mapped" with the
   label. Never clear a tier on an unmapped label.
6. **First observation** (O null — every existing member on the first refresh
   after this ships): treat as "changed" only if I maps to a tier different from
   M **and** M is not a staff change since the last import (from the audit log
   `member.update` diffs on `membershipTierId` after the import job's
   completion). Otherwise record O := I and leave M. In practice: members whose
   plan staff never touched follow TeamUp; members staff corrected keep their
   correction and appear in the conflict list once.

Multiple memberships, scheduled starts and cancellations follow the import's
existing reading of the file (one current plan, or a decision): a decision is
rule 5 (unmapped) until staff decide; a scheduled start is not current and
does not change M until it starts (rule 2 on the next refresh, rule 4 when it
is current).

## 4. The case "TeamUp reported A; staff assigned B; TeamUp now reports C"

| Step | O | M | S | Result |
|---|---|---|---|---|
| Import: TeamUp says A | A | A | – | |
| Staff assign B on the profile | A | B | staff (if set through the override) | |
| Refresh, TeamUp still A | A | B | either | rule 2: M stays B |
| Refresh, TeamUp now C (maps) | → C | **B** if S set (rule 3, conflict listed) / **C** if not (rule 4) | | |
| Refresh, TeamUp now C (unmapped) | → C | B | | rule 5, exception listed |
| Refresh, TeamUp says cancelled | → cancelled | B (label kept) | cleared | rule 1: member cancelled, access ends |

## 5. The conflict workflow (visible and actionable)

The refresh preview and the post-run report gain a **"Plan conflicts"** list
(beside today's `notInMatFlow`, `holdKept`, `decisions`): member, O, I, M, who
set M and when, and two actions per row — **Keep MatFlow's plan** (sets S, so
later refreshes keep it until TeamUp's plan changes again) and **Use TeamUp's
plan** (writes M := tier(I), clears S). Both are audited member updates and
undoable. Unmapped labels appear once per label with "Map this label to a
tier", which fixes every member carrying it.

## 6. Consequences

- A staff correction survives every refresh in which TeamUp's plan did not
  change — the common case — with no extra click.
- A TeamUp plan change after a staff correction never silently undoes it if an
  override is set, and never silently loses TeamUp's change either: it is listed.
- No refresh clears a tier because of an unmapped or renamed label.
- A genuine ending ends access even when MatFlow's plan was chosen by staff.
- Rollback of a refresh restores O as well as the owned columns
  (`planRefreshRollback` already refuses members changed since).
- Cost: three nullable columns (O, its tier, its date) and two for S; one
  migration; the refresh planner and preview change; the profile's plan picker
  sets S for TeamUp-billed members.

## 7. The one genuinely open question (for Noe)

**When TeamUp's plan changes and staff had set a different plan, who wins by
default — the staff choice or TeamUp?** Everything else above follows from the
instructions already given (never move standing backwards; MatFlow owns access
holds; a cancellation ends access; no silent removal of access). Recommendation:
**TeamUp wins by default (rule 4) unless staff explicitly chose "Keep MatFlow's
plan" (S)**, because TeamUp is where the club bills and Sean's staff will
change plans there first; the consequence is that an un-marked staff
correction is replaced when TeamUp's plan next changes, and the change is
shown in the refresh report rather than silent.
