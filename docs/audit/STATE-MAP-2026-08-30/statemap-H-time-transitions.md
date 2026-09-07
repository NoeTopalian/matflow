> **Note:** Headline sections complete; detail sections truncated (agent stalled) — regenerate on demand.

# MatFlow state-space map H — Time as a state machine

Round 2. Everything already in the caller's KNOWN list is deliberately omitted.
Evidence is `file:line`. Anything I could not prove by reading source is tagged
**UNVERIFIED**.

---

## 0. HEADLINE TRUTHS (new only)

1. **`ClassWaitlist` is a table nothing ever writes.** `expiresAt`, `position`
   and `status` ("waiting | promoted | expired") have no producer anywhere in
   `app/`, `lib/`, `scripts/`. Grep for `classWaitlist.create` / `.update` /
   `.upsert` returns zero hits; the only writes in the repo are `deleteMany`
   (`app/api/cron/retention/route.ts:612`, `lib/member-delete.ts:123`). It is
   read in three places (coach register `app/api/coach/instances/[id]/register/route.ts:53`,
   DSAR export `app/api/admin/dsar/export/route.ts:388`, and the schedule-edit
   orphan guard `app/api/classes/[id]/route.ts:167`). So the whole
   "waitlist expires, next member is promoted" time machine is a schema-only
   fiction, and `ClassWaitlist.expiresAt` is a date field with no reader and
   no writer.

2. **Nothing enforces `Class.maxCapacity`, which is why (1) is dead.**
   `performCheckin` (`lib/checkin.ts:113-330`) checks tenant, cancellation,
   rank, roster, time window and coverage — never a headcount. `maxCapacity`
   is only selected for display (`app/api/member/schedule/route.ts:162`,
   `lib/member-home.ts:374`) and for the capacity-utilisation figure in
   reports (`lib/reports.ts:361`). A class can be checked into without limit,
   so no one ever lands on a waitlist.

3. **The 4-week / 52-week horizon in the caller's KNOWN list is the *button*.
   The real horizon is 56 days and it is owned by `lib/class-instances.ts:25`
   (`ROLLING_WINDOW_DAYS = 56`).** Three call sites use it
   (`app/api/cron/class-instances/route.ts`, `app/api/classes/[id]/route.ts:196`)
   while `POST /api/instances/generate` defaults to `weeks: 4` = 28 days
   (`app/api/instances/generate/route.ts:14,54`). The two horizons differ by
   four weeks, so pressing "Generate" after the cron has run appears to do
   nothing (`created: 0`), and pressing it *instead of* the cron gives you half
   the coverage the cron's own comment promises.

4. **`Tenant.timezone` is a completely dead column.** `grep -rn timezone` over
   every `.ts`/`.tsx` in the repo returns exactly one hit and it is a Playwright
   fixture (`tests/e2e/audit/harvest.spec.ts:403`). No read in `app/`, `lib/`,
   `components/`, `scripts/`. Every time decision in the product therefore runs
   on **the Node process's local timezone**, which on Vercel is UTC.

5. **Class times are timezone-naive strings anchored to a UTC-midnight date, and
   the check-in window is computed by gluing them together with `setHours`.**
   `parseTime` (`lib/class-time.ts:6-11`) does `d.setHours(h, m, 0, 0)` on the
   instance's `date`. On a UTC server that makes a "19:00" class open its
   check-in window at 18:30 **UTC**. From late March to late October (BST) that
   is 19:30 local — the window opens half an hour *after* the class started and
   closes an hour into the next. Every British gym's self- and kiosk check-in is
   an hour out for seven months of the year.

