# MatFlow audit log

A chronological index of every audit iteration that has been run against the
codebase. Each entry links to its iter document.

Audit work runs as a **ralph loop with harsh-exit conditions**: three OMC
subagents (security-reviewer, verifier, scientist) fan out in parallel against
a scoped lane; findings get severity-rated (Critical / High / Medium / Low);
Critical+High get fixed in the same iteration's PR; Medium+Low get documented
as feature follow-ups. A lane converges when **two consecutive iterations
return 0 Critical + 0 High** for that scope.

## Lanes (current — site-wide audit, post-Track A)

- [Lane 1 — Owner/Staff dashboard](#lane-1--ownerstaff-dashboard)
- Lane 2 — Member-facing surface (pending)
- Lane 3 — Auth + Stripe + payment flows (pending)
- Lane 4 — Cross-cutting: visual integrity + a11y + mobile + light/dark (pending)

### Lane 1 — Owner/Staff dashboard

Scope: `app/dashboard/**`, `components/dashboard/**`, `app/api/admin/**`.

- (iter-1 in progress — doc to land at `lane-01-iter-1-dashboard.md`)

## Prior audit work (the original 9-area sweep — converged + merged)

| Area | Iter 1 | Iter 2 | Iter 3 | Iter 4 |
|---|---|---|---|---|
| 1 — Auth boundary | [iter-1](iter-1-auth-boundary.md) | [iter-2](iter-2-auth-boundary.md) | [iter-3](iter-3-auth-boundary.md) | — |
| 2 — PRs | [iter-1](iter-1-prs.md) | [iter-2](iter-2-prs.md) | [iter-3](iter-3-prs.md) | [iter-4](iter-4-prs.md) |
| 3 — Member lifecycle | [iter-1](iter-1-member-lifecycle.md) | [iter-2](iter-2-member-lifecycle.md) | — | — |
| 4 — Dashboard | [iter-1](iter-1-dashboard.md) | — | — | — |
| 5 — Member surface | [iter-1](iter-1-member-surface.md) | [iter-2](iter-2-member-surface.md) | — | — |
| 6 — Operator/Admin | [iter-1](iter-1-operator-admin.md) | [iter-2](iter-2-operator-admin.md) | — | — |
| 7 — Infra config | [iter-1](iter-1-infra-config.md) | — | — | — |
| 8 — Database | [iter-1](iter-1-database.md) | — | — | — |
| 9 — Tests | [iter-1](iter-1-tests.md) | — | — | — |

## Feature design docs

- [Member-tickable notes](feature-member-notes.md) — Track A predecessor (PR #15)

## Deferred backlog

- [Medium severity backlog](backlog-medium.md)
- [Low severity backlog](backlog-low.md)
