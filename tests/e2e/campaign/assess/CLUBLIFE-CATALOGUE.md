# Club-life catalogue — scenarios a real club throws at MatFlow, with what the product does today

Started 2026-09-25 (execution prompt §7 "operational days"; the earlier "club life simulation" plan). One row per scenario: the door it is driven through, the expected state, and the status. Statuses: `PASS` (proven by the named cell on the test branch), `PRODUCT` (defect, fixed or filed), `UX`, `HARNESS`, `ENV`, `GAP` (the product has no such feature; the workaround an owner uses today and a size). A row without a cell is not evidence.

Lanes L1–L12 are listed in the plan file; cells land lane by lane. Money-side scenarios that need Stripe (L2/L3) are covered by `scripts/stripe-migration-e2e.mjs` and `scripts/stripe-lifecycle-e2e.mjs` (both PASS 24 Sep) and are referenced, not repeated.

## L5 · Pausing, leaving, returning — `lh-1-clublife-pause-leave-return.spec.ts`

| ID | Scenario | Door | Expected | Status |
|---|---|---|---|---|
| C5.01 | Hold with a date → the member tries to check themselves in | owner `POST members/[id]/hold {until}`; member `POST /api/checkin` (self) | 403 `on_hold`, message names the date; no attendance row | cell |
| C5.02 | Resume → self check-in on a Stripe-covered membership | owner `POST …/resume`; member self check-in | 201, attendance row | cell |
| C5.03 | Resume → self check-in on a **cash** membership (a tier assigned, paid, not overdue) | same | 201, attendance row. **Was** 402 "No active membership or class pack credits. Buy a pack or contact your gym." (measured 25 Sep 01:18): coverage read only a Stripe subscription or a pack. Fixed 25 Sep 09:30: a desk membership (tier assigned, paid or comped, not overdue by `lib/overdue.ts`) is coverage; the schema-default "paid" with no tier still is not | PRODUCT (medium) → **fixed**, cell + unit `checkin-desk-coverage` 8 cases |
| C5.12 | Resume with nothing assigned (no tier, no Stripe, no pack) | same | 402 — a blank row is not a membership | cell |
| C5.13 | Desk member overdue by the derived rule (due date passed) | same | 402, no row | cell |
| C5.04 | Cancel at the desk (staff PATCH status → cancelled) | owner `PATCH members/[id] {status: cancelled}` | `status cancelled`, `cancelledAt` set, one `MemberStatusEvent active→cancelled reason staff_edit` | cell |
| C5.05 | Cancelled member tries to check in | member self check-in | refused (not admitted); no attendance row | cell |
| C5.06 | The member comes back (staff PATCH status → active) | owner PATCH | `cancelledAt` cleared, a second status event `cancelled→active`, history intact (two events, not one), same member id | cell |
| C5.07 | Mark inactive | owner PATCH `{status: inactive}` | status inactive, `cancelledAt` untouched, paymentStatus untouched | cell |
| C5.08 | Cancel via Stripe (subscription.deleted) → member cancelled with a status event; redelivery writes nothing | `scripts/stripe-lifecycle-e2e.mjs` | PASS 24 Sep 22:20 UTC | PASS (script) |
| C5.09 | Hold pauses Stripe collection (void) and resumes on the date | `lib/member-hold.ts` unit + hold route unit; webhook `pause_collection` unit | PASS (unit, 24 Sep); not yet exercised on a live subscription with a test clock | PASS (unit) — script leg TODO |
| C5.10 | Erase after leaving (Art. 17): what survives | `members/[id]/dsar` | out of scope for this lane; see `iter-1-member-lifecycle` audit | not covered |
| C5.11 | Desk cancel of a member whose Stripe subscription Stripe does not know | owner PATCH status → cancelled | refused with "Stripe subscription cancellation failed … Cancel manually in Stripe, then retry"; member unchanged locally. Correct behaviour; the status code is 500 where 409/502 would read better | cell (PASS on behaviour; **UX (low)**: status code) |

