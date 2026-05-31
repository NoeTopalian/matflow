# Audit — Iteration 1, Area 6: Operator / admin

**Date**: 2026-06-01
**Branch**: `audit/loop-fixes-06` (branched from `main` HEAD `3404a82`)
**Scope**: `app/admin/**`, `app/api/admin/**`, cross-cutting libs (`lib/admin-auth.ts`, `lib/operator-auth.ts`, `lib/operator-context.ts`, `lib/impersonation.ts`, `lib/csrf.ts`, `lib/rate-limit.ts`, `lib/audit-log.ts`)
**Method**: 3 OMC subagents in parallel (security with OWASP cheat-sheet, verifier with H2-4 specific brief, perf).

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 1 | 4 | 5 | 3 |
| Verifier | 1 | 2 | 4 | 2 |
| Perf | 0 | 4 | 5 | 3 |

**Deduplicated NEW Critical**: 2 (1 security + 1 verifier — H2-4 deferred).
**Deduplicated NEW High**: 10 (4 security + 2 verifier + 4 perf).

This is the highest-risk area in the system (super-admin impersonation, suspend/soft-delete/transfer-ownership, customer-support actions, PII export/erase). Per the prod-readiness brief, every finding is graded against "could this leak / corrupt / over-charge real members" — real PII + real Stripe + real charges go live soon.

---

## NEW Critical findings (must close this iter)

### A6I1-S-1 · Imported CSV files stored with `access: "public"` — unauthenticated PII exposure
- **File**: `app/api/admin/import/upload/route.ts:39-42`
- **Class**: OWASP A01 + A02 (sensitive data exposure) + GDPR Article 32
- **Description**: `put(path, file, { access: "public", … })` makes the entire CSV downloadable from the Vercel Blob CDN with no auth gate. The CSV contains member names, emails, phones, dates-of-birth, accountTypes. URL is stored in `ImportJob.fileBlobUrl`. A single URL leak (browser history, server logs, Referer header, copy-paste into chat) exposes the entire gym's PII to the internet.
- **Blast radius**: Full PII of every member in an imported CSV. GDPR breach (Article 32 — failure of "appropriate technical measures"). Reportable to ICO within 72 hours under Article 33.
- **Fix**: `access: "private"` + signed-URL retrieval in `preview`/`commit` routes via `getDownloadUrl`.

### A6I1-V-1 · Staff hard-delete has no FK-recovery path — silent 500s + H2-4 deferred Critical
- **File**: `app/api/staff/[id]/route.ts:139` + `prisma/schema.prisma:557, 392`
- **Class**: Insecure design + DB integrity
- **Description**: `DELETE /api/staff/[id]` calls `tx.user.deleteMany`. `AuditLog.userId → User` and `AttendanceRecord.checkedInById → User` both have NO `onDelete` directive (Prisma default = RESTRICT on Postgres). Any staff who recorded an audit or checked in a member produces a `P2003 FK violation`. The catch block at `:154` swallows the error and returns 500.
- **History**: This is H2-4 from Area 2 backlog, deferred to Area 6.
- **Fix**: Schema — add `onDelete: SetNull` to both relations (both nullable, so SetNull is semantically correct). Migration.

---

## NEW High findings (must close this iter)

### A6I1-S-2 · v1 admin cookie stores raw `MATFLOW_ADMIN_SECRET` — cookie theft = permanent compromise
- **File**: `lib/admin-auth.ts:80-91` + `app/api/admin/auth/login/route.ts:46`
- **Class**: OWASP A02 + A07
- **Description**: The v1 bootstrap cookie value IS the shared admin secret. Exfiltration = permanent admin access, revocable only by rotating env var + redeploying. v1.5 (HMAC-signed session token) is preferred but v1 is still active.
- **Fix**: Migrate v1 to HMAC-signed token (mirror v1.5 pattern) OR mark v1 deprecated + add startup warning if v1 is the only auth path.

### A6I1-S-3 · Impersonation cookie uses `SameSite=Lax` instead of `Strict`
- **File**: `lib/impersonation.ts:95-101`
- **Class**: OWASP A01 + A05
- **Description**: All other admin cookies (`matflow_admin`, `matflow_op_session`, `matflow_op_challenge`) use `SameSite=Strict`. Impersonation cookie uses `Lax`, allowing top-level cross-site navigation to carry the cookie. During a 60-min impersonation TTL an attacker could craft a link that triggers state-changing actions with full owner privileges over the impersonated tenant.
- **Fix**: One-line — change `sameSite: "lax"` → `"strict"` in `lib/impersonation.ts`.

