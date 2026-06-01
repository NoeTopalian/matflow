# Audit — Iteration 1, Area 8: Database

**Date**: 2026-06-01
**Branch**: `audit/loop-fixes-08`
**Scope**: `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts`, RLS policies, FK onDelete chain, index coverage vs query shapes, AuditLog archival.
**Method**: 3 OMC subagents.

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 2 | 3 | 4 | 2 |
| Verifier | 2 | 3 | 4 | 2 |
| Perf | 2 | 5 | 5 | 3 |

**Deduplicated NEW Critical**: 5.
**Deduplicated NEW High**: 8.

This is the biggest Area-level audit yet. The standout finding is A8I1-S-2 — `GET /api/members/[id]` returns `passwordHash` + `totpSecret` + `totpRecoveryCodes` to any authenticated staff member. Any coach can harvest the entire tenant's 2FA seeds + offline-crackable bcrypt hashes in one request.

---

## NEW Critical findings (close this iter)

### A8I1-S-1 / A8I1-V-1 · ClassRoster missing RLS policy (cross-tenant leak)
- **File**: `prisma/migrations/20260509115719_add_class_roster/migration.sql` + RLS activation migration history
- **Class**: A01 + multi-tenant RLS gap
- **Description**: ClassRoster was created AFTER the bulk RLS activation (20260503200000) and never received its own ENABLE+FORCE+tenant_isolation triple. Every other post-activation tenant-scoped table (LoginEvent, MemberPhoto, PushSubscription, Task) added its own RLS in the creating migration. ClassRoster did not. Any code path that bypasses the application-layer `where: { tenantId }` filter returns cross-tenant roster data.
- **Fix**: New migration `20260601000002_classroster_rls` with ENABLE+FORCE+tenant_isolation.

### A8I1-V-2 · Task.createdById + Task.assignedToId ON DELETE RESTRICT (silent staff-delete 500)
- **File**: `prisma/migrations/20260530192937_add_tasks/migration.sql:20-23`
- **Class**: Insecure design + DB integrity
- **Description**: Same class of bug fixed in Area 6 for AuditLog.userId etc. — but Task was created AFTER the Area 6 fix batch. Staff DELETE route hits Prisma P2003 + silent 500 for any staff who has ever created or been assigned a task.
- **Fix**: Make both fields nullable in schema + migration changes both FKs to `ON DELETE SET NULL`.

### A8I1-S-2 · GET /api/members/[id] returns passwordHash + totpSecret + totpRecoveryCodes to any staff caller
- **File**: `app/api/members/[id]/route.ts:29-31` — `findFirst` uses `include` with NO top-level `select`
- **Class**: A05 + A02 — sensitive data exposure
- **Description**: Without a `select` clause, Prisma returns ALL scalar fields on Member including `passwordHash` (offline-crackable bcrypt), `totpSecret` (plaintext TOTP seed — attacker clones authenticator), `totpRecoveryCodes` (full 2FA bypass), waiverIpAddress, sessionVersion, failedLoginCount, lockedUntil. The result spreads into the JSON response. Compare with `GET /api/members` (list) which correctly uses explicit `select`.
- **Blast radius**: Any staff role (owner/manager/coach/admin) can harvest entire tenant's PII + 2FA seeds + password hashes via the staff dashboard's member detail view. GDPR breach + Article 32 violation + 2FA bypass + offline-crack attack surface.
- **Fix**: Add explicit `select` matching the list endpoint pattern. Drop passwordHash, totpSecret, totpRecoveryCodes, sessionVersion, failedLoginCount, lockedUntil from the wire.

