# STATEMAP LANE D — DATA ADD / REMOVE / IMPORT / EXPORT LIFECYCLE

Repo: `C:\Users\NoeTo\Desktop\matflow` — Next.js 16 App Router, Prisma 7 / Neon Postgres, NextAuth v5, Vercel Blob, Stripe Connect, Resend.
Method: static read of source only. No dev server, no DB, no tests run. Every claim below carries a `file:line`. Anything not proven from source is tagged **UNVERIFIED**.

> STATUS: COMPLETE. Sections 0-8 below. Section 8 resolves the three items that were tagged UNVERIFIED during the pass.

## 0. HEADLINE TRUTHS

| # | Truth | Evidence |
|---|---|---|
| D-0.1 | **`Member` has no soft-delete column at all.** There is no `deletedAt` on the model — `Tenant`, `Class`, `RankSystem` and `Product` all have one, `Member` does not. Staff deletion is a real `DELETE` after a manual 10-table cascade walk. | `prisma/schema.prisma:122-216` (no `deletedAt`); cf. `Tenant.deletedAt` `schema.prisma:64`, `Class.deletedAt:365`, `RankSystem.deletedAt:279`, `Product.deletedAt:972`; `lib/member-delete.ts:137` `tx.member.deleteMany({ where })` |
| D-0.2 | **The only "soft delete" a member gets is the GDPR erase**, which overwrites the row in place: `name → "Deleted member"`, `email → deleted-<id>@deleted.invalid`, `status → "cancelled"`. That sentinel is then load-bearing: PATCH refuses to move an erased member off `cancelled`, permanently. | `app/api/admin/dsar/erase/route.ts:277-312`; resurrection block `app/api/members/[id]/route.ts:260-265` |
| D-0.3 | **CSV import mints members who cannot log in.** `import/[id]/commit` inserts `Member` rows with no `passwordHash` and no `MagicLinkToken`; both magic-link and forgot-password refuse null-password members. Login access exists only after a *separate* `POST /api/members/bulk-invite` run. | `app/api/admin/import/[id]/commit/route.ts:80-95` (createMany, no token); `app/api/members/bulk-invite/route.ts:3-7` states the lockout explicitly; eligibility filter `passwordHash: null` at `:54-63` |
| D-0.4 | **CSV import cannot carry emergency-contact data, and the member-side waiver refuses to sign without it.** `MemberDraft` has no emergency-contact fields; `POST /api/waiver/sign` 400s unless all three of name/phone/relation are already on the row. Every CSV-imported adult is therefore blocked from self-signing until someone edits them or a staff member collects the waiver on a device. | `lib/importers/index.ts:7-17` (MemberDraft shape) + `:152-197` (header maps — no emergency columns); wall at `app/api/waiver/sign/route.ts:87-92`; same wall for parents at `app/api/waiver/sign-for-child/route.ts:108-113`; the staff-device route is the only one that *writes* the trio: `app/api/members/[id]/waiver/sign/route.ts:30-32, 116-125` |
| D-0.5 | **Signed waivers deliberately outlive the member.** FK is `ON DELETE SET NULL`, and `deleteMemberCascade` explicitly does *not* delete them. A hard member delete leaves a detached `SignedWaiver` carrying `signerName`, `contentSnapshot`, `ipAddress`, `userAgent` and a live signature blob — with no `memberId` to find it by. | `prisma/schema.prisma:652-677`; `lib/member-delete.ts:24-34, 125-127`; blob deliberately retained `app/api/members/[id]/route.ts:540-542` |
| D-0.6 | **Tenant hard-delete is fail-CLOSED on Stripe but the soft-delete that starts the 30-day clock is fail-OPEN.** Soft-delete records `stripeFailed` in audit metadata and returns 200 anyway; the purge 30 days later refuses the whole tenant if any subscription will not cancel. So a gym can sit soft-deleted-but-still-charging for 30 days, then be skipped nightly forever. | fail-open: `app/api/admin/customers/[id]/soft-delete/route.ts:74-92, 123`; fail-closed: `app/api/cron/retention/route.ts:416-429, 470-514` |
| D-0.7 | **The tenant purge deliberately keeps `AuditLog`.** `AuditLog.tenantId` is a plain `String` with no FK, so the rows survive the tenant they describe and age out on their own 365-day rule. Everything else keyed to the tenant is destroyed across ~30 tables. | `prisma/schema.prisma:616-647` (no relation on `tenantId`); rationale `app/api/cron/retention/route.ts:526-531`; purge table list `:634-656` |
| D-0.8 | **Retention purges at most 2 tenants per nightly run and stops starting work at 240s.** Reconciliation runs *first* and its time is charged against that budget. A backlog of soft-deleted gyms drains at 2/night, best case. | `MAX_TENANT_PURGES_PER_RUN = 2` `app/api/cron/retention/route.ts:65`; `DEADLINE_MS = 240_000` `:63`; reconcile-first `:146-164`; `take: MAX_TENANT_PURGES_PER_RUN` `:399` |
| D-0.9 | **Every blob is written `access: "private"`, so nothing renders without a server-side proxy hop.** `downloadUrl` from `head()` carries no credential (`@vercel/blob@2.3.3` appends `?download=1` only), which is exactly why `/api/blob-image` streams bytes instead of redirecting. Two other call sites still fetch `head().downloadUrl` directly and will 403 on a genuinely private blob. | proxy rationale `app/api/blob-image/route.ts:17-27`; private writes `app/api/upload/route.ts:233-240`, `lib/waiver-signature-upload.ts:22-29`, `app/api/admin/import/upload/route.ts:83-87`; **the two raw-fetch sites**: `app/api/admin/import/[id]/commit/route.ts:41-47` and `app/api/waiver/[signedWaiverId]/signature/route.ts:85-93` |
| D-0.10 | **DSAR erase refuses to run unless the audit row is written first**, and refuses if Stripe will not cancel. This is the only destructive path in the codebase that treats its own evidence as a precondition. | `app/api/admin/dsar/erase/route.ts:239-270` (audit-before-destroy); Stripe fail-closed `:112-145` |
| D-0.11 | **Resend free tier is 100 emails/day / 3,000 a month; a bulk-invite of a real club is ~200 sends in one loop with `MAX_BATCH = 500`.** The route sends sequentially with no throttle and marks each over-cap send as `failed` in `EmailLog`. | cap documented `docs/EMAIL-HUB-SPEC.md:109`, flagged against invite day `docs/audit/CONNECTION-AUDIT-2026-08-22.md:38`; unthrottled loop `app/api/members/bulk-invite/route.ts:80-116`; `MAX_BATCH = 500` `:29`; failure recorded as EmailLog row `lib/email.ts:413-421` |
| D-0.12 | **A hard-bounced or complained address is silently frozen for 30 days across the whole tenant.** `sendEmail` short-circuits before any send and writes a `failed` EmailLog row; the only documented un-block is an operator editing the offending row by hand. There is no UI for that. | `lib/email.ts:350-385` incl. the comment "Operator can manually clear by deleting / updating the offending EmailLog row" |

---

## 1. EVERY ADD PATH

### 1.1 Members (the row that matters)

