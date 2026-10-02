# MatFlow — Product, Technical, Operational & Acceptance Specification

**Version:** 2026-10 draft 1 · **Candidate basis:** `b2af378` (main, local; 127 commits ahead of `origin/main`; production runs an older build). **Written for:** implementers building/validating MatFlow and the product owner deciding the open items. Derived from the discovery handoff (`docs/readiness/SPEC-DISCOVERY-HANDOFF-2026-10.md`) and the readiness evidence under `docs/readiness/`.

**Reading conventions.**
- **SHALL** = a required behaviour that the system already implements and that is intended; a regression is a defect.
- **SHOULD** = recommended; a deviation needs a reason.
- **PHASE A / B / C** tags scope (A = first release "the bridge"; B = billing cutover; C = platform scale).
- **[OPEN]** = an owner decision this spec cannot settle; the recommendation is given but is not yet ratified.
- **[PROVISIONAL]** = behaviour that exists but is not verified in production (real money, email delivery, restore, capacity, runtime DB role).
- Status labels from discovery (**implemented / verified / blocked / unknown**) are carried where they matter.

---

## 1. Purpose, scope and phases

### 1.1 Purpose
MatFlow is a multi-tenant SaaS for martial-arts / BJJ gyms. One **tenant = one club = one billing and data boundary**. A club manages members, families and kids, membership tiers, a class timetable (recurring schedules → dated instances), check-in across multiple doors, attendance and belt ranks, waivers, payments (cash at the desk + card via Stripe Connect), reports, and a member/parent portal. A separate platform **operator plane** approves clubs and administers accounts.

**Problems it solves:** replace a spreadsheet/kiosk-less front desk with a tenant-isolated system that (a) records attendance truthfully from several doors, (b) tracks who owes money without lying, (c) migrates a club off a previous platform (TeamUp) without members re-signing, and (d) keeps liability waivers as durable evidence.

### 1.2 Phases (the spec is written in three explicitly separated phases)
- **PHASE A — First production release ("the bridge").** One club (Total BJJ) runs its **day** in MatFlow — roster, classes, check-in, attendance, waivers, holds, cash at the desk — while **TeamUp and the club's own Stripe keep collecting every existing recurring membership**. MatFlow SHALL NOT start, change or stop that collection. Billing standing reaches MatFlow only through a manual, previewed **status refresh** import. *This is the primary in-scope release.*
- **PHASE B — Billing cutover.** Move cohorts onto MatFlow-owned Stripe subscriptions (migration engine exists; cutover rehearsals NOT RUN). Gated on Phase A live + the club's Stripe sign-in.
- **PHASE C — Platform scale.** Multi-club switching, Location/Group/verified-Person identity (designed, ADR-001, **not built**), per-club sender domains, self-serve signup, discount codes, desk point-of-sale. Roadmap.

### 1.3 A successful working day, per role (Phase A)
- **Owner/manager (desk):** add/search/edit members and families; assign tiers; take cash; put members on hold and resume them; run the register; correct mistakes; see who owes money; run and export reports; run the weekly TeamUp refresh (operator).
- **Coach:** open any class register in the club; mark attendance; scan printed cards; see who is booked vs who walked in; see hold/billing-staleness flags (never blocked by staleness).
- **Member/parent:** sign a waiver (self and for a child); see the schedule and own classes; check in (self/kiosk/QR) when eligible; see own payments; manage children.
- **Operator:** approve/reject applications; create/suspend/soft-delete clubs; reset passwords/2FA; transfer ownership; impersonate (audited); DSAR export/erase.

### 1.4 Explicit exclusions / deferrals (Phase A)
Automatic member money-reminder emails; member self-cancel (OFF for Total BJJ); multi-club switching; per-club sender domains; SMS; discount codes; desk POS basket; location-specific merchants; a custom-role builder. These are PHASE B/C or out of scope.

### 1.5 Business success criteria
**[OPEN]** No formal KPI document exists. The working definition is "one real club runs a full day unaided and nothing lies, loses, charges or messages wrongly." A measurable pilot metric (e.g. days-live, unaided-task completion rate, zero reconciliation discrepancies over N weeks) is an owner decision (§11).

---

## 2. Users, roles and account states

