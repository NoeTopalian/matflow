# Initial Test Plan for MatFlow

**Created:** 2026-04-18
**Status:** Draft (revised per Critic feedback)
**Complexity:** MEDIUM

---

## RALPLAN-DR Summary

**Principles:** Test business logic first; catch data-corruption before UX bugs; prefer fast feedback; multi-tenancy is a security boundary; demo fallback is a product feature.

**Decision Drivers:** (1) Risk of silent data corruption, (2) Extractability of pure logic, (3) Zero unit/integration coverage.

**Chosen approach:** Unit-first (Vitest) for Tier 1, then integration tests (Vitest + Prisma test DB) for Tier 2. Existing Playwright e2e covers smoke tests.

**ADR:** Unit-first maximizes defect detection per hour. Streak algorithm has 5+ edge cases impossible to cover via e2e. Requires extracting `getWeekKey`/`calculateStreak` into `lib/streak.ts` (~20 lines).

---

## Tier 1 -- Highest Risk/Value

#### 1.1 Streak Algorithm (unit)
Extract `getWeekKey()` and week-walk-back from `app/api/member/me/route.ts` lines 95-112 into `lib/streak.ts`.
- Monday-only attendance: streak = 1
- 4 consecutive weeks: streak = 4
- Gap week: streak stops at gap
- Sunday counts toward correct Mon-start week
- No attendance: streak = 0
- Current week empty, previous 3 attended: streak = 0

#### 1.2 Check-in Validation (unit)
Zod schema + role auth in `app/api/checkin/route.ts`.
- Valid self-check-in body passes schema
- Missing classInstanceId fails with correct error
- Non-staff with `memberId` returns 403
- QR flow requires both `tenantSlug` and `memberId`
- `checkInMethod` defaults to `"admin"`

#### 1.3 Announcement Role Guard (unit)
POST auth in `app/api/announcements/route.ts`.
- `owner`/`manager`: allowed (201)
- `coach`/`member`/`admin`: forbidden (403)

#### 1.4 Demo Fallback Branches (unit)
4 `DEMO_RESPONSE` return paths in `/api/member/me` -- pure session-shape logic, mock `auth()` only, no DB needed. Promoted from Tier 3 per Critic feedback.
- `tenantId: "demo-tenant"` (line 42): returns DEMO_RESPONSE with session name overlaid
- Missing `memberId` (line 48): returns unmodified DEMO_RESPONSE
- `member.findFirst` returns null (line 70): returns DEMO_RESPONSE
- Prisma throws (line 142): catch returns DEMO_RESPONSE
- All paths include required keys (`id`, `belt`, `stats`)

---

## Tier 2 -- Important

#### 2.1 Check-in Duplicate Prevention (integration)
P2002 unique constraint on `[memberId, classInstanceId]`.
- First check-in: 201
- Duplicate: 409 "Already checked in"
- Same member, different class: both succeed
- Cancelled class: 409

#### 2.2 Tenant Isolation (integration)
Two-tenant seed DB. Verify `tenantId` scoping across routes.
- Tenant-A member cannot see tenant-B announcements
- Check-in for tenant-B class fails for tenant-A session
- `/api/member/me` returns only session-tenant member

#### 2.3 Schedule dayOfWeek Filtering (unit)
`dayOfWeek` convention and `?date=` param in `/api/member/schedule/route.ts`.
- Monday class appears on Monday filter
- Sunday class absent on Saturday filter
- `?date=2026-04-20` returns correct classInstanceIds

#### 2.4 Cross-Tenant Stats Leak (integration)
`attendanceRecord.count` queries (lines 84-86) filter by `memberId` only, not `tenantId`. Added per Critic feedback.
- Seed tenant-A with 2 records this week, tenant-B with 3 in same window. Tenant-A `thisWeek` = 2, not 5
- Same pattern for `thisMonth` and `thisYear`
- Streak walk-back uses only tenant-A dates

#### 2.5 Check-in DELETE Tenant Scoping (integration)
DELETE handler (lines 88-111) scopes via `classInstance.class.tenantId`. Added per Critic feedback.
- Tenant-A staff deletes tenant-A record: succeeds
- Tenant-A staff targets tenant-B record: `deleteMany` matches 0, record persists
- Non-staff: 403
- Missing params: 400

---

## Tier 3 -- Nice to Have

#### 3.1 Auth Callback Completeness (unit)
JWT/session callbacks in `auth.ts` propagate `tenantId`, `role`, `memberId`.

#### 3.2 Authenticated E2E Flows (Playwright)
Full check-in, schedule view, announcement creation via UI.

---

## Setup & File Structure

**Vitest:** `npm install -D vitest`, config with `@/` alias, add `"test": "vitest run"` script.
**Refactor:** Extract streak logic to `lib/streak.ts`, Zod schemas to `lib/schemas/`.

```
tests/
  unit/
    streak.test.ts              (1.1)
    checkin-validation.test.ts  (1.2)
    announcement-auth.test.ts   (1.3)
    demo-fallback.test.ts       (1.4)
    schedule-dayofweek.test.ts  (2.3)
    auth-callbacks.test.ts      (3.1)
  integration/
    checkin-duplicate.test.ts   (2.1)
    tenant-isolation.test.ts    (2.2)
    cross-tenant-stats.test.ts  (2.4)
    checkin-delete.test.ts      (2.5)
```

## Success Criteria

- [ ] `npm test` passes all Tier 1-2 tests
- [ ] Tier 1 covers streak, check-in validation, announcement auth, and all 4 demo fallback branches
- [ ] No test requires a running Next.js server
- [ ] Tenant isolation tests seed two distinct tenants with overlapping time-window data
