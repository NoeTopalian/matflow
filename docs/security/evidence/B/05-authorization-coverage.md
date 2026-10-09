# B-05 — Authorization, tenant isolation and transaction coverage (SEC-017 … SEC-032)

Lane B, 9 Oct 2026. Candidate `2a6487e` + lane-B working-tree changes (listed in REPORT.md). TEST branch
(`ep-hidden-salad`) through the guarded runners only: owner role = `neondb_owner` (BYPASSRLS — RLS NOT in force),
restricted = `matflow_app` (`RLS_ENFORCED=1`, RLS in force; confirmed by `sec-b-rls-identity-db`). Mail dark (mocked);
rate limiter stubbed per file. Logs under `<scratchpad>/security/B/logs/` (existing-suite runs in `logs/existing/`,
`summary.txt` one line per file × role).

## Lane-B tests written

| File | Level | Owner role | Restricted |
|---|---|---|---|
| `tests/integration/sec-b-sean-imported-cancelled-db.test.ts` | I | 6/6 exit 0 | 6/6 exit 0 |
| `tests/integration/sec-b-ownership-transfer-db.test.ts` | I (races, 3 connections) | 9/9 exit 0 | 9/9 exit 0 |
| `tests/integration/sec-b-version-at-check-db.test.ts` | I | 4/4 exit 0 | 4/4 exit 0 |
| `tests/integration/sec-b-role-matrix-db.test.ts` | I (role × route, positive controls, swaps, support row) | see final run in REPORT | see final run in REPORT |
| `tests/integration/sec-b-rls-identity-db.test.ts` | I (RLS) | 6/6 exit 0 — RLS cells RECORD "not in force" (not a pass) | 6/6 exit 0 — enforced |
| `tests/integration/sec-b-fixture-sweep-db.test.ts` | tooling (prefix `secb-` sweep, opt-in `SEC_B_SWEEP=1`) | exit 0 | — |
| `tests/unit/login-identity-writers.test.ts` (rewritten) | Review/U | 7/7 | — |
| `tests/unit/sec-b-support-backstop.test.ts` | C/U (static) | 2/2 | — |
| `tests/unit/sec-b-email-normalisation.test.ts` | U | 3/3 | — |

Mutation / red evidence: contact-route mutants A/B (B-01), old vs new writer guard with planted writers (B-02),
pre-fix transfer routes red on cells 6/8a/8b (B-03), unlock gate widened to all staff → admin/coach cells fail (killed),
unlock support guard removed → static test lists it and the matrix support cell fails (killed).

## Static gate inventory (C) — lane-B route scope

Mutating handlers in `app/api/members/**`, `app/api/staff/**`, `app/api/account/**`: every one is session-gated with an
explicit role list (owner-only: staff create/edit/delete/2FA reset/transfer, member delete, promote-to-adult, charge,
payment-method; owner+manager: member unlock/2FA reset/hold/resume/guardian/link/unlink/invite-link/bulk-invite;
owner+manager+admin: member create/edit; all staff: rank, photos, waiver-link, card revoke). `app/api/member/**` gate on
`session.user.memberId` (a staff or support session has none → 403). Public by design: `members/accept-invite`
(token), `account/pending-tenant` (pre-session). No club route in scope takes a tenant id from the body, query or a
header (grep); the tenant always comes from the session. Operator routes take the club from the URL and are operator-gated.

## Coverage rows

