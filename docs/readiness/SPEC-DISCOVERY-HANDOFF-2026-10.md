# MatFlow — specification discovery handoff

**Written for:** an assistant who will write MatFlow's product/technical/operational/acceptance specification **without access to this repository**. Everything needed to reconstruct the system's important behaviour is below, with repository citations so the claims can be re-checked by anyone who does have the repo.

**Prepared:** 1 Oct 2026 (Italy time), read-only. No product code was changed, nothing deployed, no real data imported, no restore run, no one contacted.

**Evidence labels used throughout:** **[impl]** code read directly · **[test]** a named test pins it · **[verified]** run this session with result recorded · **[assumed]** inferred from code/comments · **[blocked]** needs an external action · **[unknown]** not determinable from what was read. "Current implementation is evidence of behaviour, not proof it is correct or wanted."

---

## 1. Executive description and proposed specification scope

**What MatFlow is.** A multi-tenant SaaS for martial-arts / BJJ gym management: one tenant = one club = one billing and data boundary. A club runs members, families and kids, membership tiers, a class timetable with recurring schedules and dated instances, check-in (desk register, member self-service, kiosk token, printed-card QR scan), attendance and belt ranks, waivers, payments (cash recorded at the desk and card via Stripe Connect), reports, and a member portal. A separate **operator plane** (`app/admin/**`) approves club applications and performs account administration. **[impl]**

**Who uses it.** Per club: **owner**, **manager**, **coach**, **admin** (staff roles), plus **members** and **parents** (member portal), and anonymous people at public doors (apply, login, kiosk, leaderboard, public club page). Across clubs: **operators** (platform super-admins). **[impl]** (`lib/authz.ts` `STAFF_ROLES`; `Operator` model.)

**Concrete first customer and operating model.** The live launch target is **Total BJJ** (owner "Sean"). The agreed first-release shape is a **bridge**: Sean runs daily club operations in MatFlow (roster, classes, check-in, attendance, waivers, holds, cash at the desk) **while TeamUp and Sean's Stripe keep collecting every existing recurring membership**. MatFlow must never start, change or stop that collection during the bridge. Billing standing reaches MatFlow only by a **manual, previewed "status refresh"** import of a TeamUp export. **[impl]** (`docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md`; `billedBy` field + `lib/billing-source.ts`.)

**Proposed specification scope — recommend THREE explicitly separated phases** (the repo already thinks in these; do not conflate them):
- **Phase A — First production release (the bridge).** Daily operations on real data for one club with TeamUp still billing. This is where the launch gates (section 7) point. *Recommend the spec treat this as the primary, in-scope release.*
- **Phase B — Billing cutover.** Move cohorts from TeamUp/Stripe onto MatFlow-owned Stripe subscriptions (the migration engine exists; cutover rehearsals NOT RUN). *Gated behind Phase A going live + Sean's Stripe sign-in.*
- **Phase C — Platform scale.** Multi-club (Location/Group/verified Person identity — ADR-001, designed not built), per-club email domains, self-serve signup, discount codes, desk point-of-sale. *Roadmap; deliberately deferred.*

**Measurable outcomes (documented).** The owner's standing goal is one paying club live and off £0 MRR; the launch register's verdict is framed per gate, not as a single "done." No formal SLA/business KPI document exists in-repo. **[assumed]** Business success criteria beyond "a real club runs a day unaided" are an **owner decision** (section 10).

**Deliberate exclusions / deferrals (stated in-repo):** member-facing automatic email reminders about money; member self-cancel is **off** for Total BJJ; multi-club switcher; per-club sender domains; SMS; discount codes; general desk POS basket; location-specific merchants; a custom-role builder. **[impl]/[assumed]** (ADR-001 non-goals; plan cut lists.)

---

## 2. Repository and evidence snapshot

| Item | Value | Evidence |
|---|---|---|
| Branch | `main` | **[verified]** `git` |
| Candidate commit | **`b2af378`** (`b2af3782cca1eebf282e7e55090db4077dcb1c17`) | **[verified]** |
| Unpushed | **127 commits** ahead of `origin/main`; production runs the **old build** (last known `90868eb`; deployed SHA is not exposed by any route) | **[verified]** |
| Working tree | clean except `.omc/project-memory.json` (tool state) + untracked `.omc/` session state and readiness docs | **[verified]** |
| Stack | Next.js 16 (Turbopack) · React 19 · TypeScript · Tailwind v4 · Prisma 7 + `@prisma/adapter-pg` · Neon Postgres · NextAuth v5 · Stripe (API `2026-03-25.dahlia`) · Resend · Vercel Blob | **[impl]** |
| Test DB | Neon **test** branch `ep-hidden-salad`; production DB never touched by a script this session | **[impl]** config guards |
| Pending migrations | 9 additive (`20260924120000_member_hold_until` … `20261001100000_member_hold_prior_status`), all wrapped `BEGIN…COMMIT`, applied to the test branch only | **[verified]** `ls prisma/migrations` |

**Verification run this session on `b2af378` (read-only, recorded):** typecheck `tsc --noEmit` 0 errors; lint (eslint + UI-rules ratchets) pass; Semgrep SAST ratchet 0/0/0; **full unit+integration suite 2,691 passed / 0 failed** (122 skipped, 15 todo; 292 files); **RLS enforcement 9/9** under the restricted role `matflow_app` with `RLS_ENFORCED=1`; migration-atomicity test included and passing; production `next build` exit 0, started healthy under the restricted role, stopped cleanly. The **full 29-file browser (e2e) pass is IN PROGRESS** at the time of writing (8/29 files recorded, all green except `a0-5` which shows 1 failure in "A0.17 month-end", consistent with a previously documented day-boundary ClassInstance-count artefact — **not yet characterised on a completed tally; do not record it as passed or as a real defect without the final run**). **[verified]**

