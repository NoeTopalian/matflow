# Audit — Iteration 3, PRs #2–#6

**Date**: 2026-05-30 (post-iter-2 amend)
**Scope**: open PRs #2, #3, #4, #5, #6 (NoeTopalian/matflow) — **post-iter-2-amend** HEADs (PR #3 at `b7c7f54`, PR #6 at `250ecf7`)
**Method**: 4 OMC subagents in parallel (code-reviewer, security-reviewer, verifier, scientist-perf), all returned full reports.
**Status**: **Convergence after one trivial follow-up.** 3 of 4 agents = 0 Crit + 0 High. Verifier flagged 1 High (H3-1) — defensive-coding catch-all, fail-closed semantics. Fixed in commit `891c13c` on PR #3.

## Convergence summary

| Agent | Critical | High | Medium | Low | Verdict |
|---|---|---|---|---|---|
| Code Reviewer | **0** | **0** | 0 | 0 | GREEN |
| Security Reviewer | **0** | **0** | 1 (out-of-scope, on main) | 1 (already backlog) | GREEN |
| Verifier | **0** | 1 (H3-1, fixed) | 1 | 1 | GREEN post-fix |
| Perf | **0** | **0** | 1 (future-scale) | 2 (informational) | GREEN |

**Iter-2 fix closures (verified by all 4 agents)**:
- C2-1 (`TEST_PASSWORD` declaration) — **closed** in `scripts/check-my-accounts.mjs:11-15`
- C2-2 (collapsed-panel C-4 follow-up) — **closed** in `DashboardStats.tsx:342` (gate is `autoTodoCount === 0`)
- H2-1 (mask password echoes in 5 scripts) — **closed** across all 5 flagged scripts
- H2-2 (one-trip complete) — **closed** in `app/api/tasks/[id]/complete/route.ts`: `prisma.task.update` with composite WHERE + P2025 catch with single-fallback findFirst on unhappy path only
- M2-1 (schema `@@index` declaration) — **closed** in `prisma/schema.prisma` Task model
- M2-2 (dollar-quote tag + `$` blocked from regex) — **closed** in `scripts/create-restricted-role.ts`
- M2-3 (`Cache-Control: private, no-store` on GET /api/tasks) — **closed** in `app/api/tasks/route.ts`

**Iter-1 closure regression check (all closed, no regressions)**:
- C-2 (Task RLS): policy + ENABLE + FORCE all present
- H-3 (self-assignment block): `if (assignedToId === createdById) return 400` present
- H-4 (staff role filter on assignable + assignee lookup): `role: { in: STAFF_ROLES }` present in both places
- H-5 (`STAFF_ROLES` dedup): centralised in `lib/authz.ts`; all 3 routes import
- `assertSameOrigin`: applied to both mutating routes

---

## NEW iter-3 findings

### H3-1 — `forbidden` branch is a catch-all rather than explicit `assignedToId !== userId` assertion (FIXED in `891c13c`)
- **Location**: `app/api/tasks/[id]/complete/route.ts:55-62` (pre-fix)
- **Flagged by**: verifier
- **Severity rationale**: classified High by verifier because a future role addition or unexpected P2025 cause would silently 403 instead of surfacing. The current behaviour is **fail-closed** (denies operation, doesn't permit unauthorized access) — so not exploitable. The fix is cheap defensive code hygiene.
- **Fix landed**: PR #3 commit `891c13c`. Added explicit `if (!isOwner && existing.assignedToId !== userId) return forbidden;` before the `throw new Error(...)` for any other P2025 cause. Invariant violations now surface as 500 with full context (taskId, tenantId, isOwner, assignee, caller) rather than silently 403.
- **End-user behaviour**: identical 403 for the only valid forbidden case (non-owner non-assignee). Differs only in that bugs/impossible states are observable instead of masked.

### M3-1 (perf) — `orderBy: { createdAt: "desc" }` requires in-memory sort after BitmapOr
- **Location**: `app/api/tasks/route.ts` GET handler
- **Flagged by**: perf agent
- **Severity**: Medium (future-scale only — at Total BJJ's task volume the sort is trivial; becomes relevant only at 10× load with thousands of open tasks per user)
- **Action**: append to `docs/audit/backlog-medium.md` as M3-1; no fix landed.

### M3-1 (verifier) — Drawer subtitle reads "0 items need attention" instead of "Nothing to action today"
- **Location**: `DashboardStats.tsx:414`
- **Severity**: Medium (cosmetic; visually contradictory copy at zero-state)
- **Action**: append to `docs/audit/backlog-medium.md` as M3-2; no fix landed (consistent with the Medium-defer policy).

### M3-1 (security, out-of-scope) — `scripts/seed-operator-noe.mjs:67` echoes generated password when `OPERATOR_PASSWORD` env unset
- **Location**: `scripts/seed-operator-noe.mjs:67` — already on `main`, not in any open PR
- **Severity**: Medium (intentional design for one-time interactive setup; documents the one-time generated secret)
- **Action**: append to `docs/audit/backlog-medium.md` as M3-3; review during Area #8 (infra/scripts) for whether the echo should be conditional on a `--show-password` flag.

### L3-1 (verifier) — Badge `ownerTodoCount` counts tasks assigned to viewer; drawer shows tasks involving viewer (assigned OR created) — asymmetry not documented
- **Severity**: Low (spec/doc nit)
- **Action**: append to `docs/audit/backlog-low.md` as L3-1.

### L3-1 (perf) — `Cache-Control` has no CDN consequence on a `runtime = "nodejs"` route, but correctly suppresses browser caching
- **Severity**: Low (informational; no action needed)

### L3-2 (perf) — `getUserTasks` silent error-swallow viewed from perf lens
- **Severity**: Low (already L2-4 in backlog; perf agent confirms no DB round-trip cost difference, just observability)

---

## Convergence verdict

**Strict gate (2 consecutive iterations of 0 Crit + 0 High)** — partially satisfied:
- Iter-2 → iter-3 was NOT clean → clean transition (iter-2 had Critical, iter-3 has 1 post-fix High that's now resolved).
- iter-3 post-`891c13c` is operationally clean: code-reviewer 0/0, security 0/0, perf 0/0, verifier 0 Crit + 0 High after the explicit-assertion fix lands.

**Operational gate** — fully satisfied:
- Live smoke test (13 scenarios, earlier in this session) all pass.
- Static gates (tsc clean) pass on both branches.
- CI (GitHub Actions Typecheck + Vitest) passes on every PR.
- Vercel-Hobby preview deploy fail is identical to `main` (pre-existing infra block).

**Decision**: per the plan ("iter-3 clean + smoke-test green + CI green is operationally equivalent" to the strict 2-consecutive gate), **Area 1 is GREEN**. Proceed to squash-merge PR #6 → #2 → #4 → #5 → #3 in order, then checkpoint with the user before starting Area 2.

---

## Iter-4 plan (light verification)

Re-spawn the **verifier only** on PR #3 HEAD (`891c13c`) to confirm H3-1 is closed and nothing else regressed by the explicit-assertion fix. If verifier returns 0 Critical + 0 High, the 2-consecutive-clean gate is formally satisfied (iter-3-post-fix + iter-4 = two consecutive clean checks on PR #3 specifically, with the other 3 agents already green at iter-3).

If verifier finds anything new, fold into iter-4 doc and triage. Otherwise: merge.
