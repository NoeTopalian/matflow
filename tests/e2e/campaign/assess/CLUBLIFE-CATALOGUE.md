# Club-life catalogue — scenarios a real club throws at MatFlow, with what the product does today

Started 2026-09-25 (execution prompt §7 "operational days"; the earlier "club life simulation" plan). One row per scenario: the door it is driven through, the expected state, and the status. Statuses: `PASS` (proven by the named cell on the test branch), `PRODUCT` (defect, fixed or filed), `UX`, `HARNESS`, `ENV`, `GAP` (the product has no such feature; the workaround an owner uses today and a size). A row without a cell is not evidence.

Lanes L1–L12 are listed in the plan file; cells land lane by lane. Money-side scenarios that need Stripe (L2/L3) are covered by `scripts/stripe-migration-e2e.mjs` and `scripts/stripe-lifecycle-e2e.mjs` (both PASS 24 Sep) and are referenced, not repeated.

## L5 · Pausing, leaving, returning — `lh-1-clublife-pause-leave-return.spec.ts`

| ID | Scenario | Door | Expected | Status |
|---|---|---|---|---|
| C5.01 | Hold with a date → the member tries to check themselves in | owner `POST members/[id]/hold {until}`; member `POST /api/checkin` (self) | 403 `on_hold`, message names the date; no attendance row | cell |
| C5.02 | Resume → self check-in on a Stripe-covered membership | owner `POST …/resume`; member self check-in | 201, attendance row | cell |
| C5.03 | Resume → self check-in on a **cash** membership (paid, no Stripe subscription, no pack) | same | **402 "No active membership or class pack credits. Buy a pack or contact your gym."** today (measured on the wire 25 Sep): the portal's self check-in requires a Stripe subscription or a pack; the kiosk admits (`requireCoverage: false`). A paid cash member is told to buy a pack | **PRODUCT (medium)** — fix: for `paymentRail = pay_at_desk` (or any member with `paymentStatus = paid`), coverage should read the paid state, not the Stripe link. Filed here; not changed tonight |
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
