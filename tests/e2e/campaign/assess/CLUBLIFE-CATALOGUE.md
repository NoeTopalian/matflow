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

## L13 · Screen transitions and resilience — `lh-4-clublife-transitions.spec.ts` (8/0 on 25 Sep)

| ID | Scenario | Door | Expected | Status |
|---|---|---|---|---|
| C13.01 | Double-clicked cash payment | two concurrent `POST /api/payments/manual`, one requestId | one Payment, due date moved once | PASS |
| C13.02 | Double-clicked hold | two concurrent `POST /api/members/[id]/hold` | on hold once, one audit row | PASS — **F-TC-9 PRODUCT (low) found and fixed**: both writes used to succeed (read-then-write); now compare-and-set, the loser gets 409 |
| C13.03 | Two staff on one member, stale form | `PATCH /api/members/[id]` with the earlier `updatedAt` | 409, first save survives | PASS |
| C13.04 | Refresh mid Add Member | browser reload with a half-typed dialog | dialog gone, nothing written | PASS |
| C13.05 | Back after a create | browser back/forward after the POST | exactly one row | PASS |
| C13.06 | Session expired before Save | cookies cleared, then Save on Settings | no "saved", nothing written | PASS |
| C13.07 | Club switch | — | one session = one club; no switcher (ADR-001 D4 NOT STARTED) | GAP (L, decided: after a second club signs) |

## L1 · Joining and the trial funnel — evidence already in the suite

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C1.01 | Walk-in trial created by staff (status taster, who ran it) | unit `member-status-event`, `attribution-conversion`; lf-3 funnel cells | PASS |
| C1.02 | Trial converts via staff PATCH: status event, credit, funnel counts | unit `conversion-funnel`, `coach-register-tick-attribution`; lf-3 | PASS |
| C1.03 | Trial goes quiet / trial cancelled: "still deciding" and "lost" | unit `conversion-funnel` partition cells | PASS (unit) |
| C1.04 | Self-signup at /apply → operator approves → owner first login | a0-1 (apply, rate limit, refusals), lg-1 create-tenant/approve, la-1 first login | PASS |
| C1.05 | Invite → accept → login → 2FA | unit `accept-invite`; la-1/la-2; lc-1 "bulk-invite is owner + manager" | PASS |
| C1.06 | Invite expires (7 days) and is re-sent | unit `accept-invite` expiry cell; re-send = bulk-invite again | PASS (unit) |
| C1.07 | Duplicate email on join | `Member @@unique([tenantId,email])` → 409 with an honest message; lc-1 | PASS |
| C1.08 | Member with no email: placeholder, never invited | lc-1 "the placeholder never becomes an invite"; unit `members-no-email-adult`, `payment-chase-skips-synthesised-email` | PASS |
| C1.09 | Brought-a-friend credit / free-text credit | `AttributionFields`; unit `attribution-conversion` XOR cells | PASS (unit) |

## L9 · Staff and roles — evidence already in the suite

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C9.01 | Owner invites manager, coach, admin; each sees exactly their nav and API | lb-2 J17/J18 (30/0 on 25 Sep) | PASS |
| C9.02 | Manager records money, coach cannot | le-1 J42 cells | PASS |
| C9.03 | Staff lockout → owner unlock; staff 2FA enrol/reset | la-1 J01/J04, unit `staff-unlock` | PASS |
| C9.04 | Staff removed mid-month: attribution and check-ins survive | `User` relations SetNull on the attribution columns; `AttendanceRecord.checkedInById` | PASS (schema) — no cell |
| C9.05 | Owner hands the club to a manager | lb-2 J69 (25 Sep) | PASS |
| C9.06 | Operator impersonation is audited and revocable | lg-2 | PASS |

## L10 · The club itself — evidence already in the suite

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C10.01 | Branding flows to login/kiosk/leaderboard | lb-1 J12, lg lanes; live check on the demo club 23 Sep | PASS |
| C10.02 | Timezone change → windows and reports re-bucket | lb-1 J16 | PASS |
| C10.03 | Club suspended by the operator: doors refuse honestly, data intact; reactivated | lg-1 "suspend then unsuspend" | PASS |
| C10.04 | Slug change: logins, QR, leaderboard tokens | slug is edited by the operator only; the demo slug swap on 23 Sep proved logins follow it; card tokens are per member (not slug-bound); leaderboard token unaffected | PASS (observed) — no cell |
| C10.05 | Kiosk / display token rotate and disable | lb-1 J13, J66 | PASS |
| C10.06 | Club closes: export everything, retention afterwards | DSAR/export routes exist per member; a whole-club export is the operator CSV (tenants) — **no single "export this club" action** | GAP (M) |

## L11 · Communications — evidence already in the suite

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C11.01 | Invite, magic link, reset, chase, announcement each land in EmailLog with a state | unit `email-*`, `magic-link-security`, `announcements-*` | PASS (unit) |
| C11.02 | Bounce webhook suppresses future sends | unit `resend-webhook`, `email-bounce-short-circuit` | PASS (unit) — live delivery BLOCKED on DMARC + `RESEND_WEBHOOK_SECRET` |
| C11.03 | No send to a synthesised address | unit `payment-chase-skips-synthesised-email`, `members-no-email-adult`; lc-1 | PASS |
| C11.04 | Member opt-outs honoured | `Member.classReminders/beltPromotions/gymAnnouncements` read by the senders; unit `announcements-unseen` | PASS (unit) |
| C11.05 | Members told when a session is cancelled | none | GAP (M) — same as C7.09 |

## L3 · Money goes wrong — `scripts/stripe-lifecycle-e2e.mjs` (PASS 24 Sep 22:20 UTC) and unit

| ID | Scenario | Evidence | Status |
|---|---|---|---|
| C3.01 | Renewal fails → overdue + failed Payment row; retry succeeds → paid | lifecycle script (fail leg); success leg = migration script's clocked charge | PASS |
| C3.02 | Checkout abandoned (`checkout.session.expired`) → nothing recorded | unit `stripe-webhook-handlers` | PASS (unit) |
| C3.03 | Payment method detached / card expiring: what the owner sees | `payment_method.detached` handler flips to overdue + card; no "expiring" warning | PASS (detach) / GAP (S: expiry warning) |
| C3.04 | Refund full / partial with pack apportionment | lifecycle script (full), unit refund apportionment (partial) | PASS |
| C3.05 | Dispute created → lost → won | lifecycle script (created); **closed won AND lost on the wire** — `scripts/stripe-dispute-closed-e2e.mjs` PASS 2026-09-25 15:10 UTC: won → Payment succeeded again, member paid, Dispute won, one audit row; lost → Payment written off as refunded, member overdue, Dispute lost, one audit row; redelivered closures write nothing. **PRODUCT F-TC-2 found and fixed here:** every opened dispute emailed each owner twice (two templates on one branch; connection audit 2026-08-22 BROKEN #8 was still live) — now one `dispute_opened_owner` per owner, pinned by unit | PASS |
| C3.06 | Webhook replayed / out of order / wrong account | lifecycle script (replay), unit (`active` after `canceled`, foreign account 409) | PASS |
| C3.07 | Stripe disconnected mid-life | `account.application.deauthorized` unit; not producible on a Custom test account | PASS (unit) |
| C3.08 | Reconcile finds a subscription whose events never arrived | cron `stripe-reconcile` exists but **is not in `vercel.json` crons** (only monthly-reports, retention, class-instances are scheduled), and `CRON_SECRET` is unset in production — it has never run anywhere but a test env | BLOCKED (CRON_SECRET) + GAP (S: add the schedule) |
