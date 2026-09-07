# StateMap Lane E — Exhaustive entity-state sweep

Scope: every state-bearing field in `prisma/schema.prisma` NOT covered by prior lanes
(Tenant.subscriptionStatus/deletedAt, Member.status/paymentStatus/passwordHash/TOTP/lockedUntil,
User role/TOTP, Operator.role). Evidence is file:line. Anything not proven by a grep or read is
marked UNVERIFIED. Read-only sweep; no dev server, tests or DB were run.

---

## 0. HEADLINE TRUTHS

**H1 — `ClassInstance.isCancelled` can never become `true`. The class-cancellation feature is
unreachable.**
No `classInstance.update` / `updateMany` exists anywhere in app/, lib/, scripts/. The only writes
are `createMany` (app/api/classes/[id]/instances/route.ts:95,
app/api/cron/class-instances/route.ts:167, app/api/instances/generate/route.ts:67), `deleteMany`
(app/api/classes/[id]/route.ts:182, app/api/cron/retention/route.ts:613) and a seed `upsert`
(prisma/seed.ts:219). The cancel payload schema is dead code: `cancelSchema` is declared at
app/api/classes/[id]/instances/route.ts:11-14 and never referenced again — that file's POST parses
`genSchema` instead (line 64-66). Consequences: `cancellationReason` is never written; the ~10
read paths filtering `isCancelled: false` (app/api/coach/today/route.ts:32,
app/api/kiosk/[token]/classes/route.ts:56, lib/member-home.ts:312, app/dashboard/page.tsx:68,
app/api/member/schedule/route.ts:86, lib/member-stats.ts:161, app/dashboard/checkin/page.tsx:37
and :148) are permanent no-ops; the strike-through "cancelled" rendering at
app/member/home/page.tsx:1562-1566 is dead UI; the guard
`if (instance.isCancelled) return { kind: "class_cancelled" }` (lib/checkin.ts:133) is
unreachable; and `@@index([date, isCancelled])` (prisma/schema.prisma:408) indexes a constant.

