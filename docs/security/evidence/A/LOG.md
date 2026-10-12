# Lane A (identity and sessions) — working log

Branch `security/assurance-2026-10`. Candidate `2a6487e` (source build `c837e38`); the branch head when lane A started
was `afc2288` (lead's campaign docs only — no source change since `2a6487e`). Synthetic data only; TEST branch only via
the guarded runners. Entries are appended as work lands so partial work survives.

## 1. AH-G7 / SEC-012 — trace (code review, 9 Oct 2026)

Every path that decides "is this session still allowed" on the club plane:

| # | Path | Behaviour at `2a6487e` on a DB error / malformed result | Verdict |
|---|---|---|---|
| G7-1 | `auth.ts` jwt() → `lib/session-revocation.ts checkSessionVersion` (every Node pass of every request with a session cookie) | catch → verdict `unknown`; caller comment: "unknown keeps the token"; `session()` then returns the full user. Malformed row: `row.sessionVersion !== tokenVersion` only, so a row without a version compared against a token without one would pass. | **FAIL-OPEN, reproduced** (unit + DB, see §4) |
| G7-2 | `auth.ts` jwt() legacy `mustChangePassword` stamp (tokens minted before the claim existed) | catch → key left absent → `session()` maps absent to `false` → a temporary-password session reads as "no change needed" for that request | FAIL-OPEN (narrow: legacy tokens only) |
| G7-3 | `auth.ts` jwt() support-session swap/restore body | inner `catch { /* best-effort */ }` → a throw part-way through leaves a half-swapped token (target id with the operator's other claims, or the reverse) and the token is kept | FAIL-OPEN (narrow: support sessions only) |
| G7-4 | `auth.ts` jwt() support resolver throw | already fail-closed when support may be live (6 Oct review D1) | PASS (pinned by tests/unit/impersonation-jwt-claims.test.ts) |
| G7-5 | `auth.ts` jwt() demo-tenant upgrade | catch keeps a `demo-tenant` token; such tokens are only minted with DEMO_MODE outside production and auth.ts throws at boot if DEMO_MODE is set in production | NOT APPLICABLE in production (evidence: auth.ts module guard) |
| G7-6 | Edge runtime (proxy.ts) | never checks revocation (Prisma is Node-only); the Node pass of the same request decides | by design; the Node pass is the control |
| G7-7 | Routes that read the JWT with `getToken()` and never run jwt(): staff `app/api/auth/totp/verify`, `app/api/member/totp/verify` (both only re-issue the half-signed-in token), `app/api/admin/impersonate` (operator-gated) | no revocation check on that request; the token they re-issue keeps the old `sessionVersion`, so the next request's (now fail-closed) check refuses it | RESIDUAL (Low): a revoked pending session can still spend one TOTP step. Fix withheld: it breaks three out-of-scope test fixtures that mint tokens without `sessionVersion` (see REPORT §6). |

Operator plane:

| # | Path | Behaviour on a DB error / malformed result | Verdict |
|---|---|---|---|
| G7-8 | `lib/operator-auth.ts resolveMfaSessionRow` (every operator gate: isAdminAuthed, isAdminPageAuthed, getOperatorContext, step-up, impersonation) | `prisma.operator.findUnique` rejects → the rejection propagates → the route throws before any work (Next answers 500 with no body data). Malformed row: strict `!==` on sessionVersion and `!== true` on totpEnabled → null | FAIL-CLOSED (tested, §4) |
| G7-9 | `app/admin/page.tsx` | `.catch(() => null)` → not authed | FAIL-CLOSED |
| G7-10 | `lib/operator-step-up.ts currentOperatorSessionVersion` | catch → null → `wrong_session` 403 | FAIL-CLOSED |

## 2. Fix for G7-1..G7-3 (lane A, uncommitted; lead commits)

- `lib/session-claims.ts` (new): `REVOCATION_UNVERIFIED_CLAIM`.
- `lib/session-revocation.ts`: malformed row → `unknown`; token version that is not a non-negative integer → `revoked`;
  optional `tenantId` (row in another club → `revoked`); log/Sentry now say fail CLOSED.
- `auth.ts`: the mark is dropped at the top of every non-sign-in jwt() pass; `unknown` (or a failed legacy
  `mustChangePassword` read) sets it and returns the token (cookie kept — a blip signs nobody out); `session()` returns no
  user while it is set; the support swap/restore catch now ends the session (`null`).

## 3. AH-G5 / SEC-015 — grant expiry label

`consumeStepUpGrant`: when the conditional spend misses, the session version matches and no outcome row exists, a nonce
that is STILL this grant's means only the expiry failed → `expired` (was `used`). Refused either way before and after.

### 2a. Design correction during the work (recorded so a reviewer can follow it)

The first fix kept the token and marked it so `session()` returned a session WITHOUT a user. Driving the real
`app/api/members` GET showed why that is unsafe: the server-side `auth()` (next-auth 5.0.0-beta.32,
`node_modules/next-auth/lib/index.js` getSession/parseSessionResponse) returns that object, it is truthy, and 57
`auth()` call sites check only `if (!session)` before reading `session.user.*` (one TypeError, 500 — but a site using
`session.user?.tenantId` in a filter would have read `undefined`). The shipped fix returns `null` from jwt() for
`unknown` — the answer every gate already reads as signed out. The same file shows the cost is small: the server-side
`auth()` applies no Set-Cookie, so the browser keeps its cookie and the next request is checked afresh; only a failure
on `/api/auth/session` itself clears the cookie.

## 4. Evidence — SEC-012 / AH-G7

Environment: Windows 11, Node per `package-lock.json`, vitest 4.1.11; TEST branch `ep-hidden-salad` only, through
`scratchpad/att/run-engine.sh` (owner role) and `scratchpad/q78/run-restricted.sh` (`matflow_app`, `RLS_ENFORCED=1`).
Red runs use a disposable git worktree of `2a6487e` (scratchpad `security/A/wt-head`, node_modules junctioned) with
copies of the runners pointed at it; the main tree is never reverted.

| Run | Command | Exit | Result |
|---|---|---|---|
| unit, fixed tree | `npx vitest run tests/unit/sec-a-revocation-fail-closed.test.ts` | 0 | 47/47 |
| unit, RED at `2a6487e` | same file in the worktree | 1 | 36 failed / 12 passed (first version of the file, 48 cases) — every DB-failure case admitted the session; the half-swapped support token was kept |
| DB, owner role | `bash run-engine.sh tests/integration/sec-a-revocation-fail-closed-db.test.ts` | 0 | 6/6 |
| DB, matflow_app + RLS | `bash run-restricted.sh tests/integration/sec-a-revocation-fail-closed-db.test.ts` | 0 | 6/6 |
| DB, RED at `2a6487e` (owner) | same file in the worktree | 1 | 3 failed (real 57014 timeout, real 57P01 connection loss, member connection loss) / 3 passed (positive controls) |
| DB exposure probe at `2a6487e` (owner) | probe copy of the file with the refusal assertion replaced by a recorder; not committed | 0 | `fault=timeout admitted_user=yes members_GET=200 canary_returned=true logout_all=200`; `fault=connloss admitted_user=yes members_GET=200 canary_returned=true logout_all=200 coach_sessionVersion 1->2` — the second token was ALREADY REVOKED (its version 0, the row's 1) and still read the member list and wrote |
| operator gate unit | `npx vitest run tests/unit/sec-a-operator-gate-fail-closed.test.ts` | 0 | 20/20 (positive control, 4 real-shaped DB errors × 3, 4 malformed rows, stale authority incl. allowlist) |

The fault is injected INTO the revocation lookup's own transaction by the server: `SET LOCAL statement_timeout =
'150ms'; SELECT pg_sleep(3)` (57014) or `SELECT pg_terminate_backend(pg_backend_pid())` (57P01); the test asserts the
reported error carries that server code. SET LOCAL only (a session SET through the pooler leaks — project memory).

**Verdict AH-G7: REPRODUCED at `2a6487e` (release blocker confirmed: a revoked session read tenant data and wrote
during a real database fault) → FIXED AWAITING RETEST (independent review).**

## 5. AH-D2 / SEC-003 / SEC-004 — trace and evidence

Token purposes, issuers, consumers, retirement (code review of `2a6487e`):

| Purpose | Issuers | Consumer(s) | Subject resolved at use by | Retired by |
|---|---|---|---|---|
| reset (6-digit code, 2 min) | `app/api/auth/forgot-password` | `app/api/auth/reset-password` | (tenant, address): User first, else Member with a password | address moves (`retireEmailBoundTokens`: staff/member PATCH, member self-service, login-email, contact-email, account password); NOT member delete, staff DELETE, import rollback |
| login (link, 30 min) | `app/api/magic-link/request` | `app/api/magic-link/verify` | (tenant, address): User first, else Member with a password | same as above |
| first_time_signup (link, 7 days members / 30 min owner) | `app/api/members` POST, `members/bulk-invite`, `members/[id]/invite-link`, `admin/applications/[id]/approve` | `app/api/members/accept-invite` (members), `app/api/magic-link/verify` (owner) | (tenant, address) | same as above |
| waiver_open (link) | `members/[id]/waiver-link`, `waiver/kiosk-request` | `app/api/waiver/open` (not a sign-in credential; verify refuses the purpose) | (tenant, address) | only when a writer names the purpose |
| operator enrolment ticket | `scripts/operator-access.mjs` | `app/api/admin/auth/operator-totp/setup` | the Operator row named by the HMAC'd enrolment cookie; the ticket hash is ON that row | cleared by the conditional update that enables TOTP |
| disown-login link | login alert mail | `app/api/auth/disown-login/[token]` | the LoginEvent id inside the HMAC'd token → its user/member id | single use (`disownedAt`) |

The last two are bound to an immutable id by construction → NOT APPLICABLE WITH EVIDENCE for AH-D2.

Reproduced at `2a6487e` (DB, owner role, worktree): the old reset code of a DELETED member reset the password of the
NEW member created at the same address (`expected 200 to be 400`); an invitation minted for a deleted member set the
password of the new member at that address (`expected 200 to be 410`); the login link of a coach removed through the
real staff DELETE route signed the NEW coach at that address into `/dashboard` with a session cookie
(`red-d2-loginlink-probe`). Attacker prerequisite: holding a credential mailed to the address before it changed hands
(the previous holder of a shared or reassigned mailbox) and redeeming it within its lifetime.

Fix (no migration; `lib/auth-token-binding.ts`): links are `<random>.<tag>`, tag = keyed HMAC over purpose, club,
subject kind and id, random (128 bits); reset codes are stored as a keyed HMAC over club, subject and code. Consumers
recompute for the subject they resolve now. Wired: forgot-password + reset-password (codes), magic-link request + verify
(login links), accept-invite and verify (consumers of invitations). Untagged links take the old address-only path
until they expire (`legacy`).

| Run | Exit | Result |
|---|---|---|
| DB owner role `sec-a-token-subject-binding-db` | 0 | 7/7 |
| DB matflow_app + RLS | 0 | 7/7 |
| DB RED at `2a6487e` (helper copied in; routes as at the candidate) | 1 | 3 failed (login link untagged/takeover, reset 200, invitation 200), 4 passed |

**Verdict AH-D2: REPRODUCED → FIXED AWAITING RETEST for reset codes and login links; PARTIALLY FIXED for invitations**
— the four invitation issuers are outside lane A's file scope and still mint untagged tokens (patch in REPORT §4).

## 6. AH-G5 / SEC-015 — evidence

`tests/integration/sec-a-step-up-expiry-db.test.ts`: owner 6/6 (exit 0), matflow_app 6/6 (exit 0); RED at `2a6487e`:
1 failed (`expected 'used' to be 'expired'`), 5 passed. Two expiries exist (signed `exp`, checked before any write; stored
`stepUpExpiresAt`, checked by the conditional spend against the APP clock as a bound parameter — no DB/app skew window).
A refusal spends nothing; superseded → `used`; revoked operator session → `wrong_session`; 5 concurrent spends → 1.
Existing `tests/integration/operator-step-up-db.test.ts` pinned the old label (`refusal` "used" for a DB-forced expiry):
companion edit in `patches/companion-edits.patch`, verified 10/10 under both roles in a worktree with the edit.

## 7. AH-R7 / SEC-013 — incident revoke-all control

`POST /api/admin/customers/[id]/revoke-access` (new) + step-up action `access.revoke_all` (version = subject existence
only). `tests/integration/sec-a-revoke-access-db.test.ts`: owner 5/5, matflow_app 5/5 (exit 0). Mutants (in place on the
new route only, restored by `cmp`): grant not spent → 2 failed; user scope retires the whole club's codes → 1 failed;
club scope under-revokes → 1 failed; waiver links retired → 1 failed (all killed). The existing operator authz matrix
(`operator-endpoint-authz-matrix`) covers the route for every refused persona once the companion edit adds it (verified
in the worktree: 245/245 across the four affected unit files).

## 8. SEC-007 — recovery-code race (new finding, fixed)

`app/api/auth/totp/recover` read the stored codes and wrote the remainder back unconditionally. RED at `2a6487e`
(`tests/integration/sec-a-recovery-code-race-db.test.ts`, owner): 3 failed — two concurrent recoveries bumped
`sessionVersion` twice and wrote two `auth.totp.recovery.used` rows; a recovery with no factor enabled still bumped the
version. Fix: a conditional `updateMany({ id, totpEnabled: true } → totpEnabled false)` claims the recovery first. Fixed
tree: 4/4 owner, 4/4 matflow_app. `app/api/member/totp/recover` has the same pattern (outside lane A's scope; open).

## 9. Regression sweep on the fixed tree (both roles, one file at a time)

Summary file: scratchpad `security/A/regress-summary.txt`. All exit 0 under owner AND matflow_app: the six sec-a-* DB
files, token-scoping-db 7, owner-recovery-revocation-db 5, support-session-binding-db 5, login-email-change-db 11,
account-editing-db 14, operator-member-totp-reset 8, operator-enrolment-ticket-db 4, totp-login-paths 14,
operator-hub-conflict-db 11. operator-step-up-db: 9/10 on the main tree (the pinned `used` label, §6) → 10/10 with the
companion edit. Leftover scan after all runs (read-only): 0 tenants / users / members / links / codes / operators with
the lane prefix.

Full unit suite on the main tree: 408/413 files pass; failures = session-revocation (tag, companion), audit-labels (2
labels, companion), operator-endpoint-authz-matrix + journeys-manifest (new route registration, companion), and
sec-e-secret-scan (lane E's own evidence file, not lane A). In a worktree with lane A's files + both patches: only
sec-e-secret-scan and readiness-scripts-release-verify fail (the latter only in a worktree with uncommitted files; it
passes on the main tree). `tsc --noEmit`: no error in lane A files. `eslint` on lane A files: 0 errors (1 pre-existing
warning: unused `prisma` import in auth.ts, present at `2a6487e`).

## 10. Hand-back note

Writing `docs/security/evidence/A/REPORT.md` was refused by the tool layer ("subagents should return findings as
text"); per RULES.md it was not routed another way. The report is the lane's final message to the lead, who can save it
to that path. Disposable worktrees (`2a6487e` and current+patches) were removed after the node_modules junctions were
detached; the main tree's node_modules is intact.