| Path | Route / file | Guard | Validation | Tenant scoping | Notes |
|---|---|---|---|---|---|
| Staff creates one member | `POST /api/members` — `app/api/members/route.ts:138` | `assertSameOrigin` `:142`; session `:145`; role in owner/manager/admin `:148`; kids require **owner** `:180`; rate limit 30/hr per (tenant,user) `:153-163` | `memberCreateSchema` (`lib/schemas/member.ts`); future-DOB refused `:218-223`; kid must have a top-level parent `:187-199`; `MAX_KIDS_PER_PARENT` cap `:203-210` | `withTenantContext(session.user.tenantId)` `:231`; `tenantId` never read from body `:234` | Adults get a `MagicLinkToken` (`purpose: first_time_signup`, 7-day TTL) plus an `invite_member` email; the raw URL is echoed back as a fallback `:282-321`. Token/email failure is swallowed — the member is created regardless `:315-320`. Kids get **no** token `:283` and a synthesised email `:226` |
| Parent self-serve adds a kid | `POST /api/member/children` — `app/api/member/children/route.ts:33` | `assertSameOrigin`; session must carry `memberId`; parent must not itself be a kid | zod `{name, dateOfBirth?, accountType}`; future DOB refused; `MAX_KIDS_PER_PARENT` | `tenantId` from session only (header comment: "never trusted from body") | `passwordHash: null`, `waiverAccepted: false`, `onboardingCompleted: true`. Deliberately does **not** inherit the parent's waiver |
| CSV import, self-serve | `POST /api/admin/import/upload` then `/[id]/preview` then `/[id]/commit` | `assertSameOrigin` + `requireApiOwner` on upload `app/api/admin/import/upload/route.ts:53-57`; `requireApiOwner` on commit `commit/route.ts:18` | 10 MB cap `:11,69`; source in generic/mindbody/glofox/wodify `:12,67`; MIME or `.csv` extension `:72`. Row level: email regex + non-empty name, else the row is an error `lib/importers/index.ts:127-134` | blob path `tenants/<tenantId>/imports/…` `:83`; job row and all inserts inside `withTenantContext` | Batches of 25, `createMany` with `skipDuplicates`; duplicate detection is an email pre-check `commit:70-96`. `fileBlobUrl` is never returned to the client (`publicJobView` `upload:24-50`). Blob deleted after a successful commit `commit:157-160` |
| CSV white-glove handoff | `POST /api/onboarding/csv-handoff` — `app/api/onboarding/csv-handoff/route.ts:35` | `assertSameOrigin` + `requireApiOwner` `:36-40` | 10 MB, CSV MIME/extension, notes max 500 chars `:30-68` | private blob under `tenants/<tenantId>/imports/handoff-…` `:78-82` | Creates `ImportJob` with **`status: "pending_white_glove"`** `:92` — a status the retention cron does not treat as terminal (see 3.4). Emails `MATFLOW_APPLICATIONS_TO` (default hard-coded `noetopalian@gmail.com` `:103`) with the job id but deliberately **no download link** `:115-127` |
| Bulk invite, unlocks imported members | `POST /api/members/bulk-invite` — `app/api/members/bulk-invite/route.ts:36` | `assertSameOrigin` + `requireApiStaff` `:37-41` | `memberIds` array, max 500 `:29-34` | `withTenantContext` for the candidate read and every token write `:51,84` | Eligibility is `accountType != "kids"` AND `passwordHash: null` `:54-63`. Invalidates prior unused invites before minting `:86-89`. **Sequential sends, no throttle** `:80-116`; `maxDuration = 300` `:27` |
| Accept invite | `POST /api/members/accept-invite` | none — the token is the credential | — | — | Converts a `first_time_signup` token into a `passwordHash`. **UNVERIFIED** — not read line-by-line in this pass |
| Seed | `prisma/seed.ts` | refuses to run when `NODE_ENV=production` unless `ALLOW_SEED_IN_PROD=1` `:28-33` | — | upserts tenant `totalbjj` `:41-44` | 12 demo members + 3 staff on `password123`. `npx prisma migrate reset` auto-runs it via the `prisma.seed` wire in `package.json:15` |
| Operator creates tenant + owner | `POST /api/admin/create-tenant` — `app/api/admin/create-tenant/route.ts:35` | `getOperatorContext` (legacy shared secret **or** `matflow_op_session` cookie) `:36-39`; rate limit 10/hr per IP `:41-47` | zod: slug `^[a-z0-9-]+$` 3-40, owner password min 8 `:21-33` | `withRlsBypass` — pre-tenant by definition `:67` | bcrypt cost 12. The password is handed off **out of band**; this route sends no email |
| Approve application to tenant | `POST /api/admin/applications/[id]/approve` | `isAdminAuthed` + `getOperatorContext` | — | — | Sends the `owner_activation` email carrying a 30-minute sign-in link plus the club code (`lib/email.ts:250-261`) |

### 1.2 Everything else that can create rows

| Data | Route | Guard | Tenant scoping |
|---|---|---|---|
| Classes + schedules | `POST /api/classes` `app/api/classes/route.ts:48` | CSRF + role in owner/manager `:50-56` | `withTenantContext`, `tenantId` from session `:73-77` |
| Class instances, manual | `POST /api/instances/generate` `:15`; `POST /api/classes/[id]/instances` | CSRF + owner/manager | `withTenantContext`; only `isActive: true, deletedAt: null` classes `app/api/instances/generate/route.ts:44` |
| Class instances, nightly | `GET /api/cron/class-instances` | `Authorization: Bearer ${CRON_SECRET}` `:70-78` | per-tenant loop under `withTenantContext`; 56-day rolling horizon; `createMany({skipDuplicates:true})` made honest by `@@unique([classId,date,startTime])` (migration `20260819090000`, `prisma/schema.prisma:406`) |
| Attendance | `POST /api/checkin` `app/api/checkin/route.ts:29`; `POST /api/kiosk/[token]/checkin`; `POST /api/coach/instances/[id]/attendance` | CSRF + session; `checkInMethod` re-derived **server-side**, never trusted `:57-62`; kiosk authenticates on the HMAC'd `kioskTokenHash` | `withTenantContext` |
| Rosters | `POST /api/classes/[id]/roster` | CSRF + owner/manager/admin | `ClassRoster.tenantId` |
| Ranks and promotions | `POST /api/members/[id]/rank` (owner/manager/coach); `/rank/demote` (owner/manager/admin) | CSRF + role | `withTenantContext` |
| Payments, manual / at desk | `POST /api/payments/manual`; `POST /api/orders/[id]/mark-paid` | CSRF + `requireApiOwnerOrManager` | `withTenantContext` |
| Photos | `POST /api/members/[id]/photos` (staff); `POST /api/member/children/[id]/photos` (parent); `PUT /api/members/[id]/profile-picture` | CSRF + staff-or-self | `MemberPhoto.tenantId` |
| Blob, all images | `POST /api/upload` `app/api/upload/route.ts:139` | CSRF `:145`; owner-only **except** `purpose` in `profile-pic`/`member-photo`, which allow staff-in-tenant or the member themselves `:72-136` | path `tenants/<tenantId>/<id>.<ext>` `:228`; target member re-checked against the tenant `:123-134` |
| Announcements, products, tiers, class packs, tasks, initiatives | `POST` on `/api/announcements`, `/products`, `/memberships`, `/class-packs`, `/tasks`, `/initiatives` | CSRF + owner/manager (products and class-packs use `requireApiOwnerOrManager`) | `withTenantContext` |
| Gym application, public | `POST /api/apply` | **none** — unauthenticated public form | writes `GymApplication`, which has no tenant. `docs/TODO.md:100` flags the missing rate limit / captcha |

### 1.3 Upload validation, in one place

All from `app/api/upload/route.ts` unless noted.

- Ingress cap **4 MB** (`MAX_UPLOAD_MB = 4` `:32`), deliberately under Vercel's ~4.5 MB serverless body limit so a rejection is explainable rather than an opaque platform 413 `:27-31`.
- Allow-list png/jpeg/jpg/webp `:18`, **plus magic-byte verification** `:43-50, 178-182`.
- Every accepted image is re-encoded through `sharp` to WebP — profile pics 512 square cover-crop, everything else longest edge at most 1600 `:197-213`. This strips EXIF.
- `access: "private"` + `addRandomSuffix: true` `:233-240`.
- **Fallback**: if Blob is unconfigured or throws, the route stores a `data:` URL in the DB instead `:243-250`. Same pattern for waiver signatures `lib/waiver-signature-upload.ts:18-36`. Consequence: `MemberPhoto.url` and `SignedWaiver.signatureImageUrl` are a union type — blob URL **or** inline base64 — so every delete path must filter through `isVercelBlobUrl` (`lib/blob-url.ts:15-17`) before calling `del()`.

### 1.4 Scripts that write

`scripts/` is operator-side, run by hand against `DATABASE_URL`. Nothing here is guarded beyond having the connection string.

| Script | What it adds / changes |
|---|---|
| `scripts/seed-operator-noe.mjs` (82 lines) | creates or updates the `Operator` row behind the super-admin console |
| `scripts/setup-test-accounts.mjs` (112) | test tenants and users |
| `scripts/enrol-one-member.mjs` (22) | single-member enrolment helper |
| `scripts/reset-owner-password.ts` (13), `reset-totp-noe.mjs`, `reset-totalbjj-owner-totp.mjs`, `swap-totalbjj-owner-email.mjs`, `clear-rate-limit.ts` | credential / lockout repair |
| `scripts/seed-class-instance-duplicates.mjs` | reproduces the duplicate-instance bug for testing |
| `scripts/maybe-migrate.mjs` | runs on every `npm run build` (`package.json:8`) — this is how migrations reach production |
| `scripts/find-orphan-kids.mjs` (55), `diagnose-blob.mjs` (41), `inspect-blob-urls.mjs` (42), `check-db-state.mjs`, `introspect-integrity.ts` | read-only diagnostics for exactly the gaps in section 7 |

---

## 2. EVERY REMOVE PATH

### 2.1 The three member-removal verbs

MatFlow has three distinct, non-interchangeable member removals. Nothing in the UI names them consistently.

| Verb | Route | Who | What actually happens |
|---|---|---|---|
| **Hard delete** | `DELETE /api/members/[id]` `app/api/members/[id]/route.ts:430` | **owner only** `:436` | Row destroyed. `lib/member-delete.ts` walks 10 dependent tables then `member.deleteMany` `:98-139` |
| **Parent removes their kid** | `DELETE /api/member/children/[id]` `:218` | the linked parent | Same cascade, called directly `:297-299` — but **no photo-blob cleanup** (see 3.2) |
| **GDPR erase** | `POST /api/admin/dsar/erase` `:53` | **owner only** `:54`, 5/hr per tenant `:65` | Row survives, pseudonymised in place; 7 satellite tables destroyed or scrubbed |