## Findings log
- **F-L5-1 (PRODUCT, medium):** portal self check-in refuses a paid cash member (`no_coverage`) because coverage = Stripe subscription or pack. Kiosk admits. For Total BJJ after migration every member is Stripe-linked, so it does not bite on day one; for a cash club it does. See C5.03.

## L6 · Families — `lh-2-clublife-families.spec.ts`

| ID | Scenario | Door | Expected | Status |
|---|---|---|---|---|
| C6.01 | Owner adds two children to a parent | `POST /api/members {accountType: kids, parentMemberId}` | kids rows linked to the parent, no password, synthesised address | cell |
| C6.02 | Manager tries to add a child; a child as a parent | same | 403 (owner-only kids policy); 400 (no nesting) | cell |
| C6.03 | Parent checks a child in from the portal; another parent tries the same child | member `POST /api/checkin {onBehalfOfMemberId}` | 201 + attendance for the child; 404 for the stranger | cell |
| C6.04 | Move a child between parents | `link-child` to the new guardian (a bare `unlink-child` is refused: "A child account can't be left without a guardian" — measured 25 Sep, correct) | the row survives, only the link moves. **Was impossible** (F-L6-1, measured 25 Sep 09:55): link refused any child already linked, unlink refused to leave them without a guardian — the two guards deadlocked. Fixed: link moves a linked child, recording the previous guardian in the audit row; a child with a login is still not linkable | PRODUCT (medium) → **fixed**, cell |
| C6.05 | Child turns adult | `promote-to-adult` | own account, no parent, old parent's kids count drops; cannot promote twice | cell |
| C6.06 | Delete a parent who has a child | `DELETE members/[id]?probe=1` | the probe names the child; nothing removed without a chosen strategy | cell |
| C6.07 | Child on a kids tier billed to the parent through Stripe | `member/subscriptions/start-for-kid` | not exercised here (needs the club's Stripe + a card session); covered by `parent-pays-for-kid` integration test (DB-bound suite, 0 failed 24 Sep) | PASS (integration) |
| C6.08 | Parent's card fails → child also loses coverage? | Stripe | not proven; the child's `paymentStatus` is its own column and the webhook keys on the PAYER's customer id — whether the child flips is **unknown** | GAP-check (unverified) |
| C6.09 | Kids on the public leaderboard show first name + initial only | `/leaderboard/[token]` | PASS (J66, lg lanes) | PASS |

## L4 · Changing plans — no lane; documented from the code (2026-09-25)

| ID | Scenario | Today | Status |
|---|---|---|---|
| C4.01 | Upgrade mid-cycle (4-weekly £55 → £98) on a Stripe subscription | no item swap exists; the desk cancels at period end via the refund/cancel routes and starts a new subscription; proration is never applied | **GAP (M)** — workaround: cancel at period end + start new on the day; document in the runbook |
| C4.02 | Downgrade | same as C4.01 | GAP (M) |
| C4.03 | Switch cadence (monthly → 4-weekly) | a different Stripe price = a different tier; same as C4.01 | GAP (M) |
| C4.04 | Price change on a tier with live subscribers | Stripe prices are immutable; the tier's `pricePence` edit does not touch existing subscriptions (they keep the old price); new members get the new price once `stripePriceId` is cleared or re-minted — **the memberships page does not say this** | **UX (medium)** — say what happens to existing members at the point of change (prompt §6) |
| C4.05 | Tier deactivated with members on it | `isActive=false`: members keep it, not offered (memberships page lists active only, so the count of its members is hidden) | PASS (behaviour) / UX (low): inactive tiers invisible |
| C4.06 | Tier deleted with members on it | `MembershipTier` → Member is SetNull: members keep going with no tier (and, after the coverage fix, no portal coverage until reassigned) | UX (medium) — refuse or warn when members are on it |
| C4.07 | Cash member moves to card | staff `SubscribeDrawer` starts a subscription; `nextDueAt` handed to Stripe | PASS (le-1 / J67 create path) |
| C4.08 | Two concurrent plans | one `membershipTierId` per member | GAP (L) — the import keeps the current plan and notes the other |
| C4.09 | Adult + junior package | modelled as the adult on a tier and the child on a kids tier | GAP (M) |
| C4.10 | Minimum commitment (2 cycles) | not enforced; self-cancel is off for Total BJJ so the desk is the only door | GAP (S, policy) |

## L8 · Attendance and the door — `lh-3-clublife-door.spec.ts` (in progress)

| ID | Scenario | Door | Expected | Status |
|---|---|---|---|---|
| C8.01 | Member on a venue-bound tier tries a class at another venue | member self check-in | 403 `venue_not_covered`, both venue names in the message, no row | cell (slice 2) |
| C8.02 | Same member at a class at their venue, and at a class with no venue | same | 201 both | cell (slice 2) |
| C8.03 | Staff mark for the same member at the other venue | owner `POST /api/checkin` admin | 201 — the desk overrides | cell (slice 2) |
| C8.04 | Kiosk at the other venue | kiosk token check-in | refused (member-decided path) | cell (slice 2) |
| C8.05 | Duplicate check-in | any | 409 | PASS (ld-2 J36 race cell) |
| C8.06 | Undo restores a pack credit | staff undo | PASS (unit `checkin-undo-restores-pack-credit`) | PASS |
| C8.07 | Pack: last credit, expiry, extend expiry | member/pack routes | last credit and expiry PASS (unit); **extend expiry has no tool** | GAP (S) |
| C8.08 | Card revoked → scan refused | lc-3 J29 | PASS | PASS |

## L7 · Classes and the timetable — evidence already in the assess suite (ld-1, 25/0 on 25 Sep) plus gaps

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C7.01 | Class created; 56 days of instances minted | ld-1 J31 "manager creates at the route and 56 days are minted" | PASS |
| C7.02 | Start time moved: no future instance at the old time, past attendance untouched | ld-1 "a start-time move leaves no future instance at the old time" | PASS |
| C7.03 | One session cancelled and un-cancelled; a cancelled session refuses check-in | ld-1 J33 cells | PASS |
| C7.04 | Class archived stops minting; Generate is idempotent and bounded | ld-1 cells | PASS |
| C7.05 | Capacity reached: member refused, staff overrides | unit `checkin-capacity`; ld-2 | PASS |
| C7.06 | Roster-only and rank-gated classes | unit `kiosk-roster-refusal`, `checkin-*`; ld-2 | PASS |
| C7.07 | Check-in window before/after in the club's timezone | ld-1 J16 (lb-1) "POST checkin respects the window under a shifted zone"; unit `class-time-timezone` | PASS |
| C7.08 | Coach reassigned / removed: instances keep history | `Class.coachUserId` SetNull; no cell | not covered (low) |
| C7.09 | Members told when their session is cancelled | none — cancellation writes no notification | GAP (M) |
| C7.10 | Bank-holiday closure (cancel a day) | per-instance cancel only; no bulk tool | GAP (S) |
| C7.11 | DST change across a week: wall-clock times hold | unit `class-time-timezone`, `build-instance-rows` | PASS (unit) |

## L12 · Time itself — unit evidence

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C12.01 | Due dates step by cycle across month ends and DST (4-weekly, fortnightly, weekly, monthly clamp) | unit `overdue-derivation` (cycle cells added 23 Sep) | PASS (unit) |
| C12.02 | Reports week and month boundaries | `lib/reports.ts` uses the club timezone since the Aug fix; unit `reports-*` | PASS (unit) — a DST-week cell on the wire is not written |
| C12.03 | Leaderboard month in the club's zone | unit `leaderboard-aggregate` | PASS (unit) |
| C12.04 | Retention windows | cron `?dryRun=1` counts (23 Sep) | PASS (dry run) — live run BLOCKED on `CRON_SECRET` |
| C12.05 | Stripe test clock through a period end | `scripts/stripe-migration-e2e.mjs`, `scripts/stripe-lifecycle-e2e.mjs` | PASS |