**Prior reports treated as leads, not proof.** The readiness docs under `docs/readiness/` (permission matrix, TeamUp contract, launch register, connection register, function register, Ralph ledger, security evidence) are the richest existing evidence and are cited below; several carry placeholders or an earlier candidate SHA (e.g. the permission matrix was generated at `9993565`, the launch register at `9eed314`) and should be regenerated against the final frozen SHA before the spec is finalised.

---

## 3. Product scope, users and permissions

### 3.1 Roles and account states
- **Staff** (`User`, per club, `@@unique([tenantId,email])`): `owner | manager | coach | admin` (DB CHECK). The same person at two clubs is two unrelated `User` rows — **there is no cross-club account link today**. 2FA (TOTP) optional; `mustChangePassword` forces `/set-password` after an operator reset; lockout after failed logins; `sessionVersion` invalidates all sessions on bump. **[impl]**
- **Members / parents** (`Member`, per club, `@@unique([tenantId,email])`): `accountType` `adult | junior | kids | parent`. Kids are **passwordless** and carry **synthesised emails** (`@no-login.matflow.local`) so the club is never told it "invited" them and they can never sign in. Parents manage kids via `parentMemberId`. **[impl]**
- **Operators** (`Operator`, platform-level, no tenantId): approve/reject applications, create tenants, suspend/soft-delete clubs, force password/2FA resets, transfer ownership, impersonate (audited), DSAR export/erase. **v1 ships a single shared-secret cookie** (`MATFLOW_ADMIN_SECRET`); the per-operator `Operator` table (v1.5, with its own login + TOTP) exists but its UI is deferred. **[impl]**

### 3.2 Enforcement model (where each restriction lives)
Four layers, in order of authority:
1. **Page gates** (`lib/authz.ts`, redirect-based) for server components.
2. **Route gates** (`lib/api-authz.ts`, JSON 401/403) for API handlers: `requireApiStaff`, `requireApiOwnerOrManager`, `requireApiOwner`; member-session checks; kiosk/display **token** doors; operator context; **cron bearer secret**; Stripe **webhook signature**. **[impl]**
3. **Application-layer tenant filter** — every tenant query carries `where:{tenantId}` and runs in `withTenantContext` (sets a transaction-local Postgres GUC). This is the **primary** isolation defence. **[impl]**
4. **Row-level security (RLS)** — `ENABLE + FORCE` on 41/47 tables (migration `20260503200000`); with RLS on and no tenant set, a bare query returns **zero** rows (safe-by-default). RLS is a **backstop**: in production the app currently connects as a `BYPASSRLS` role, so RLS only bites code paths using the restricted role — **none in production today** (ADR-001 D8; the production role is **[blocked]** on a query only the owner can run in the Neon console). **[impl]/[blocked]**

The complete per-route matrix (route | methods | who | CSRF | rate-limit) is `docs/readiness/PERMISSION-MATRIX.md` (generated from the routes at `9993565`; regenerate at the final SHA). Notable server-enforced restrictions: adding a **kid** is owner/manager only; memberships CRUD is owner (create/list owner+manager); staff admin is owner-only; settings PATCH owner-only; refunds, charges, DSAR export, upload, migrate-memberships, drive are owner-only; **exports and reports are owner+manager**; check-in/card are staff; kiosk/leaderboard are token doors; webhook is signature-only. **[impl]**

### 3.3 Manager payment-CSV export — the specific investigation requested
- **Route:** `GET /api/payments/export.csv` → `requireApiOwnerOrManager` + rate-limit 10/hour per tenant. A **manager can export**; coach and admin are refused. **[impl]/[verified]** (independent review, section 7, confirmed coach/admin refused).
- **Exported fields (12, every tenant payment, `take: 5000`):** Paid-on date, **member name, member email**, amount (pence), currency, status, description, Stripe invoice id, Stripe payment-intent id, refunded-at, refunded amount, recorded-at. CSV cells pass the formula-injection guard (`lib/csv.ts`). **[impl]**
- **Scope:** all payments for the club (not row-limited by member); 5,000-row cap.
- **Auditability:** **the export writes NO `AuditLog` row** — a manager can download every member's name, email and payment history untracked. This is a **genuine gap** for a bulk-PII egress point (compare: holds, attendance overrides, migrations all audit). **[impl]** (route has no `logAudit` call.)
- **Evidence of a business need:** **none found in-repo.** The access mirrors Reports (owner+manager), which is the only rationale visible. Per the task's instruction, "managers can see similar data on screen" is **not** sufficient justification for a bulk, offline, un-audited export.
- **Unresolved owner decision (section 10):** keep manager access, restrict to owner, or keep manager access **but add an audit row (and consider field minimisation / a reason prompt)**. *Recommendation: at minimum add an audit row for every export regardless of who runs it; then decide owner-vs-manager as policy.*

---

## 4. Workflow catalogue and business rules

Each workflow below is sourced from route + lib reads and named tests. (Full detail with line anchors is in the evidence gathered this session; the citations are the files to open.)