| ID | Applicability | Verification | Level | Evidence |
|---|---|---|---|---|
| SEC-017 Object-level | APPLICABLE | PASS (scope sample) | I, both roles | role-matrix swap cells (6 object routes: club A owner on club B object → 404, B byte-identical); transfer cell 4; existing `cross-tenant-authorisation-matrix` 54/54 both roles, `roster-cross-tenant` 3/3, `tenant-isolation` 2/2, `cross-tenant-stats` 3/3 both roles |
| SEC-018 Function-level | APPLICABLE | PASS for 9 routes × 6–7 roles; rest by static inventory only | I + C | role-matrix: positive control per allowed role, 401/403 (never 404/500) and row unchanged per denied role; mutant killed |
| SEC-019 Mass assignment | APPLICABLE | PASS (member create/edit) | I | role-matrix mass-assignment cell: tenantId, passwordHash, sessionVersion, totp*, externalRef, importJobId, billedBy, parentMemberId ignored (zod strips); owner-route non-strict body is AH-G6 (lane C) |
| SEC-020 Tenant selection confusion | APPLICABLE | PASS (code review, scope) / browser NOT RUN | C | no client-supplied tenant id in scope; host/cookie/session disagreement at the browser level belongs to lanes A/C |
| SEC-021 RLS / runtime role | APPLICABLE | TEST: PASS under `matflow_app`; PRODUCTION: UNKNOWN → **BLOCKED** (lead / lane E) | I | `sec-b-rls-identity-db` (restricted): club B identity/token rows invisible, cross-club UPDATE (ORM and raw SQL) matches 0, INSERT/MOVE into club B refused by WITH CHECK, no-context default deny; `rls-coverage` 1/1, `rls-foundation` 9/9 (restricted; 6 skipped under owner). Residual: `app.bypass_rls` is settable by the app role itself (116 `withRlsBypass` calls in 62 files) — RLS backs up a forgotten filter inside `withTenantContext`, nothing more. Under a BYPASSRLS runtime role the app-layer filter is the only defence (demonstrated: the cross-club UPDATE succeeds as `neondb_owner`) |
| SEC-022 List/search/export disclosure | APPLICABLE | PASS for `GET /api/members`; exports NOT RUN by lane B | I | role-matrix list cell (club A staff never see club B rows; member/anonymous refused) |
| SEC-023 Support escalation | APPLICABLE | **FIXED** (defence in depth) → PASS | I + C | FINDING SEC-B-F4: 15 member mutators lacked the in-route support refusal (unlock answered 200 to a support session at the handler); proxy.ts refuses non-GET support requests first, so not reachable through the proxy. Fix: `refuseSupportSession` in each; static guard + matrix support row. Existing `support-session-binding-db` 5/5 both roles |
| SEC-024 Background-job authority | APPLICABLE | NOT RUN (lane B) | — | writer inventory: no cron/job writes User/Member email; cron authority is lane F/C |
| SEC-025 Cross-table collision | APPLICABLE | PASS | I | Sean scenario (B-01); `login-identity-claims-db` (see summary.txt); admin-hub race suite (not re-run) |
| SEC-026 Normalisation | APPLICABLE | PASS | U + I | `sec-b-email-normalisation` (non-ASCII refused before folding; claim compares `lower(btrim())`); `email-lowercase-invariant` (summary.txt) |
| SEC-027 Legacy duplicates | APPLICABLE | PASS (I, admin-hub claims-db `many` cases) | I | `login-identity-claims-db`; read-only duplicates script (production run is the operator's call) |
| SEC-028 TOCTOU / stale version | APPLICABLE | PASS member route; **AH-C2 OPEN Low** (owner route) | I | B-04 |
| SEC-029 Writer bypass | APPLICABLE | guard gap FIXED; SEC-B-F1 (script) OPEN | Review/U | B-02 |
| SEC-030 Partial multi-step | APPLICABLE | PASS (hub two-step, admin-hub evidence; Sean sequence re-run) + transfer audit moved into the transaction | I | B-01, B-03 |
| SEC-031 Lost response / retry | APPLICABLE | PASS | I | transfer replay → `alreadyApplied` (cell 5, both roles); hub member/owner replay (admin-hub DB suites) |
| SEC-032 Ownership / destructive races | APPLICABLE | **FIXED** → PASS | I (3 connections, both roles) | B-03 (SEC-B-F3) |

## Harness finding (SEC-088 input for lane F)

`tests/integration/security.test.ts` F5 (staff creation) fails 2/12 under BOTH runners at this candidate: the file mocks
`@/lib/prisma-tenant` with a transaction client that has no `$executeRaw`/`$queryRaw`, and since `48a9182` the staff
route takes the claim lock, so it answers 500. Pre-existing (lane B did not touch `app/api/staff/route.ts`); the
admin-hub "integration green" list did not include this file. Owner of the fix: whoever owns that file (mock needs the
two raw methods returning `[]`/`0`).
