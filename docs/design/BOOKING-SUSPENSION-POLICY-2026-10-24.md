# Booking suspension and capacity policy (proposal, 24 Oct 2026)

Status: **proposal for Noe's approval (Decision 2). Not implemented.** Separate
from the approved preservation requirement (D2, Noe 21 Oct 2026: "Preserve
bookings pending an approved migration policy, enforce current eligibility at
attendance, and explain affected bookings visibly. Do not silently delete
them."), which is implemented: no loss of access deletes a booking; the
member, the owner's preview and the coach register show it; the door refuses
at attendance. No production data.

## 1. Today, after D2

- A booking is a standing `ClassSubscription` (member + class), not a seat in
  one session.
- **Booking capacity** counts every booking of the class under the Class row
  lock (`app/api/member/class-subscriptions/[classId]/route.ts`); a booking
  kept for a member the class now turns away still counts.
- **Door capacity** counts confirmed attendance of the session, not bookings
  (`lib/checkin.ts` `capacityState`). A booking does not reserve a place
  against a walk-in; nothing at the door looks at bookings.
- So a kept-but-ineligible booking can block a new eligible booking, and a
  booking never protects a place at the door.

## 2. The proposed policy (one consistent set)

**P1. States.** A booking is `active` or `suspended`. Suspended = kept, shown,
not counted. No other states; deletion stays only for the member's own cancel,
staff removing the booking explicitly, and member deletion.

**P2. What suspends.** A booking is suspended — in the same transaction as the
change, recorded per trigger as today's `class.bookings.kept_ineligible` rows —
when the class's rules or the member's standing make every door refuse the
member: removed from the squad list, membership list narrowed past their plan,
rank gate raised or demotion past it (refused at the member's own doors), plan
removed or changed to one not included, membership cancelled. Not suspended:
a hold (it ends by itself; the hold gate already refuses), an exhausted
allowance (counted per period; the booking notice already says so), a paused
class (paused bookings are already hidden and kept).

**P3. Capacity.** A suspended booking **releases its place**: booking capacity
counts active bookings only. (The alternative — counting suspended bookings —
lets an ineligible member block an eligible one indefinitely.)

**P4. No queue, no automatic reactivation.** Suspended bookings do not form a
waiting list and are never reactivated as a side effect of an unrelated edit.
When the member becomes eligible again (re-added to the squad, plan changed
back, list widened, promoted), the booking becomes **reactivatable**: the
member and staff see "You can be booked again" with one action, which runs the
normal booking path (Class lock, eligibility, capacity) and either reactivates
or says the class is full.

**P5. Eligibility returns after the place was taken.** Reactivation is judged
like a new booking: if the class is full, the booking stays suspended and the
member is told the class is full; nothing displaces the member who took the
place.

**P6. Door capacity is unchanged.** Bookings remain "this is my class"
markers, not reservations: the door counts attendance only, and a walk-in can
take a place a booked member has not yet used. If the club wants reserved
places, that is a separate feature (per-session reservations with a hold time)
and needs its own decision.

## 3. Worked example: a class of 10 places

| Step | Event | Active bookings | Suspended | Who holds what |
|---|---|---|---|---|
| 1 | A..J book | 10 (A..J) | – | full; K cannot book |
| 2 | Plan list narrowed; A's plan excluded | 9 (B..J) | A | A suspended in the same transaction, place released; A sees "Not eligible: …" |
| 3 | K books | 10 (B..K) | A | K holds the tenth place |
| 4 | A's plan changes to an included one | 10 | A (reactivatable) | A is told "You can be booked again"; nothing changes automatically |
| 5 | A taps "Book again" | 10 | A | refused "This class is full"; A stays suspended; K keeps the place |
| 6 | C cancels; A taps again | 10 (A, B, D..K) | – | A reactivated through the normal booking path |
| At the door, any session | | | | capacity = attendance; a walk-in may take a place before a booked member arrives (unchanged) |

## 4. What it costs

A `status` (and `suspendedAt`, `suspendedBy` trigger) on `ClassSubscription`;
the booking count filters `status = active`; the D2 write paths set
`suspended` instead of only recording; the member schedule and register read
the status; a "Book again" action. One migration; the lock order is unchanged
(the suspension is written under the Class lock the paths already take,
`docs/design/LOCK-ORDER-2026-10-24.md`).

## 5. Decision for Noe

Approve P1–P6 as one policy. Recommendation: **approve**; the consequence is
that an ineligible member stops holding a bookable place (P3) and never gets it
back silently (P4/P5), while the door's behaviour does not change (P6). If not
approved, D2's preservation stands as it is: kept bookings keep counting
against booking capacity.