### 4.1 Club setup & staff onboarding
Apply (`/api/apply`, public, rate-limited) → `GymApplication` (status `new`; notification failure non-fatal **[test]**). Operator approves (`/api/admin/applications/[id]/approve`) → creates `Tenant` + owner `User`, mints a 30-min `first_time_signup` magic-link, sends `owner_activation` email (failure doesn't roll back). Owner activates → `/onboarding` wizard → `/set-password`. Add staff (`/api/staff`, **owner-only** POST): a random password is generated and **never emailed**; the new user gets `mustChangePassword:true` and an accept-invite link. Duplicate email → 409. **[impl]** **[test]** e2e `lb-1`, `lb-2`, `lb-3`, `la-1`; `accept-invite.test.ts`. **Onboarding-wizard internal steps: [unknown]** (only page existence read).

### 4.2 Members: create / search / edit / archive; family & kids
Create (`POST /api/members`, staff; rate 30/hr): kids are owner/manager-only, require a top-level parent in-tenant (no nesting), enforce `MAX_KIDS_PER_PARENT`; kid emails always synthesised; tier resolved in-tenant (the tenant boundary); initial `paymentStatus = initialDeskPaymentStatus(tier)` (`free` if price 0 else **`pending`** = "No payment yet"); adults may start as `taster` (funnel start); future DOB rejected; **`createRequestId` dedupes** a lost-response retry. Search/list (GET, **staff-only** — exposes PII): cursor pagination, `?search=` server-side, `?filter=kids`. Edit (PATCH): uses `updateMany({where:{id,tenantId}})` so one club can't repoint another's member; status→cancelled sets `cancelledAt`; may cancel a Stripe sub. **Archive = hard DELETE (owner-only)** with an F5 "deletion gateway": `?probe=1` returns linked kids (409) so the UI shows a 3-option picker; actual delete needs `?confirm=1` or `?strategy=reassign|cascade|orphan`. **[impl]** **[test]** `lc-1`, `lc-2`, `parent-deletion-gateway`, `member-cascade-delete`, `member-children-lifecycle`.

### 4.3 Membership: assign tier / hold / resume / cancel / reactivate
Assign at create or PATCH (`membershipTierId` + legacy `membershipType` kept in sync). **Hold** (`/api/members/[id]/hold`, owner+manager): `paymentStatus="paused"` + optional `holdUntil` (≥1 day, ≤365, else "cancel instead"); if a Stripe sub exists, `pause_collection{behavior:"void"}`; **compare-and-set** write → 409 on a double-click; stores `holdPriorStatus`. **Resume** (`/api/members/[id]/resume`): **restores the exact prior status** (`holdPriorStatus`), so a never-paid member resumes to `pending` not `paid` (fixed 1 Oct); clears Stripe pause first; 502 "nothing was changed" if Stripe errs; cash member's `nextDueAt` left as-is so a payment is honestly owed on return. Cancel = PATCH status→cancelled; reactivate = status edit back (recorded as a status event). **[impl]** Member self-cancel exists but is **off** for Total BJJ.

### 4.4 Classes: scheduling, booking, cancellation, capacity, attendance, check-in
**One check-in rule engine** `lib/checkin.ts performCheckin`, shared by all doors, with a per-method gate matrix: **admin/qr(card)/auto bypass gates (staff/system override), self & kiosk enforce all** (rank, roster-if-any, time window, venue, kids, hold, waiver, capacity). Gate order is fixed and each refusal has a machine `reason` + one sentence (`lib/checkin-refusal.ts`) so **every door answers identically** (fix F-6, where a member sheet read any 409 as success). Capacity uses `SELECT … FOR UPDATE` + count **in the insert transaction** (no last-seat race); duplicate attendance → unique constraint → `{kind:"duplicate"}` (idempotent). Class packs decrement/restore credits. Doors: desk register (`/api/checkin`, server computes `effectiveMethod` — a member can't self-promote to admin), parent→kid (`onBehalfOfMemberId`), kiosk (`/api/kiosk/[token]/checkin`, token-auth, paused-club 403 first), card scan (`/api/checkin/card`, 5-yr signed card, admin gate profile, one token/request). Coach register (`/api/coach/instances/[id]/register`): any staff opens any register in the club (the per-coach lock was removed 17 Sep); medical notes redacted unless owner/manager/admin; roster = subscribers ∪ anyone with an attendance row (walk-ins flagged); each row shows `onHold`, `billedBy`, billing staleness. **[impl]** **[test]** `checkin-pack-race`, `checkin-window-config`, `parent-checkin-kid`, `ld-1`, `ld-2`. Instances are generated by a daily cron on a **56-day rolling horizon**, idempotent only because of `ClassInstance @@unique([classId,date,startTime])`.

### 4.5 Front-desk daily operations
Record cash/manual payment (`/api/payments/manual`, owner+manager, rate 60/5min): methods `cash|exempt|external|comp|other`; **£10,000 cap**; **`requestId` REQUIRED**; advances `nextDueAt` by the tier cycle (from the due date, not today; first payment anchors from `paidAt`); flips `paymentStatus="paid"`; a duplicate `requestId` returns the **existing** row with **200** (so a retry never double-charges, but two genuine £40s in a day are still allowed via a fresh id). **[impl]** **[test]** `le-1`, `a0-4`.

### 4.6 Payments: visibility, reporting, CSV export
History/outstanding/refund/intent routes + reports data layer `lib/reports.ts getReportsData` (cached ~60s): weeks 4–24, class + adult/kids filters, 3 attendance-rate modes (all divide-by-zero → null), `paymentHealth` importing the **same** overdue/noPaymentYet definitions as the dashboard and the Outstanding tab (one source of truth, so no screen says "nobody owes" while Outstanding lists names). Reports + export are owner+manager. CSV export detailed in §3.3. **[impl]** **[test]** `le-2`, `le-3`, `billing.test.ts`.

### 4.7 TeamUp import / refresh / exceptions / rollback (operational)
Upload → preview → commit → (rollback). Owner-only, CSRF, 10 MB cap, **private** Vercel Blob (URL never returned to client), `fileHash` refuses a duplicate upload, `sourceExportedAt` required for a refresh. **Create** commit: folds a TeamUp "Memberships" export (one row per membership-ever-held) into people; two passes (adults/parents then kids) in 25-row slices, resumable, manifest written in the same transaction; imported members are `billedBy="teamup"`. **Refresh** commit: updates **only** TeamUp-owned fields (status, paymentStatus, cancelledAt, plan, tier, "status as of") on members matched by the first-import key; creates nobody; a changed name/email at TeamUp is an **exception**, never a guess; a MatFlow hold is **never lifted** by a refresh (access is MatFlow's). **Rollback**: create-rollback removes only rows this job created that nobody has touched since (keeps anyone with a login, payment, waiver, later edit, etc., with a reason); refresh-rollback restores prior standing only where the member still carries exactly what the refresh wrote. **[impl]** **[test]** `teamup-rehearsal`, `import-teamup`, `lc-3`. (Full field-ownership table: `TEAMUP-OPERATIONS-CONTRACT.md` §2.)

### 4.8 Staff handover & mistake correction
Operator ownership transfer, force-password reset, member/operator TOTP reset, member/staff unlock, club suspend/soft-delete, DSAR export/erase. Corrections flow through PATCH (status events capture the change) with a full `AuditLog` trail. **[impl]** **[test]** `lg-1`, `lg-2`, `operator-member-totp-reset`, `staff-edit-email`.

### 4.9 Status / date / financial label semantics (the four axes — keep them separate in the spec)
The system **deliberately separates four axes** that a single member carries at once:
1. **`Member.status` — lifecycle/entitlement:** `active | inactive | cancelled | taster`. `cancelledAt` is the churn key (not `updatedAt`). Transitions via single writer `lib/member-status.ts` → `MemberStatusEvent` (funnel; `import`-reason excluded from conversion math). **[impl]**
2. **`Member.paymentStatus` — billing state (stored):** `paid | overdue | paused | free | pending | cancelled`. **`pending` renders as "No payment yet."** `free` = zero-price tier. **[impl]**
3. **Overdue / "who owes" — DERIVED (`lib/overdue.ts`):** stored `overdue` is written at only two lines (both in the Stripe webhook), so cash clubs would never show it. `owesMoneyClause = overdueClause ∪ noPaymentYetWhere`; a member with a Stripe subscription is excluded from due-date derivation (their schedule is Stripe's). `shownPaymentStatus(member,now)` must be used by every list/profile (a bug once showed "Paid" where the dashboard said overdue). `advanceDueDate` steps from the due date (late payment keeps the billing day), month-end clamped both ways in UTC. **[impl]** **[test]** `billing-cycle`, `billing`.
4. **Payment history (`Payment.status`):** `succeeded | failed | refunded | disputed | pending`; `paidAt` (money moved, back-dateable) vs `createdAt` (recorded). **[impl]**
Plus: **hold** (`paused` + `holdUntil`; an expired `holdUntil` is not on hold), **`nextDueAt`/billing-cycle** (`weekly|fortnightly|four_weekly|monthly|annual|none`), **`billedBy=teamup`** (payment ownership; excluded from chase; 8-day staleness warning that never refuses a check-in), **review-lock** (tenant-level `423 review_locked` on anything that bills/invites/destroys), **`isKids`** on Class/Tier (adults refused with one sentence). **[impl]**

---

## 5. Data model and integration contracts

### 5.1 Entity inventory (Prisma; ids are `cuid()`; CHECK constraints live in migration SQL)
`Tenant` (club/customer/data boundary; `slug @unique`, `stripeAccountId @unique`, `kioskTokenHash`, `displayTokenHash @unique`, branding, `currency`/`timezone`/`country` CHECKs, `paymentRail`, `memberSelfBilling`, review-lock fields, `deletedAt` soft-delete). `User` (staff, `@@unique[tenantId,email]`, `mustChangePassword`, TOTP, lockout, `sessionVersion`). `Member` (central; `@@unique[tenantId,email]`, `[tenantId,externalRef]`, `[tenantId,createRequestId]`; `accountType`, `status`, `paymentStatus`, `nextDueAt`, `holdUntil`, `holdPriorStatus`, `billedBy`/`billingStatusAsOf`/`billingStatusSource`, `parentMemberId` self-FK SetNull, attribution FKs with an XOR CHECK, Stripe ids). `MemberStatusEvent` (funnel; `onDelete Cascade` to Member; reasons CHECK). `MembershipTier` (`billingCycle` CHECK, `isKids`, `locationId`, Stripe price/product ids). `Class` / `ClassSchedule` (no tenantId, via classId) / `ClassInstance` (`@@unique[classId,date,startTime]` — the idempotency key for the cron) / `ClassRoster` / `ClassSubscription` / `ClassWaitlist`. `AttendanceRecord` (`@@unique[memberId,classInstanceId]`, `checkInMethod` incl. `qr`, `importJobId`/`sourceRowId` for imported history). `Payment` (`stripeInvoiceId`/`stripePaymentIntentId @unique`, `stripeChargeId` indexed-not-unique, `status` CHECK, `requestId` with `@@unique[tenantId,requestId]`). `SignedWaiver` (`onDelete SetNull` to Member — liability evidence outlives the member; `titleSnapshot`/`contentSnapshot` freeze what was shown; `requestId`). `ImportJob` (`status`, `mode` create/refresh, `fileHash`, `sourceExportedAt`, `manifest`, `rolledBackAt`). `MemberClassPack`/`ClassPack`/`ClassPackRedemption`. `Location` (venue, additive, "never a data boundary"). `EmailLog` (state machine). `StripeEvent` (`eventId @unique`, global idempotency). `AuditLog` (`tenantId` **nullable, no FK** — survives tenant hard-delete). `Operator`/`GymApplication`/`PlatformConfig` (platform). Plus ranks/belts, notifications, announcements, magic-link/reset tokens, login events, password history, disputes, orders/products, Google-Drive connection, initiatives. **[impl]** (`prisma/schema.prisma`, ~1,344 lines.)

**Tenant ownership:** 34 of 46 models carry `tenantId`; the rest are scoped through a parent FK or are deliberately global (`StripeEvent`, `RateLimitHit`, `Operator`, `PlatformConfig`, `GymApplication`, `ClassSchedule`/`ClassInstance` via classId). **onDelete:** most FKs **into** Tenant are default RESTRICT (the retention cron relies on the ordering); Cascade is used for status events, photos, roster, push subs, password history, login events, initiative attachments, tasks→tenant; SetNull for tier/parent/attribution/coach/location/audit/waiver links so history survives.

### 5.2 TeamUp (CSV import + refresh)
Format: TeamUp "Memberships" export, one row per membership-ever-held; headers matched case-insensitively (`customer name/email`, `membership name`, `type`, `status`, dates, emergency contact…). People folded by `(email,name)` lowercased — **nothing else is identity** (not surname/phone/address). Kids never keep their row email (it's the payer's); a parent is the adult sharing the email or a synthesised unverified draft from the emergency contact. **Estimated next-payment date is written to notes only, never to `nextDueAt`** (so nothing can charge on a guess). Refresh changes only `status/paymentStatus/cancelledAt/membershipType/membershipTierId` (+ provenance) and preserves everything a club edits in MatFlow; matching is by the stored first-import key; a changed name/email → exception. Preview writes nothing; commit is resumable (manifest in-tx); rollback is conservative (keeps touched rows with a reason). **Atomicity caveat:** commit runs 25-row slices each in their own transaction (not one big tx); a slice failing on a system error ends the job `failed` for re-run — but a durability weakness is noted (an `ok:true` shape can follow partially-failed slices) in `CONNECTION-REGISTER.md`. **[impl]** **[test]** `import-teamup`, `teamup-rehearsal`.

### 5.3 Stripe (Standard Connect; API `2026-03-25.dahlia`)
Gym is merchant of record (platform liability declined 17 Sep). Webhook: tenant resolved from `event.account`; an unlinked/missing account → **409 so Stripe retries** (never ack-and-drop). **Signature** required (400 on bad/missing). **Idempotency:** `StripeEvent.create` is the first statement inside the one processing transaction; crash → whole tx rolls back → clean redelivery; duplicate → P2002 → ack. Only `HANDLED_STRIPE_EVENT_TYPES` are claimed (unknown types acked un-claimed). ~20 event types handled (subscription deleted/updated, invoice succeeded/failed/voided, checkout completed/expired, payment-intent processing/succeeded/failed, mandate.updated, charge.refunded, customer.deleted, payment_method.detached, dispute created/updated/closed, account.updated, account.application.deauthorized) with careful rules (e.g. £0 first invoice confirms paid without a Payment row; refunds apportion pack credits; deauthorized stamps the cached status **disabled** rather than clearing it, to avoid failing open). Emails + audit logs are dispatched **after** commit, fire-and-forget. **Migration engine** (`lib/stripe/migrate-memberships.ts`): ADOPT / REPLACE (default) / CREATE / SKIP with explicit reasons; crash-safe via `metadata.matflowMemberId` search; flips a migrated member to `billedBy="matflow"`. **Whether live card money has flowed end-to-end in production is [unknown]**; the replace path is proven in **test mode** only. The `billed_elsewhere` guard (`lib/billing-source-server.ts`) returns 409 before any provider call for TeamUp-billed members; the **exact set of routes that call it** is enforced via review-lock + these guards but was not fully enumerated — the independent review confirmed the `members/[id]/charge` path returns 409. **[impl]/[verified-partial]**

### 5.4 Email + background jobs
Email (`lib/email.ts`, Resend, 23 templates, all HTML-escaped): with no `RESEND_API_KEY` it logs one `EmailLog` "failed" and sends nothing (mail-dark); bounce-aware (skips a recipient bounced/complained in 30 days); otherwise `queued → sent|failed`. The schema has `delivered/bounced/complained` statuses but `lib/email.ts` never writes them — those would come from a Resend webhook; **whether a Resend status webhook handler exists is [unknown]/[assumed absent]**. `RESEND_FROM` defaults to a shared `resend.dev` sandbox sender; **production mail is [blocked] on `RESEND_FROM` + SPF/DKIM/DMARC**. Crons (bearer `CRON_SECRET`, 503 if unset; Vercel Hobby allows 2 schedules so only **retention** (daily 03:30; runs Stripe reconcile first; chunked GDPR purge; tenant hard-delete 30-day grace, fail-closed on live billing; `?dryRun=1`) and **monthly-reports** (needs `ANTHROPIC_API_KEY`) are scheduled; **class-instances** (56-day horizon) and **stripe-reconcile** also exist. **[impl]**

### 5.5 Other integrations
Vercel **Blob** (private; import CSVs, photos, waiver signatures; needs `BLOB_READ_WRITE_TOKEN`). **Google Drive** (owner-only connect/index; tokens encrypted with AES-256-GCM, `lib/encryption.ts`). **Push** (service worker + subscriptions exist; **delivery not live** per CLAUDE.md — do not claim it). **[impl]**

---

## 6. Architecture and operational model

- **Frontend/backend:** one Next.js 16 app (App Router, server components + route handlers); member portal under `app/member/**`, staff dashboard under `app/dashboard/**`, operator plane under `app/admin/**`, public pages (`/apply`, `/login`, `/[slug]`, `/leaderboard/[token]`, `/kiosk`). **DB** Neon Postgres via Prisma + `@prisma/adapter-pg` (a pg Pool; production must use the **pooled** host). **Auth** NextAuth v5 (credentials + club slug; TOTP; magic links). **Hosting** Vercel (auto-deploy on push to `main`; `maybe-migrate` runs before build). **[impl]**
- **Request flow / trust boundaries:** browser → route handler → auth/route gate → `assertSameOrigin` (CSRF) → `withTenantContext` (tenant GUC + app-layer `where:{tenantId}`) → Prisma. Public/token/webhook/cron doors bypass the session gate by design and are the ones to scrutinise (listed in the permission matrix). **[impl]**
- **Tenant isolation & privilege:** section 3.2. The single most important production caveat: **RLS is a backstop only while the runtime role bypasses it; the app-layer filter is the real defence** (ADR-001 D8; production role **[blocked]** on the owner's query). **[impl]**
- **Background work:** 4 crons (§5.4); Stripe webhook; no queue/outbox (post-commit emails are fire-and-forget — a crash between commit and send loses that email; a durable outbox is an explicit non-goal today). **[impl]**
- **Config (names only):** `DATABASE_URL` (+ pooled host), `RESTRICTED_DATABASE_URL`, `AUTH_SECRET`/`NEXTAUTH_*`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_CLIENT_ID`, `RESEND_API_KEY`/`RESEND_FROM`, `CRON_SECRET`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `MATFLOW_ADMIN_SECRET`, `TESTING_MODE` (dev/test only; refuses `VERCEL_ENV=production`). **[impl]**
- **Migrations/release:** `prisma migrate`; migrations wrapped `BEGIN…COMMIT` (atomicity test); **known finding: history does not replay from an empty DB (fails at `20260513000002`)** — a brand-new environment can't be built from migrations alone, but deploying onto the existing production DB is unaffected. **[impl]** (launch register §8.)
- **Logging/monitoring/audit:** `AuditLog` (365-day retention); Sentry with a PII scrubber; `EmailLog`. **No uptime monitor / alerting pipeline verified in-repo.** **[impl]/[unknown]**
- **Backup/restore:** Neon branch/PITR; a point-in-time **restore rehearsal is [blocked]** (needs the Neon console — owner).
- **Performance/capacity:** a single-club pilot load test exists (`CAPACITY-PILOT-2026-09-24.md`: laptop→remote Neon, pool max 5, labelled diagnostic — p95s recorded but explicitly **not** production-equivalent). **Ten-club concurrent capacity is NOT measured.** No accessibility audit or formal browser/device matrix beyond the Playwright chromium suite + some 375/915/1440 checks. Do **not** manufacture enterprise guarantees from the green test suite. **[impl]/[unknown]**

---

## 7. Six-gate evidence table

The release decision rule (owner, 1 Oct) is six gates, each PASS/FAIL/BLOCKED with an owner and evidence. (These map onto the older G1–G4 in the launch register; don't double-count.) **Current position, verified this session:**

| Gate | Required outcome | Existing evidence | Candidate | Remaining work | Dependency / owner | Closure criterion |
|---|---|---|---|---|---|---|
| **1 Daily operations** | Staff complete member setup, waivers, bookings, check-in, attendance correction, membership changes on a production build | assess suite + end-user rounds 1–3; 7 verifier lanes WORKING (register, kiosk, portal, money, import) | `b2af378` | the **full unaided rehearsal** (one simulated club day) not yet done on the frozen candidate | lead + end-user agent | a clean simulated day with findings triaged |
| **2 Data correctness** | TeamUp rehearsal reconciles people/memberships/guardians, every discrepancy explained | synthetic reconciliation PASS (19/19); refresh field-ownership + rollback PASS | `b2af378` | real export | **Sean** (export) + **Noe** (go) | real import reconciles exactly, exceptions explained |
| **3 Security** | Independent checks: correct role access, no cross-club/family leakage; SAST + public DAST clean; money-retry safety | **SAST (Semgrep) CLEAN + CI ratchet**; **DAST (Nuclei) CLEAN**; **independent review: all 11 areas CONFIRMED, no P0/P1** | `b2af378` | P2 manager-CSV policy (§3.3); Stripe/throttle sub-checks blocked on env | lead ≠ reviewer (done); owner for P2 | **PASS (recorded)**, with env-blocked items noted |
| **4 Release candidate** | Clean prod build + critical browser tests on the same commit; tsc/lint/unit/RLS/atomicity green | tsc 0, lint, Semgrep 0/0/0, **unit+integration 2,691/0**, RLS 9/9 restricted, atomicity, prod build exit 0 | `b2af378` | **full 29-file browser pass IN PROGRESS** (8/29, a0-5 shows 1 day-boundary item to characterise) | lead | all 29 files green (or every red characterised) on the frozen SHA, **no concurrent agents** |
| **5 Recovery** | Import rollback demonstrated **and** an isolated restore rehearsal, with named responsibilities | import rollback + migration-atomicity PASS; retention dry-run captured | `b2af378` | **Neon point-in-time restore rehearsal** | **Noe** (Neon console) | a documented restore to a point in time, responsibilities named |
| **6 Human acceptance** | Sean + a staff member complete agreed tasks **without developer intervention** | task cards prepared (`USABILITY-KIT.md`) | deployed pilot | the sessions themselves | **Noe** (authorise contact) | agreed tasks completed unaided, findings recorded |

**Browser-test totals so far (not final):** 8/29 files recorded; a0-1..la-2, lb-1 green; **a0-5 = 12 passed / 1 failed** (A0.17 month-end; matches the prior day-boundary artefact — **treat as unresolved until the completed tally and a root-cause line exist; distinguish a clean first run from a retry**). The run uses the serial runner (one file at a time, one worker), no retries configured beyond the runner's restart-on-server-death. **[verified]**

**Overlap note (gates 1 vs 6):** Gate 1's rehearsal is run by an **end-user agent** (no developer hints) and is evidence of *operability*; Gate 6 is the **real humans** (Sean + a desk user) doing the same tasks and is evidence of *acceptance*. They use the same task list but are different witnesses — do not count one as the other.

**Proposed procedures for the three outstanding real-world items (label as PROPOSALS):**
- *Real-data reconciliation:* on an isolated throwaway club on the test branch (or a Noe-authorised protected environment with a 24-h cleanup), import Sean's real export, reconcile counts per status/plan to the dated source snapshot, every unmatched/quarantined row explained; success = exact reconciliation + zero silent drops; failure = any unexplained count difference. Real PII enters no git/fixture/log.
- *Restore rehearsal:* Noe performs one Neon point-in-time restore to a scratch branch, records RTO/RPO achieved and the exact steps; success = data at the chosen point recovered and reconciled; failure/BLOCKED recorded with the missing access.
- *Human acceptance:* Sean + one desk user run the `USABILITY-KIT.md` cards on the deployed pilot build; capture every hesitation/assist/misunderstanding; success = agreed tasks completed unaided; this is gated on Noe authorising contact.

---

## 8. Requirements-to-evidence matrix (core; stable discovery IDs)

| ID | Behaviour / constraint | Source & status | Existing verification | Missing acceptance evidence |
|---|---|---|---|---|
| R-TEN-1 | Every tenant read/write is isolated by club | [impl] app-layer filter + RLS backstop | RLS 9/9 restricted; independent review area 1 CONFIRMED; `tenant-isolation` tests | production runtime role is non-BYPASSRLS (ADR-001 D8) — **[blocked]** |
| R-TEN-2 | No cross-family data access within a club | [impl] parent/guardian checks | independent review area 2 CONFIRMED | subscribe-for-kid cross-guardian path **[blocked]** on Stripe |
| R-AUTH-1 | Roles enforced server-side, not just UI | [impl] `api-authz` | review area 4 CONFIRMED; `lb-2` nav⇄gate⇄API | — |
| R-AUTH-2 | Session revocation on password/ownership/sessionVersion change | [impl] | review area 9 CONFIRMED | — |
| R-AUTH-3 | Login throttle + lockout | [impl] `auth.ts` | 8/8 with bypasses off (prod build, earlier) | masked by `TESTING_MODE` in the live review — **re-confirm on the frozen build with bypasses off** |
| R-MON-1 | No double-charge on retry/double-submit (payments, member, waiver, check-in) | [impl] requestId / unique / FOR UPDATE | review area 5 CONFIRMED; `checkin-pack-race` | webhook replay/out-of-order **[blocked]** on connected Stripe |
| R-MON-2 | Overdue/"who owes" derived consistently across dashboard, Outstanding, Reports | [impl] `lib/overdue.ts` single source | `billing` tests; reports import the same clause | an end-user check that all three agree on the frozen build |
| R-MON-3 | TeamUp-billed member cannot be card-charged in MatFlow | [impl] `billed_elsewhere` 409 | review area 5 (charge route 409) | self/parent/staff subscription paths **[blocked]** on Stripe |
| R-WAIVER-1 | Signed text == shown text; waiver outlives member | [impl] snapshot columns, SetNull | verifier lane 2; `member-cascade` | — |
| R-IMPORT-1 | Refresh changes only TeamUp-owned fields, never MatFlow edits | [impl] `teamup-refresh` | `teamup-rehearsal`; functional reviewer CONFIRMED | on **real** data (Gate 2) |
| R-IMPORT-2 | Import commit atomic / resumable / rollback conservative | [impl] | rehearsal PASS | durability weakness (ok:true after failed slice) — **harden or document** (`CONNECTION-REGISTER`) |
| R-CHECKIN-1 | Every door answers a refusal identically with a reason | [impl] `checkin-refusal` | `checkin-refusal.test.ts`; verifier lane 3 | manager/coach desk, phone-width, hold-ending-on-date **not covered** (launch register §8) |
| R-DATA-1 | Statuses/labels mean exactly one thing each | [impl] §4.9 | unit tests per lib | — |
| R-REC-1 | Recoverable from import error and from a point in time | [impl] rollback; [blocked] restore | rollback PASS | restore rehearsal (Gate 5) |
| R-PII-1 | Bulk PII export is controlled and audited | [impl] owner+manager + rate-limit; **NOT audited** | review P2 | **audit row missing** — owner decision + fix |
| R-OPS-1 | Crons safe (auth, idempotent, missed-run tolerant) | [impl] | atomicity + horizon design | production run needs `CRON_SECRET`; retention first-run dry-run **must be read by a human** |

**What the green suite proves and does not:** 2,691 passing unit+integration tests prove the pure logic (billing maths, refusal rules, import folding, idempotency guards, webhook handlers against synthetic events) and DB-bound behaviour on the test branch. They do **not** prove: real card money end-to-end in production, email delivery, ten-club concurrency, the production runtime DB role, a restore, or a real human completing a day unaided. **[verified]/[blocked]**

---

## 9. Contradictions, risks and missing information

- **Permission matrix / registers are at older SHAs** (matrix `9993565`, launch register `9eed314`) with placeholders; current candidate is `b2af378`. *Regenerate at the frozen SHA before the spec cites counts.* **[impl]**
- **Manager CSV export is un-audited** (§3.3) — contradiction with the rest of the system's "every sensitive action audits" posture. **Owner decision + fix.**
- **RLS is advertised as isolation but is a backstop in production** (runtime role bypasses it). Not a defect today (app-layer filter holds, independently confirmed) but a **stated risk** until ADR-001 D8 (non-BYPASSRLS runtime role) is done. **[blocked]**
- **Import commit durability:** `ok:true` can follow partially-failed 25-row slices. Flagged in `CONNECTION-REGISTER.md`; **harden or document explicitly** before real-data import. **[impl]**
- **Migration history won't replay from empty** — blocks standing up a fresh environment from migrations alone. **[impl]**
- **Email delivery, production Stripe money, ten-club capacity, restore, production DB role** — all **[blocked]/[unknown]**; the spec can only describe these provisionally.
- **No owner for several requirements:** the business success metric, the manager-export policy, the TeamUp field-ownership sign-off (Noe + Sean), and the "switch date from which attendance is MatFlow's" are **unassigned decisions** (section 10). **[impl]** (TeamUp contract §6.)
- **Push notifications** are scaffolded but not live — the spec must not describe them as working. **[impl]**

---

## 10. Prioritised questions for the product owner (decision → options → recommendation)

1. **Specification scope split.** Confirm the spec covers **Phase A (the bridge) as the release**, with B (cutover) and C (platform) as separate later phases. *Recommend: yes — it matches the gates and avoids over-scoping.* **Impact: highest (frames the whole spec).**
2. **TeamUp operating contract sign-off** (Noe **and** Sean): the field-ownership table, the weekly refresh + operator + 8-day staleness, "cash at the desk only" for new money, and the **switch date** from which attendance is MatFlow's. *Recommend: adopt the proposed contract as written.* **Impact: high (gate 2, daily ops).**
3. **Manager payment-CSV export.** Options: (a) keep owner+manager **and add an audit row** [recommended minimum]; (b) restrict to owner; (c) keep but minimise fields / require a reason. *Recommend (a) now, decide owner-vs-manager as policy.* **Impact: medium (compliance).**
4. **Production DB runtime role** (ADR-001 D8): run the Neon query; decide whether to move the runtime to a non-BYPASSRLS role before or after the pilot. *Recommend: confirm the query now; schedule the role change as a rehearsed post-pilot config change.* **Impact: medium-high (security posture claim).**
5. **Business success metric** for the pilot (what makes the first paying club "working"?). No in-repo source. **Impact: medium (acceptance criteria).**
6. **Member self-cancel and automated money emails** — confirm both stay **off** for the first release. *Recommend: yes.* **Impact: low-medium.**
7. **Email sender identity** (`RESEND_FROM` + DMARC) and whether G3 (member invites) is in Phase A or deferred. *Recommend: defer member comms to just after go-live; it's the single non-code blocker.* **Impact: medium (gate 6/G3).**

---

## 11. Suggested structure for the final specification

1. **Purpose, scope and phases** (A bridge / B cutover / C platform; explicit exclusions).
2. **Users, roles and account states** (+ the operator plane).
3. **Permissions specification** — the action × role × tenant matrix, with the enforcement layer named per rule, and the bulk-export policy resolved.
4. **Domain model & glossary** — the entity inventory and, critically, the **four status axes** (lifecycle / billing state / derived overdue / payment history) each defined once.
5. **Workflows** — one section per §4 workflow with pre/post-conditions, state transitions, validation, errors/empty/recovery, idempotency/concurrency, and tenant boundary.
6. **Integration contracts** — TeamUp (field ownership, refresh, exceptions, rollback), Stripe (events, idempotency, migration), email (states + delivery dependency), Blob/Drive/push (with "not live" called out).
7. **Architecture & trust boundaries** — request flow, isolation model (app-layer + RLS backstop + the D8 caveat), background jobs, config names, migration/release, logging/audit/monitoring, backup/restore.
8. **Non-functional** — performance/capacity (with the pilot caveat), accessibility, browser/device support — **stated as targets vs measured**, never conflated.
9. **Acceptance specification** — the requirements-to-evidence matrix (section 8) turned into acceptance tests, with the gate closure criteria.
10. **Operational runbook** — daily ops, the TeamUp refresh procedure, incident/restore responsibilities, the cron dry-run-before-first-run rule.
11. **Open decisions & roadmap** — section 10 items with owners and target dates.

---

## Closing statement

**Sufficiently established to specify now:** the domain model and the four status axes; the permission model and its enforcement layers; every core workflow (setup, members/families, membership/holds, classes/check-in across all doors, desk payments, reporting/export, TeamUp import/refresh/rollback, operator administration); the TeamUp operating contract's mechanics; the Stripe webhook/idempotency/migration design; the architecture and isolation model; and the security posture (SAST + DAST clean, independent isolation review all-CONFIRMED no P0/P1). These rest on 2,691 passing unit+integration tests, RLS proven under the restricted role, and an independent review — all on candidate `b2af378`.

**Can only be specified provisionally:** production card-money end-to-end; email delivery; ten-club concurrent capacity; the production runtime DB role (BYPASSRLS?); point-in-time restore; and the final browser-pass tally (**in progress — do not record it as green**). Each is **[blocked]** on an external action or **[unknown]** from static evidence.

**Necessary before the final spec is complete:** (1) the owner decisions in section 10 — above all the phase split and the TeamUp contract sign-off; (2) the completed, characterised 29-file browser pass on the frozen SHA; (3) regeneration of the permission/function registers at that SHA; (4) the manager-export audit decision; and (5) the three external evidence items (real-data reconciliation, restore rehearsal, human acceptance) or their explicit deferral with owners named.