### 2.2 Hard delete — exact order and refusal conditions

Preflight, in `app/api/members/[id]/route.ts`:

1. CSRF `:431`, session `:433`, `role === "owner"` `:436`.
2. `?probe=1` is a **read-only** kid probe `:460-481`. This exists because the old code deleted no-kids members on the probe itself — `RemoveMemberModal` fired it on `useEffect(open)`, so opening the modal deleted the member (`Lane 1 iter-1 V-02 [Critical]`, comment `:451-459`).
3. Without `?probe=1` you must pass `?confirm=1` **or** `?strategy=` — otherwise 400 `:487-493`.
4. Kids strategy is one of `reassign` plus `toParentMemberId`, `cascade`, or `orphan` `:496-508`.
5. **Stripe preflight, fail-closed** `:543-626`: every subscription about to be destroyed is set `cancel_at_period_end`. No connected account plus a live subscription is a hard 422 `:594-603`. A Stripe error fails the delete `:608-618`.
6. Photo URLs of the doomed members are captured **before** the cascade, because `MemberPhoto` is `ON DELETE CASCADE` and the row is the only record of where the file lives `:530-542, 590`.

Then `deleteMemberCascade` (`lib/member-delete.ts:84-140`), in this order:

`rankHistory` (via the member's `memberRank` ids), `memberRank`, `classPackRedemption` (via `memberClassPack` ids), `memberClassPack`, `attendanceRecord`, `classSubscription`, `classWaitlist`, `loginEvent`, then `member.deleteMany(where)`.

The final delete re-uses the original `where` predicate so a concurrent mutation returns `count = 0` and the helper reports `race` rather than a phantom success `:135-138`.

Handled by the database, not the helper (`lib/member-delete.ts:15-34`):

| Table | FK behaviour | Result |
|---|---|---|
| `ClassRoster`, `MemberPhoto`, `PushSubscription`, `LoginEvent` | CASCADE | rows destroyed |
| `Payment`, `Order`, `Notification` | SET NULL | rows kept, `memberId` nulled |
| `Member.parentMemberId` (children) | SET NULL | kids orphaned, visible to staff for re-link |
| `Task.assigneeMemberId` | SET NULL | staff sent-items history preserved |
| **`SignedWaiver`** | **SET NULL** (migration `20260816090000_signed_waiver_retention_on_member_delete`) | **row RETAINED and detached** — see 3.1 |

### 2.3 GDPR erasure — exact scope

`app/api/admin/dsar/erase/route.ts`. Order is deliberate and each step is a refusal point.

1. 409 if already erased (`status = cancelled` AND email starts `deleted-`) `:95-97`.
2. **Stripe cancel first, fail-closed** `:112-145` — no connected account plus a live subscription is 422 `:119-128`; a failed cancel returns Stripe's own status `:133-143`.
3. Pre-flight read captures blob URLs and per-surface counts `:160-231` — the URLs must be read before the rows go or the files are orphaned forever ("Blob never GCs" `:151-153`).
4. **Audit row written and awaited BEFORE any destruction; if it throws, the erase is refused** `:239-270`.
5. One tenant transaction does everything else `:276-393`.
6. Blobs deleted **after** the DB commit, best-effort per file `:395-404`.

| Surface | Action | Line |
|---|---|---|
| `Member.name` | to `"Deleted member"` | `:281` |
| `Member.email` | to `deleted-<id>@deleted.invalid` (keeps the tenant/email unique satisfied) | `:284` |
| `phone`, `dateOfBirth`, all three `emergencyContact*`, `medicalConditions`, `passwordHash`, `notes`, `waiverIpAddress`, `stripeCustomerId`, `stripeSubscriptionId`, `totpSecret` | null | `:285-308` |
| `totpEnabled` | false; `totpRecoveryCodes` to `Prisma.DbNull` (real SQL NULL, not JSON null) | `:306-308` |
| `status` | `"cancelled"`; `sessionVersion` incremented to kill live JWTs | `:309-311` |
| `MemberPhoto` | rows **deleted**, blobs deleted best-effort | `:316`, `:399-401` |
| `SignedWaiver` | `signatureImageUrl`, `signerName`, `ipAddress`, `userAgent` nulled; signature blob deleted. **`titleSnapshot`, `contentSnapshot`, `acceptedAt`, `memberId` RETAINED** under Article 17(3)(e) legal-claims hold | `:318-333`, `:402-404` |
| `LoginEvent`, `PushSubscription`, `Notification` | rows deleted | `:340-345` |
| `Task` where `kind='member_note'` | rows deleted; `staff_task` untouched | `:350-352` |
| `RankHistory.notes` | nulled (reached via `memberRank.memberId` — the table has no `tenantId`) | `:361-364` |
| `MagicLinkToken`, `PasswordResetToken` | rows for the **original** email deleted, **case-insensitively** | `:375-380` |
| `EmailLog.recipient` | rewritten to the sentinel; `subject` **deliberately left alone** | `:389-392` |

**What survives an erasure**, by design: `AttendanceRecord` (so counts do not silently change), `Payment` and `Order` (tax and dispute), `MemberRank` plus `RankHistory` dates, the `SignedWaiver` content snapshot, `AuditLog` (including the `member.dsar_erase` row itself), `MemberClassPack`, `ClassRoster`, `ClassWaitlist`, `ClassSubscription`, and every `EmailLog.subject` string.

### 2.4 Tenant soft-delete, then purge

**Step 1 — soft delete.** `POST /api/admin/customers/[id]/soft-delete` `:28`. Operator-only (`isAdminAuthed` `:29`), 20/hr per operator+IP `:32`, and the operator must retype the exact gym name `:54-56`. Then, atomically `:99-103`: `Tenant.deletedAt = now`, and `sessionVersion` incremented on **every** `User` and **every** `Member` so all sessions die instantly. Stripe subscriptions are cancelled first — but **fail-open**: failures are counted into `stripeFailed` / `stripeFailedIds` in the audit metadata and the route still returns 200 `:74-92, 105-123`. `DELETE` on the same route restores by nulling `deletedAt` `:126-161` — it does **not** un-bump `sessionVersion` and does **not** un-cancel Stripe.

**Step 2 — nightly purge.** `app/api/cron/retention/route.ts`, scheduled `30 3 * * *` in `vercel.json`. Candidates are `deletedAt < now - 30d`, oldest first, **max 2 per run** `:394-401`.

Refusal conditions, in order:

- `elapsed() > 240_000` stops new tenants being started `:412-415`.
- `cancelTenantSubscriptions` fails, so the **whole tenant is skipped**, the reason recorded, retried tomorrow `:424-429`. Reasons: any member still carries a `stripeSubscriptionId` while the tenant has no `stripeAccountId` `:487-494`, or any single cancel call fails `:503-510`.
- A member batch that removes zero rows throws `tenant <id>: member purge stalled` — deliberately loud rather than looping `:765-767`.

Destruction order inside `purgeTenant` `:540-712`:

| # | What | Line |
|---|---|---|
| 1 | `Task`, batched | `:551-556` |
| 2 | **Members, kids first**, in two passes (`parentMemberId != null`, then everything). Required because migration `20260515000001` adds a non-deferrable CHECK `accountType <> 'kids' OR parentMemberId IS NOT NULL`, and the `SET NULL` fired by deleting a parent would abort the entire transaction | `:558-586` |
| 2a | Per batch of 10: `MemberPhoto.url` and `SignedWaiver.signatureImageUrl` blobs deleted **before** the rows | `:721-762` |
| 3 | `AttendanceRecord`, `ClassWaitlist`, `ClassInstance` by class id, then `ClassSchedule`, `ClassSubscription`, `ClassRoster`, `Class` | `:590-622` |
| 4 | `RankRequirement`, `RankSystem` | `:627-630` |
| 5 | `MemberPhoto`, `PushSubscription`, `LoginEvent`, `Notification`, `Announcement`, `MembershipTier`, `SignedWaiver`, `MemberClassPack`, `ClassPack`, `MagicLinkToken`, `PasswordResetToken`, `EmailLog`, `Payment`, `Dispute`, `Order`, `Product`, `MonthlyReport`, `Initiative` (attachments CASCADE), `GoogleDriveConnection`, `IndexedDriveFile` | `:634-660` |
| 6 | `ImportJob` — **blobs first**, then rows | `:663-673` |
| 7 | `User` (PasswordHistory CASCADEs; `AuditLog.userId` SET NULL) | `:678-683` |
| 8 | Tenant logo blob, then `auditLog.create("admin.tenant.hard_deleted")` **and** `tenant.delete` in the **same transaction** | `:689-709` |

**Deliberately kept: `AuditLog`.** `AuditLog.tenantId` carries no FK (`prisma/schema.prisma:632`), so those rows outlive the tenant and expire on their own 365-day rule. Rationale at `:526-531`: the erasure-evidence trail, including the `member.dsar_erase` rows a restore has to replay per `docs/runbooks/db-restore.md`, must outlive the data it attests to.

### 2.5 Time-based purges (same cron, independent rules)

Every rule is independent (own try/catch), chunked at 1000 rows per transaction, and stops at 240s reporting `partial` rather than failing `:16-31, 272-294`. A failed rule makes the whole response **500** so uptime monitoring can see it `:245-262`.

| Rule | Predicate | Window | Line |
|---|---|---|---|
| `auditLog` | `createdAt <` | 365 d | `:68, 167-175` |
| `emailLog` | `createdAt <` | 365 d | `:69, 176-184` |
| `magicLinkToken` | `expiresAt <` | expiry plus 24 h grace, so "expired" stays distinguishable from "invalid" | `:70-75, 185-193` |
| `passwordResetToken` | `expiresAt <` | expiry plus 24 h | `:194-202` |
| `rateLimitHit` | `hitAt <` | 1 d | `:76-77, 203-211` |
| `stripeEvent` | `processedAt <` | 90 d | `:78-79, 212-222` |
| `importJob` | `status NOT IN ('complete') AND createdAt <` — **blob deleted before the row** | 30 d | `:80-81, 101, 223, 298-334` |
| `importJobDiagnostics` | nulls `dryRunSummary` and `errorLog` on **all** jobs including `complete` ones | 30 d | `:82-90, 224-227, 355-368` |
| `tenantHardDelete` | `deletedAt <` | 30 d, max 2/run | `:91-92, 228, 388-455` |

Not covered by any rule, deliberately: `Announcement.expiresAt` — "nothing is destroyed automatically, so the retention cron must NOT prune these" (`prisma/schema.prisma:523-527`).

### 2.6 Other removals

| Thing | Route | Semantics |
|---|---|---|
| Class | `DELETE /api/classes/[id]` `:441` | **Sets `isActive: false` only** `:481-486`. Refuses with 409 if attendance or roster history exists unless `?force=true` `:469-478`. See 7.4 — `Class.deletedAt` is never written by any code path |
| Product | `DELETE /api/products/[id]` | soft, `deletedAt: new Date()` `app/api/products/[id]/route.ts:73` |
| Rank system | `DELETE /api/ranks/[id]` | soft, `deletedAt: new Date()` `app/api/ranks/[id]/route.ts:109` |
| Tenant | `POST /api/admin/customers/[id]/soft-delete` | soft, `deletedAt` `:100` |
| Staff user | `DELETE /api/staff/[id]` `:135` | **hard**. Owner only `:143`; cannot delete self `:149`; `role: { not: "owner" }` in the predicate so the last owner survives `:156`. `PasswordHistory` CASCADEs; `AuditLog.userId`, `Class.coachUserId`, `AttendanceRecord.checkedInById` and all three `Task` user FKs SET NULL |
| Attendance | `DELETE /api/checkin` `:169` | hard, staff only `:176`. **Restores any class-pack credit the record consumed, in the same transaction** `:198-199` |
| Announcement | `DELETE /api/announcements/[id]` | hard plus blob `del()` `:87-100` |
| Member photo, staff side | `DELETE /api/members/[id]/photos` | hard plus blob `del()` `:161-170` |
| Profile picture | `DELETE /api/members/[id]/profile-picture` | hard plus blob `del()` `:222-232` |
| Promotion photo replacement | `POST /api/members/[id]/rank` | old `kind='promotion'` photos blob-deleted, then rows deleted `:173-196` |
| Orphan blob | `POST /api/upload/delete-orphan` `:39` | CSRF plus any session; the URL must be a Vercel Blob URL **and** start `/tenants/<callerTenantId>/` `:63-78`. Returns 200 even on failure `:84-89`. No audit row on success, by design `:16-17` |

---

## 3. WHAT EACH REMOVAL LEAVES BEHIND

### 3.1 Hard member delete

| Residue | Where | Consequence |
|---|---|---|
| **Detached `SignedWaiver`** with `signerName`, `contentSnapshot`, `ipAddress`, `userAgent` and a **live signature blob** | `prisma/schema.prisma:652-677`; helper skips it `lib/member-delete.ts:125-127`; blob explicitly not cleaned `app/api/members/[id]/route.ts:540-542` | Intentional legal hold. But `memberId` is now NULL, so the row is unreachable by member and only reachable by `tenantId`. No UI reads waivers by tenant alone — **UNVERIFIED** whether any surface lists detached waivers |
| `Payment`, `Order`, `Notification` rows with `memberId = null` | SET NULL FKs, `schema.prisma:863-864, 941-942, 502-503` | `/api/payments/export.csv` renders these with a blank name and email `:41-42` — the money is still in the ledger, the person is not |
| Orphaned kids under `strategy=orphan` | `lib/member-delete.ts:237-244` | `accountType` forced `kids` to `junior` to satisfy the CHECK; `parentMemberId` nulled by the FK. `scripts/find-orphan-kids.mjs` exists precisely to find them |
| `AuditLog` rows for the member | `entityType='Member', entityId=<id>` | survive 365 days; that is the only record the person existed |
| Stripe `Customer` object | never deleted anywhere in the codebase (`grep` for `customers.del` returns nothing) | the customer, its saved cards and its invoice history stay in the connected account forever. Only the **subscription** is cancelled |
| In-flight emails | `EmailLog` rows keyed by `recipient` string, not `memberId` | survive with the real address until the 365-day rule |

### 3.2 Parent-side kid delete — strictly worse

`app/api/member/children/[id]/route.ts:293-299` calls `deleteMemberCascade` directly. It has the same fail-closed Stripe preflight `:241-291`, but it **never reads the kid's `MemberPhoto.url` values**. `MemberPhoto` is `ON DELETE CASCADE`, so Postgres destroys the rows — and with them the only pointer to the files.

**Every photo of a kid deleted by their own parent is orphaned in Vercel Blob, permanently.** The staff route fixed exactly this bug (`app/api/members/[id]/route.ts:530-542`); the parent route was not updated.

### 3.3 GDPR erase

| Residue | Where |
|---|---|
| `SignedWaiver` content and dates, `memberId` intact | `erase/route.ts:318-333` — deliberate |
| `AttendanceRecord`, `Payment`, `Order`, `MemberClassPack`, `ClassRoster`, `MemberRank` | untouched |
| `EmailLog.subject` strings, which can contain a name (`"Welcome to X, <name>!"` is a body, but `rank_promoted` puts the rank in the subject) | `erase:383-388` explicitly accepts this residual risk |
| Orphaned blob files whenever `del()` throws | `erase:419-426` warns and continues; the warning names the row so a human can clean up. There is **no** sweep that ever revisits them |
| The `member.dsar_erase` audit row itself | `:240-263` — required evidence, expires at 365 days |

### 3.4 Tenant purge

| Residue | Where |
|---|---|
| **`AuditLog` for the whole gym** | deliberate, `:526-531` |
| Stripe connected account, customers, invoices, payouts | nothing in the purge touches the account itself; only subscriptions are cancelled `:470-514` |
| **`ImportJob` rows with `status = "pending_white_glove"`** | the white-glove route writes a status the cron's `IMPORT_JOB_TERMINAL_STATUSES = ["complete"]` list does not exempt (`csv-handoff:92` vs `retention:101`). So a handoff CSV nobody imported within 30 days has its blob **and** its row destroyed by rule `importJob`, with only an `onboarding.csv_handoff` audit row left |
| Any blob whose `del()` failed | `deleteBlobsBestEffort:375-384` swallows and returns 0 |
| Rows in a partially-purged tenant | committed batches stand, `deletedAt` stays set, tomorrow resumes `:436-441` |

### 3.5 Blob-orphan inventory (rows deleted, file left behind)

| Site | Deletes row | Deletes blob |
|---|---|---|
| `app/api/members/[id]` DELETE (staff) | yes | **yes** `:672, 706-730` |
| `app/api/member/children/[id]` DELETE (parent) | yes, via CASCADE | **NO** |
| `app/api/member/children/[id]/photos/[photoId]` DELETE | yes `:54-57` | **NO** |
| `app/api/initiatives/[id]/attachments` DELETE | yes `:111` | **NO** — `InitiativeAttachment.blobUrl` never `del()`'d |
| `app/api/initiatives/[id]` DELETE | yes `:74`, attachments CASCADE (`schema:718`) | **NO** |
| `app/api/members/[id]/photos` DELETE | yes | yes `:161-170` |
| `app/api/members/[id]/profile-picture` DELETE | yes | yes `:222-232` |
| `app/api/announcements/[id]` DELETE | yes | yes `:87-100` |
| `app/api/members/[id]/rank` POST (replacing a promotion photo) | yes | yes `:173-196` |
| `admin/dsar/erase` | yes | yes, best-effort `:399-404` |
| `cron/retention` member drain and import purge | yes | yes, best-effort `:736-751, 663-673` |
| Tenant logo on tenant purge | yes | yes `:689-691` |
| **Tenant logo replaced via settings** | n/a | **UNVERIFIED** — no `del()` found in `app/api/settings/route.ts` |

---

## 4. EXPORT / READ-OUT, AND EXTERNAL WRITE-IN

### 4.1 Everything that leaves the system as a file

There are exactly **four** file-producing surfaces. Two are server routes with `Content-Disposition: attachment`; two are client-side `Blob` downloads.

| Export | Route / file | Guard | Rate limit | Content |
|---|---|---|---|---|
| **DSAR / Article 15 subject export** | `GET /api/admin/dsar/export` `app/api/admin/dsar/export/route.ts:76` | `requireApiOwner` `:77` | 10/hr per tenant `:85` | One JSON file, `_meta.version: 2`. See 4.2 |
| **Payments CSV** | `GET /api/payments/export.csv` `:13` | `requireApiOwnerOrManager` `:14` | 10/hr per tenant `:18` | Date, member name, **member email**, amount pence, currency, status, description, Stripe invoice id, Stripe payment-intent id, refunded-at, refunded pence. `take: 5000`, no cursor, **no truncation marker** `:26-33` |
| **Reports CSV** | client-side, `components/dashboard/ReportsView.tsx:95-126` | whatever gated `/api/reports` (owner/manager) | none | **Aggregates only** — totals, weekly attendance, monthly signups, top classes, members-by-status, check-in methods. No member-level PII |
| **Operator tenants CSV** | client-side, `app/admin/tenants/TenantsList.tsx:85-107` | operator console | none | Gym, slug, **owner name, owner email**, member count, status, Stripe flags, created. Cross-tenant by design |

Notably absent: **there is no member-roster CSV export.** A gym can import members but cannot export them. See 7.1.

### 4.2 What the DSAR export actually contains

Included (`app/api/admin/dsar/export/route.ts:110-446`): the Member row's PII columns with an explicit allow-list select `:112-133`; parent and children summaries; attendance, payments, orders, signed waivers (each capped at `CAP_HISTORY = 5000` `:66`); class subscriptions, class packs and redemptions; ranks and rank history **including free-text `notes`** `:289-301`; email logs and audit logs (`CAP_LOG = 1000` `:67`); `MemberPhoto` **metadata only**; `LoginEvent`; `PushSubscription` endpoint and date only; waitlists; rosters; `member_note` Tasks; magic-link and password-reset tokens **as counts plus latest date** `:436-445`.

Deliberately excluded `:32-36, 127-128`: `passwordHash`, `totpSecret`, `totpRecoveryCodes`, `sessionVersion`, `failedLoginCount`, `lockedUntil`, push `p256dh`/`auth` keys, token hashes, **and every raw blob URL**.

Two specific hardenings worth naming:

- `signatureImageUrl` is rewritten to `/api/waiver/<id>/signature` `:508-511`. The storage URL never leaves the server.
- `MemberPhoto.url` is **not even selected from the database** `:355-358` — because the proxy form `/api/blob-image?url=<encoded>` still embeds the raw storage URL, and for photos uploaded before commit `efebb33` the store was public `:341-354`.

Every capped section is `{ items, total, truncated }` so the export cannot silently under-report `:69-74, 587-597`. The audit row stores `hashToken(member.email)`, never the address, so re-running an export on an erased member does not re-plant their email in `AuditLog` `:613-630`.

### 4.3 Read-out surfaces that are not files

| Surface | Route | Guard |
|---|---|---|
| Signature PNG bytes | `GET /api/waiver/[signedWaiverId]/signature` `:27` | session; staff of the tenant **or** the member themselves `:45-52`; audited as `waiver.signature.view` `:56-64`; tenant-scoped lookup returns 404 not 403 `:33-43` |
| Any private blob's bytes | `GET /api/blob-image` `:54` | session `:55-58`; URL must match `isVercelBlobUrl` `:63`; pathname must start `/tenants/<callerTenantId>/` `:72-84`; non-image content types downgraded to `application/octet-stream` attachment `:129-137` |
| Member directory | `GET /api/members` `:43` | staff-only `:49-50`, `Cache-Control: private, no-store` `:131` |
| Audit log | `GET /api/audit-log` | `requireApiOwner` |

### 4.4 External write-in — Stripe

`POST /api/stripe/webhook`. Signature-verified, then **claim-and-process**: `stripeEvent.create({ eventId })` inside the same transaction as the handler, so the unique constraint on `StripeEvent.eventId` is the idempotency lock `:149`. Unhandled types are acked **without** claiming, so a future handler is not permanently starved `:42-66`.

16 handled types `:46-62`: `customer.subscription.deleted|updated`, `invoice.payment_failed|succeeded|voided`, `checkout.session.completed`, `payment_intent.processing|succeeded`, `mandate.updated`, `charge.refunded`, `customer.deleted`, `payment_method.detached`, `charge.dispute.created|updated|closed`, `account.updated`.

Rows Stripe can create or mutate without any human in MatFlow:

| Write | Line |
|---|---|
| `StripeEvent` (the idempotency claim) | `:149` |
| `Member.paymentStatus`, `stripeSubscriptionId` etc. via `updateMany` | `:226, 782` |
| `Payment` **upsert** — five separate call sites | `:266, 388, 464, 549, 743` |
| `MemberClassPack` **create** — a member buying a pack materialises the row from the webhook | `:453` |
| `Order.status` flip to paid | `:526` |
| `Dispute` upsert | `:851` |
| `Tenant.stripeAccountStatus` cache refresh on `account.updated` | `:191` |

### 4.5 External write-in — Resend

`POST /api/webhooks/resend`. svix-verified; **503 in production if `RESEND_WEBHOOK_SECRET` is unset**, unsigned events accepted only in dev `:42-64`. It only ever **updates** `EmailLog` — it never creates rows `:141-149`. A `STATUS_RANK` ladder stops an out-of-order `delivered` overwriting a terminal `bounced` or `complained` `:31-39, 135-139`. Unknown events, opens and clicks are acked and dropped `:112-118`.

### 4.6 Cron-created rows

| Cron | Schedule (`vercel.json`) | Creates |
|---|---|---|
| `/api/cron/class-instances` | `40 2 * * *` | `ClassInstance` rows on a 56-day rolling horizon, all tenants |
| `/api/cron/monthly-reports` | `0 2 1 * *` | one `MonthlyReport` per tenant where `subscriptionStatus in (active, trial)` and `deletedAt: null` `:44-51`. **503s the entire run if `ANTHROPIC_API_KEY` is unset** `:28-34` |
| `/api/cron/retention` | `30 3 * * *` | one `AuditLog` row per hard-deleted tenant `:693-707`. Also runs Stripe reconciliation first `:158-164` |
| `/api/cron/stripe-reconcile` | **not in `vercel.json`** — folded into retention because the Vercel Hobby plan allows only 2 cron entries (comment `retention:146-156`, though `vercel.json` now lists 3) | mutates `Payment` rows from a 72h Stripe lookback |

---

## 5. CORRECTION PATHS — WHO CAN EDIT WHAT AFTER CREATION

### 5.1 Member fields

| Field | Staff (`PATCH /api/members/[id]`) | Member (`PATCH /api/member/me`) | Notes |
|---|---|---|---|
| `name` | yes, 1-100 | yes, 1-120 trimmed | |
| `email` | yes, `z.string().email()` | yes — **unless structural** | Self-edit refuses when `accountType === "kids"`, or the address ends `@no-login.matflow.local`, or ends `@deleted.invalid` `member/me:365-383` |
| `phone` | yes, normalised to E.164 with UK shortcuts `lib/schemas/member.ts:8-30` | yes, same field | |
| `emergencyContact` name/phone/relation | yes | yes | Also written by the staff-device waiver route `members/[id]/waiver/sign:116-125` |
| `medicalConditions` | **NO** — absent from `memberUpdateSchema` | **yes**, as `JSON.stringify(array)` `member/me:386` | Staff can read it (`members/[id]` GET `:63`) but cannot correct it |
| `status` | yes, enum active/inactive/cancelled/taster | **NO** | Transition **to** cancelled stamps `cancelledAt` once `:317` and cancels Stripe fail-closed `:269-298` |
| `paymentStatus` | yes, enum of 6 | **NO** | Deliberate manual override for cash-at-the-desk `lib/schemas/member.ts:52-59` |
| `notes` | yes, sanitised, max 2000 | **NO** | `notesField(2000)` strips control, zero-width and bidi-override chars **before** the length check |
| `dateOfBirth` | yes | yes | Staff path refuses future dates on create `:218-223`; **the PATCH path does not re-check** |
| `accountType` | **NO** on PATCH — only settable at create | **yes**, clamped to `parent` or `adult` only `member/me:395-398` | `kids` / `junior` are staff-managed |
| `hasKidsHint`, `classReminders`, `beltPromotions`, `gymAnnouncements` | no | yes | |
| `waiverAccepted` | no | **yes** — and it mints a `SignedWaiver` `member/me:440-475, 533-552` | See 5.3 |
| `totpEnabled`, `totpSecret`, `totpRecoveryCodes` | **immutable** — `stripTotpFields` runs on the body `:216` | **immutable** — same strip `member/me:287` | Only three routes may clear them: `/api/admin/customers/[id]/totp-reset`, `/api/admin/customers/[id]/member-totp-reset`, `/api/members/[id]/totp-reset` (`lib/totp-immutable.ts:1-14`) |
| `passwordHash`, `sessionVersion`, `failedLoginCount`, `lockedUntil` | not in any schema | not in any schema | Changed only by auth flows and `/api/members/[id]/unlock` |
| `tenantId`, `id`, `joinedAt` | never | never | |

Concurrency and rate limits on the staff PATCH: optimistic lock on `updatedAt` when the client sends one, returning 409 with `currentUpdatedAt` `:231, 376-381`; 60 PATCHes/hour per (tenant, user) `:23-24, 196-206`. Every PATCH writes a from-to diff into `AuditLog.metadata.changes` over 10 diffable fields — `notes` is deliberately excluded `:389-405`.

### 5.2 The one field that is permanently frozen

Once a member has been GDPR-erased (email matches `/^deleted-.*@deleted\.invalid$/`), **any** `status` transition other than to `cancelled` is refused with 422: *"This member has been erased under GDPR Article 17 and cannot be reactivated."* `app/api/members/[id]/route.ts:260-265`. There is no override route. The row is a permanent tombstone.

### 5.3 Waivers — five acceptance paths, three different bars

| Path | Auth | Signature image? | Emergency-contact trio required? |
|---|---|---|---|
| `POST /api/waiver/sign` `:45` | member session `:48-52` | **yes**, PNG magic-byte checked `:69-70` | **YES** — 400 without all three `:87-92` |
| `POST /api/waiver/sign-for-child` `:57` | parent session | **yes** | **YES**, on the **parent's** trio `:108-113` |
| `POST /api/members/[id]/waiver/sign` `:50` | staff session, any of the 4 roles `:54-55` | **yes** | **NO** — the trio is **required in the request body** and **written onto the member** `:30-32, 116-125` |
| `PATCH /api/member/me` with `waiverAccepted: true` `:440` | member session | **NO** — creates a `SignedWaiver` with a null `signatureImageUrl` `:541-551` | **YES** `:459-465` |
| `POST /api/waiver/open` `:56` | **none** — a `waiver_open` magic-link token is the whole credential `:76-92` | **NO** `:109-121` | **NO** |

`POST /api/waiver/open` is therefore the escape hatch from the emergency-contact wall, and the only unauthenticated write path to `SignedWaiver`. It is minted by `POST /api/waiver/kiosk-request` (kiosk device token plus a signed member token), sends the `kiosk_waiver` email, invalidates prior unused `waiver_open` tokens, and expires in 24 hours `waiver/kiosk-request:73-105`.

A `SignedWaiver` row is **append-only** — no route anywhere updates one except the DSAR scrub (`erase:325-333`). Re-signing creates another row; the DSAR export orders by `acceptedAt desc` `:241`.

### 5.4 Payments and money

| Action | Route | Who | Mutability |
|---|---|---|---|
| Record a manual payment | `POST /api/payments/manual` | `requireApiOwnerOrManager` | `Payment.status` hard-coded `"succeeded"` `:109`; `amountPence` must be ≥1 unless the method is free `:37-41` |
| Refund | `POST /api/payments/[id]/refund` `:47` | `requireApiOwner` `:57` | CSRF first `:50`; 30 per 5 min per tenant `:14-15`; **optimistic lock on `refundedAmountPence`** — a concurrent refund yields 409, not 500 `:29-35`; `subscriptionAction` is **required** for subscription invoices so money is never refunded while the sub keeps billing `:42-44` |
| Mark order paid | `POST /api/orders/[id]/mark-paid` | `requireApiOwnerOrManager` | stamps `paidByUserId` |
| Everything else on `Payment` | **only** the Stripe webhook and the reconcile cron | — | There is **no** route to edit an existing `Payment` amount, date or description. Effectively immutable |

### 5.5 Attendance and ranks

- **Attendance**: staff can delete a check-in (`DELETE /api/checkin:169`), which **restores the class-pack credit it consumed in the same transaction** `:198-199`. There is no route to edit `checkInTime` or `checkInMethod` — `checkInMethod` is re-derived server-side on create and never trusted from the client `:57-62`.
- **Ranks**: promote via `POST /api/members/[id]/rank` (owner/manager/**coach**), demote via `POST /api/members/[id]/rank/demote` (owner/manager/**admin**, not coach). Both append a `RankHistory` row. Demotion can additionally delete `ClassSubscription` rows for classes the member no longer qualifies for `rank/demote:127`. `RankHistory` rows are never updated except for the DSAR `notes` scrub.
- **Class**: `PATCH /api/classes/[id]` rebuilds instances — it `deleteMany`s future `ClassInstance` rows `:182` when the schedule changes.

---

## 6. THE RUNBOOK — adding a new club end to end, today

Every step names the real route or script. Breakages are marked **BREAKS HERE**.

### Step 0 — the operator must exist and hold TOTP

There is no UI to create an `Operator`. Run `node scripts/seed-operator-noe.mjs` against `DATABASE_URL` (82 lines; writes the `Operator` row). Then:

1. `POST /api/admin/auth/operator-login` with email and password. 5 attempts / 15 min per IP `:31`. Returns `{ totpRequired: true }` plus a short-lived challenge cookie if TOTP is already on `:5-7`.
2. First time only: `GET /api/admin/auth/operator-totp/setup` returns `{ secret, qrDataUrl }` and persists `totpSecret` with `totpEnabled: false` `:50-60`. `POST` the 6-digit code to enable it, which bumps `sessionVersion` and re-issues the session cookie `:2-6`.
3. Thereafter `POST /api/admin/auth/operator-totp` completes login and sets the HMAC-signed `matflow_op_session` cookie.

Lockout recovery: `scripts/reset-totp-noe.mjs`, `scripts/reset-totalbjj-owner-totp.mjs`, `scripts/clear-rate-limit.ts`.

### Step 1 — create the tenant

**Preferred, via the funnel:** the club submits `POST /api/apply` (public, unauthenticated), then the operator calls `POST /api/admin/applications/[id]/approve`. That one call `approve/route.ts:93-186`:

- slugifies the gym name, retrying up to 5 times with a 2-byte hex suffix on collision `:78-84`;
- creates `Tenant` plus owner `User` with `role: "owner"` and a **random 24-char temp password the owner never sees** `:86-114`;
- mints a `MagicLinkToken`, `purpose: "first_time_signup"`, **30-minute expiry** `:125-138`;
- flips the application to `approved`, audits as `admin.application.approve`;
- sends the `owner_activation` email carrying `/api/magic-link/verify?token=…&tenantSlug=<slug>` plus the club code `:164-184`.

**If `RESEND_API_KEY` is unset**, the link is only `console.warn`'d into the Vercel log `:182-183`, and `activationLink` comes back in the response body **only when `NODE_ENV !== "production"`** `:192`. In production with email down, the owner cannot be activated from the API response at all.

**Alternative, direct:** `POST /api/admin/create-tenant` with an operator-chosen password, handed over out of band. That route sends no email.

### Step 2 — owner activation and first sign-in

The owner clicks the activation link within **30 minutes** `:126`. If they miss it, the email tells them to use the Forgot-password flow `lib/email.ts:258`. They then set a real password via Settings, Account.

### Step 3 — owner enables TOTP

`GET/POST /api/auth/totp/setup`, then `POST /api/auth/totp/recovery-codes` to mint 8 HMAC-hashed recovery codes (`prisma/schema.prisma:92`). Once `totpEnabled` is true the owner **cannot self-disable**; only `POST /api/admin/customers/[id]/totp-reset` (operator) can clear it (`lib/totp-immutable.ts:5-11`).

### Step 4 — bring the members in (CSV)

Two routes, and the choice is load-bearing.

**Self-serve** — `POST /api/admin/import/upload` (owner, multipart, 10 MB, source in generic/mindbody/glofox/wodify), then `POST /api/admin/import/[id]/preview`, then `POST /api/admin/import/[id]/commit`. Commit fetches the private blob via `head().downloadUrl` `:41-47`, parses, inserts in batches of 25, deletes the blob, and emails the owner `import_complete`.

**White-glove** — `POST /api/onboarding/csv-handoff` (wizard step 13). Writes `ImportJob` with `status: "pending_white_glove"` and emails MatFlow. To actually import it, the operator has to reach the tenant's own owner-gated import routes — via `POST /api/admin/impersonate` or the owner's credentials — because `commit` is `requireApiOwner`, not operator-authed. The commit route does accept `pending_white_glove`, since it only rejects `running` and `complete` `:27-29`.

**BREAKS HERE (1) — private-blob `downloadUrl`.** `commit:41-47` and `preview:25` resolve `head(url).downloadUrl` and then plain-`fetch` it. `app/api/blob-image/route.ts:17-27` documents that in `@vercel/blob@2.3.3` the `downloadUrl` is the plain blob URL with `?download=1` appended and carries **no credential**, while the SDK's own reader must send `Authorization: Bearer <BLOB_READ_WRITE_TOKEN>`. Uploads are written `access: "private"`. The `catch` around `head()` `:45` only covers `head()` itself throwing — a 403 on the subsequent `fetch(fetchUrl)` surfaces as `Failed to fetch file (403)` and the job is marked `failed`. The proven-correct pattern is `get(url, { access: "private" })` and streaming the body, exactly as `blob-image` does. The same shape sits in `app/api/waiver/[signedWaiverId]/signature/route.ts:85-93`.

**BREAKS HERE (2) — no emergency-contact columns.** `MemberDraft` (`lib/importers/index.ts:7-17`) carries name, email, phone, DOB, membershipType, status, accountType, notes, joinedAt. No emergency contact, no medical conditions, no rank. Every imported member therefore fails the wall in step 6.

### Step 5 — bulk invite

`POST /api/members/bulk-invite` with no body targets every eligible member (`accountType != "kids"`, `passwordHash: null`), capped at 500.

**BREAKS HERE (3) — Resend free tier.** The route loops **sequentially, unthrottled, unbatched** `:80-116`. Resend's free tier is documented at 100/day and 3,000/month (`docs/EMAIL-HUB-SPEC.md:109`), and `docs/audit/CONNECTION-AUDIT-2026-08-22.md:38` flags precisely this: "plan tier (100/day cap vs ~200-member invite day)". Sends past the cap return `result.error`, are written to `EmailLog` as `status: "failed"` `lib/email.ts:413-421`, and land in the response's `failed[]`. **The tokens are still minted** `:90-98`, so the invite links exist and stay valid for 7 days — they simply were not delivered. Re-running bulk-invite invalidates those tokens and mints new ones `:86-89`, so a retry the next day is safe but resets the clock. Mitigations available today: pass explicit `memberIds` slices of roughly 90 per day, or upgrade the Resend plan.

Second-order effect: any address that hard-bounces or complains is frozen for 30 days across the whole tenant by the pre-send check `lib/email.ts:350-385`, with no UI to clear it.

### Step 6 — first waiver

The member logs in with their invite link, sets a password, and hits `POST /api/waiver/sign`.

**BREAKS HERE (4) — the emergency-contact wall.** `app/api/waiver/sign/route.ts:87-92` returns 400 unless `emergencyContactName`, `emergencyContactPhone` **and** `emergencyContactRelation` are all non-blank on the row already. CSV import cannot supply them (break 2), and `POST /api/members` does not accept them either — `memberCreateSchema` has no emergency fields `lib/schemas/member.ts:32-40`. Three ways through:

1. The member fills them in first via `PATCH /api/member/me`; the onboarding flow does this and enforces the same trio before `onboardingCompleted: true` `member/me:404-430`.
2. Staff collect on a device: `POST /api/members/[id]/waiver/sign` **requires the trio in the request body and writes it onto the member** `:30-32, 116-125`. This is the only path that both captures a signature and fills the gap.
3. Kiosk link: `POST /api/waiver/kiosk-request` then `POST /api/waiver/open` — **no trio required, no signature captured, no session needed** `waiver/open:56-121`.

### Step 7 — first check-in

Requires a `ClassInstance` to exist.

1. `POST /api/classes` creates the class and its `ClassSchedule` rows.
2. `POST /api/instances/generate` (owner/manager, default 4 weeks, max 52) materialises instances immediately. **Do not skip this** — the nightly cron at `40 2 * * *` will not have run yet, and without instances `/api/member/schedule` returns `classInstanceId: null`, which silently disables check-in on both sides (`cron/class-instances:10-19`).
3. Check in via `POST /api/checkin` (staff or member) or the kiosk.
4. Kiosk: `POST /api/settings/kiosk` with `action: "enable"` (owner only) mints a 24-byte base64url token, stores only its HMAC in `Tenant.kioskTokenHash`, and **returns the raw token exactly once** `settings/kiosk:5-11, 35-37`. Print it or lose it — recovery is `regenerate`, which invalidates the old URL.

### Step 8 — first payment

1. `GET /api/stripe/connect` starts Connect OAuth; `/api/stripe/connect/callback` stores `Tenant.stripeAccountId` (unique — one account per club, `schema.prisma:27`).
2. Configure the webhook; `scripts/setup-stripe-webhook.mjs` exists for this. It must be subscribed to all 16 types in `HANDLED_EVENT_TYPES` `webhook:46-62`, or the corresponding rows silently never appear.
3. Create a `MembershipTier` (`POST /api/memberships`) and wire it to a Stripe price.
4. Either the member self-subscribes (`POST /api/member/subscriptions/start`) or staff record cash (`POST /api/payments/manual`, which writes `status: "succeeded"` directly).
5. Verify with `scripts/verify-stripe.mjs` and `scripts/refresh-stripe-account-status.mjs`.

**Watch for:** `Tenant.stripeAccountStatus` is a **cache**, refreshed only by the `account.updated` webhook `schema.prisma:29`, `webhook:191`. If the webhook is not wired, the dashboard's Stripe health is stale indefinitely — which is exactly why `scripts/refresh-stripe-account-status.mjs` exists.

### Step 9 — verification sweep

`scripts/check-db-state.mjs`, `scripts/verify-login.mjs`, `scripts/find-orphan-kids.mjs`, `scripts/inspect-blob-urls.mjs`, `scripts/diagnose-blob.mjs`, `scripts/introspect-integrity.ts`, `scripts/check-stats-accuracy.ts`.

---

## 7. GAPS, RANKED

Ranked by damage to a real club, not by code severity.

### 7.1 Data that can enter but never leave

| # | Gap | Evidence |
|---|---|---|
| **G1** | **There is no member-roster export.** A club can import 200 members from Glofox and then has no supported way to get them back out. The only member-level export is the **per-member** DSAR JSON, rate-limited to 10/hr per tenant `dsar/export:85` — so exporting 200 members takes 20 hours. `/api/payments/export.csv` exports money, not people; the reports CSV is aggregates only. This is a lock-in objection a prospect will raise, and it is also the GDPR Article 20 portability answer | four export sites in total: `grep Content-Disposition` and `grep "text/csv"` over `app/` and `components/` |
| **G2** | Invite links whose email failed are **unrecoverable**. `bulk-invite` stores only `hashToken(token)` `:94` and its response is `{ invited, eligible, failed }` `:133` — the raw token never leaves the function. The single-member `POST /api/members` **does** return `inviteUrl` `:323`; the bulk path does not. After a Resend cap-out the operator's only move is to re-run bulk-invite, which invalidates and re-mints | `bulk-invite:90-100, 133` vs `members/route.ts:304, 323` |
| **G3** | A bounced address is frozen for 30 days tenant-wide with **no UI to clear it**. The code's own comment says the operator clears it by deleting or updating the offending `EmailLog` row — i.e. by hand, in SQL | `lib/email.ts:350-385` |
| **G4** | `Member.medicalConditions` can be written by the member (`member/me:386`) and read by staff (`members/[id]` GET `:63`) but **staff cannot correct it** — the field is absent from `memberUpdateSchema` | `lib/schemas/member.ts:43-70` |
| **G5** | Photos stored as `data:` URLs (the Blob-unavailable fallback) are excluded from the DSAR export entirely, because the export deliberately emits **no** photo URL of any kind. For those members the image sits in Postgres and is unreachable through any export | `upload:243-250`; `dsar/export:341-358, 515-523` |

### 7.2 Data that can leave but never enter

| # | Gap | Evidence |
|---|---|---|
| **G6** | **The importer's field set is far narrower than the export's.** `MemberDraft` supports 9 fields. The DSAR export emits emergency contacts, medical conditions, ranks, rank history, attendance, payments, waivers, class packs and rosters. **None of those can be imported.** A club migrating in loses its grading history, attendance history and waiver record — the three things a BJJ gym actually cares about | `lib/importers/index.ts:7-17` vs `dsar/export:110-446` |
| **G7** | Emergency contacts specifically: importable **no**, settable at member-create **no**, required to sign a waiver **yes**. This is the single most expensive interaction in the product | `importers/index.ts:152-197`; `schemas/member.ts:32-40`; `waiver/sign:87-92` |
| **G8** | Ranks and belts cannot be imported, and there is no bulk-promote route. Every migrated member starts unranked and must be promoted one at a time through `POST /api/members/[id]/rank` | no rank key in `MemberDraft`; no bulk route in the full `app/api` inventory |

### 7.3 Data that can be destroyed without record

| # | Gap | Evidence |
|---|---|---|
| **G9** | **`AuditLog` expires at 365 days, unconditionally — including `member.dsar_erase` and `admin.tenant.hard_deleted`.** The tenant purge goes to real trouble to preserve audit rows past the tenant's death `:526-531`, then the `auditLog` rule in the same file deletes them a year later. After 366 days there is no record that a gym ever existed, that a GDPR erasure was fulfilled, or who ordered either. `docs/runbooks/db-restore.md` is cited as depending on replaying `member.dsar_erase` rows | `retention:68, 167-175` vs `:526-531` |
| **G10** | **Parent-side kid deletion orphans every photo of that child in Blob.** Rows CASCADE, the URLs go with them, no `del()` is ever called. The staff route fixed this exact bug; the parent route was not updated | `member/children/[id]/route.ts:293-299` vs `members/[id]/route.ts:530-542, 672` |
| **G11** | `InitiativeAttachment` blobs are **never** deleted — not on attachment delete, not on initiative delete (attachments CASCADE) | `initiatives/[id]/attachments/route.ts:111`; `initiatives/[id]/route.ts:74`; `schema.prisma:718` |
| **G12** | Parent-side kid **photo** delete removes the row without the blob | `member/children/[id]/photos/[photoId]/route.ts:54-57` |
| **G13** | Replacing a tenant logo leaves the old file orphaned — no `del()` in the settings route | `app/api/settings/route.ts` — `logoUrl` at `:27, 80`, no `del` import |
| **G14** | A `pending_white_glove` `ImportJob` is destroyed — blob **and** row — 30 days after upload, because the cron's terminal-status list is `["complete"]` only. The club's CSV and the record of which file it was both vanish; only the `onboarding.csv_handoff` audit row survives, and that expires at 365 days | `csv-handoff:92` vs `retention:101, 302-334` |
| **G15** | Stripe `Customer` objects are created (`lib/stripe/subscriptions.ts:82`, `member/class-packs/buy:85`) and **never deleted** anywhere. A GDPR erasure nulls `stripeCustomerId` on the MatFlow side `erase:298-299`, so the erased member's full identity survives inside the connected Stripe account with **nothing left in MatFlow pointing at it**. The erasure is both incomplete and irreversibly un-followable | no `customers.del` anywhere in `app/` or `lib/` |
| **G16** | Every blob `del()` in the codebase is best-effort and swallowed, and **no sweep ever revisits a failed one**. `delete-orphan` exists but must be handed a URL the caller already holds | `erase:419-426`; `retention:375-384`; `members/[id]:706-730`; `upload/delete-orphan:16-17` |

### 7.4 Structural inconsistencies worth fixing cheaply

| # | Gap | Evidence |
|---|---|---|
| **G17** | **`Class.deletedAt` is dead code.** The column exists, carries `@@index([tenantId, deletedAt])`, is documented as distinct from `isActive` ("isActive=false is paused, deletedAt is removed from history"), and every read filters on it — but **no code path ever writes it**. `DELETE /api/classes/[id]` only sets `isActive: false`. A class can never be removed from history | `schema.prisma:365, 373`; `classes/[id]:481-486`; `grep "deletedAt: new Date()"` returns only Product, RankSystem and Tenant |
| **G18** | **Soft-delete is fail-open on Stripe; the purge 30 days later is fail-closed.** A tenant whose subscriptions refused to cancel keeps charging cards for 30 days, and is then skipped by the purge every night, forever, until a human reads `details.failures` in a cron response body. Nothing alerts on it | `soft-delete:74-92, 123` vs `retention:424-429` |
| **G19** | The tenant purge does at most **2 tenants per nightly run**, and reconciliation eats the front of the 240s budget. A backlog cannot be drained faster without a code change | `retention:65, 63, 146-164, 399` |
| **G20** | `Member` has no `deletedAt`, so `status = "cancelled"` is doing three jobs: churned, GDPR-erased, and admin-cancelled. Analytics disambiguate on `cancelledAt` and the `deleted-*@deleted.invalid` email pattern instead of a column | `schema.prisma:131-133`; `members/[id]:260-265` |
| **G21** | `vercel.json` declares **3** crons while `retention:146-156` still explains that reconcile was folded in because the Hobby plan allows 2 entries and monthly-reports plus retention use both. One of the two is stale; `/api/cron/stripe-reconcile` exists as a route with no schedule | `vercel.json` vs `retention:146-156` |
| **G22** | `Notification` rows are read and swept, but the DSAR erase comment states "No writer exists today" — the model is dead weight that still costs a delete pass | `erase:343-345` |

### 7.5 The three things to fix first

1. **G7 plus G6 — widen `MemberDraft`** to carry the emergency-contact trio (and ideally rank and medical conditions), and accept the trio in `memberCreateSchema`. That one change removes the wall that blocks every CSV-imported member from self-signing a waiver, which today forces either a staff device or a kiosk link for all 200 of them.
2. **Break 1 — replace `head().downloadUrl` plus `fetch` with `get(url, { access: "private" })`** in `admin/import/[id]/commit:41-47`, `admin/import/[id]/preview:25` and `waiver/[signedWaiverId]/signature:85-93`. The correct pattern is already written and fully commented in `app/api/blob-image/route.ts:17-27`.
3. **G1 — ship a members CSV export.** `payments/export.csv` is 61 lines and is the template. It closes the lock-in objection, answers Article 20 portability, and makes G6 survivable in the meantime because a club can at least round-trip its own data.

---


## 8. ADDENDUM — the three UNVERIFIED items, now resolved

**`POST /api/members/accept-invite`** (`app/api/members/accept-invite/route.ts`) — public, token-gated. Rate-limited 10 per 15 min per IP `:29-41`. Password policy: min 10 chars, must contain upper, lower and a digit `:20-26`. Token looked up **by HMAC hash** under `withRlsBypass` because the tenant is not known yet `:51-56`; rejects wrong purpose (404), already-used (410) and expired (410) `:57-66`. Then switches to `withTenantContext(tokenRow.tenantId)`, resolves the member by the `tenantId_email` composite unique `:68-76`, bcrypt-hashes at cost 12, sets `passwordHash` and marks the token used. Returns `{ ok, tenantSlug, email }` so the page can call `signIn()` immediately — no second login step `:10-16`. This is the route that converts a bulk-invite token into a member who can actually log in.

**`PATCH /api/settings` and `logoUrl`** — G13 **confirmed**. The zod field accepts an absolute URL, a relative path, **or a `data:` URL up to 3,000,000 characters** `app/api/settings/route.ts:27-34`, and the handler simply writes the new value. There is no `del` import in the file and no read of the previous `logoUrl` before overwriting. Every logo change therefore orphans the previous blob, and a tenant running the `data:` fallback stores up to ~3 MB of base64 in the `Tenant` row, which the tenant purge's logo cleanup (`retention:689-691`, guarded by `isVercelBlobUrl`) correctly skips but which no export ever surfaces.

**Third item, now RESOLVED and worse than stated.** `SignedWaiver` is referenced in exactly 13 files, and **every one of them is an API route or a lib** — `dsar/erase`, `dsar/export`, `cron/retention`, `member/me`, `members/[id]`, `members/[id]/waiver-link`, `members/[id]/waiver/sign`, `waiver/[signedWaiverId]/signature`, `waiver/open`, `waiver/sign-for-child`, `waiver/sign`, `lib/member-delete.ts`, `lib/waiver-signature-upload.ts`. **No page, server component or client component anywhere in `app/` or `components/` reads the model.** The only reads are: the DSAR export (filtered `memberId` plus `tenantId`), the signature byte proxy (filtered `id` plus `tenantId`), and the retention purge (`deleteMany` by `tenantId`).

Consequences, in order of severity:

1. **There is no waiver list view at all.** A gym owner cannot browse, search or audit their signed waivers in the product. The only way to see one is to already know a member id and pull their DSAR export, or to know a `signedWaiverId` and fetch the PNG.
2. **Detached waivers — the ones `member-delete.ts` goes out of its way to preserve as liability evidence — are reachable by nothing.** After `memberId` is nulled, no route filters on `tenantId` alone except the purge that destroys them. The legal-hold reasoning in D-0.5 and `lib/member-delete.ts:24-34` is sound in the database and inert in the application: the club has the evidence and no way to produce it without direct SQL.

That makes "add a waivers list, filterable including detached rows" a fourth candidate for the fix-first list in 7.5 — it is the cheapest way to turn an existing, deliberate retention decision into something that actually defends an injury claim.

---

*End of Lane D. Written from source only — no dev server, no database, no tests run.*