### 2.1 Staff (`User`, per club)
Roles `owner | manager | coach | admin` (DB CHECK). SHALL be unique per club (`@@unique([tenantId,email])`); the same person at two clubs is two unrelated rows (no cross-club link in Phase A). State: optional TOTP 2FA; `mustChangePassword` (forces `/set-password` after an operator reset); failed-login lockout; `sessionVersion` (a bump invalidates all sessions). **[OPEN/PHASE C]** verified cross-club `Person` identity (ADR-001 D4).

### 2.2 Members & parents (`Member`, per club)
`accountType` `adult | junior | kids | parent`. Unique per club. **Kids SHALL be passwordless and SHALL carry a synthesised, non-contactable email** (`@no-login.matflow.local`) so they can never sign in or be emailed; a parent manages them via `parentMemberId`. A member carries, simultaneously and independently, four orthogonal axes (§4.1): lifecycle status, billing state, derived "owes money", and payment history.

### 2.3 Operators (`Operator`, platform)
Platform super-admins; no `tenantId`. **Phase A ships a single shared-secret cookie** (`MATFLOW_ADMIN_SECRET`); the per-operator table + login + TOTP exist (v1.5) but the UI is deferred. **[OPEN]** whether per-operator operator identity is required before go-live.

### 2.4 Public / token principals
Anonymous at public doors (apply, login, public club page `/[slug]`, leaderboard `/leaderboard/[token]`, kiosk). Token principals: kiosk token, leaderboard/display token, magic link, invite token. Provider principal: the Stripe webhook (signature).

---

## 3. Permissions specification

### 3.1 Enforcement layers (authority order)
1. **Page gates** (`lib/authz.ts`, redirect) for server components.
2. **Route gates** (`lib/api-authz.ts`, JSON 401/403): `requireApiStaff`, `requireApiOwnerOrManager`, `requireApiOwner`; member-session checks; token doors; operator context; cron bearer; webhook signature.
3. **Application-layer tenant filter** — every tenant query SHALL include `where:{tenantId}` and run inside `withTenantContext`. **This is the primary isolation control.**
4. **Row-level security** — `ENABLE + FORCE` on 41/47 tables; no tenant set ⇒ zero rows. RLS is a **backstop**; in production it only bites if the runtime role is non-BYPASSRLS, which today it is not (**[OPEN/PHASE B+]** ADR-001 D8).

Authorisation is server-side: a hidden UI control is **not** a control. Every state-mutating route SHALL call `assertSameOrigin` (CSRF) first.

### 3.2 Permissions matrix (authoritative generated source: `docs/readiness/PERMISSION-MATRIX.md`, regenerate at the frozen SHA)
Representative, normative rules (not exhaustive):

| Capability | owner | manager | coach | admin | member/parent | enforced at |
|---|---|---|---|---|---|---|
| View members list (PII) | ✓ | ✓ | ✓ | ✓ | ✗ (own/family only) | route (staff) + tenant filter |
| Create member (adult) | ✓ | ✓ | ✓ | ✓ | ✗ | route (staff) |
| Create **kid** | ✓ | ✓ | ✗ | ✗ | parent (own) | route |
| Edit member | ✓ | ✓ | ✓ | ✓ | own via portal | route + `updateMany{id,tenantId}` |
| **Delete member** (hard, gated) | ✓ | ✗ | ✗ | ✗ | ✗ | route (owner) |
| Memberships (tiers) create/list | ✓ | ✓(list/create) | ✗ | ✗ | ✗ | route |
| Memberships edit/delete | ✓ | ✗ | ✗ | ✗ | ✗ | route (owner) |
| Hold / resume | ✓ | ✓ | ✗ | ✗ | ✗ | route (owner+manager) |
| Classes/instances/roster CRUD | ✓ | ✓ | (read/mark) | (read/mark) | read schedule | route |
| Check-in (desk/card) | ✓ | ✓ | ✓ | ✓ | self/kiosk/QR | `lib/checkin.ts` gate matrix |
| Record cash payment | ✓ | ✓ | ✗ | ✗ | ✗ | route + requestId |
| Refund | ✓ | ✗ | ✗ | ✗ | ✗ | route (owner) |
| Reports (view) | ✓ | ✓ | ✗ | ✗ | ✗ | route |
| **Payments CSV export** | ✓ | ✓ | ✗ | ✗ | ✗ | route + rate-limit (**see §3.3**) |
| Import / refresh / rollback | ✓ | ✗ | ✗ | ✗ | ✗ | route (owner) |
| Staff admin / role change | ✓ | ✗ | ✗ | ✗ | ✗ | route (owner) |
| Club settings | ✓ | ✗ | ✗ | ✗ | ✗ | route (owner) |
| Emergency/medical notes | ✓ | ✓ | redacted on register | ✓ | own/child | route + `showMedical` redaction |
| Cross-club access | — none in Phase A; operator plane only, audited — | | | | | tenant filter + RLS |

