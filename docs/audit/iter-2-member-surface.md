# Audit — Iteration 2, Area 5: Member surfaces

**Date**: 2026-05-31
**Branch**: `audit/loop-fixes-05`
**Predecessor**: `iter-1-member-surface.md` (closed 7 High)
**Method**: 3 OMC subagents in parallel re-audit post-iter-1 fixes (security with OWASP cheat-sheet, verifier, perf).

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 0 | **0** | 4 | 2 |
| Verifier | 0 | 2 | 2 | 2 |
| Perf | 0 | 2 | 4 | 2 |

**Deduplicated NEW Critical**: 0.
**Deduplicated NEW High**: 4 (2 verifier state-machine/test-correctness + 2 perf).

**iter-1 closures re-verified by verifier**: A5H-2 (cancellation banner) ✓, A5H-3 (schedule localStorage primaryColor) ✓, A5H-4 (DemotionBanner render) ✓, A5H-5 (nav tap-height ≥48px) ✓.

**Security iter-2 verdict (verbatim)**: *"0 Critical, 0 High. The 7 High findings from iter-1 are confirmed closed. The codebase shows strong security posture across the member surface with consistent patterns for authentication, CSRF, tenant isolation, and input validation."*

---

## NEW High findings (Batch D, this iter)

### A5I2-V-1 · Cancellation banner missing `suspended` branch

- **File**: `app/member/home/page.tsx:1267`
- **Class**: State-machine completeness (verifier)
- **Description**: iter-1 added the cancelled/inactive banner, but `Member.status` also takes `suspended` (tenant-level enforcement / owner action) per `prisma/schema.prisma:124`. A suspended member sees the normal home screen with no indication their access is restricted.
- **Fix**: Extend the guard to `(memberStatus === "cancelled" || memberStatus === "inactive" || memberStatus === "suspended")` and simplify the label string to interpolate `memberStatus` directly.

### A5I2-V-2 · Parent-mode test uses wrong localStorage key

- **File**: `tests/unit/member-home-parent-mode.test.tsx:82`
- **Class**: Test correctness (verifier)
- **Description**: Test pre-seeds `{ "matflow.onboarding.v1": "true" }` but the production code reads `bjj_onboarded` (`app/member/home/page.tsx:61`). The onboarding modal renders on top of the page in jsdom, risking false-green assertions on the underlying content.
- **Fix**: Change the test's initial localStorage store to `{ bjj_onboarded: "true" }`.

### A5I2-P-1 · `/api/member/me/recent-demotion` N+1 + missing indexes

- **File**: `app/api/member/me/recent-demotion/route.ts:48-53` + `prisma/schema.prisma` (`model RankHistory`)
- **Class**: N+1 + missing index (perf)
- **Description**: For each of up to 5 RankHistory rows, two sequential `rankSystem.findUnique` calls — up to 11 trips worst case. Plus `RankHistory` had **zero indexes** (`memberRankId` unindexed, `promotedAt` unindexed), so the outer `findMany` is a full table scan. Invisible at demo scale; breaks at ~500 members × ~5 rank events.
- **Fix**:
  1. Collect all `fromRankId`/`toRankId` from the rows, bulk-fetch via single `rankSystem.findMany({ where: { id: { in: allIds } } })`, resolve via in-memory `Map`. Worst case drops from 11 round-trips to 2.
  2. Add `@@index([memberRankId])` + `@@index([promotedAt])` to `RankHistory` via migration `20260531200000_rank_history_indexes`.

### A5I2-P-2 · `/api/member/me` GET fires 3 sequential `withTenantContext` blocks

- **File**: `app/api/member/me/route.ts:74-133`
- **Class**: N+1 (connection-setup) — perf
- **Description**: GET opens 3 separate `withTenantContext` connections sequentially: `member.findFirst`, `computeMemberStats`, conditional `user.findUnique` for `promotedBy`. Each `withTenantContext` acquires + releases a pooled connection (~5–15ms each on a cold pool). Common post-promotion path pays 3× connection-setup cost before responding.
- **Fix**: Merge into a single `withTenantContext` block; the three internal queries are already sequential by data dependency. Connection-setup cost drops from 3× to 1×.

---

