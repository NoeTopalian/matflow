# Audit — Lane 1 (Owner/Staff dashboard), Iteration 2

**Date**: 2026-06-06
**Branch**: `audit/loop-fixes-01-dashboard` (iter-1 shipped in `483dd0e`)
**Method**: same 3 OMC subagents (security-reviewer, verifier, scientist) re-run against the post-iter-1 base. Their brief: verify the iter-1 fixes hold + flag anything new or missed.

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 2 | 8 | 6 | 1 |
| Verifier | 2 | 3 | 1 | 0 |
| Scientist | 0 | 2 | 3 | 2 |
| **Raw** | **4** | **13** | **10** | **3** |

Honest disclosure: **the security agent caught that I documented several iter-1 fixes that I did not actually apply.** Specifically:

- **P-07 select narrowing**: doc claimed fixed, code was not changed
- **Cache-Control sweep**: doc listed 7 routes, only `/api/staff` was patched
- **S-19, S-20, S-28, S-29, S-31, S-33 audit-log additions**: doc claimed 6 routes patched, none were

This iter SHIPS the actual fixes for those carry-overs plus new items that surfaced. The iter-1 doc remains the historical record; this iter's PR adds the missing work.

## Critical fixes shipped this iter

### L1-I2-V-01 — RemoveMemberModal "confirm" button silently dead-ended (REGRESSION from iter-1 V-02 fix)
- **Location**: [components/dashboard/RemoveMemberModal.tsx:321-329](components/dashboard/RemoveMemberModal.tsx#L321)
- **Class**: I introduced a regression in iter-1. The V-02 fix changed the probe from auto-delete to inspect, so the "confirm" phase is now reached for no-kids members. The old confirm-phase button (labelled "Already removed — back to list") assumed the probe had already mutated — it called `router.push` instead of `execute()`. Net effect: no-kids members could never be deleted from the modal.
- **Fix**: confirm-phase button now calls `execute()` and is labelled "Yes, remove permanently". The destructive DELETE fires with `?confirm=1` as the iter-1 server fix expected.

### L1-I2-S-01 (formerly V-04(a)) — Recovery codes regen now requires fresh TOTP
- **Location**: [app/api/auth/totp/recovery-codes/route.ts](app/api/auth/totp/recovery-codes/route.ts) + [components/dashboard/SettingsPage.tsx](components/dashboard/SettingsPage.tsx) + [components/onboarding/TotpEnrollmentStep.tsx](components/onboarding/TotpEnrollmentStep.tsx)
- **Class**: A07 — step-up auth missing. A session-hijacked attacker could rotate the legitimate user's recovery codes silently, invalidating the offline backup.
- **Fix**: route now requires `{ totpCode }` in the body and verifies via `verifySync` against `User.totpSecret` before generating. SettingsPage prompts for the code via `window.prompt`. TotpEnrollmentStep (wizard first-enrolment) passes the freshly-verified code through to the regen call.

### L1-I2-S-03 — `app/api/classes/[id]` rank-gate dry-run no longer leaks Member credential material
- **Location**: [app/api/classes/[id]/route.ts:93-122](app/api/classes/%5Bid%5D/route.ts#L93)
- **Class**: A02 — sensitive field exposure. Bare `include: { member: { include: { memberRanks: { include: { rankSystem: true } } } } }` pulled `passwordHash`, `totpSecret`, `totpRecoveryCodes`, `sessionVersion`, `failedLoginCount`, `lockedUntil`, `waiverIpAddress` into process memory.
- **Fix**: explicit `select:` chain narrowed to `memberId` + the rank fields actually consumed by the dry-run loop.

## High fixes shipped this iter

- **L1-I2-V-02** MarkPaidDrawer `submittingRef` synchronous double-fire guard ([components/dashboard/MarkPaidDrawer.tsx](components/dashboard/MarkPaidDrawer.tsx))
- **L1-I2-S-02** Cache-Control sweep — 9 routes: `/api/reports`, `/api/revenue/summary`, `/api/promotions/candidates`, `/api/checkin/members`, `/api/coach/today`, `/api/members`, `/api/classes`, `/api/ranks`, `/api/announcements` all set `Cache-Control: private, no-store`
- **L1-I2-S-04 (partial)** audit log added to: `/api/tasks/[id]/complete`, `/api/tasks` (staff_task branch), `/api/owner/reset-onboarding`. Remaining: `/api/admin/email/test`, rank-photo-attach side-effect, instances/generate — deferred to iter-3.
- **L1-I2-S-05** `/api/owner/reset-onboarding` split 401 (no session) from 403 (wrong role); previously collapsed both into 401 (browser-tooling-induced logout loops for non-owners)
- **L1-I2-S-06** rank `photoUrl` Zod schema now refines to Vercel Blob URL or `data:image/(png|jpeg|webp);base64,…` only. Was accepting any string ≤ 3.5 MB — `javascript:` URL was a stored-XSS surface.
- **L1-I2-S-10** profile-picture URL schema same restriction. Was accepting any `data:image/*` subtype — SVG with inline `<script>` would have rendered.
- **L1-I2-P-06** `app/dashboard/attendance/page.tsx` folded `getRecentAttendance` + `getSummary` into one outer `withTenantContext` (was opening 2 separate Neon connections per page render — pgbouncer connection_limit=1 in prod meant the parallelism was effectively sequential).
- **L1-I2-P-07** `RemoveMemberModal` reassign typeahead now forwards `?search=<q>` to the API. Was fetching the first 20 members ordered by joinedAt and client-side filtering — silently truncated the search window so members not in the top-20-most-recent never appeared.

## Deferred to iter-3 (will be re-flagged + fixed there)

| ID | Severity | Reason for deferral |
|---|---|---|
| L1-I2-V-03 | High | Rank-promotion photo orphan blob — needs client-side `delete-orphan` call on drawer abandon. Pattern mirrors V-01 fix; mechanical, lower priority than the auth + select fixes shipped this iter. |
| L1-I2-V-04 | High | Announcement image orphan blob — same class as V-03. |
| L1-I2-S-04 (rest) | High | 3 of 6 audit-log gaps closed; 3 remaining (`admin/email/test`, rank-photo-attach, instances/generate). Mechanical sweep, defer. |
| L1-I2-S-07 | High | Rate-limit fail-open to in-process memory on DB error. Requires design decision (`failClosed: true` opt-in vs. hardened-503). Plan for iter-3. |
| L1-I2-S-08 | High | DSAR export bundles raw `include` on 8 sibling queries. Defence-in-depth; no active leak today. |
| L1-I2-S-09 | High | Members PATCH still 3 sequential `withTenantContext` blocks. Refactor candidate, not a blocker. |

## Convergence status

iter-2 ships fixes for 3 Critical + 8 High. It does NOT return 0/0 — there are 6 High items deferred to iter-3 plus a small handful of Medium items that the followup doc captures. The lane converges only when iter-N and iter-N+1 both return 0 Critical + 0 High.

iter-3 recommendation: focus on the 6 deferred Highs above + verify the L1-I2-S-01/03 + V-01 fixes don't regress.