### 3.3 Manager payment-CSV export (specific requirement)
- `GET /api/payments/export.csv` SHALL require owner **or** manager and SHALL be rate-limited (10/hour/tenant). Coach and admin SHALL be refused (verified).
- Exported fields: paid-on, **member name, member email**, amount (pence), currency, status, description, Stripe invoice id, Stripe PI id, refunded-at, refunded amount, recorded-at; all cells formula-injection-guarded (`lib/csv.ts`). Scope: all club payments, cap 5,000 rows.
- **Defect to fix:** the export currently writes **no `AuditLog` row**. **The system SHALL audit every bulk PII export** (actor, timestamp, row count) regardless of role. This is a required change, not optional.
- **[OPEN] owner decision:** keep owner+manager (recommended, *with* the audit row and optional field minimisation / reason prompt) **or** restrict to owner. Discovery found **no documented business need** beyond parity with Reports; "visible on screen" does not by itself justify a bulk offline export.

---

## 4. Domain model & glossary (normative semantics)

### 4.1 The four status axes (SHALL remain distinct)
A member carries all four at once; the spec, UI and reports SHALL NOT conflate them.
1. **Lifecycle / entitlement — `Member.status`:** `active | inactive | cancelled | taster`. `taster` = trial (funnel start); `cancelled` sets `cancelledAt` (the churn key — analytics SHALL filter on `cancelledAt`, not `updatedAt`). Transitions SHALL go through the single writer `lib/member-status.ts` → `MemberStatusEvent` (reasons `staff_edit|stripe_webhook|import|self_signup`; `import`-reason events SHALL be excluded from conversion maths).
2. **Billing state — `Member.paymentStatus` (stored):** `paid | overdue | paused | free | pending | cancelled`. **`pending` SHALL render as "No payment yet."** `free` = zero-price tier. A desk-created member SHALL start `free` (zero-price) or `pending` (priced), never silently `paid`.
3. **Derived "owes money" — `lib/overdue.ts`:** stored `overdue` is written at only two lines (both in the Stripe webhook), so cash clubs would never show it; therefore overdue SHALL be **derived**: `owesMoneyClause = overdueClause ∪ noPaymentYetWhere`, where a member with a Stripe subscription is excluded from due-date derivation (their schedule is Stripe's). Dashboard, the Outstanding tab, Reports and every list/profile SHALL use the **same** definition and `shownPaymentStatus(member, now)` (never the raw stored value), so no two screens disagree about who owes.
4. **Payment history — `Payment.status`:** `succeeded | failed | refunded | disputed | pending`; `paidAt` (money moved, back-dateable) ≠ `createdAt` (recorded).

Related: **hold** = `paused` + optional `holdUntil` (an expired `holdUntil` is *not* on hold; resume SHALL restore `holdPriorStatus`). **`nextDueAt`** advances by the tier `billingCycle` (`weekly|fortnightly|four_weekly|monthly|annual|none`) from the **due date** (late payment keeps the billing day), month-end clamped both ways in UTC. **`billedBy=teamup`** = TeamUp owns collection (excluded from chase; 8-day staleness warning that SHALL NOT refuse a check-in). **Review-lock** = tenant-level `423 review_locked` on anything that bills/invites/destroys. **`isKids`** (Class/Tier) ⇒ adults refused with one sentence.

### 4.2 Entity inventory (key fields, ownership, deletion)
Full field-level detail is in the discovery handoff §5.1. Normative points:
- **Tenant** owns the boundary: `slug @unique`, `stripeAccountId @unique` (one connected account per club — the webhook-routing invariant), `kioskTokenHash`/`displayTokenHash` (hashed, raw shown once), `timezone`/`currency`/`country` CHECKs, review-lock fields, `deletedAt` (soft-delete, 30-day grace).
- **Member** uniqueness: `[tenantId,email]`, `[tenantId,externalRef]` (import identity), `[tenantId,createRequestId]` (desk idempotency). Kids require a top-level parent (DB CHECK). Attribution FKs carry an XOR CHECK (credited to a user **or** a member, not both).
- **SignedWaiver** SHALL outlive its member (`onDelete SetNull`) and SHALL store `titleSnapshot`/`contentSnapshot` (what was shown at signing) — liability evidence, ~6-year retention.
- **ClassInstance** SHALL be unique on `[classId,date,startTime]` (the idempotency key making instance generation and check-in safe under concurrency).
- **Payment**/**MemberClassPack** dedupe on Stripe ids (`@unique`) and, for manual payments, `[tenantId,requestId]`.
- **AuditLog** `tenantId` is nullable with no FK so audit survives tenant hard-delete.
- **Tenant ownership:** 34/46 models carry `tenantId`; the rest are parent-scoped or deliberately global (`StripeEvent`, `Operator`, `PlatformConfig`, `GymApplication`, schedules/instances). onDelete into Tenant is mostly RESTRICT (retention ordering); Cascade/SetNull chosen per model so history survives.
- **Authoritative source per field:** contact/emergency/medical/DOB/photo/waiver = MatFlow (staff or member). Billing standing/plan/cancellation = **TeamUp** during Phase A (via refresh). Card collection = TeamUp/Stripe. Cash = MatFlow. Attendance from the switch date = MatFlow.

---

## 5. Workflow specification

Each workflow states the required behaviour; verification references are in §9. (Detailed step traces: handoff §4.)

### 5.1 Club setup & staff onboarding
Apply (public, rate-limited) → `GymApplication`. Operator approves → creates Tenant + owner User + a 30-min `first_time_signup` magic link; emails owner activation (email failure SHALL NOT roll back the DB). Owner activates → onboarding wizard → sets own password. Add staff (owner-only): a random password is generated and **never emailed**; the user receives `mustChangePassword=true` + an accept-invite link. Duplicate email → 409. **Tenant boundary:** tenant creation is cross-tenant (`withRlsBypass`); everything after is tenant-scoped. **[unknown]** onboarding-wizard step contents (spec author to confirm the required setup steps).

### 5.2 Members: create / search / edit / archive; families
Create (staff; rate 30/hr): kids owner/manager-only, require a top-level in-tenant parent, enforce `MAX_KIDS_PER_PARENT`; kid email always synthesised; tier resolved in-tenant; initial `paymentStatus` per §4.1(2); future DOB rejected; **`createRequestId` SHALL dedupe a lost-response retry**. Search/list: staff-only (PII), server-side search, `?filter=kids`. Edit: `updateMany{id,tenantId}` (no cross-club repoint); status→cancelled sets `cancelledAt`. **Archive = hard DELETE (owner-only)** with the F5 gateway: `?probe=1` returns linked kids (409) → UI shows a 3-option picker; actual delete needs `?confirm=1` or `?strategy=reassign|cascade|orphan`. **Recovery:** no undo for a hard delete — the gateway is the safeguard; waivers survive (SetNull).

### 5.3 Membership: assign / hold / resume / cancel / reactivate
Assign at create/PATCH (tier id + legacy label kept in sync). **Hold** (owner+manager): `paused` + `holdUntil` (≥1 day, ≤365; else "cancel instead"); Stripe `pause_collection{void}`; **compare-and-set** → 409 on a double-click; stores `holdPriorStatus`. **Resume:** restores the exact prior status (never blindly "paid"); clears Stripe pause first; 502 "nothing was changed" on a Stripe error; cash member's `nextDueAt` unchanged so the next payment is honestly owed. Cancel = PATCH→`cancelled`; reactivate = status edit back. Member self-cancel exists but SHALL be OFF in Phase A.

### 5.4 Classes, capacity, attendance, check-in (the check-in engine is the heart of Phase A)
One engine `lib/checkin.ts performCheckin` SHALL serve every door with a per-method gate matrix: **admin / card(qr) / auto bypass gates (staff/system override); self & kiosk enforce all** (rank, roster-if-any, time window, venue, kids, hold, waiver, capacity). Gate order is fixed; **every refusal SHALL carry a machine `reason` + one human sentence** (`lib/checkin-refusal.ts`) so all doors answer identically (no door may treat a 409 refusal as success). **Capacity** SHALL be enforced with `SELECT … FOR UPDATE` + count inside the insert transaction (no last-seat race). **Duplicate** attendance SHALL be idempotent (unique constraint → `duplicate`). Staff overrides (hold/unsigned/kids) SHALL be explicit (`acknowledged[]`) and audited, and SHALL NOT change the rule. Doors: desk register (server computes `effectiveMethod`; a member SHALL NOT self-promote to admin), parent→kid, kiosk (token door; paused-club 403 before token verify), card scan (5-yr signed card; admin gate profile; one token/request). Instances SHALL be generated on a 56-day rolling horizon per club timezone, idempotent via the unique slot.

### 5.5 Front-desk daily operations (cash)
Record manual payment (owner+manager, rate 60/5min): methods `cash|exempt|external|comp|other`; **£10,000 cap**; **`requestId` REQUIRED**; advances `nextDueAt`; flips to `paid`; a duplicate `requestId` SHALL return the existing row with 200 (no double-charge), while a fresh id allows a second genuine payment.

### 5.6 Payments visibility, reporting, export
One overdue/owes definition shared across dashboard, Outstanding and Reports (§4.1(3)). Reports (owner+manager): weeks 4–24, class + adult/kids filters, 3 attendance-rate modes (divide-by-zero → null). CSV export per §3.3 (with the required audit-row fix).

### 5.7 TeamUp import / refresh / exceptions / rollback (Phase A, synthetic until authorised)
Pipeline upload → preview → commit → (rollback); owner-only; 10 MB; private Blob; `fileHash` refuses a duplicate upload; refresh requires `sourceExportedAt`. **Create** folds a "Memberships" export (one row per membership-ever-held) into people (grouped by email+name only — surname/phone/address are NOT identity); kids never keep their row email; a parent is the email-sharing adult or a synthesised unverified draft; the estimated next-payment date SHALL be written to notes only, **never** to `nextDueAt`; imported members are `billedBy="teamup"`. **Refresh** SHALL change only `status, paymentStatus, cancelledAt, membershipType, membershipTierId` (+ provenance) and SHALL preserve all MatFlow-edited fields; matching is by the stored first-import key; a changed name/email → exception (never guessed); a MatFlow hold SHALL NOT be lifted by a refresh. **Rollback** SHALL remove only rows the job created that nobody has touched since (keeping edited/paid/login/waiver rows with a reason), and refresh-rollback restores prior standing only where the member still carries exactly what the refresh wrote. **Atomicity requirement:** commit runs 25-row slices in separate transactions; **the known durability weakness (an `ok` shape can follow a partially-failed slice) SHALL be hardened or explicitly documented before real-data import** (`CONNECTION-REGISTER.md`).

### 5.8 Staff handover & mistake correction
Operator: ownership transfer, force-password/TOTP reset, member/staff unlock, suspend/soft-delete, DSAR export/erase. Corrections flow via PATCH (status events) under a full audit trail.

### 5.9 Cross-cutting rules
Timezones: all billing arithmetic UTC; `nextDueAt` is a zone-less UTC wall clock; display dates `en-GB`/UTC. Concurrency: `updateMany{id,tenantId}`, compare-and-set holds, `FOR UPDATE` capacity, unique `requestId`/attendance. Historical records: `MemberStatusEvent` (survives the 365-day audit purge), TeamUp history kept, current membership derived. Stale source data: `billingStatusAsOf` + 8-day warning, never a refusal.

---

## 6. Integration contracts

### 6.1 TeamUp (CSV; the Phase A operating contract — `TEAMUP-OPERATIONS-CONTRACT.md`, **[OPEN]** sign-off by owner + Sean)
Field ownership table, weekly refresh (named operator, Monday + after any bulk TeamUp change), 8-day staleness, cash-only for new money, and the attendance **switch date** are the contract. MatFlow SHALL NOT start/change/stop TeamUp collection. The card-subscription paths for a `teamup`-billed member SHALL refuse with `409 billed_elsewhere` before any provider call.

### 6.2 Stripe (Standard Connect; API `2026-03-25.dahlia`)
Gym is merchant of record. Webhook SHALL: verify the signature (400 on bad/missing); resolve the tenant from `event.account` and **return 409 (retry) for an unlinked/missing account** (never ack-and-drop); make `StripeEvent.create` the first statement of the one processing transaction (crash ⇒ clean redelivery); claim only handled event types. ~20 events handled with specific rules (£0 first invoice confirms paid without a Payment row; refunds apportion pack credits; `deauthorized` stamps the cached status disabled, not cleared). Emails/audit fire after commit, fire-and-forget. Migration engine: ADOPT / REPLACE(default) / CREATE / SKIP(reason), crash-safe via `metadata.matflowMemberId`. **[PROVISIONAL]** real production card money, webhook replay/out-of-order, and cross-guardian subscribe are not verified (no connected account in test); the replace path is proven in test mode only.

### 6.3 Email (Resend) — **[PROVISIONAL] delivery blocked**
`lib/email.ts`, 23 HTML-escaped templates; `EmailLog` state machine `queued → sent|failed`; mail-dark when `RESEND_API_KEY` unset; bounce-aware (30-day). `delivered/bounced/complained` statuses exist in schema but are **[unknown]** whether a Resend status webhook writes them. Production delivery SHALL require `RESEND_FROM` + SPF/DKIM/DMARC (owner action) and is a PHASE A tail / early-PHASE-B item; no member is messaged before the club signs off imported data.

### 6.4 Other
Vercel **Blob** (private; CSVs/photos/waiver signatures). **Google Drive** (owner-only; tokens AES-256-GCM, `lib/encryption.ts`, now pinning `authTagLength`). **Push** — scaffolded, **NOT live**; the spec SHALL NOT describe push delivery as working. Crons (bearer `CRON_SECRET`): retention (daily; reconcile first; GDPR purge; tenant hard-delete fail-closed on live billing; `?dryRun=1` SHALL be read by a human before the first real run), monthly-reports (needs `ANTHROPIC_API_KEY`), class-instances (56-day horizon), stripe-reconcile.

---

## 7. Architecture & operational model

### 7.1 System
One Next.js 16 app (App Router; member portal `app/member/**`, dashboard `app/dashboard/**`, operator `app/admin/**`, public pages). Prisma 7 + `@prisma/adapter-pg` over Neon Postgres (production SHALL use the pooled host). NextAuth v5 (credentials + club slug; TOTP; magic links). Vercel hosting; push to `main` auto-deploys; `maybe-migrate` runs before build.

### 7.2 Trust boundaries & isolation
browser → route gate → `assertSameOrigin` → `withTenantContext` (tenant GUC + app-layer filter) → Prisma. Public/token/webhook/cron doors bypass the session gate by design and are the scrutiny surface (enumerated in the permission matrix). **Isolation posture:** app-layer `where:{tenantId}` is the primary control; RLS is a backstop that only engages under a non-BYPASSRLS role — **[OPEN]** the production runtime role (ADR-001 D8) must be confirmed and, recommended, moved to the restricted role as a rehearsed post-pilot change.

### 7.3 Config (names only)
`DATABASE_URL` (pooled), `RESTRICTED_DATABASE_URL`, `AUTH_SECRET`/`NEXTAUTH_*`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_CLIENT_ID`, `RESEND_API_KEY`/`RESEND_FROM`, `CRON_SECRET`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `MATFLOW_ADMIN_SECRET`, `TESTING_MODE` (dev/test only; refuses `VERCEL_ENV=production`).

### 7.4 Release, logging, recovery
Migrations wrapped `BEGIN…COMMIT` (atomicity test). **Known finding:** migration history does not replay from an empty DB (fails at `20260513000002`) — a fresh environment can't be built from migrations alone; deploying onto the existing prod DB is unaffected; SHALL be squashed/repaired before a second environment is needed. Logging: `AuditLog` (365-day), Sentry with a PII scrubber, `EmailLog`. **[unknown]** uptime monitor/alerting pipeline. Backup/restore: Neon PITR; a **restore rehearsal is [blocked]** (owner, Neon console).

### 7.5 Security posture (verified this session, candidate `b2af378`)
SAST (Semgrep, 6 rulesets, 595 files) **CLEAN** with a CI ratchet; DAST (Nuclei, 3,304 templates) **CLEAN** on the public surface (strong headers/CSP already present; `X-Powered-By` removed); **independent isolation review: all 11 areas CONFIRMED, no P0/P1** (tenant/family/role/money-retry/token/suspend-revoke/operator/web-battery). Two fixes made (AES-GCM `authTagLength`; `X-Powered-By`). Open: the manager-CSV audit gap (§3.3); env-blocked sub-checks (Stripe, throttle under `TESTING_MODE`, verified separately 8/8 with bypasses off).

### 7.6 Non-functional — **targets vs measured (SHALL NOT be conflated)**
- **Measured:** a single-club pilot load test (laptop → remote Neon, pool max 5) — a labelled diagnostic, **not** production-equivalent.
- **Not measured / [OPEN] targets:** ten-club concurrent capacity; production p95/p99 on Vercel; accessibility (no formal audit); browser/device matrix beyond Playwright chromium + spot 375/915/1440 checks. The spec SHALL state these as targets to be proven, and SHALL NOT infer enterprise guarantees from the green test suite.

---

## 8. Acceptance specification

### 8.1 Requirements → acceptance (stable IDs; extends handoff §8)
| ID | Requirement (SHALL) | Acceptance evidence required | Status |
|---|---|---|---|
| R-TEN-1 | Every tenant read/write isolated by club | RLS proof under restricted role + independent cross-tenant probes find nothing | verified (test branch); prod runtime role **[OPEN]** |
| R-TEN-2 | No cross-family access within a club | parent-vs-other-family probes 404/403 | verified; subscribe-for-kid cross-guardian **[blocked]** Stripe |
| R-AUTH-1 | Roles enforced server-side | each owner/manager/coach/admin probe refused as specified | verified |
| R-AUTH-3 | Login throttle + lockout | with bypasses off on the frozen build | re-confirm (masked by TESTING_MODE in the live review) |
| R-MON-1 | No double-charge on retry/double-submit | requestId/unique/FOR UPDATE tests + a lost-response retry drill | verified (synthetic) |
| R-MON-2 | One "owes money" definition across all screens | dashboard = Outstanding = Reports on the same data | **[gap]** end-user check on the frozen build |
| R-MON-3 | TeamUp-billed member not card-chargeable | 409 on member/parent/staff paths | charge path verified; subscription paths **[blocked]** Stripe |
| R-WAIVER-1 | Signed text == shown text; outlives member | snapshot columns + SetNull survival test | verified |
| R-IMPORT-1 | Refresh touches only TeamUp-owned fields | rehearsal: edit in MatFlow → refresh → edit kept, standing changed | verified (synthetic); real **[blocked]** |
| R-IMPORT-2 | Import atomic/resumable; rollback conservative | rehearsal + the durability-weakness hardening | **[gap]** harden or document before real import |
| R-CHECKIN-1 | Every door answers a refusal identically | refusal-reason tests + screen check per door | verified for self/kiosk; manager/coach-desk & phone-width **not covered** |
| R-PII-1 | Bulk PII export controlled **and audited** | export writes an audit row (actor, count) | **[gap]** audit row missing — required fix |
| R-REC-1 | Recover from import error and a point in time | rollback (done) + a restore rehearsal | restore **[blocked]** owner |
| R-OPS-1 | Crons safe (auth/idempotent/missed-run) | horizon + atomicity + a human-read dry-run before first prod run | partial; needs `CRON_SECRET` + dry-run review |

### 8.2 What the test suite proves — and does not
2,691 passing unit+integration tests (candidate `b2af378`) prove the pure logic (billing maths, refusal rules, import folding, idempotency, webhook handlers vs synthetic events) and DB-bound behaviour on the test branch. They **do not** prove: real production card money, email delivery, ten-club concurrency, the production runtime DB role, a restore, or a human completing a day unaided. These require the gate evidence in §9.

---

## 9. Six release gates (verified position, candidate `b2af378`, 1 Oct 2026)

| Gate | Required outcome | Evidence | Remaining | Owner | Closure criterion |
|---|---|---|---|---|---|
| 1 Daily operations | Staff complete setup/waivers/bookings/check-in/corrections/membership changes on a prod build | assess + end-user rounds 1–3; 7 verifier lanes WORKING | full **unaided** rehearsal on the frozen candidate | lead + end-user agent | a clean simulated club day, findings triaged |
| 2 Data correctness | TeamUp rehearsal reconciles people/memberships/guardians | synthetic reconciliation + refresh/rollback PASS | real export | Sean + owner | real import reconciles exactly, exceptions explained |
| 3 Security | role access correct; no cross-club/family leak; SAST+DAST clean; money-retry safe | SAST+DAST CLEAN; independent review all 11 CONFIRMED, no P0/P1 | P2 manager-CSV policy; Stripe/throttle sub-checks | lead≠reviewer (done); owner (P2) | **PASS recorded**, env items noted |
| 4 Release candidate | clean prod build + browser tests on the same commit; tsc/lint/unit/RLS/atomicity green | tsc 0, lint, Semgrep 0/0/0, unit+integration **2,691/0**, RLS 9/9, atomicity, build exit 0 | **29-file browser pass IN PROGRESS** (10/29; a0-5 shows one day-boundary item to characterise) | lead | all 29 green (or every red characterised) on the frozen SHA, no concurrent agents |
| 5 Recovery | import rollback **and** isolated restore rehearsal, responsibilities named | rollback + atomicity PASS; retention dry-run captured | Neon PITR rehearsal | owner | a documented restore, responsibilities named |
| 6 Human acceptance | Sean + a staff member complete agreed tasks unaided | task cards prepared | the sessions | owner (authorise contact) | agreed tasks completed unaided |

**Gate 1 vs 6 (no double-count):** Gate 1 = an end-user *agent* (no hints) proving *operability*; Gate 6 = *real humans* proving *acceptance*. Same task list, different witnesses.

**Proposed procedures (PROVISIONAL until agreed):** real-data reconciliation on an isolated throwaway/authorised environment with 24-h cleanup, reconcile to the dated snapshot, every unmatched row explained; restore = one Neon PITR to a scratch branch recording RTO/RPO and steps; human acceptance = the `USABILITY-KIT.md` cards on the deployed pilot, capturing every hesitation/assist.

---

## 10. Contradictions, risks & missing information
- Registers (permission/function matrices) generated at older SHAs with placeholders — regenerate at the frozen SHA.
- Manager CSV export un-audited (contradicts the "every sensitive action audits" posture) — **required fix + [OPEN] policy**.
- RLS advertised as isolation but a backstop in production (runtime role) — **[OPEN]** D8.
- Import commit durability (`ok` after a failed slice) — harden/document before real data.
- Migration history won't replay from empty — blocks a fresh environment.
- Email delivery / production Stripe money / ten-club capacity / restore / production DB role — **[PROVISIONAL]/[blocked]**.
- Push described nowhere as live — keep it that way.

## 11. Prioritised owner decisions (recommendation labelled; highest-impact first)
1. **Confirm the phase split** (A bridge release / B cutover / C platform). *Recommend: yes.* — frames the whole spec.
2. **TeamUp operating contract sign-off** (owner + Sean), incl. the attendance **switch date**. *Recommend: adopt as written.*
3. **Manager payment-CSV export:** add an audit row regardless of role [required]; then decide owner-vs-manager [recommend keep owner+manager, audited].
4. **Production DB runtime role** (D8): run the query; schedule the non-BYPASSRLS move as a rehearsed post-pilot change.
5. **Pilot success metric** (none in-repo).
6. **Member self-cancel & automated money emails** stay OFF in Phase A. *Recommend: yes.*
7. **Email sender identity + whether member invites (G3) are in Phase A or deferred.** *Recommend: defer just past go-live.*

---

## Closing — specification confidence

**Specifiable now (established + intended):** the phase model; users/roles/account states; the permission model and its four enforcement layers; the four status axes and the domain model; every core workflow (setup, members/families, membership/holds, classes/check-in across all doors, desk cash, reporting/export, TeamUp import/refresh/rollback, operator admin); the TeamUp operating mechanics; the Stripe webhook/idempotency/migration design; the architecture/isolation model; and the security posture (SAST+DAST clean, independent review all-CONFIRMED). These rest on 2,691 passing tests, RLS proven under the restricted role, and an independent review on `b2af378`.

**Specifiable only provisionally:** production card money; email delivery; ten-club capacity; the production runtime DB role; point-in-time restore; and the final browser-pass tally (**still running — not to be recorded as green**).

**Needed before this spec is final:** the §11 owner decisions (above all the phase split and the TeamUp sign-off); the completed, characterised 29-file browser pass on the frozen SHA; register regeneration at that SHA; the manager-export audit fix (and policy); and the three external evidence items (real-data reconciliation, restore rehearsal, human acceptance) or their explicit deferral with owners named.