## NEW Medium findings (backlog)

- **M-A5I2-1**: PATCH `/api/member/me` lacks a zod schema (uses per-field manual guards). Defence-in-depth gap — no exploitable path today thanks to `stripTotpFields` + Prisma typed schema + IDOR-impossible self-only scope. (`app/api/member/me/route.ts:204-230`)
- **M-A5I2-2**: Kid photo upload schema accepts any URL scheme. Currently rendered only as `<img src>` (browsers sandbox `javascript:`/`data:text/html`), so no exploit today, but any future render in `<a href>`/`<iframe src>` makes it stored-XSS. (`app/api/member/children/[id]/photos/route.ts:31`)
- **M-A5I2-3**: No `logAudit` on `/api/member/checkout` and `/api/member/class-packs/buy`. Every other billing-mutating member route audits — gap is compliance/forensics, not exploitable.
- **M-A5I2-4**: No rate-limit on member checkout/subscription-start/cancel routes. Requires a stolen session to abuse; would burn Stripe API quota + create many pending charges.
- **M-A5I2-5**: `tests/unit/demotion-cascade.test.ts` covers the route but `<DemotionBanner />` has no unit test (its fetch + dismiss + null-render paths are untested at UI layer).
- **M-A5I2-6**: Profile `MILESTONES` + `BEGINNER_CARD` are hardcoded demo data (`app/member/profile/page.tsx:14-51, :379`). Same class as deferred A5H-6 — needs `/api/member/me/milestones` endpoint.
- **M-A5I2-7**: PATCH `/api/member/me` opens 2 pre-flight read-`withTenantContext` blocks before the update (onboarding-completion trio + waiver). Common finish-onboarding flow pays 4 sequential connections. Merge into one read like P-2.
- **M-A5I2-8**: `/api/member/classes` does 50 `ClassInstance` + 50 `Class` joins per page, but the result set deduplicates to ~10 unique classes. Use `classSubscription.findMany` (the correct semantic) or `distinct` on `classId`.

## NEW Low findings (backlog)

- **L-A5I2-1**: Home + Progress + Profile each independently `fetch("/api/member/me")` per `useEffect`. The `Cache-Control: private, max-age=30` from iter-1 A5H-8 helps subsequent loads, but a cold first nav to each page still fires a fresh round-trip. Lift to layout-level Context or SWR.
- **L-A5I2-2**: `FamilySection` fetches `/api/member/me/children` (no timetable) while home fetches `?include=timetable`. Different URLs → no cache sharing. Unify the URL.
- **L-A5I2-3**: Cancellation banner has no dismiss — inconsistent with `<DemotionBanner />` pattern. Low risk in practice; reactivation triggers nav.
- **L-A5I2-4**: `memberName` default is hardcoded `"Alex"`; brief flash of `"Good morning, Alex"` before fetch lands. Same on profile (`"Alex Johnson"`). Use empty initial + conditional render or skeleton.
- **L-A5I2-5**: GET `/api/member/me` catch-block returns DEMO_RESPONSE (200) on any DB error — masks DB outages from monitoring + may briefly show wrong identity on transient failure. Switch to 503 (operational only — does not change happy path).
- **L-A5I2-6**: `/api/member/me/payments` and `/api/member/family/[id]/billing` GETs have no `Cache-Control` header. Next.js defaults to `no-store`, so safe in practice — but intermediate proxies might cache by default. Set explicit `private, no-store`.

---

## Static gates after Batch D

- `npx tsc --noEmit` → clean
- `npx vitest run tests/unit/{member-home-parent-mode,announcements-unseen}.test.ts` → 10/10 pass
- Migration `20260531200000_rank_history_indexes` hand-crafted (idempotent `CREATE INDEX IF NOT EXISTS` — safe against test branch divergence; `prisma migrate deploy` will apply in CI / test branch). Schema edit + `prisma generate` complete.

## Status

iter-2 = 0 Critical + 4 High. Batch D applied. **Next**: iter-3 audit (same 3 agents) to confirm 0/0 — that's the 2-consecutive-clean gate for area audit-green. After audit-green: test-engineer phase (1–3 dual-project e2e specs), then merge PR #10, then Area 6.
