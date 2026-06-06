# Audit — Lane 1 (Owner/Staff dashboard), Iteration 1

**Date**: 2026-06-06
**Branch**: `audit/loop-fixes-01-dashboard` (stacked on `feat/member-profile-pictures` → `feat/member-tickable-notes` → `main` while PRs #15 + #16 are open)
**Scope**: `app/dashboard/**`, `components/dashboard/**`, `app/api/admin/**`, plus the API routes the dashboard hits (`app/api/staff/**`, `app/api/members/**`, `app/api/classes/**`, `app/api/ranks/**`, `app/api/memberships/**`, `app/api/products/**`, `app/api/announcements/**`, `app/api/initiatives/**`, `app/api/payments/**`, `app/api/settings/**`, `app/api/drive/**`, `app/api/owner/**`, `app/api/tasks/**`, `app/api/reports/**`, `app/api/upload/**`).
**Method**: 3 OMC subagents (security-reviewer, verifier, scientist) in parallel against the same lane scope. Same harsh-exit convergence rule as the 9-area audit: lane ships when TWO consecutive iters return 0 Critical + 0 High.

## Convergence summary

| Agent | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Security | 2 | 19 | 24 | 12 | 57 |
| Verifier | 4 | 11 | 13 | 10 | 38 |
| Scientist | 5 | 24 | 28 | 15 | 72 |
| **Raw**  | **11** | **54** | **65** | **37** | **167** |

After dedup + verification triage:

- **NOT-A-FINDING** (verified clean during triage): 1 — `P-65 withTenantContext atomicity` — [lib/prisma-tenant.ts:32](lib/prisma-tenant.ts#L32) wraps the callback in `prisma.$transaction`, so multi-write handlers ARE atomic. Both subagents flagged it as a concern; verification proves the wrapping is in place.
- **DEDUP** (same root cause, multiple findings): the CSRF cluster (S-02 through S-22) is one mechanical pattern. The optimistic-UI-without-rollback cluster (V-07, S-37, S-38, S-39) is the same. The bare-`include` hygiene cluster (P-06 through P-10, P-24, P-25, P-62, P-09) is one defensive pattern.

**This iter ships fixes for**: 10 Critical + 26 High (after dedup) = 36 distinct fixes across ~30 files. Medium + Low items captured in [lane-01-iter-1-followups.md](lane-01-iter-1-followups.md) as feature backlog (not in this PR).

---

## Critical findings (fixed in this PR)

### V-02 — RemoveMemberModal fires destructive DELETE on open without confirm
- **Location**: [components/dashboard/RemoveMemberModal.tsx:67-96](components/dashboard/RemoveMemberModal.tsx#L67)
- **Class**: Catastrophic UX regression — silent data loss
- **Evidence**: The `useEffect` on `open === true` immediately issues `DELETE /api/members/${memberId}` with no strategy. If the member has no linked kids, the gateway returns 200 and the member is **permanently deleted with zero explicit confirmation** beyond the single click on "Remove member…" in the More Actions menu.
- **Fix**: Replace the auto-DELETE probe with a non-destructive `GET /api/members/[id]` lookup of `hasKidsHint` + `kids.length`. Only the user-initiated `execute()` path issues DELETE.

### V-01 — AvatarUploader orphans the Vercel Blob when PUT fails after upload (PR #16 code)
- **Location**: [components/ui/AvatarUploader.tsx:80-104](components/ui/AvatarUploader.tsx#L80)
- **Class**: Storage bloat + minor data-URL exposure
- **Evidence**: `POST /api/upload?purpose=profile-pic` lands a blob; if the subsequent `PUT /api/members/[id]/profile-picture` fails (network, 5xx, 404), the blob is never referenced and never GC'd (Vercel Blob has no sweep). Double-click also races two uploads.
- **Fix**: On PUT failure, issue a best-effort `DELETE` to the just-obtained blob URL via the new `/api/upload/blob-delete` helper.

### V-03 — `addPayment` closes drawer before POST, double-click duplicates
- **Location**: [components/dashboard/MemberProfile.tsx:389-426](components/dashboard/MemberProfile.tsx#L389)
- **Class**: Money-ledger race
- **Evidence**: `addPayment` calls `setPaymentDrawer(false)` and clears form BEFORE the `fetch` resolves. No `saving` ref guard. Rapid double-click queues two POSTs; `tempId = 'local-' + Date.now()` collides for two within 1 ms.
- **Fix**: Use a `useRef<boolean>` to block re-entry synchronously; close the drawer only on success; switch tempId to `crypto.randomUUID()`.

### V-04 — Recovery codes regenerate without TOTP re-verification; codes lost on drawer close
- **Location**: [components/dashboard/SettingsPage.tsx:1922,2086](components/dashboard/SettingsPage.tsx#L1922)
- **Class**: Auth weakness + UX data loss
- **Evidence**: POST `/api/auth/totp/recovery-codes` is gated only by session check — no TOTP code re-entry. A hijacked session can regenerate recovery codes silently. Additionally, backdrop click while `recoveryGenerating === true` discards the freshly-generated codes (one-time view), permanently locking the operator out of their backup.
- **Fix**: Require TOTP code in the request body; verify server-side before generating. Guard drawer backdrop while `recoveryGenerating === true`.

### S-01 — Staff invite generates a random password the owner never sees → permanent lockout
- **Location**: [app/api/staff/route.ts:38-94](app/api/staff/route.ts#L38)
- **Class**: Broken auth flow visible to user
- **Evidence**: When the owner omits a password (the common case — the UI doesn't require one), the route generates `randomBytes(16).toString("hex") + "Aa1!"` and hashes it. The plaintext is never returned, never emailed. `mustChangePassword: true` flag is returned but there's no companion mechanism to set the password. New staff cannot log in.
- **Fix**: Mint an `InviteToken` row (same pattern as `app/api/members/route.ts:248-280` for member invites) and email an `/login/accept-invite?token=…` link. Drop the random-password fallback.

### S-02 — POST /api/members has no CSRF guard + no rate-limit; can spam invites via gym's email sender
- **Location**: [app/api/members/route.ts:124-296](app/api/members/route.ts#L124)
- **Class**: A05 misconfig (CSRF) + abuse vector
- **Evidence**: Route mints a `MagicLinkToken` and emails an invite link on success. Without `assertSameOrigin`, a malicious page can use a logged-in staff session in a victim browser to send invites to attacker-chosen emails FROM the gym's transactional sender — phishing reputation damage.
- **Fix**: Add `assertSameOrigin` at the top of POST + rate-limit envelope (30 creates / hour per tenant+user, key `member:create:${tenantId}:${userId}`).

### P-01 — `app/dashboard/members/page.tsx` `findMany` has NO `take` cap; can OOM at scale
- **Location**: [app/dashboard/members/page.tsx:7](app/dashboard/members/page.tsx#L7)
- **Class**: Scale-blocker
- **Evidence**: `tx.member.findMany({ where: { tenantId } })` with no `take`. Nested `memberRanks` + `attendances` selects compound the row size. At 5 000 members this transfers ~5 MB per render and can OOM a 256 MB Vercel function.
- **Fix**: Add `take: 500` server cap + log a warning when the cap is hit. Cursor-based pagination is a follow-up because the list UI is currently fully client-side.

### P-02 — Missing `@@index([tenantId, name])` on Member; members list does a full tenant scan + JS sort
- **Location**: [prisma/schema.prisma](prisma/schema.prisma) Member model + [app/dashboard/members/page.tsx:7](app/dashboard/members/page.tsx#L7)
- **Class**: Scale-blocker (paired with P-01)
- **Evidence**: `orderBy: { name: 'asc' }` with no covering index forces Postgres to seq-scan + sort. ~50–500 ms saved at 1 000 members.
- **Fix**: Migration adds `@@index([tenantId, name])`.

### P-03 — `lib/reports.ts` opens a second `withTenantContext` block; doubles Neon connection pressure
- **Location**: [lib/reports.ts:256-264](lib/reports.ts#L256)
- **Class**: Connection pool exhaustion at concurrency
- **Fix**: Fold the class-name resolution into the first `withTenantContext`'s `Promise.all`.

### P-04 — `app/dashboard/analysis/page.tsx` uses `distinct` instead of `groupBy`; materialises entire month's rows in JS
- **Location**: [app/dashboard/analysis/page.tsx:54-59](app/dashboard/analysis/page.tsx#L54)
- **Class**: 10x DB transfer + JS memory pressure
- **Fix**: Replace `findMany({ distinct: ["memberId"] })` with `groupBy({ by: ["memberId"], _count: true })`.

### P-05 — `app/dashboard/attendance/page.tsx` fetches all month/week rows to JS just to count
- **Location**: [app/dashboard/attendance/page.tsx:83-110](app/dashboard/attendance/page.tsx#L83)
- **Class**: 10x DB transfer
- **Fix**: Replace two `findMany` calls with `count()`.

---

## High findings (fixed in this PR)

### CSRF sweep — 13 mutating routes lack `assertSameOrigin`

The `assertSameOrigin` helper exists ([lib/csrf.ts](lib/csrf.ts)) and is adopted on ~30 routes from the prior 9-area audit. The following routes were missed and are bulk-added in this PR:

- S-03: [app/api/staff/route.ts](app/api/staff/route.ts) POST
- S-03: [app/api/staff/[id]/route.ts](app/api/staff/%5Bid%5D/route.ts) PATCH, DELETE
- S-04: [app/api/memberships/route.ts](app/api/memberships/route.ts) POST + [app/api/memberships/[id]/route.ts](app/api/memberships/%5Bid%5D/route.ts) PATCH, DELETE
- S-05: [app/api/classes/route.ts](app/api/classes/route.ts) POST + [app/api/classes/[id]/route.ts](app/api/classes/%5Bid%5D/route.ts) PATCH, DELETE + `instances/route.ts` POST + `roster/route.ts` PUT + `roster/[memberId]/route.ts` DELETE + [app/api/instances/generate/route.ts](app/api/instances/generate/route.ts) POST
- S-06: [app/api/ranks/route.ts](app/api/ranks/route.ts) POST + [app/api/ranks/[id]/route.ts](app/api/ranks/%5Bid%5D/route.ts) PATCH, DELETE
- S-07: [app/api/products/[id]/route.ts](app/api/products/%5Bid%5D/route.ts) PATCH, DELETE
- S-08: [app/api/orders/[id]/mark-paid/route.ts](app/api/orders/%5Bid%5D/mark-paid/route.ts) POST
- S-09: [app/api/reports/generate/route.ts](app/api/reports/generate/route.ts) POST
- S-10: [app/api/announcements/route.ts](app/api/announcements/route.ts) POST + [app/api/announcements/[id]/route.ts](app/api/announcements/%5Bid%5D/route.ts) PATCH, DELETE
- S-11: [app/api/initiatives/route.ts](app/api/initiatives/route.ts) POST + [app/api/initiatives/[id]/route.ts](app/api/initiatives/%5Bid%5D/route.ts) PATCH, DELETE
- S-12: [app/api/members/[id]/rank/route.ts](app/api/members/%5Bid%5D/rank/route.ts) POST + [app/api/members/[id]/rank/demote/route.ts](app/api/members/%5Bid%5D/rank/demote/route.ts) POST
- S-13: [app/api/members/[id]/link-child/route.ts](app/api/members/%5Bid%5D/link-child/route.ts) POST + `unlink-child/route.ts` POST
- S-14: [app/api/settings/route.ts](app/api/settings/route.ts) PATCH
- S-15: [app/api/class-packs/route.ts](app/api/class-packs/route.ts) POST + [app/api/class-packs/[id]/route.ts](app/api/class-packs/%5Bid%5D/route.ts) PATCH, DELETE
- S-16: [app/api/drive/select-folder/route.ts](app/api/drive/select-folder/route.ts) POST + `disconnect/route.ts` POST + `index/route.ts` POST
- S-17: [app/api/admin/email/test/route.ts](app/api/admin/email/test/route.ts) POST
- S-18: [app/api/owner/reset-onboarding/route.ts](app/api/owner/reset-onboarding/route.ts) POST
- S-22: [app/api/coach/instances/[id]/attendance/route.ts](app/api/coach/instances/%5Bid%5D/attendance/route.ts) POST

Pattern (single-line addition at the top of every handler):

```ts
const csrfViolation = assertSameOrigin(req);
if (csrfViolation) return csrfViolation;
```

### Missing audit log — 6 mutating routes write without `logAudit`

- S-19: [app/api/tasks/route.ts:240-282](app/api/tasks/route.ts#L240) — staff_task branch (legacy)
- S-20: [app/api/tasks/[id]/complete/route.ts:17-87](app/api/tasks/%5Bid%5D/complete/route.ts#L17)
- S-28: [app/api/admin/email/test/route.ts](app/api/admin/email/test/route.ts)
- S-29: [app/api/owner/reset-onboarding/route.ts](app/api/owner/reset-onboarding/route.ts)
- S-31: [app/api/members/[id]/rank/route.ts:141-155](app/api/members/%5Bid%5D/rank/route.ts#L141) — photo attach side-effect
- S-33: [app/api/instances/generate/route.ts](app/api/instances/generate/route.ts) + [app/api/classes/[id]/instances/route.ts](app/api/classes/%5Bid%5D/instances/route.ts)

### Cache-Control sweep — 7 per-tenant aggregate routes lack `private, no-store`

CDN/proxy caching of per-tenant data is a cross-tenant leak risk. Bulk-add `Cache-Control: private, no-store`:

- P-42: `app/api/reports/route.ts`
- P-43: `app/api/revenue/summary/route.ts`
- P-44: `app/api/promotions/candidates/route.ts`
- P-45: `app/api/checkin/members/route.ts`
- P-46: `app/api/staff/route.ts`
- P-47: `app/api/coach/today/route.ts`
- P-63 (policy): also `app/api/members/route.ts`, `app/api/classes/route.ts`, `app/api/ranks/route.ts`, `app/api/announcements/route.ts`

### P-07 — Rank-gate dry-run uses bare `include: { member: true }` returning `passwordHash`
- **Location**: [app/api/classes/[id]/route.ts:86-99](app/api/classes/%5Bid%5D/route.ts#L86)
- **Class**: A02 — sensitive field exposure (passwordHash, totpSecret in process memory + outgoing JSON if response shape changes)
- **Fix**: Explicit `select:` chain — only `memberId` + the rank fields actually consumed.

### S-23 — Announcement image upload orphans blob on POST failure
- **Location**: [components/dashboard/AnnouncementsView.tsx:73-125](components/dashboard/AnnouncementsView.tsx#L73)
- **Class**: Storage bloat + base64 fallback writes ~6.7 MB strings to Postgres
- **Fix**: Drop the base64 fallback. On `/api/announcements` POST failure after a successful upload, fire DELETE against the blob URL.

### S-30 — Staff PATCH doesn't bump `sessionVersion` on password change
- **Location**: [app/api/staff/[id]/route.ts:60-91](app/api/staff/%5Bid%5D/route.ts#L60)
- **Class**: A07 — incomplete session invalidation
- **Fix**: When `newPassword` is set, also set `data.sessionVersion = { increment: 1 }`. Mirrors `app/api/admin/customers/[id]/force-password-reset/route.ts:71`.

### Optimistic UI without rollback — 4 manager components

- V-07 / S-37: [components/dashboard/RanksManager.tsx](components/dashboard/RanksManager.tsx) reorder, delete, bulk-create — snapshot prev, restore on failure
- S-38: [components/dashboard/MembershipsManager.tsx](components/dashboard/MembershipsManager.tsx) — same pattern fix
- S-39: [components/dashboard/SettingsPage.tsx](components/dashboard/SettingsPage.tsx) staff list — same pattern fix
- V-15 cross-link: [components/dashboard/DashboardStats.tsx:231](components/dashboard/DashboardStats.tsx#L231) `handleComplete` rollback — already correct, refresher on consistency only

### P-67 — `MemberProfile.tsx:saveProfile` doesn't send `updatedAt`; concurrency guard inactive
- **Location**: [components/dashboard/MemberProfile.tsx:saveProfile](components/dashboard/MemberProfile.tsx)
- **Class**: Silent concurrent overwrite
- **Fix**: Include `updatedAt: member.updatedAt` in the PATCH body; the server already handles the 409 case.

### Other High items folded into this PR

- S-32: `app/api/members/[id]/rank/route.ts:14-16` — `photoUrl` accepts arbitrary protocols. Restrict to Vercel Blob origin OR `data:image/(png|jpeg|webp)` only.
- S-36: AnnouncementsView base64 fallback writes to DB — drop, error instead.
- S-41: rate-limit keys for DSAR per-tenant could starve concurrent operators — switch to `${tenantId}:${userId}`.

---

## Medium + Low — deferred to follow-up backlog

See [lane-01-iter-1-followups.md](lane-01-iter-1-followups.md). Headline counts:

- 13 verifier Mediums (mostly UX guards on backdrop / Cancel during save)
- 24 security Mediums (audit log enrichment, error-log hygiene, console.error redaction)
- 28 scientist Mediums (bare `include` payload narrowing where no sensitive field leaks, more `Cache-Control` headers, `select:` defensive hygiene)
- 37 Lows (polish, demo data, dead UI placeholders, copy nits, micro-perf)

Convergence rule: these do NOT block lane-1 convergence. Lane-1 converges when iter-N and iter-N+1 both return 0 Critical + 0 High across all three subagents.

---

## Status

iter-1: 10 Critical + 26 High deduped → fixes shipped in this PR. iter-2 runs after the fixes land + gates re-green.