### A8I1-P-1 · `lib/promotion-candidates.ts` fires per-rank `attendanceRecord.count()` N+1
- **File**: `lib/promotion-candidates.ts:90-96` + `:173-180`
- **Class**: N+1 — 600 queries per `GET /api/promotions/candidates` at 200 members × 3 rank systems
- **Description**: `Promise.all` over MemberRank rows, each issuing its own `count()`. At 200 members × 3 rank systems = 600 individual COUNT queries × ~5-10ms RTT = 3-6s of serial latency per call. `isPromotionReady` (member-detail chip) has the identical pattern.
- **Fix**: Single `attendanceRecord.groupBy({ by: ['memberId'], _count: true, where: { memberId: { in: allMemberIds }, checkInTime: { gte: earliest } } })`. JS filter afterwards.

### A8I1-P-2 · `AttendanceRecord` missing direct `tenantId` column → full-table seq-scan
- **File**: `app/api/dashboard/stats/route.ts:41-53` + `lib/reports.ts:147-199` + `prisma/schema.prisma` (`AttendanceRecord` model)
- **Class**: Missing tenant denorm column — prevents index usage
- **Description**: `AttendanceRecord` has no direct `tenantId`. Queries use `{ member: { tenantId } }` which Prisma translates as a hash-join. The schema declares `@@index([tenantId, checkInTime])` on a column that doesn't exist on AttendanceRecord — the index is dead. Every dashboard load + every weekly/monthly report scans the full heap.
- **Fix**: Add `tenantId String` column to `AttendanceRecord`. Schema migration backfills from `Member.tenantId` for existing rows. Replace `{ member: { tenantId } }` with `{ tenantId }` at every call site. The existing `@@index([tenantId, checkInTime])` then becomes usable as intended.

---

## NEW High findings (close this iter)

### A8I1-V-3 / A8I1-P-3 · EmailLog missing composite index (deferred A7I1-P-4)
- **File**: `prisma/schema.prisma` (EmailLog) + `lib/email.ts:272-282`
- **Description**: Bounce-check fires on every outbound send: `findFirst({ where: { tenantId, recipient, status: { in: ["bounced","complained"] }, createdAt: { gte: 30d } } })`. Existing indexes are `(tenantId, createdAt)` and `(status)` — neither covers the full predicate. 20-50k row scan per send at 50k emails/month.
- **Fix**: `@@index([tenantId, recipient, status, createdAt])`.

### A8I1-V-4 · PasswordHistory.userId ON DELETE RESTRICT
- **File**: `prisma/migrations/20260424205716_init/migration.sql:332`
- **Description**: Staff DELETE route hits P2003 for any User who has password history. Same class as V-2 / Area 6's H2-4 fixes.
- **Fix**: Migration to `ON DELETE CASCADE` (password history has no meaning without the user).

### A8I1-V-5 · `prisma/seed.ts` has no production guard
- **File**: `prisma/seed.ts:17-21`
- **Description**: Only guards on `DATABASE_URL` empty. No `NODE_ENV !== "production"` check. `package.json:19` wires it as `prisma seed` so `npx prisma migrate reset` against a misconfigured env can re-seed prod with 12 fake members + 3 staff sharing `password123`.
- **Fix**: Refuse to run if `NODE_ENV === "production"` unless `ALLOW_SEED_IN_PROD` is explicitly set.

### A8I1-S-3 · TOTP secrets stored plaintext in User + Member + Operator
- **File**: `app/api/auth/totp/setup/route.ts:48` + `app/api/member/totp/setup/route.ts` + `app/api/admin/auth/operator-totp/setup/route.ts`
- **Class**: A02 Cryptographic Failures
- **Description**: `totpSecret` written as raw base32 string. Google Drive tokens are already encrypted at rest via `lib/encryption.ts` (AES-256-GCM); same pattern not applied here. DB read = clone every authenticator.
- **Fix**: Wrap all writes with `encrypt()`. Add `decrypt()` in every verify path. Data migration to encrypt existing plaintext secrets in-place — opportunistic (decrypt-or-fallback during the migration window).