6. **`Class.deletedAt` is never set by the delete route.** `DELETE
   /api/classes/[id]` writes `{ isActive: false }` only
   (`app/api/classes/[id]/route.ts:481-486`) while the audit row claims
   `soft: true`. The schema documents these as different states
   (`prisma/schema.prisma:365` — "isActive=false is 'paused', deletedAt is
   'removed from history'"), so the "removed" state is unreachable through the
   API.

7. **Deleting or pausing a class leaves up to 56 days of live `ClassInstance`
   rows, and `performCheckin` does not filter on `isActive` / `deletedAt`.**
   The instance lookup is `{ id: classInstanceId, class: { tenantId } }`
   (`lib/checkin.ts:118-122`) — no activity predicate. The lists hide the class
   (`app/api/member/schedule/route.ts:60`, `lib/member-home.ts` class query),
   but any client holding a `classInstanceId` (an open tab, a cached PWA page, a
   kiosk mid-session) can still check in to a class the gym deleted, burning a
   class-pack credit against a session that will never run. The instance-orphan
   reconcile only runs when the PATCH body carries `schedules`
   (`app/api/classes/[id]/route.ts:371`), never on the `isActive` flip.

8. **Attendance carries no notion of *when the class was*, only when the button
   was pressed.** `AttendanceRecord.checkInTime` is `@default(now())`
   (`prisma/schema.prisma:420`) and no route accepts an override — the create in
   `lib/checkin.ts` passes no `checkInTime`. Staff check-in bypasses the time
   window entirely (`enforceTimeWindow: isSelf`,
   `app/api/checkin/route.ts:125`), so a coach filling in Monday's register on
   Wednesday stamps Wednesday. Every downstream time series — streaks,
   last-visit, monthly report attendance-by-day — keys off `checkInTime`, not
   `classInstance.date`.

9. **There is no pause/resume machinery at all.** No `pausedAt`, `resumeAt`,
   `pauseUntil` anywhere in the schema; `paymentStatus: "paused"` is only ever
   *mirrored in* from a Stripe-side pause
   (`app/api/stripe/webhook/route.ts:673`) or set by a staff PATCH. Nothing
   un-pauses on a date. A frozen member stays frozen until a human notices.

10. **`current_period_end` is never persisted.** The code says so in its own
    comment: "the subscription-level `current_period_end` was REMOVED in dahlia
    and now lives on `sub.items.data[i].current_period_end`. Nothing reads it
    today." (`lib/stripe/subscriptions.ts:226-227`). So MatFlow has **no local
    answer to "when does this member's access lapse"**; the only signal is a
    webhook arriving after the fact. If webhooks are down, a cancelled member is
    indistinguishable from a paying one until the reconciler's 72-hour lookback
    happens to catch it.

11. **`Member.joinedAt` — the de-facto "member since" — is
    `@default(now())` and only settable by the CSV importer**
    (`app/api/admin/import/[id]/commit/route.ts:91`). No create/update route
    exposes it. A gym that onboards manually gets "joined today" for a
    fifteen-year black belt, and that field feeds new-member counts
    (`app/api/dashboard/stats/route.ts:39`) and the AI causal report's net-new
    figure (`lib/ai-causal-report.ts:69-70`).

12. **`GymApplication` accumulates prospect PII (name, email, phone, IP, user
    agent) forever.** `prisma/schema.prisma:982-996`. It appears in no retention
    rule (`app/api/cron/retention/route.ts:166-228`) and in no tenant purge list
    (`:632-655`) — it has no `tenantId`, so it is invisible to both. Same for
    `LoginEvent`, `Notification`, `IndexedDriveFile` and every past
    `ClassInstance` / `AttendanceRecord`: they are only deleted when a *whole
    tenant* is purged, never on age.

---

## 1. Date-field sweep

Every non-trivial temporal column in `prisma/schema.prisma`. Plain
`createdAt`/`updatedAt` audit stamps are folded into one row at the end.
"Actor" = what makes the transition happen once the moment passes.

### 1a. Fields with NO actor at all (time passes, nothing happens)

| Field | Schema | Should happen | Actor | Gap |
|---|---|---|---|---|
| `ClassWaitlist.expiresAt` | `:486` | Hold lapses, next member promoted | none - no code writes this table (Headline 1) | Whole model inert; `status` never leaves its `waiting` default |
| `ClassWaitlist.joinedAt` / `.position` | `:485,484` | FIFO ordering | none | Same |
| `Notification.sentAt` | `:509` | n/a - the model is never written either. `grep -rn "\.notification\."` returns only DSAR erase (`app/api/admin/dsar/erase/route.ts:345`) and the tenant purge | none | Entire `Notification` model is dead: a read path exists, a write path does not |
| `Dispute.evidenceDueAt` | `:904` | Warn staff before Stripe auto-loses the dispute | none. Written from Stripe (`app/api/stripe/webhook/route.ts:861,865`), put in the notification email, used once as an `orderBy` (`app/api/payments/route.ts:81`) | The deadline can pass in silence. Local `status` stays `needs_response` until `charge.dispute.closed` arrives |
| `Order.paidAt` null + `status:"pending"` | `:949,945` | Abandoned Stripe checkout should cancel | none. `checkout.session.expired` is absent from `HANDLED_EVENT_TYPES` (`app/api/stripe/webhook/route.ts:46-62`) | Every abandoned cart becomes a permanent `pending` order, indistinguishable from a genuine pay-at-desk order awaiting cash |
| `Member.dateOfBirth` | `:141` | 18th birthday - kids/junior becomes adult, adult waiver required | none. No age arithmetic exists anywhere; every hit is a passthrough (`app/api/member/children/route.ts:61`, DSAR, importer) | A `kids` account stays `kids` for life, still bound to `parentMemberId`, still served the kids waiver |
| `GoogleDriveConnection.lastIndexedAt` | `:739` | Re-index a stale folder | none. Displayed only (`app/api/drive/status/route.ts:28`); `/api/drive/index` is manual and no cron calls it | The monthly AI report reads `IndexedDriveFile` (`lib/ai-causal-report.ts:170-176`) with no staleness check, so a folder last indexed in March silently feeds March content into September's report |
| `IndexedDriveFile.modifiedAt` / `.indexedAt` | `:748,751` | Detect drift against Drive | none | Files deleted in Drive are never removed locally |
| `Tenant.kioskTokenIssuedAt` | `:60` | Rotate or expire the kiosk URL | none. Written on mint, cleared on disable, displayed (`app/api/settings/kiosk/route.ts:103,67,139`) | The kiosk URL is valid forever until a human regenerates it. A tablet taken from the front desk is a permanent unauthenticated tenant-scoped surface |
| `SignedWaiver.acceptedAt` + `version` | `:672,668` | Annual or on-version-change re-signing | none. No expiry logic; `version` is written but never compared | `Tenant.waiverContent` can be edited in settings with no re-consent prompt for existing members |
| `Member.waiverAcceptedAt` | `:144` | Same | none | Same |
| `RankRequirement.minMonths` with `MemberRank.achievedAt` | `:333,297` | Member becomes promotion-eligible | lazy, read-only. `meetsPromotionThreshold` recomputes `monthsElapsed` on every render (`lib/promotion-candidates.ts:64-66`), called from `app/dashboard/promotions/page.tsx:15` and `app/api/promotions/candidates/route.ts:14` | No notification, no task, no email - eligibility exists only while a manager has that page open. It also uses a 30.44-day "month" while `lib/member-stats.ts:305` implements a correct calendar `wholeMonthsBetween` for badges: two month definitions in one codebase |
| `MembershipTier.maxClassesPerWeek` | `:1011` | Refuse the N+1th check-in that week | none. CRUD plus one table sort (`components/dashboard/MembershipsManager.tsx:248`) | Unlimited in practice |
| `Class.maxCapacity` | `:342`ff | Class full, open a waitlist | none (Headline 2) | With `maxClassesPerWeek` also unenforced, no attendance limit of any kind exists |
| `Tenant.subscriptionStatus = "trial"` | `:26` | Trial ends, tenant suspends | none, and no date to end from | Noted because the enforcement point already exists - `auth.ts:193-194` rejects `deletedAt` and `suspended` at sign-in - it simply has no trigger feeding it |
| `Member.paymentStatus = "paused"` | `:133` | Pause ends, billing resumes | none. No `pausedAt`/`resumeAt` column exists; the value only ever arrives by Stripe mirror (`app/api/stripe/webhook/route.ts:673`) | A freeze has no end date anywhere in the system |
| `Task` has no `dueDate` | `:1108-1111` | Task overdue, chase it | n/a - the column does not exist | Member action items ("sign your waiver") can never be overdue, so nothing escalates |
| `Initiative.endDate` | `:705` | Campaign ends | lazy, read-only overlap filter (`lib/ai-causal-report.ts:155-165`) | Benign; listed for completeness |