### A6I1-S-4 · Suspend/soft-delete do NOT cancel Stripe subscriptions — members continue to be charged after access is revoked
- **File**: `app/api/admin/customers/[id]/suspend/route.ts` + `…/soft-delete/route.ts`
- **Class**: OWASP A04 (insecure design) — financial harm
- **Description**: Both routes flip `Tenant.subscriptionStatus` + bump `sessionVersion` but never touch Stripe. A suspended/deleted tenant's members keep paying monthly while being locked out. Chargeback liability + regulatory exposure (FCA / EU consumer rights). DSAR-erase already cancels Stripe correctly — pattern exists, just not wired here.
- **Fix**: Before `Tenant.update`, iterate active member subscriptions and call `cancelSubscriptionAtPeriodEnd` per member. Idempotent (safe if subscription already cancelled).

### A6I1-S-5 · No rate-limit on destructive admin operations
- **Files**: `app/api/admin/customers/[id]/{suspend,soft-delete,transfer-ownership,force-password-reset,totp-reset,member-totp-reset}/route.ts` + `applications/[id]/{approve,reject}/route.ts`
- **Class**: OWASP A07 + A04
- **Description**: A compromised operator session (e.g. via S-2 cookie theft) can iterate all tenant IDs and suspend/delete every gym in seconds. No throttle. Auth-level routes ARE rate-limited (5/15min). DSAR routes ARE rate-limited (5–10/hr). Destructive customer-action routes are NOT.
- **Fix**: Add `checkRateLimit(\`admin:customer-action:${operatorId}:${ip}\`, 20, 60 * 60 * 1000)` to each route.

### A6I1-V-4 · Application reject has no AuditLog entry — GDPR/compliance evidence gap
- **File**: `app/api/admin/applications/[id]/reject/route.ts:44-48`
- **Class**: OWASP A09 (logging failures)
- **Description**: Approval calls `logAudit`. Rejection only `console.warn`s — logs rotate out of Vercel after retention. No queryable record of who rejected an application or why. The decision to deny a business platform access is significant; needs durable audit trail.
- **Fix**: Add `await logAudit({ tenantId: "SYSTEM" /* or sentinel */, action: "admin.application.reject", entityType: "GymApplication", entityId: id, metadata: { gymName, reason, operatorEmail }, actAsUserId: operator.operatorId, req })`. May need to relax `AuditLog.tenantId` nullability — verify schema.

### A6I1-P-1 · Import commit fires per-row N+1 transactions (1000 round-trips per CSV)
- **File**: `app/api/admin/import/[id]/commit/route.ts:46-69`
- **Class**: N+1
- **Description**: Inner `for (const [idx, d] of slice.entries())` opens a separate `withTenantContext` transaction PER row. A 1000-row import = 1000 round-trips to Neon. At 10 ms per RTT = 10 s of serial latency + 1000 pool checkouts. The 25-row slicing only batches the progress write, not the inserts.
- **Fix**: Replace per-row transaction with one `createMany({ data: slice, skipDuplicates: true })` per slice. Pre-fetch existing emails with one `findMany`. 1000 transactions → ~40.

### A6I1-P-2 · Soft-delete + suspend fire 3 sequential `withRlsBypass` calls
- **File**: `app/api/admin/customers/[id]/{soft-delete,suspend}/route.ts`
- **Class**: N+1 (connection-setup)
- **Description**: Each route opens 3 separate transactions: tenant.update, user.updateMany, member.updateMany. Three connection-pool checkouts + transaction boundaries where one would do.
- **Fix**: Merge into single `withRlsBypass(async (tx) => { … })`. Same-transaction also closes A6I1-S-10 race window (atomicity).

### A6I1-P-3 · Missing cross-tenant indexes on Payment + Dispute for admin dashboard
- **Files**: `app/admin/page.tsx:91-103`, `app/admin/billing/page.tsx:34-97`, `prisma/schema.prisma`
- **Class**: Missing index
- **Description**: Admin dashboard runs `payment.aggregate({ where: { status, createdAt: gte } })` cross-tenant (no `tenantId` filter — intentional). Existing `@@index([tenantId, status])` + `@@index([tenantId, createdAt])` are useless without tenantId as leading column. Postgres seq-scans the full Payment table. Same for `Dispute` aggregates.
- **Fix**: Schema migration adding:
  - `Payment @@index([status, createdAt])`
  - `Payment @@index([status, paidAt])`
  - `Dispute @@index([status, updatedAt])`

### A6I1-P-4 · Missing `AuditLog.createdAt` standalone index — dashboard top-10 query needs it
- **File**: `app/admin/page.tsx:92-102` + `prisma/schema.prisma`
- **Class**: Missing index
- **Description**: Dashboard fires `auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 })` with NO `where` clause. Only existing index is `@@index([tenantId, createdAt])` — useless for full-table sort. Postgres sort pass on full heap. At 500k rows this becomes the dominant dashboard query.
- **Fix**: Add `@@index([createdAt])` standalone on `AuditLog`. Schema migration.

---

## Architectural / scope items (deferred — not Critical/High per triage)

### A6I1-V-2 / A6I1-S-9 · Transfer-ownership not atomic (read + write in separate transactions)
- **File**: `app/api/admin/customers/[id]/transfer-ownership/route.ts:56-82`
- **Class**: TOCTOU
- **Status**: Will fix as part of Batch A (1-line refactor — fold read into the same `withRlsBypass` as the write).