### A8I1-S-4 · Stripe webhook findMember fallback queries without tenantId
- **File**: `app/api/stripe/webhook/route.ts:125`
- **Description**: Falls back to `{ stripeCustomerId: customerId }` with no tenantId filter. Member.stripeCustomerId has no unique constraint — if two tenants share a customer ID (test re-use, multi-tenant Stripe), `findFirst` returns arbitrary member. Wrong tenant's payment status gets mutated.
- **Fix**: Refuse-to-process without tenant resolution. Add `(tenantId, stripeCustomerId) WHERE stripeCustomerId IS NOT NULL` partial unique index.

### A8I1-P-4 · `lib/checkin.ts` roster check fires 2 sequential queries
- **File**: `lib/checkin.ts:101-113`
- **Description**: `classRoster.count({ where: { classId } })` then conditional `findUnique`. Two round-trips per check-in. `count` omits tenantId so composite index `(tenantId, classId)` isn't used.
- **Fix**: Single `findUnique({ where: { classId_memberId } })` query.

### A8I1-P-5 + A8I1-P-6 + A8I1-P-7 · Big SELECTs on aggregate paths
- **Files**: `lib/reports.ts:173-179, 256-264`, `app/api/member/classes/route.ts:29-38`, `app/api/revenue/summary/route.ts:36-46`
- **Description**: groupBy over AttendanceRecord (same join issue as P-2); triple-join member-classes returns full Class rows for in-JS dedup; revenue summary fetches all payments to sum in JS.
- **Fix**: Convert to `aggregate()` / `groupBy` / `$queryRaw`. P-5 + P-6 partially close after P-2 lands (the join-based tenant filter is the root cause).

---

## Backlog (Medium/Low)

**Medium** (M-A8I1-*):
- V-6, S-8: Tenant.subscriptionStatus/Tier + Operator.role + ImportJob.status + Dispute.status + EmailLog.status + Task.status missing CHECK constraints
- V-7: ClassWaitlist.status / MemberClassPack.status / Initiative.type missing CHECK
- V-8: MemberRank + RankHistory chains RESTRICT FKs
- V-9, S-5, P-11: AuditLog archival cron + soft-delete expiry cron
- S-6: Seed bcrypt cost-12 shared password
- S-7: create-restricted-role.ts $executeRawUnsafe with role-name interpolation (safe but pattern-fragile)
- S-9: Member.stripeCustomerId lacks partial unique constraint (paired with S-4)
- P-8, P-9, P-10, P-12: MemberRank/ClassWaitlist/ClassSubscription extra indexes

**Low** (L-A8I1-*):
- V-10: ClassSubscription + ClassWaitlist member FKs (member-delete.ts probably handles)
- V-11: PasswordHistory EXISTS-subquery RLS (correct, slower)
- S-10: Operator + PlatformConfig no RLS (by design)
- S-11: No migration-history integrity CI check
- P-13: 13 files use `new PrismaClient()` (test/seed/script only — needs lint guard)
- P-14: ClassInstance tenantId denorm (would benefit from P-2 pattern)
- P-15: AuditLog GET endpoint big SELECT

---

## Batch plan

**Batch A — Critical**:
- A8I1-S-1/V-1: ClassRoster RLS migration
- A8I1-V-2: Task FK SetNull (schema nullable + migration)
- A8I1-S-2: `app/api/members/[id]/route.ts` explicit select
- A8I1-P-1: promotion-candidates groupBy collapse
- A8I1-P-2: AttendanceRecord.tenantId denorm column + migration backfill + route updates

**Batch B — High**:
- A8I1-V-3/P-3: EmailLog composite index
- A8I1-V-4: PasswordHistory FK CASCADE
- A8I1-V-5: seed production guard
- A8I1-S-3: TOTP secrets encryption (User + Member + Operator setup/verify routes + data migration)
- A8I1-S-4: Stripe webhook refuse-no-tenant + partial unique index
- A8I1-P-4: checkin roster collapse
- A8I1-P-5/6/7: deferred or partial fix (P-2 closes most of P-5; P-6/P-7 are call-site refactors)

---

## Status

iter-1 = 5 Critical + 8 High. Batch A + Batch B applied. Static gates expected: tsc, lint, vitest, build. iter-2 audit confirms closures.
