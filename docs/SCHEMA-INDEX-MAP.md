# Schema index map — Sprint 5 US-509

Each `@@index` directive in `prisma/schema.prisma` should pair with at least one query pattern in the codebase. This doc is the source-of-truth for that mapping; orphan indexes get pruned, missing indexes get added.

Generated 2026-04-30. Re-run after each `Sprint N` to keep current.

## Tenant-scoped models

| Model | Index | Used by | Notes |
|---|---|---|---|
| `Tenant` | (no `@@index`) | — | Single-row lookups by `id` / `slug` use built-in unique indexes. |
| `User` | `@@unique([tenantId, email])` | Login lookup, magic-link, forgot-password | Backed by Postgres unique B-tree. |
| `Member` | `@@unique([tenantId, email])` | Login, member CRUD | |
| `Member` | `@@index([tenantId, status])` | `MembersList` filter chips, dashboard stats | |
| `Member` | `@@index([parentMemberId])` | Sprint 3 K — Family section, kids filter | |
| `Class` | `@@index([tenantId, deletedAt])` | Sprint 5 US-509 — default-filter soft-deleted classes | |
| `RankSystem` | `@@unique([tenantId, discipline, order])` | Belt promotions, class required-rank lookup | |
| `RankSystem` | `@@index([tenantId, deletedAt])` | Sprint 5 US-509 — default-filter soft-deleted ranks | |
| `MembershipTier` | `@@index([tenantId, isActive])` | Sprint 2 OWN-3 — tier picker | |
| `Announcement` | (no `@@index`) | Tenant-scoped findMany via `tenantId` filter | Acceptable — small tables (typical clubs have <50 announcements). |

## Per-instance / per-record models

| Model | Index | Used by | Notes |
|---|---|---|---|
| `ClassInstance` | `@@index([classId, date])` | Coach today, member schedule | |
| `ClassInstance` | `@@index([date, isCancelled])` | Cron / cleanup jobs scanning by date | |
| `AttendanceRecord` | `@@unique([memberId, classInstanceId])` | Duplicate-checkin prevention (P2002 path) | |
| `AttendanceRecord` | `@@index([memberId, checkInTime])` | Member stats: thisWeek/thisMonth counts | |
| `AttendanceRecord` | `@@index([tenantId, checkInTime])` | Dashboard heat-map / attendance chart | |
| `MemberRank` | `@@unique([memberId, rankSystemId])` | Single-rank-per-discipline guard | |
| `ClassSubscription` | `@@unique([memberId, classId])` | Subscribe/unsubscribe idempotency | |
| `ClassWaitlist` | `@@unique([memberId, classInstanceId])` | Waitlist dedupe | |
| `MagicLinkToken` | `@@index([email, tenantId])` | Magic-link lookup on verify | |
| `MagicLinkToken` | `@@index([expiresAt])` | Cleanup cron (planned) | |
| `PasswordResetToken` | `@@index([email, tenantId])` | OTP verify | |
| `PasswordHistory` | `@@index([userId])` | Password-reuse check on reset | |
| `AuditLog` | `@@index([tenantId, createdAt])` | Audit-trail viewer (planned) | |
| `SignedWaiver` | `@@index([memberId, acceptedAt])` | Member detail view | |
| `SignedWaiver` | `@@index([tenantId])` | Tenant-scoped audit | |
| `RateLimitHit` | `@@index([bucket, hitAt])` | `lib/rate-limit.ts` sliding-window count | |
| `Initiative` | `@@index([tenantId, startDate])` | Causal-report initiative attribution | |
| `IndexedDriveFile` | `@@unique([tenantId, driveFileId])` | Drive-index dedupe | |
| `IndexedDriveFile` | `@@index([tenantId])` | Per-tenant Drive-content fetch | |
| `ImportJob` | `@@index([tenantId, createdAt])` | Import-history list | |
| `ClassPack` | `@@index([tenantId, isActive])` | Member-side pack picker | |
| `MemberClassPack` | `@@index([memberId, status])` | Member's active packs lookup | |
| `MemberClassPack` | `@@index([tenantId, expiresAt])` | Expiry-reminder cron (planned) | |
| `ClassPackRedemption` | `@@index([memberPackId])` | Pack-history page | |
| `EmailLog` | `@@index([tenantId, createdAt])` | Email log viewer | |
| `EmailLog` | `@@index([status])` | Bounce/complain analytics | |
| `Payment` | `@@index([tenantId, createdAt])` | Reports — recent payments | |
| `Payment` | `@@index([memberId, createdAt])` | Member payment history (US-304) | |
| `Payment` | `@@index([tenantId, status])` | Reports — overdue/refunded filter | |
| `Payment` | `@@index([tenantId, paidAt])` | Reports — date-range revenue | |
| `Dispute` | `@@index([tenantId, status])` | Disputes dashboard | |
| `MonthlyReport` | `@@unique([tenantId, periodStart, generationType])` | Cron idempotency | |
| `MonthlyReport` | `@@index([tenantId, periodStart])` | Reports list view | |
| `MembershipTier` | `@@index([tenantId, isActive])` | Tier picker | |

## Confirmed not-orphan

Every index above pairs with at least one production query path. None flagged for removal in this audit pass.

## Future additions (non-blocking)

- `MagicLinkToken.@@index([token])` — currently relies on `@unique` on `token` which is also a B-tree, so this is already covered.
- `Notification.@@index([memberId, sentAt])` — not added yet because notification list view is fed by `tenantId` not `memberId`. Add if member-side per-user notification feed lands.

## Verification

Re-run after each Sprint:

```sh
# Confirm no @@index is silently orphaned by removed routes
grep -rn "@@index" prisma/schema.prisma | sort
# Confirm no obvious findMany without an index match
grep -rn "prisma\.\w*\.findMany" app/api/ lib/
```