### A6I1-V-3 · DSAR routes gated by `requireOwner()` — operator cannot trigger from admin surface
- **File**: `app/api/admin/dsar/{export,erase}/route.ts`
- **Decision**: Backlog. Per Area 3 design, DSAR is owner self-service. Operator-led DSAR requires impersonation first (already audited). Adding operator-direct DSAR is a feature, not a bug — feature-follow-up phase.

### A6I1-V-5 · Customer-support UI: member TOTP reset / force-password-reset not surfaced on `/admin/security`
- **Decision**: Backlog. The API routes exist and are reachable from the tenant detail page (Danger Zone). A cross-tenant member-lookup UI is a feature, not a bug — feature-follow-up phase.

### A6I1-V-8 · Import flow has no admin UI page
- **Decision**: Backlog. Import is owner-self-service; the operator stake-list interpretation was overzealous.

---

## Medium findings (backlog — M-A6I1-*)

- **M-A6I1-1**: `constantTimeEq` leaks string length via early return (`lib/admin-auth.ts:28-31`).
- **M-A6I1-2**: Approval audit log fire-and-forget (`applications/[id]/approve/route.ts:135-149`). Inconsistent with DSAR-erase await pattern.
- **M-A6I1-3**: Suspend/soft-delete already covered by P-2 fix (atomicity).
- **M-A6I1-4**: Tenants listing has no pagination (`app/admin/tenants/page.tsx:28-69`). Filter runs on every keystroke client-side.
- **M-A6I1-5**: DSAR export materialises whole package in memory + pretty-prints JSON (`api/admin/dsar/export/route.ts:78-138`).
- **M-A6I1-6**: GymApplication.findMany hard-capped at 200 with no cursor pagination.
- **M-A6I1-7**: AuditLog activity endpoint missing `(action, createdAt)` composite index for prefix filter.
- **M-A6I1-8**: `User.@@index([role, lockedUntil])` — locked-out owners scan.
- **M-A6I1-9**: Slug-uniqueness loop in approve route fires up to 5 sequential `findUnique` calls.

## Low findings (backlog — L-A6I1-*)

- **L-A6I1-1**: `hashSnippet` uses djb2 (weak); use truncated SHA-256 for audit-trail snippets (`dsar/erase/route.ts:180-184`).
- **L-A6I1-2**: Operator `totpSecret` stored in DB unencrypted (acceptable but consider envelope encryption).
- **L-A6I1-3**: Activity-feed IP masking regex is IPv4-only; IPv6 not masked.
- **L-A6I1-4**: Admin dashboard `force-dynamic` with no Cache-Control; 8 parallel DB queries per nav.
- **L-A6I1-5**: Import progress writes 40× per 1k-row import.
- **L-A6I1-6**: TOTP-reset + force-password-reset routes fire sequential reads (tenant.findUnique + user.findFirst); merge.
- **L-A6I1-7**: Admin login redirect always → `/admin/applications` even when no applications (UX confusion).
- **L-A6I1-8**: TenantsList duplicates logout helper instead of using AdminTopNav shared hook.
- **L-A6I1-9**: Activity feed checks `"actingAs" in r.metadata` but impersonate route writes different keys; "(impersonated)" label may never fire.
- **L-A6I1-10**: Dashboard placeholder cards ("MRR", "Trial to active rate") display `—` with "Wired in v2" hint — remove or hide until wired.

---

## Batch plan

**Batch A — security Critical + High** (highest priority — real PII + Stripe charges):
- A6I1-S-1: Blob upload → private
- A6I1-S-3: Impersonation cookie SameSite → strict
- A6I1-S-4: Suspend/soft-delete cancel Stripe subscriptions
- A6I1-S-5: Rate-limit destructive admin ops

**Batch B — Verifier Critical + High**:
- A6I1-V-1: Schema `onDelete: SetNull` on AuditLog.userId + AttendanceRecord.checkedInById + migration (H2-4)
- A6I1-V-4: Application reject AuditLog entry
- A6I1-V-2 / A6I1-S-9: Transfer-ownership atomicity (read + write in same transaction)

**Batch C — Perf High**:
- A6I1-P-1: Import commit → bulk createMany per slice
- A6I1-P-2: Suspend + soft-delete merge into single withRlsBypass
- A6I1-P-3 + A6I1-P-4: Schema migration — 4 new indexes (Payment×2, Dispute, AuditLog)

**Batch D — Security High (deferred)**:
- A6I1-S-2: v1 cookie HMAC-sign (or full v1 deprecation — needs user decision; treat as backlog for this iter)

---

## Status

iter-1 = 2 Critical (S-1, V-1) + 9 High (S-2/3/4/5, V-2/4, P-1/2/3/4) confirmed for fix. Three architectural items moved to backlog. iter-2 audit will run after Batch A+B+C land on the audit/loop-fixes-06 branch.