**H2 — `Class.deletedAt` is never written, so "paused" and "removed" collapse into one state.**
The class DELETE route soft-deletes by flipping `isActive` only —
app/api/classes/[id]/route.ts:480-485 (`// Soft-delete by setting isActive = false`,
`data: { isActive: false }`). No `deletedAt: new Date()` write for `class` exists anywhere. The
schema comment at prisma/schema.prisma:365 claims the opposite ("isActive=false is 'paused',
deletedAt is 'removed from history'"). Every `deletedAt: null` predicate on Class is therefore a
no-op (app/api/classes/route.ts:24, app/api/cron/class-instances/route.ts:145,
app/api/instances/generate/route.ts:44, app/api/member/schedule/route.ts:60,
lib/member-home.ts:286, app/dashboard/timetable/page.tsx:35, app/dashboard/page.tsx:31,
app/api/member/me/subscriptions/route.ts:28, app/dashboard/checkin/page.tsx:125,
app/api/classes/[id]/instances/route.ts:71), and `@@index([tenantId, deletedAt])`
(prisma/schema.prisma:373) indexes a constant. app/dashboard/page.tsx:31 counts deleted classes as
live because it filters on `deletedAt` alone, not `isActive`.

**H3 — `ClassWaitlist` has zero writers. The whole model is write-dead.**
No `classWaitlist.create/update/upsert/createMany/updateMany` exists in app/, lib/, scripts/ or
prisma/. Only reads and cascade deletes: app/api/coach/instances/[id]/register/route.ts:53
(filters `status: "waiting"`), app/api/admin/dsar/export/route.ts:388,
app/api/classes/[id]/route.ts:175-178 (`_count.waitlists`), app/api/coach/today/route.ts:70
(`waitlistCount`), app/api/cron/retention/route.ts:612, lib/member-delete.ts:123. So `status`
(waiting|promoted|expired), `position` and `expiresAt` are unreachable, `waitlistCount` is always
0, and the class-delete safety check `_count.waitlists > 0` (app/api/classes/[id]/route.ts:175)
never fires.

**H4 — `Notification` has zero writers. The in-app notification model is entirely dead.**
The only two references in the repo are DSAR: app/api/admin/dsar/erase/route.ts:183
(`notification.count`) and :345 (`notification.deleteMany`). There is no `notification.create`
anywhere. `read`, `channel` ("email"|"in_app"), `type`, `title`, `message` and `sentAt` are never
written and never listed to any user. `@@index([tenantId, memberId, read])`
(prisma/schema.prisma:512) backs a query that does not exist.
app/dashboard/notifications/page.tsx is misleadingly named — it reads `Announcement` (line 7).

**H5 — `PlatformConfig` has zero reads and zero writes; so does `Tenant.featureFlags`.**
No `platformConfig.` reference exists anywhere in app/, lib/ or scripts/. The schema comment
(prisma/schema.prisma:1051-1052) promises it holds "audit-log retention days, feature-flag
defaults, webhook outboxes"; retention windows are in fact hardcoded constants
(app/api/cron/retention/route.ts:68-91). `Tenant.featureFlags` (prisma/schema.prisma:62) likewise
has zero references, despite migration 20260506000000_operator_platform_config_feature_flags
shipping it. `PlatformConfig.updatedById` / `updatedAt` are dead by extension.

**H6 — `MemberClassPack.status = "expired"` is written lazily by a member-facing GET and by
nothing else.**
The only writer is app/api/member/class-packs/route.ts:29-32, inside
`GET /api/member/class-packs`. No cron sweeps it (vercel.json crons are monthly-reports,
retention, class-instances; the retention rule list at app/api/cron/retention/route.ts:166-229 has
no pack rule). A member who never opens the packs screen keeps `status: "active"` past `expiresAt`
indefinitely. It is mostly inert for redemption because both redemption paths independently
require `expiresAt: { gt: new Date() }` (lib/checkin.ts:206-213 and :285-292), but the DSAR export
(app/api/admin/dsar/export/route.ts:256-263) and `@@index([tenantId, expiresAt])` imply a sweep
that does not exist.

**H7 — `Order.status = "cancelled"` is never written, and there is no staff surface for Orders at
all.**
Written values are `"pending"` (app/api/member/checkout/route.ts:114 and :214) and `"paid"`
(app/api/orders/[id]/mark-paid/route.ts:70, app/api/stripe/webhook/route.ts:528). `"cancelled"` is
only read, defensively, at app/api/orders/[id]/mark-paid/route.ts:51-53. There is no
`GET /api/orders` (app/api/orders contains only `[id]/mark-paid`) and no dashboard page listing
orders. A `pay_at_desk` order therefore lands as `pending` and is invisible to staff forever; the
only client reference to `orderRef` is the member's own success toast
(app/member/shop/page.tsx:121). Nothing in the UI appears to call `mark-paid` (no non-API
reference to the route was found).

**H8 — `Task.completedById` is not written on the staff completion path**, contradicting the
schema comment at prisma/schema.prisma:110-114 ("Always a User… an owner overriding on behalf of
someone else"). Staff tick: app/api/tasks/[id]/complete/route.ts:47 writes only
`{ status: "done", completedAt: new Date() }`. Member tick does write it:
app/api/member/tasks/[id]/complete/route.ts:69-73. So attribution exists for member notes and is
NULL for every staff task.

**H9 — `EmailLog.status` has a seventh, undocumented value: `delivery_delayed`.**
Written at app/api/webhooks/resend/route.ts:105. The schema documents only
`queued | sent | delivered | bounced | failed | complained` (prisma/schema.prisma:842) and there is
no CHECK constraint on EmailLog (absent from every migration; cf.
prisma/migrations/20260430000001_schema_check_constraints/migration.sql). It is ranked 2 in
`STATUS_RANK` (app/api/webhooks/resend/route.ts:30-38), so it permanently masks `sent` (rank 1)
and sits level with `delivered`.

**H10 — DSAR erasure silently lifts the 30-day bounce suppression for an address.**
Suppression is `emailLog.findFirst({ recipient, status in [bounced, complained], createdAt gte
now-30d })` (lib/email.ts:355-366). DSAR erase rewrites `recipient` to a sentinel rather than
deleting the rows (app/api/admin/dsar/erase/route.ts:388-391), so the bounce record no longer
matches the address. Re-adding the same member inside the window resumes sending to a known-bad
mailbox. There is also no operator UI to clear suppression — lib/email.ts:353 explicitly says
"Operator can manually clear by deleting / updating the offending EmailLog row", i.e. by hand in
the database.

**H11 — a dispute that closes on an unmapped Stripe status leaves `Payment.status = "disputed"`
and `Member.paymentStatus = "overdue"` permanently.**
The status normaliser passes unknown Stripe values through verbatim
(app/api/stripe/webhook/route.ts:839-847, `return s;`), and the Payment branch treats anything
that is not `won|lost|charge_refunded` as `"disputed"` (:949-953), with `Member.paymentStatus`
forced to `"overdue"` for the same set (:962-969). Stripe's `warning_closed` (a withdrawn early
warning) is not in the map, so it re-writes disputed/overdue with no later event to clear it.
`Dispute.status` has no CHECK constraint in any migration, so the raw Stripe string is persisted.

**H12 — the reconciler's handled-event list has drifted from the webhook's, and the reconciler has
no schedule of its own.**
lib/stripe/reconcile.ts:26-42 says "Keep in sync with HANDLED_EVENT_TYPES in
app/api/stripe/webhook/route.ts" but omits `charge.dispute.closed`, which the webhook does handle
(app/api/stripe/webhook/route.ts:61, branch at :819-823). A dropped `charge.dispute.closed` is
therefore invisible to the drop-detector — and per its own comment at :61 that is exactly the
event whose absence leaves "a dispute … 'under_review' forever". Separately,
`/api/cron/stripe-reconcile` is absent from vercel.json's three crons; it runs only as step 0 of
the retention cron (app/api/cron/retention/route.ts:160), so a retention failure disables
reconciliation too (app/api/cron/stripe-reconcile/route.ts:3-9 documents this trade-off).

---

## 1. MODEL-BY-MODEL TABLE

Legend: **W** = values actually written; **R** = readers that branch on it; **D** = default;
**CK** = CHECK constraint. Models already owned by other lanes (Tenant identity/billing, Member
identity/billing, User auth, Operator.role) are listed only for their *residual* fields.

### 1.1 Payment

| Field | D | W (writers) | R (branching readers) | CK |
|---|---|---|---|---|
| `status` | none (required) | `succeeded`, `failed`, `pending`, `refunded`, `disputed` | see below | `succeeded\|failed\|refunded\|disputed\|pending` — 20260430000001_schema_check_constraints/migration.sql:33, `NOT VALID` |
| `paidAt` | null | set with `succeeded`; never cleared | ordering + revenue windows | — |
| `refundedAt` / `refundedAmountPence` | null | webhook `charge.refunded`, refund route | partial-refund arithmetic | `amountPence >= 0` + refund invariant, 20260818200000_payment_money_constraints/migration.sql:30,33 |
| `failureReason` | null | ad-hoc charge + `invoice.payment_failed` | display only | — |

Writers: `succeeded` — app/api/payments/manual/route.ts:109, app/api/stripe/webhook/route.ts:398,
:474, :559/:563, :752/:757, :915 (dispute won), app/api/members/[id]/charge/route.ts:222/:229/:243
via `ledgerStatus`. `failed` — app/api/stripe/webhook/route.ts:276/:281, charge route
`ledgerStatus`. `pending` — charge route only, when the PaymentIntent outcome is `unknown`
(app/api/members/[id]/charge/route.ts:200-201). `refunded` — app/api/payments/[id]/refund/route.ts:307
(only when fully refunded), webhook :634, :711, :921, :932. `disputed` —
app/api/stripe/webhook/route.ts:952 only.

Readers that branch: app/api/payments/chase/route.ts:50 (`status: "failed"`),
app/api/payments/outstanding/route.ts:29, app/dashboard/page.tsx:197, app/admin/page.tsx:87,
app/admin/billing/page.tsx:42/:48/:66, app/api/payments/[id]/refund/route.ts:102 (legacy
`refunded` rows with no `refundedAmountPence` are treated as fully refunded),
components/dashboard/payments-columns.tsx:36-70 + PaymentsTable.tsx:61-62 (tab filters for
`disputed` / `pending`).

**Payment risks**
- `pending` has a *conditional* exit only. It is written when the ad-hoc charge cannot determine
  the outcome (app/api/members/[id]/charge/route.ts:197-201). It clears if
  `payment_intent.succeeded` later arrives with **no** `invoice` set
  (app/api/stripe/webhook/route.ts:742-761, `update: { status: "succeeded" }`).
  `payment_intent.payment_failed` is **not** in `HANDLED_EVENT_TYPES`
  (app/api/stripe/webhook/route.ts:46-63), so a PI that later declines leaves the ledger row
  `pending` forever. Same for a PI that *is* invoice-backed: the `if (!piInvoiceId)` guard at :742
  skips the upsert entirely.
- `disputed` exits only via a later `charge.dispute.*` event mapping to won/lost/charge_refunded —
  see H11.
- No row is written at all when the ad-hoc charge outcome is `unknown` **and** no PI id came back
  (app/api/members/[id]/charge/route.ts:235, `else if (outcome !== "unknown")`) — deliberate, and
  documented at :207-212.

### 1.2 Dispute

| Field | D | W | R | CK |
|---|---|---|---|---|
| `status` | none | normalised `needs_response`, `under_review`, `won`, `lost`, `charge_refunded`, **plus any raw Stripe status** (app/api/stripe/webhook/route.ts:846 `return s;`) | app/admin/billing/page.tsx:55 (`in [needs_response, under_review]`), :60 (`lost` + 30d), app/api/payments/route.ts:70 (`in [needs_response, under_review]`) | none |
| `evidenceDueAt` | null | webhook :861/:865 | email copy only (:887-889) | — |

Only writer: the single `dispute.upsert` at app/api/stripe/webhook/route.ts:851-867. No manual
dispute management surface exists. UNVERIFIED: which exact Stripe statuses reach production —
`warning_closed` is the concrete unmapped case by inspection of the map at :839-847.

### 1.3 ClassPack / MemberClassPack / ClassPackRedemption

| Field | D | W | R | CK |
|---|---|---|---|---|
| `ClassPack.isActive` | `true` | `true` at create (app/api/class-packs/route.ts:86), `false` on DELETE (app/api/class-packs/[id]/route.ts:62), settable either way by PATCH (:11, :30) | app/api/member/class-packs/route.ts:23, app/api/member/class-packs/buy/route.ts:48, app/member/purchase/pack/[id]/page.tsx:16; staff list sorts by it (app/api/class-packs/route.ts:26) but does not filter | none |
| `MemberClassPack.status` | `active` | `active` (implicit default on create, app/api/stripe/webhook/route.ts:453-458), `expired` (app/api/member/class-packs/route.ts:31), `refunded` (app/api/payments/[id]/refund/route.ts:320, webhook :653, :723, :941) | lib/checkin.ts:210 + :289 (`status: "active"`), app/api/member/class-packs/route.ts:18, lib/checkin.ts:102 (`=== "refunded"` skips credit restore) | none |
| `creditsRemaining` | none | set to `pack.totalCredits` on purchase (webhook :458); `decrement: 1` guarded (lib/checkin.ts:221-224, :297-300); `increment: 1` on attendance delete (lib/checkin.ts:103-106); forced to 0 on refund | `gt: 0` guards at lib/checkin.ts:211, :222, :290, :298 | none |
| `expiresAt` | none (required) | purchase only | redemption gate + lazy-expire | — |

Notes: the decrement is race-safe (guarded `updateMany` + count check, lib/checkin.ts:219-229 and
:297-301). `refunded` is terminal by design — lib/checkin.ts:98-99 states resurrecting to
`active` "would be a billing decision, not an undo". `expired` is also terminal and, per H6,
lazily written. `ClassPackRedemption` carries no state fields; it is deleted wholesale when the
backing attendance is removed (lib/checkin.ts:83-85).

### 1.4 Class / ClassSchedule / ClassInstance

| Field | D | W | R | CK |
|---|---|---|---|---|
| `Class.isActive` | `true` | `false` at app/api/classes/[id]/route.ts:484 (DELETE); settable both ways via PATCH (:23, :395) | 9+ list/generate paths (see H2 list) | none |
| `Class.deletedAt` | null | **never** (H2) | 10 no-op filters | none |
| `ClassSchedule.isActive` | `true` | `false` at app/api/classes/[id]/route.ts:107 (slot removed), `true` at :126 (slot restored) | app/api/classes/route.ts:26, :[id]/route.ts:155/:220/:404, cron :149, generate :45 | none |
| `ClassSchedule.endDate` | null | UNVERIFIED — no writer found; `startDate` defaults to `now()` | not read in any generation path found | — |
| `ClassInstance.isCancelled` | `false` | **never** (H1) | 8 no-op filters + 1 unreachable guard | none |
| `ClassInstance.cancellationReason` | null | **never** | app/dashboard/attendance/page.tsx:36 mentions it in a comment only | — |

`ClassSchedule.isActive` is the one soft-state pair in this cluster with a genuine two-way
transition (deactivate at :107, reactivate at :126, keyed by `slotKey`). The comment at
app/api/classes/[id]/route.ts:99 explains rows are kept rather than deleted.

### 1.5 ClassRoster / ClassSubscription

| Field | D | W | R | CK |
|---|---|---|---|---|
| `ClassRoster` (`addedAt`, `addedByUserId`) | now() / null | create at app/api/classes/[id]/roster/route.ts:61, bulk `createMany` at :[id]/route.ts:358 | `addedByUserId` is never read for behaviour; roster *presence* gates check-in (lib/checkin.ts:160-172) | none |
| `ClassSubscription.notificationsEnabled` | `true` | **never written to `false` anywhere** | **never read for behaviour** — only surfaced in the DSAR export (app/api/admin/dsar/export/route.ts:251) | none |

`ClassSubscription` rows are created at app/api/member/class-subscriptions/[classId]/route.ts:40
and deleted at :69, app/api/classes/[id]/roster/[memberId]/route.ts:34,
app/api/classes/[id]/route.ts:363, app/api/members/[id]/rank/demote/route.ts:127,
lib/member-delete.ts:122, app/api/cron/retention/route.ts:618. The notification fan-out on class
change reads subscribers (app/api/classes/[id]/route.ts:288, :315) **without** filtering
`notificationsEnabled` — so the per-class mute switch exists in the schema and is honoured
nowhere.

### 1.6 MembershipTier

| Field | D | W | R | CK |
|---|---|---|---|---|
| `isActive` | `true` | `false` at app/api/memberships/[id]/route.ts:84 (DELETE = archive); `true`/`false` accepted by PATCH schema (:17) | app/api/memberships/route.ts:32, app/dashboard/memberships/page.tsx:28, app/api/member/family/[id]/billing/route.ts:62, app/api/member/subscriptions/start/route.ts:105, start-for-kid:115 | none |
| `billingCycle` | `monthly` | `monthly\|annual\|none` via zod enum (app/api/memberships/[id]/route.ts:14) | UNVERIFIED — no behavioural branch found, display only | `monthly\|annual\|none` — 20260430000001/migration.sql:38 |
| `isKids` | `false` | create/PATCH | app/api/member/family/[id]/billing/route.ts:62 (`isKids: true`) gates the kid tier list | none |
| `stripePriceId` / `stripeProductId` | null | create/PATCH, nullable to unlink | app/api/member/subscriptions/start/route.ts:105 resolves price → tier server-side | none |

**Archive has no exit in practice.** Both listing surfaces filter `isActive: true`
(app/api/memberships/route.ts:32 and app/dashboard/memberships/page.tsx:28), and there is no
`?includeArchived` parameter, so an archived tier can never be selected in the UI to be
re-activated even though PATCH would accept it. Same shape for `ClassPack.isActive`, except the
staff list at app/api/class-packs/route.ts:24-26 does **not** filter — it only orders by
`isActive: "desc"` — so deactivated packs remain visible and reactivatable there.

**Corrections to the two rows above, after re-checking:**
- `ClassSchedule.endDate` **is** written (app/api/classes/route.ts:85,
  app/api/classes/[id]/route.ts:137) and **is** honoured during generation —
  lib/class-instances.ts:88-96 clamps the window to `startDate`/`endDate`, and both are selected
  by app/api/cron/class-instances/route.ts:150 and app/api/classes/[id]/route.ts:156. Not dead.
- The `classSubscription.findMany` calls at app/api/classes/[id]/route.ts:288 and :315 are **not**
  a notification fan-out; they compute which subscribers would *lose access* after a rank-gate or
  roster change. Those subscriptions are then hard-deleted at :362-366. **No member is notified**
  — the only record is the audit metadata `cascadeCancelledMemberIds`
  (app/api/classes/[id]/route.ts:424). The `notificationsEnabled` finding stands: nothing anywhere
  reads it.

### 1.7 SignedWaiver

| Field | D | W | R | CK |
|---|---|---|---|---|
| `version` | `1` | **never set explicitly** — always the default | app/api/admin/dsar/export/route.ts:233 (export payload only) | none |
| `collectedBy` | null | `"self"` (app/api/waiver/sign/route.ts:108), `"admin_device:{userId}"` (app/api/members/[id]/waiver/sign/route.ts:111 and :137), `"kiosk_waiver_link"` (app/api/waiver/open/route.ts:116), and a **raw parent member cuid** (app/api/waiver/sign-for-child/route.ts:129) | **never read anywhere** | none |
| `titleSnapshot` / `contentSnapshot` | none | snapshot of `Tenant.waiverTitle/waiverContent` (or kids variants) at signing time | the evidence record | length CHECKs: none |
| `memberId` | — | nullable, `ON DELETE SET NULL` (20260816090000_signed_waiver_retention_on_member_delete) | detached rows survive member deletion by design (prisma/schema.prisma:653-660) | — |

There is **no `WaiverTemplate` model** in the schema. Versioning is snapshot-only: each
`SignedWaiver` row copies the tenant's current title/content. `version` is a vestigial counter
that is always `1`, so "which template version did they sign" is answerable only by diffing
`contentSnapshot`. The documented `collectedBy` vocabulary at prisma/schema.prisma:669
(`'self' | 'admin_device:{userId}'`) is wrong — four shapes are written, one of which is an
opaque member id with no prefix, making the column unparseable without knowing all four forms.
DSAR erase rewrites signer fields at app/api/admin/dsar/erase/route.ts:325.

### 1.8 ImportJob

| Field | D | W | R | CK |
|---|---|---|---|---|
| `status` | `pending` | `pending` (app/api/admin/import/upload/route.ts:97; also app/api/onboarding/csv-handoff/route.ts:85), `preview` (app/api/admin/import/[id]/preview/route.ts:59), `running` (app/api/admin/import/[id]/commit/route.ts:34), `complete` (:129), `failed` (:198 and preview:75) | app/api/cron/retention/route.ts:303 (`notIn: IMPORT_JOB_TERMINAL_STATUSES`, i.e. everything but `complete`) | none |
| `source` | none | `'generic' \| 'mindbody' \| 'glofox' \| 'wodify'` per schema comment — UNVERIFIED which are actually written; lib/importers/ exists | UNVERIFIED | none |
| `errorLog` / `dryRunSummary` | null | preview + commit; **scrubbed to SQL NULL after 30 days** (app/api/cron/retention/route.ts:355-366) | UI diagnostics | — |
| counters (`totalRows`…`errorRows`) | 0 | preview :60-62, commit :113-115 (per-slice progress) and :127-135 (final) | progress poller | — |

**`running` has no exit on crash.** It is set at commit start (commit/route.ts:34) and only
replaced by `complete` (:129) or `failed` (:198) if the handler returns. A serverless timeout
mid-import leaves the job `running` indefinitely; the retention rule then deletes it (row + blob)
30 days later because `running` is not in `IMPORT_JOB_TERMINAL_STATUSES`
(app/api/cron/retention/route.ts:100). There is no resume, no retry, and no "stuck job" surface.

### 1.9 MagicLinkToken

| Field | D | W | R | CK |
|---|---|---|---|---|
| `purpose` | `login` | `login` (app/api/magic-link/request/route.ts:78), `first_time_signup` (app/api/members/route.ts:294, bulk-invite:95, app/api/admin/applications/[id]/approve/route.ts:134), `waiver_open` (app/api/members/[id]/waiver-link/route.ts:59, app/api/waiver/kiosk-request/route.ts:87) | app/api/members/accept-invite/route.ts:57 (`!== "first_time_signup"` → reject), app/api/waiver/open/route.ts:32 and :84, app/api/waiver/kiosk-status/route.ts:32 | none |
| `used` + `usedAt` | `false` / null | always written together — request:71, verify:27, accept-invite:87, bulk-invite:88, waiver-link:56, kiosk-request:80, waiver/open:129 | consume guards `used: false` | none |
| `expiresAt` | none | 30 min for login (request:66); other issuers set their own | consume guards `expiresAt: { gt: now }` | — |
| `ipAddress` / `userAgent` | null | request:79-80, accept-invite:87, waiver/open:129 | forensics only | — |

Consume is atomic everywhere it matters: `updateMany({ where: { tokenHash, used: false,
expiresAt: { gt: now } } })` then a `count !== 1` check (app/api/magic-link/verify/route.ts:25-29).
Every issuer first invalidates prior unused tokens for the same (email, tenant, purpose) —
request:69-72, bulk-invite:86-89, waiver-link:54-57, kiosk-request:78-81 — by *marking them used*
rather than deleting, so `usedAt` doubles as "superseded at". `used=true` is terminal; the row is
swept 24h after `expiresAt` by app/api/cron/retention/route.ts:186-193.

### 1.10 PasswordResetToken

| Field | D | W | R | CK |
|---|---|---|---|---|
| `used` | `false` | `true` at app/api/auth/forgot-password/route.ts:81 (invalidate prior) and app/api/auth/reset-password/route.ts:140 | atomic consume guard :141 | none |
| `expiresAt` | none | forgot-password:86 | :64 | — |

**Asymmetry:** unlike `MagicLinkToken`, this model has **no `usedAt`** (prisma/schema.prisma:602-612),
so "when was this reset token consumed / superseded" is unanswerable. Consume is otherwise atomic
(`updateMany … used: false, expiresAt: { gt: now }`, then `count !== 1` →
app/api/auth/reset-password/route.ts:139-149). Retention sweeps 24h past expiry
(app/api/cron/retention/route.ts:194-202). There is **no `PasswordResetCode` model** in the schema
despite the naming in the reset-password error copy ("Code is invalid or has already been used",
app/api/auth/reset-password/route.ts:147).

### 1.11 EmailLog

| Field | D | W | R | CK |
|---|---|---|---|---|
| `status` | `queued` | `queued` / `failed` at creation (lib/email.ts:375 — `failed` when suppressed), `failed` (lib/email.ts:393, :417, :434), `sent` (:425 and webhook :82), `delivered` (webhook :85), `bounced` (:88), `complained` (:99), `delivery_delayed` (:105) | lib/email.ts:360 (suppression), app/api/webhooks/resend/route.ts:135-139 (rank monotonicity) | none |
| `resendId` | null | :425 only, `@unique` | webhook lookup key (:125) | — |
| `sentAt` | null | set only on `sent` (:425); **never set by the webhook** even when it writes `sent`/`delivered` | ordering | — |
| `errorMessage` | null | suppression reason (:376-378), send errors, bounce diagnostics (webhook :91-100) | display | — |
| `recipient` | none | overwritten with a sentinel by DSAR erase (app/api/admin/dsar/erase/route.ts:388-391) | suppression match | — |

Monotonic status ladder: `queued 0 < sent 1 < delivered 2 = delivery_delayed 2 < failed 3 <
bounced 4 < complained 5` (app/api/webhooks/resend/route.ts:30-38). A lower-ranked event is
dropped (:137-139). Consequence: **`failed` outranks `delivered`** — an `email.failed` arriving
after `email.delivered` marks a delivered message failed, and no later `delivered` can undo it.
`bounced` / `complained` are terminal. Retention: 365 days (app/api/cron/retention/route.ts:69,
rule at :176-184).

### 1.12 Announcement

| Field | D | W | R | CK |
|---|---|---|---|---|
| `pinned` | `false` | **create only** (app/api/announcements/route.ts:148) | order-by in all three readers (route.ts:76, lib/member-home.ts:546, app/dashboard/notifications/page.tsx:9); drives the "rich card" treatment at app/member/home/page.tsx:104-139 | none |
| `expiresAt` | null | **create only**, server-computed from `durationDays` (app/api/announcements/route.ts:152-154) | app/api/announcements/route.ts:72-74 — **member role only** | none |
| `title` / `body` | — | create + PATCH (`updateSchema`, app/api/announcements/[id]/route.ts:9-12) | — | body ≤ 2000 via zod; no DB CHECK |

Three defects here:
1. **`expiresAt` cannot be edited or extended.** The PATCH schema accepts only `title` and `body`
   (app/api/announcements/[id]/route.ts:9-12). The schema comment at prisma/schema.prisma:523-526
   promises staff see expired rows "as 'Expired', extendable"; no extend path exists. Once
   expired, the only exits are "stay hidden from members" or DELETE (:87).
2. **`pinned` cannot be toggled after creation** for the same reason.
3. **Expired announcements still leak to members** on the member-home path.
   `lib/member-home.ts:545-549` reads `where: { tenantId }` with no expiry predicate, and it is
   consumed by `GET /api/member/home` (app/api/member/home/route.ts:165) which feeds
   app/member/home/page.tsx:1326. The comment at app/api/announcements/route.ts:66-67 asserts
   "lib/member-home.ts filters its own" — it does not. `@@index([tenantId, expiresAt])`
   (prisma/schema.prisma:533) therefore backs only one of the two member read paths.
4. The staff view never selects `expiresAt` at all (app/dashboard/notifications/page.tsx:13-19),
   so staff cannot even see which notices are expired.

Retention deliberately does **not** prune announcements (no rule in
app/api/cron/retention/route.ts:166-229); they are only removed on tenant hard-delete (:639).

### 1.13 GymApplication

| Field | D | W | R | CK |
|---|---|---|---|---|
| `status` | `new` | `approved` (app/api/admin/applications/[id]/approve/route.ts:144), `rejected` (reject/route.ts:54). `new` only via the default at app/api/apply/route.ts:54 | app/admin/page.tsx:77 (`in ["new","contacted"]`), app/api/admin/applications/route.ts:22 (`in ["new","pending","contacted"]`), approve:74 (`=== "approved"` idempotency), app/admin/applications/ApplicationsClient.tsx:135 (hides actions once approved/rejected) | `new\|contacted\|approved\|rejected` — 20260430000004_gym_applications/migration.sql:25, `NOT VALID` |

- **`contacted` is read in two places but never written anywhere.** Dead value.
- **`pending` is read at app/api/admin/applications/route.ts:22 but is not in the CHECK
  constraint**, so it can never exist — a filter term that matches nothing.
- `approved` and `rejected` are both terminal; there is no reopen route
  (`app/api/admin/applications/[id]` contains only `approve` and `reject`).

### 1.14 Task

| Field | D | W | R | CK |
|---|---|---|---|---|
| `status` | `open` | `done` (app/api/tasks/[id]/complete/route.ts:47; app/api/member/tasks/[id]/complete/route.ts:70) | guarded `status: "open"` in both completers; list filters | `open\|done` — 20260530192937_add_tasks/migration.sql:15 |
| `kind` | `staff_task` | `staff_task` + `member_note` (app/api/tasks/route.ts:155 and :263) | app/api/member/tasks/[id]/complete/route.ts:69, DSAR erase :351, export :420 | `staff_task\|member_note` + XOR/body invariants — 20260601110000/migration.sql:48,52,58,65 |
| `completedAt` | null | with `done` on both paths | display | — |
| `completedById` | null | **member path only** (see H8) | not read for behaviour | — |

`done` is **terminal** — there is no reopen/undo route and no `DELETE` (the whole surface is
`app/api/tasks/route.ts` + `app/api/tasks/[id]/complete/route.ts`). A mis-ticked task cannot be
un-ticked. The only deletion path is DSAR erase for `member_note` rows
(app/api/admin/dsar/erase/route.ts:350-352); `staff_task` rows are never deleted except on tenant
hard-delete via the `Tenant → Task` CASCADE (prisma/schema.prisma:1074).

### 1.15 Order / Product

| Field | D | W | R | CK |
|---|---|---|---|---|
| `Order.status` | `pending` | `pending`, `paid` (see H7) | app/api/orders/[id]/mark-paid/route.ts:44 (already paid → 409), :51 (cancelled → 409), app/api/stripe/webhook/route.ts:527 (the `status: "pending"` predicate is inside the `updateMany` for atomicity) | `pending\|paid\|cancelled` — 20260430000005_orders/migration.sql:32, `NOT VALID` |
| `Order.paymentMethod` | none | `pay_at_desk` (app/api/member/checkout/route.ts:115), `stripe` (:215) | not branched on for behaviour beyond the schema comment "staff user who marked it paid (pay_at_desk only)" | `pay_at_desk\|stripe` — same migration:36 |
| `Order.paidByUserId` | null | app/api/orders/[id]/mark-paid/route.ts (with the paid flip) — UNVERIFIED whether it is set; only `status`/`paidAt` appear at :70 | — | — |
| `Product.inStock` | `true` | create (`.default(true)`, app/api/products/route.ts:15) and PATCH | `@@index([tenantId, inStock, deletedAt])` exists but **no read filters on `inStock`** — app/api/products/route.ts:25, app/api/member/products/route.ts:29 and app/api/member/checkout/route.ts:40 all filter `deletedAt: null` only | none |
| `Product.deletedAt` | null | `new Date()` at app/api/products/[id]/route.ts:73 | 4 filters | none |
| `Product.category` | `other` | zod enum (app/api/products/route.ts:7) | display | 5-value CHECK — 20260430000003/migration.sql:25 |

- `Product.deletedAt` has **no restore path** — every lookup pre-filters `deletedAt: null`
  (app/api/products/[id]/route.ts:43 and :69), so a soft-deleted product is unreachable by id.
- **`inStock` gates nothing.** An out-of-stock product is still listed to members and still
  purchasable through checkout (app/api/member/checkout/route.ts:39-40 validates against
  `deletedAt: null` only). The composite index at prisma/schema.prisma:977 anticipates a filter
  that was never written.

### 1.16 MemberPhoto

| Field | D | W | R | CK |
|---|---|---|---|---|
| `kind` | `evidence` | `evidence` (hardcoded, app/api/members/[id]/photos/route.ts:106), `evidence\|milestone\|promotion` (parent upload, app/api/member/children/[id]/photos/route.ts:27 `ALLOWED_KINDS` → :126), `promotion` (app/api/members/[id]/rank/route.ts:207), `profile` (app/api/members/[id]/profile-picture/route.ts:160) | `kind: "profile"` lookups at app/api/member/me/route.ts:164, app/api/members/route.ts:108, profile-picture:144/:169/:217; `kind: "promotion"` at app/api/members/[id]/rank/route.ts:176 | `evidence\|milestone\|promotion\|profile` — 20260606100000/migration.sql:17 (superseding 20260513000001:40) |
| `memberRankId` | null | app/api/members/[id]/rank/route.ts:208 and :221 (promotion photos) | DSAR export :292; cascade at lib/member-delete.ts:104 | — |

All four `kind` values are genuinely written. Note staff cannot upload `milestone` — the staff
route hardcodes `evidence` (:106) while parents get the three-way choice. `profile` is upsert-like
with a partial unique index (20260606100000) and a race-loser re-read at profile-picture:168-173.

### 1.17 RankSystem / MemberRank / RankHistory / RankRequirement

| Field | D | W | R | CK |
|---|---|---|---|---|
| `RankSystem.deletedAt` | null | `new Date()` at app/api/ranks/[id]/route.ts:107-110, guarded by a dependency check (:95-104 refuses if classes still reference it) | app/api/ranks/route.ts:23, app/api/classes/[id]/route.ts:277, app/api/members/[id]/rank/demote/route.ts:53, lib/promotion-candidates.ts:140 and :210 | none |
| `MemberRank.stripes` | 0 | promotion routes | belt rendering | none |
| `MemberRank.promotedById` | null | promotion route — UNVERIFIED which writer sets it | not branched on | — |
| `RankHistory.*` | — | append-only on promotion/demotion | member timeline (lib/member-home.ts:126-141), `/api/member/me/recent-demotion` | — |
| `RankRequirement.minAttendances` / `minMonths` | 30 / 6 | **no write route exists anywhere** | lib/promotion-candidates.ts:83 and :201 | none |

`RankSystem.deletedAt` has **no restore path** — every read filters `deletedAt: null`, so a
soft-deleted belt is unreachable by id and `@@index([tenantId, deletedAt])` only ever serves the
"is null" side. **`RankRequirement` can never be populated by the application**: there is no
POST/PATCH anywhere (the only non-read reference is the tenant purge at
app/api/cron/retention/route.ts:628) and `prisma/seed.ts` does not create any. The promotion-ready
suggestion therefore always runs on the hardcoded fallbacks that
lib/promotion-candidates.ts:83/:201 read as "overrides".

**Corrections to 1.15 / 1.17:**
- `Order.paidByUserId` **is** written — app/api/orders/[id]/mark-paid/route.ts:71
  (`paidByUserId: userId`, alongside `status: "paid"` and `paidAt`). Not UNVERIFIED.
- `MemberRank.promotedById` **is** written on both the promote path
  (app/api/members/[id]/rank/route.ts:104, :109, :128, :133, :141, :146) and the demote path
  (app/api/members/[id]/rank/demote/route.ts:72, :77, :89), and it **is** read — the promoter's
  name is resolved at app/api/member/me/route.ts:186-189. Not dead.

### 1.18 LoginEvent

| Field | D | W | R | CK |
|---|---|---|---|---|
| `disownedAt` | null | `new Date()` at app/api/auth/disown-login/[token]/route.ts:79; cleared back to `null` at lib/login-event.ts:108 on the next sign-in from that device | replay guard at disown-login:55; "is this a new device" test at lib/login-event.ts:115 (`isNew: existing.disownedAt !== null`) | — |
| `firstSeenAt` / `lastSeenAt` | now() | create :118, refresh :102-108 | new-device notification | — |
| `userId` XOR `memberId` | — | one of the two | — | `(userId IS NOT NULL)::int + (memberId IS NOT NULL)::int = 1` — 20260504000000_login_events/migration.sql:48 (**VALID**, not deferred) |

This is one of the few flags in the schema with a clean bidirectional transition: set on disown,
cleared on the next legitimate login. **No retention rule** covers LoginEvent
(app/api/cron/retention/route.ts:166-229 has no rule) — rows accumulate per device forever and are
removed only on member/user delete (CASCADE) or tenant purge (:637).

### 1.19 StripeEvent / RateLimitHit

| Field | D | W | R | Notes |
|---|---|---|---|---|
| `StripeEvent.eventId` (`@unique`) | — | app/api/stripe/webhook/route.ts:149 | the `@unique` violation *is* the idempotency check (:1045, `P2002` → ack and skip) | 90-day retention (app/api/cron/retention/route.ts:78, rule :212-222) |
| `StripeEvent.type` | — | :149 | lib/stripe/reconcile.ts:105 | — |
| `RateLimitHit.bucket` / `hitAt` | now() | lib/rate-limit.ts:30 | `groupBy` sliding window at :17-22 | pruned three ways |

`RateLimitHit` is pruned by (a) a 5%-probability opportunistic `deleteMany` of rows >1h old
(lib/rate-limit.ts:31-34), (b) an explicit `resetRateLimit(bucket)` (:80-84), and (c) the nightly
retention rule at 1 day (app/api/cron/retention/route.ts:76, rule :203-211). The limiter silently
degrades to a **per-instance in-memory map** on any DB error unless the caller passes
`failClosed` (lib/rate-limit.ts:62-67) — so a DB outage turns a global limit into a per-lambda one,
and `memoryStore` state is invisible to every DB-based read.

### 1.20 Initiative / InitiativeAttachment / MonthlyReport / Drive

| Field | D | W | R | CK |
|---|---|---|---|---|
| `Initiative.type` | none | all six of `marketing\|new_class\|price_change\|holiday\|coach_hired\|other` are permitted by the zod enum at app/api/initiatives/route.ts:8 and [id]/route.ts:8 | lib/ai-causal-report.ts:155-160 (date-window overlap only) | none |
| `Initiative.endDate` | null | create :62, PATCH :38 | lib/ai-causal-report.ts:160, :187-188 | — |
| `MonthlyReport.generationType` | none | `auto` (app/api/cron/monthly-reports/route.ts:73), `on_demand` (app/api/reports/generate/route.ts:55) | part of `@@unique([tenantId, periodStart, generationType])`; a duplicate is swallowed at cron :89 | none |
| `GoogleDriveConnection.scope` | `drive.readonly` | `DRIVE_SCOPE` at lib/google-drive.ts:242 and :249 | app/api/drive/status/route.ts:29 (display) | none |
| `GoogleDriveConnection.expiresAt` / token refresh | — | lib/google-drive.ts:96 (refresh persists new token) | :83 | — |
| `GoogleDriveConnection.lastIndexedAt` | null | lib/google-drive.ts:210-212 | status display :28; **never used to decide whether to re-index** | — |
| `IndexedDriveFile.contentHash` / `modifiedAt` | — | index run | change detection — UNVERIFIED which of the two is authoritative | — |

`Initiative.type` is never branched on — the AI report only formats it into the prompt
(lib/ai-causal-report.ts:271, :287). `lastIndexedAt` is a pure display cache: nothing schedules or
skips indexing based on it, so it can be arbitrarily stale with no consequence.

### 1.21 PushSubscription

| Field | D | W | R | CK |
|---|---|---|---|---|
| `endpoint` (`@unique`) | — | `upsert` at app/api/push/subscribe/route.ts:34 | lib/push.ts:12 (`findMany({ where: { memberId } })`) | — |
| `memberId` / `userId` | null | one of the two | lib/push.ts:12 selects by `memberId` **only** | **no XOR CHECK** (unlike LoginEvent) |

There is **no unsubscribe route** — the only removal paths are a send failure
(lib/push.ts:21, `delete(...).catch(() => {})`), DSAR erase
(app/api/admin/dsar/erase/route.ts:341), FK cascade on member/user delete, and tenant purge
(app/api/cron/retention/route.ts:636). `lib/push.ts` never reads `userId`, so **staff push
subscriptions are written and never delivered to**. `userAgent` is captured and never read. No
retention rule; stale endpoints persist until a send fails.

### 1.22 AttendanceRecord

| Field | D | W | R | CK |
|---|---|---|---|---|
| `checkInMethod` | none (required) | `"admin"` (app/api/checkin/route.ts:26 default + app/api/coach/instances/[id]/attendance/route.ts:51-52), `"self"` (forced server-side, app/api/checkin/route.ts:100 and :113), `"kiosk"` (app/api/kiosk/[token]/checkin/route.ts:77) | lib/checkin.ts:283 (`method === "kiosk"` → opportunistic pack redemption), app/api/checkin/route.ts:117 (`isSelf` → full gates), lib/reports.ts:28 (`checkInMethods` breakdown) | none |
| `checkedInById` | null | app/api/checkin/route.ts via `checkedInByUserId` → lib/checkin.ts:242 and :272 | attribution display | `ON DELETE SET NULL` |

**Documented-but-never-written values:** the schema comment at prisma/schema.prisma:421 lists
`"qr", "admin", "self", "auto", "kiosk"`. **`"qr"` appears nowhere in the codebase.** `"auto"` is
accepted by the zod enum (app/api/checkin/route.ts:26) and passed through on the staff branch
(:78, `effectiveMethod = checkInMethod`) but **no client sends it** — no `checkInMethod: "auto"`
literal exists in app/ or components/. So `auto` is reachable only by a hand-crafted staff API
call, and it silently disables the rank gate, roster gate, time window and coverage requirement
(app/api/checkin/route.ts:116, `const isSelf = effectiveMethod === "self"`). That is a real
privilege surface: any staff role in `["owner","manager","coach","admin"]` (:66) can bypass every
check-in rule by choosing the method.

### 1.23 Operator (residual — role is another lane's)

| Field | D | W | R | CK |
|---|---|---|---|---|
| `sessionVersion` | 0 | `{ increment: 1 }` at app/api/admin/auth/operator-totp/setup/route.ts:101 — **the only increment anywhere** | lib/operator-auth.ts:281-283 (`op.sessionVersion !== verified.sessionVersion` → reject) | none |
| `failedLoginCount` / `lockedUntil` | 0 / null | lib/operator-auth.ts:218-223 (lock resets the counter to 0 — deliberate, per the AH-7 note at :212-217), :235-238, `completeOperatorLogin` :254-259 | :210 | none |
| `lastLoginAt` | null | `completeOperatorLogin` :258 | display only | — |
| `totpEnabled` / `totpSecret` | false / null | operator-totp/setup:52 and :97-103 | login gate | — |

**Operator session revocation has exactly one trigger: enrolling TOTP.** There is no operator
password-change route, no "sign out everywhere", and no `operator.create` in app/ or lib/ —
operators exist only via scripts (scripts/seed-operator-noe.mjs:47 `upsert`,
scripts/reset-totp-noe.mjs:49, scripts/playwright-verify-v1.5-admin.mjs:59). So a leaked operator
cookie is valid until its own expiry with no in-app way to invalidate it.

### 1.24 Tenant — residual state fields (billing/identity belong to other lanes)

| Field | D | W | R | CK |
|---|---|---|---|---|
| `stripeAccountStatus` (JSON cache) | null | lib/stripe-account-status.ts:97-102 (`refreshStripeAccountStatus`) | `canAcceptCharges` :119-123; `ensureCanAcceptCharges` :132-148 | none |
| `stripeConnected` | `false` | `true` at app/api/stripe/connect/callback/route.ts:63; `false` at app/api/stripe/disconnect/route.ts:40 (which also `Prisma.DbNull`s the status cache) | 12 gates | none |
| `subscriptionTier` | `pro` | tenant creation only — app/api/admin/create-tenant/route.ts:76, app/api/admin/applications/[id]/approve/route.ts:102 | **display only** (app/admin/tenants/[id]/page.tsx:99, app/dashboard/settings/page.tsx:114) | none |
| `kioskTokenHash` / `kioskTokenIssuedAt` | null | mint/regenerate app/api/settings/kiosk/route.ts:103, disable :67 | tenant resolution at app/kiosk/[token]/page.tsx:30, app/api/kiosk/[token]/{checkin:60,classes:36,members:47}, app/api/waiver/kiosk-request/route.ts:48 | none |
| `featureFlags` | null | **never** | **never** | none |
| `checkinWindowBeforeMin` / `AfterMin` | 30 / 30 | settings | lib/checkin.ts:180-181 (with a `?? 30` fallback) | `0..180` — 20260513000003/migration.sql:8,10 (**VALID**) |
| `onboardingCompleted` | `false` | onboarding flow | app/admin/tenants/page.tsx:65 (operator visibility) | none |

**`stripeAccountStatus` is the one genuine stale-able cache.** Refresh triggers: the
`account.updated` webhook (app/api/stripe/webhook/route.ts:1094, deliberately deferred outside the
transaction per :192-196 and :1085-1088) and a lazy 24-hour staleness check inside
`ensureCanAcceptCharges` (lib/stripe-account-status.ts:143-146). Two consequences:
- **Not every paid path uses the gate.** `ensureCanAcceptCharges` is called from
  app/api/member/checkout/route.ts:155, app/api/member/class-packs/buy/route.ts:66,
  app/api/member/subscriptions/start/route.ts:74, start-for-kid:78,
  app/api/stripe/create-subscription/route.ts:48. It is **not** called from
  app/api/members/[id]/charge/route.ts (staff ad-hoc charge) nor from
  app/api/class-packs/route.ts:52, which checks only `stripeConnected`. Staff can therefore charge
  a card on an account whose `charges_enabled` is false.
- **Operator surfaces read the cache raw, with no staleness check** —
  app/admin/tenants/page.tsx:53 casts `stripeAccountStatus` and reads `chargesEnabled`, feeding
  the filters at app/admin/tenants/TenantsList.tsx:69-73. A tenant that has not transacted in
  months shows a months-old capability state.
- Fail-open branch: a `StripePermissionError` writes `chargesEnabled: true` with
  `disabledReason: "status_unreadable"` (lib/stripe-account-status.ts:78-85) — a deliberate
  trade-off, documented at :60-67, but it means `chargesEnabled: true` is not always evidence.

`subscriptionTier` is written once at creation, never changed (no upgrade/downgrade route exists),
and **gates nothing** — no code branches on `starter|pro|elite|enterprise`.

### 1.25 Member — residual flags (status/paymentStatus/auth belong to other lanes)

| Field | D | W | R | Verdict |
|---|---|---|---|---|
| `classReminders`, `beltPromotions`, `gymAnnouncements` | `true` | app/api/member/me/route.ts:362-ish PATCH round-trip (:314) | **read back only to render the toggles** (:230-232) — no send path consults them | **Cosmetic. The three RB-005 opt-outs do nothing.** |
| `taskAssignments` | `true` | member profile PATCH | **honoured** — lib/notify-member-action.ts:52 selects it and :89 gates the send | Working |
| `notifyOnNewLogin` | `true` | profile PATCH | **honoured** — lib/login-event.ts:92, with a server-side owner override (`isOwner ? true : …`) | Working |
| `hasKidsHint` | `false` | set `false` at app/api/members/[id]/promote-to-adult/route.ts:54 when the last child leaves; set true/false only by the member's own PATCH (app/api/member/me/route.ts:392) | list/profile rendering | **One-way cache.** Adding a child never sets it `true` (no `hasKidsHint: true` write exists outside selects), so it decrements but never increments — it is a self-declared hint, not a derived count. |
| `lastAnnouncementSeenAt` | null | app/api/member/me/mark-announcements-seen/route.ts:25 | unseen computation at app/api/announcements/route.ts:85 and lib/member-home.ts:557 | Working |
| `preferredPaymentMethod` | `card` | lib/stripe/subscriptions.ts:180 (from the PM type); forced back to `card` on BACS mandate `inactive` (app/api/stripe/webhook/route.ts:606) | display | Working, narrow |
| `cancelledAt` | null | webhook :238 and :696 with the cancelled flip | churn analytics | **No exit** — never cleared if a member is reactivated |

### 1.26 AuditLog — "retention classes"

There is exactly **one** retention class: 365 days, uniformly, for every action
(`AUDIT_LOG_RETENTION_MS = 365 * DAY_MS`, app/api/cron/retention/route.ts:68; rule at :167-175,
predicate `createdAt: { lt: ago(...) }`). No action, entity type or severity is exempt. That means
irreversible financial write-offs (`stripe.dispute.lost`, app/api/stripe/webhook/route.ts:980),
`admin.tenant.hard_deleted` (retention:694) and GDPR fulfilment records age out on the same clock
as `announcement.updated`.

| Field | D | W | R | Notes |
|---|---|---|---|---|
| `action` | none | free-form string; ~40+ distinct values across the codebase (e.g. `announcement.created`, `class.deleted`, `payment.adhoc.charge`, `stripe.dispute.${status}`, `order.mark_paid`, `membership.tier.delete`, `rank.deleted`, `class_pack.deactivate`) | operator + tenant audit views | **no CHECK, no enum, no central registry** — `stripe.dispute.${status}` (webhook:980) interpolates a raw Stripe status, so the action vocabulary is open-ended |
| `tenantId` | — | nullable; **null rows are written via `withRlsBypass`** (lib/audit-log.ts:51-54) and are invisible to every tenant-scoped query by RLS (prisma/schema.prisma:626-631) | operator surfaces only | — |
| `userId` | — | `ON DELETE SET NULL` — attribution is lost when staff are deleted (prisma/schema.prisma:619-625) | — | — |
| `metadata.actingAs` | — | impersonation is folded into `metadata` rather than a column (lib/audit-log.ts:29-35) | any reader must know to look inside the JSON | — |

`logAudit` is **fire-and-forget with swallowed errors** (lib/audit-log.ts:47-59, `void
op.catch(() => {})`). Audit loss is silent by design; the comment at :46-49 states the trade-off
explicitly. This matters for the state map because several state transitions have **no evidence
other than the audit row** — e.g. cascade-cancelled class subscriptions
(app/api/classes/[id]/route.ts:424) and dispute outcomes (webhook:977-990).

---

## 2. DEAD-VALUE AND STALE-CACHE LIST

### 2a. Values documented or accepted but never written

| Model.field | Value | Where it is documented | Evidence it is never written |
|---|---|---|---|
| `ClassInstance.isCancelled` | `true` | prisma/schema.prisma:395, `cancelSchema` at app/api/classes/[id]/instances/route.ts:12 | no `classInstance.update` anywhere (H1) |
| `ClassInstance.cancellationReason` | any | schema:396 | ditto |
| `Class.deletedAt` | any timestamp | schema:365 | DELETE writes `isActive` only (H2) |
| `ClassWaitlist.status` | `waiting`, `promoted`, `expired` | schema:487 | no writer for the model at all (H3) |
| `ClassWaitlist.position`, `expiresAt` | any | schema:484, :486 | ditto |
| `Notification.*` | all | schema:498-513 | no `notification.create` (H4) |
| `PlatformConfig.*` | all | schema:1053-1058 | zero references (H5) |
| `Tenant.featureFlags` | any | schema:61-62 | zero references |
| `GymApplication.status` | `contacted` | CHECK 20260430000004:25; read at app/admin/page.tsx:77 | no writer |
| `GymApplication.status` | `pending` | read at app/api/admin/applications/route.ts:22 | **not even in the CHECK** — unreachable by construction |
| `Order.status` | `cancelled` | CHECK 20260430000005:32; read at mark-paid:51 | no writer (H7) |
| `AttendanceRecord.checkInMethod` | `qr` | schema:421 | zero occurrences of the string in app/ or lib/ |
| `AttendanceRecord.checkInMethod` | `auto` | zod enum app/api/checkin/route.ts:26 | no client sends it; reachable only by hand-crafted API call |
| `SignedWaiver.version` | anything but `1` | schema:666 | never set explicitly by any of the five create sites |
| `Member.accountType` | `junior` | CHECK 20260430000001:13 | UNVERIFIED — not sampled in this lane; flagged for the identity lane |

### 2b. Written but never read (for behaviour)

| Model.field | Written at | Only ever surfaced as |
|---|---|---|
| `ClassSubscription.notificationsEnabled` | default `true`; never set `false` | DSAR export field (app/api/admin/dsar/export/route.ts:251) |
| `SignedWaiver.collectedBy` | 4 distinct shapes (see 1.7) | nothing — zero readers |
| `SignedWaiver.version` | always `1` | DSAR export (:233) |
| `Product.inStock` | create + PATCH | nothing filters on it; the composite index at schema:977 is unused |
| `Member.classReminders` / `beltPromotions` / `gymAnnouncements` | profile PATCH | the toggles themselves — no send path consults them |
| `Tenant.subscriptionTier` | tenant creation | two display strings |
| `Initiative.type` | create/PATCH | prompt text in lib/ai-causal-report.ts:271, :287 |
| `GoogleDriveConnection.lastIndexedAt` | lib/google-drive.ts:212 | status display; never gates a re-index |
| `PushSubscription.userId` | app/api/push/subscribe/route.ts:34 | **never read** — lib/push.ts:12 queries by `memberId` only, so staff push is stored and never sent |
| `PushSubscription.userAgent` | subscribe route | nothing |
| `ClassRoster.addedByUserId` | roster create | nothing branches on it |
| `MonthlyReport.costPence` / `modelUsed` | report generation | UNVERIFIED — no aggregate/budget check found |
| `Task.completedById` (staff path) | never written (H8) | — |
| `EmailLog.sentAt` | only on the client-side `sent` write (lib/email.ts:425) | never set by the Resend webhook even when it writes `sent`/`delivered` |

### 2c. Caches that can go stale — and what refreshes them

| Cache | Refreshed by | Staleness risk |
|---|---|---|
| `Tenant.stripeAccountStatus` | `account.updated` webhook (app/api/stripe/webhook/route.ts:1094) **and** a 24h lazy check inside `ensureCanAcceptCharges` (lib/stripe-account-status.ts:143-146) | Bounded on the five gated checkout paths. **Unbounded** on app/admin/tenants/page.tsx:53, which reads the raw JSON with no refresh; and the staff ad-hoc charge (app/api/members/[id]/charge) never consults it at all. `disabledReason: "status_unreadable"` means `chargesEnabled: true` can be a fail-open placeholder (:78-85). |
| `MemberClassPack.status` | only `GET /api/member/class-packs` (app/api/member/class-packs/route.ts:29) | Unbounded — a pack the member never looks at stays `active` past expiry forever (H6). |
| `Member.hasKidsHint` | decremented at app/api/members/[id]/promote-to-adult/route.ts:54; set manually by the member (app/api/member/me/route.ts:392) | One-way. Never set `true` when a child is created, so it under-reports. |
| `ImportJob.processedRows` etc. | per-slice writes (app/api/admin/import/[id]/commit/route.ts:113-116) | Freezes at the last committed slice if the function times out; the job also stays `running` forever. |
| `Member.lastAnnouncementSeenAt` | app/api/member/me/mark-announcements-seen/route.ts:25 | Correct, but combined with the unfiltered read at lib/member-home.ts:546 an *expired* announcement can still be counted "unseen". |
| `GoogleDriveConnection.lastIndexedAt` | lib/google-drive.ts:212 | Display-only; no behavioural consequence. |
| `Tenant.stripeConnected` | `true` at connect callback:63, `false` at disconnect:40 | Only the platform's own disconnect route clears it. If the gym revokes access from the Stripe dashboard, nothing flips this — the `account.updated` handler refreshes `stripeAccountStatus` but never touches `stripeConnected` (app/api/stripe/webhook/route.ts:1094). UNVERIFIED whether Stripe emits a deauthorise event that is handled: `account.application.deauthorized` is **not** in `HANDLED_EVENT_TYPES` (:46-63). |
| `RateLimitHit` in-memory fallback | nothing — per-lambda `Map` (lib/rate-limit.ts:3) | On a DB error the limiter silently becomes per-instance and its state is invisible to `resetRateLimit`'s DB delete (:82). |

---

## 3. STATES WITH NO EXIT

Ordered by consequence. "No exit" = once entered, no code path in app/, lib/ or scripts/ can
return the row to its prior state.

| # | State | Entered at | Why there is no exit | Consequence |
|---|---|---|---|---|
| 1 | `Payment.status = "pending"` after an ad-hoc charge with unknown outcome | app/api/members/[id]/charge/route.ts:200-201 | The only clearing event is `payment_intent.succeeded` **with no `invoice`** (webhook :742-761). `payment_intent.payment_failed` is not in `HANDLED_EVENT_TYPES` (:46-63), and an invoice-backed PI skips the upsert. | Ledger row stuck `pending`; the dashboard's Pending tab (components/dashboard/PaymentsTable.tsx:62) grows monotonically. |
| 2 | `Payment.status = "disputed"` + `Member.paymentStatus = "overdue"` after an unmapped dispute close | webhook :949-953, :962-969 | The normaliser returns unknown Stripe statuses verbatim (:846) and the else-branch re-asserts `disputed`. `warning_closed` never maps to `won`. | Member is permanently "overdue"; revenue is permanently contested in the ledger. |
| 3 | `Order.status = "pending"` for a `pay_at_desk` order | app/api/member/checkout/route.ts:114 | No UI lists orders, no route calls `mark-paid`, and `cancelled` is never written (H7). | Every desk order is a permanent orphan. Staff have no idea it exists. |
| 4 | `Task.status = "done"` | app/api/tasks/[id]/complete/route.ts:47 | No reopen route, no PATCH, no DELETE on `app/api/tasks/[id]`. | A mis-ticked task is permanent. |
| 5 | `Announcement` past `expiresAt` | app/api/announcements/route.ts:152 | PATCH accepts only `title` + `body` (app/api/announcements/[id]/route.ts:9-12); the promised "extend" action (schema:523-526) does not exist. | Hidden from members forever; only DELETE removes it. And per H12/1.12 it is not actually hidden on the member-home path. |
| 6 | `Announcement.pinned` | create only (:148) | Not in the PATCH schema. | Cannot unpin; the only fix is delete-and-repost, which resets `createdAt` and re-marks it unseen for everyone. |
| 7 | `MembershipTier.isActive = false` | app/api/memberships/[id]/route.ts:84 | PATCH would accept `true`, but both list endpoints filter `isActive: true` (memberships/route.ts:32, app/dashboard/memberships/page.tsx:28) so the archived tier is unreachable in the UI. | Archive is effectively permanent. (`ClassPack` avoids this — its staff list does not filter, app/api/class-packs/route.ts:24-26.) |
| 8 | `Product.deletedAt` set | app/api/products/[id]/route.ts:73 | Both `findFirst` guards pre-filter `deletedAt: null` (:43, :69), so no route can address the row. | Soft delete is a hard delete with extra storage. |
| 9 | `RankSystem.deletedAt` set | app/api/ranks/[id]/route.ts:107-110 | No `deletedAt: null` write for `rankSystem` anywhere. | Same as above. Existing `MemberRank` rows keep pointing at an invisible belt; lib/promotion-candidates.ts:140 and :210 skip them, so those members silently drop out of promotion suggestions. |
| 10 | `MemberClassPack.status = "refunded"` | refund route :320, webhook :653/:723/:941 | Deliberate — lib/checkin.ts:98-99 documents that resurrecting to `active` "would be a billing decision, not an undo". | Correct by design; listed for completeness. |
| 11 | `MemberClassPack.status = "expired"` | app/api/member/class-packs/route.ts:31 | No reactivation. Also no *entry* unless the member visits the page (H6). | Correct by design, unreliable in timing. |
| 12 | `ImportJob.status = "running"` after a timeout | app/api/admin/import/[id]/commit/route.ts:34 | No resume, no watchdog, no stuck-job UI. | Row + CSV blob linger for 30 days, then the retention rule deletes both (app/api/cron/retention/route.ts:298-334). |
| 13 | `GymApplication.status` `approved` / `rejected` | approve:144, reject:54 | No reopen route. | A mis-clicked reject cannot be undone; the applicant must re-apply. |
| 14 | `EmailLog.status` `bounced` / `complained` | webhook :88, :99 | Rank monotonicity (:135-139) forbids downgrade, and there is no clear-suppression route. | 30-day send block per address, clearable only by hand in the DB (lib/email.ts:353) — or accidentally by DSAR erase (H10). |
| 15 | `Member.cancelledAt` | webhook :238, :696 | Never nulled, even when a member is reactivated. | Churn analytics can double-count a returning member. |
| 16 | `MagicLinkToken.used = true` | 7 sites (see 1.9) | Terminal by design; row swept 24h past expiry. | Correct. |
| 17 | Operator session (no revocation) | — | `sessionVersion` increments only on TOTP enrol (app/api/admin/auth/operator-totp/setup/route.ts:101). | A leaked operator cookie cannot be invalidated from inside the app. |

---

## 4. APPENDIX — coverage, method, and what is still UNVERIFIED

### 4a. Models with no state-bearing fields (checked, nothing to report)

`PushSubscription` (covered in 1.21 for its missing XOR), `MemberPhoto` (1.16),
`RankHistory` (append-only), `PasswordHistory` (append-only, CASCADE on user delete —
prisma/schema.prisma:541-544), `InitiativeAttachment` (CASCADE from Initiative),
`IndexedDriveFile` (`@@unique([tenantId, driveFileId])`, content-hash change detection),
`ClassPackRedemption` (join row only), `MonthlyReport` (append-only, unique per
tenant+period+generationType), `RateLimitHit` (1.19), `StripeEvent` (1.19).

### 4b. CHECK-constraint inventory relevant to this lane

All added `NOT VALID` unless noted, i.e. pre-existing drifted rows are grandfathered
(prisma/migrations/20260430000001_schema_check_constraints/migration.sql:3-5 explains the pattern):

- `Payment.status` — 20260430000001:33
- `Payment.amountPence >= 0` + refund invariant — 20260818200000:30, :33
- `MembershipTier.billingCycle` — 20260430000001:38
- `Product.category`, `Product.pricePence >= 0` — 20260430000003:25, :29
- `GymApplication.status` — 20260430000004:25
- `Order.status`, `Order.paymentMethod`, `Order.totalPence >= 0` — 20260430000005:32, :36, :40
- `MemberPhoto.kind` — 20260513000001:40, replaced by 20260606100000:17 (drop-then-add, **VALID**)
- `Task.status` — 20260530192937:15 (**VALID**, inline in CREATE TABLE)
- `Task.kind` + assignee XOR + body-required + staff-assignee-required — 20260601110000:48, :52, :58, :65 (**VALID**)
- `LoginEvent` userId/memberId XOR — 20260504000000:48 (**VALID**)
- `Tenant.checkinWindow*` 0-180 — 20260513000003:8, :10 (**VALID**)
- `*.notes` length caps — 20260601100000:21, :25, :29

**Models with an enum-like string column and NO CHECK at all:** `EmailLog.status`,
`Dispute.status`, `ImportJob.status`, `ImportJob.source`, `ClassWaitlist.status`,
`MemberClassPack.status`, `MagicLinkToken.purpose`, `SignedWaiver.collectedBy`,
`AttendanceRecord.checkInMethod`, `Notification.type`/`channel`, `Initiative.type`,
`MonthlyReport.generationType`, `AuditLog.action`/`entityType`, `Tenant.subscriptionTier`,
`Member.preferredPaymentMethod`, `RankSystem.discipline`. `EmailLog` and `Dispute` are the two
where an out-of-vocabulary value provably reaches the column today (H9, H11).

### 4c. Method

Sweep was grep/read only over `prisma/schema.prisma`, `prisma/migrations/**/*.sql`, `app/`,
`lib/`, `scripts/`, `components/`, `vercel.json`, `package.json`. For each state field the pattern
was: (1) find every `<model>.create|update|updateMany|upsert|deleteMany`, (2) grep the literal
values, (3) grep the readers that put the field in a `where` or a conditional, (4) cross-check the
migration CHECK. Claims of "never written" were verified by an exhaustive delegate-method grep
across all four source roots, not by absence from a sample.

### 4d. Still UNVERIFIED

- `ImportJob.source` — which of `generic|mindbody|glofox|wodify` the upload route actually writes
  (lib/importers/ not read in this lane).
- `Member.accountType = "junior"` — in the CHECK (20260430000001:13) but not sampled here; belongs
  to the identity lane.
- `MonthlyReport.costPence` / `modelUsed` — whether any budget or model-selection logic reads them.
- `IndexedDriveFile.contentHash` vs `modifiedAt` — which is authoritative for change detection.
- Whether Stripe emits `account.application.deauthorized` in this integration, and therefore
  whether `Tenant.stripeConnected` can go stale in practice (the event is not handled either way —
  app/api/stripe/webhook/route.ts:46-63).
- Which exact Stripe dispute statuses reach production (H11 is proven from the map, not from logs).
- `ClassSchedule` rows whose `endDate` is in the past: no cleanup exists, but generation clamps
  correctly (lib/class-instances.ts:88-96), so this is cosmetic — not confirmed against data.

*End of Lane E.*
