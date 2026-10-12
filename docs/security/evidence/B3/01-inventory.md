# B3-01 — Inventory of the bare `prisma.<model>.*` call sites (SF-87)

Lane B3, security campaign iteration 2 follow-up, 10 Oct 2026. Source read at HEAD 15d7b33 (code identical to 03ef584).
Method: `grep -rnE "\bprisma\.[a-z][A-Za-z]*\.[a-zA-Z]+\("` over app/, lib/, auth.ts, proxy.ts (excluding lib/prisma*.ts),
plus a read of every file that imports the singleton from `@/lib/prisma`, plus the RLS table list taken from every
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` in prisma/migrations/*/migration.sql (47 tables; the database copy is
re-checked live in 02-pooler-measurement.md via `pg_class.relrowsecurity`). The pinned form of this inventory is
tests/unit/sec-b3-bare-prisma-allowlist.test.ts.

## Count reconciliation
The brief's list (27, from R2/B2's textual count) mixes executable calls with text that only looks like one. Exact today:

- **25 executable bare model calls in 9 files** — every one on `Operator` (19) or `RateLimitHit` (6).
- 4 textual matches that are not calls: lib/pagination.ts:6 (comment), lib/session-revocation.ts:15 and :16 (a comment
  describing the old shape — the code goes through `withRlsBypass`, line 55), app/api/settings/route.ts:209
  (`Parameters<typeof prisma.tenant.update>` — a TypeScript type, erased at compile time).
- lib/rate-limit.ts has 3 executable calls, not 2 (line 115, the 5 % prune `prisma.rateLimitHit.deleteMany(...).catch()`,
  was missed by the earlier count).
- Bare non-model calls (outside the brief's scope, listed for completeness): app/api/health/route.ts:32
  `prisma.$queryRaw\`SELECT 1\`` (no table); lib/auth-lockout.ts:175 and lib/rate-limit.ts:86–88 `prisma.$transaction`
  whose raw SQL touches only `"RateLimitHit"` (text pinned by tests/unit/sec-c-static-guards.test.ts).
- Files importing the singleton with no bare model call: auth.ts, app/api/announcements/route.ts,
  app/api/members/route.ts, app/api/members/[id]/route.ts, app/api/settings/route.ts (type only), app/api/health.

## Classes
(a) non-tenant table — RLS irrelevant; (b) tenant table filtered by tenantId in the query; (c) tenant table looked up by
id/token only — relies on RLS or the token's binding; (d) write to a tenant table.

| # | file:line | call | table (RLS?) | app-layer filter | reachable by | cross-tenant row possible if RLS context wrong? | class |
|---|---|---|---|---|---|---|---|
| 1 | app/api/admin/auth/logout/route.ts:44 | operator.updateMany | Operator (no RLS, no tenantId) | id + sessionVersion | operator holding a verified session or enrolment cookie | no — platform table, no tenant rows | a |
| 2 | app/api/admin/auth/operator-totp/route.ts:88 | operator.findUnique | Operator (no) | id from the signed MFA challenge | holder of a password-verified operator challenge | no | a |
| 3 | app/api/admin/auth/operator-totp/route.ts:123 | operator.findUnique | Operator (no) | id | same | no | a |
| 4 | app/api/admin/auth/operator-totp/route.ts:129 | operator.update | Operator (no) | id | same | no | a |
| 5 | app/api/admin/auth/operator-totp/setup/route.ts:127 | operator.findUnique | Operator (no) | id of the verified caller | operator with enrolment ticket / session | no | a |
| 6 | app/api/admin/auth/operator-totp/setup/route.ts:136 | operator.update | Operator (no) | id | same | no | a |
| 7 | app/api/admin/auth/operator-totp/setup/route.ts:189 | operator.findUnique | Operator (no) | id | same | no | a |
| 8 | app/api/admin/auth/step-up/route.ts:77 | operator.findUnique | Operator (no) | id of the session | signed-in operator | no | a |
| 9 | lib/auth-lockout.ts:132 (countRecent) | rateLimitHit.count | RateLimitHit (no RLS, no tenantId) | bucket (pair/addr key) | anonymous — every staff/member credential sign-in (auth.ts lockoutState) | no | a |
| 10 | lib/auth-lockout.ts:263 (clearPairOnSuccess) | rateLimitHit.deleteMany | RateLimitHit (no) | bucket / reservation id | anonymous on a successful sign-in | no | a |
| 11 | lib/impersonation.ts:150 (startSupportSession) | operator.update | Operator (no) | id | operator (/api/admin/impersonate) | no | a |
| 12 | lib/impersonation.ts:182 (endSupportSession) | operator.updateMany | Operator (no) | id + nonce hash | operator | no | a |
| 13 | lib/impersonation.ts:254 (resolveActiveImpersonation) | operator.findUnique | Operator (no) | id from a verified impersonation token, cross-checked with the verified operator session | any request carrying both signed cookies (auth.ts, every request of a support session) | no | a |
| 14 | lib/operator-auth.ts:238 (consumeOperatorTotp) | operator.updateMany | Operator (no) | id + step | challenge holder / operator | no | a |
| 15 | lib/operator-auth.ts:270 (attemptOperatorLogin) | operator.findUnique | Operator (no) | email | anonymous (/api/admin/auth/operator-login) | no | a |
| 16 | lib/operator-auth.ts:305 | operator.update | Operator (no) | id | anonymous (failed operator login counter) | no | a |
| 17 | lib/operator-auth.ts:322 | operator.update | Operator (no) | id | anonymous (expired lock reset) | no | a |
| 18 | lib/operator-auth.ts:341 (completeOperatorLogin) | operator.update | Operator (no) | id | operator after TOTP | no | a |
| 19 | lib/operator-auth.ts:476 (resolveMfaSessionRow) | operator.findUnique | Operator (no) | id from a verified session cookie | any request with a valid operator session cookie | no | a |
| 20 | lib/operator-auth.ts:589 (resolveOperatorEnrolment) | operator.findUnique | Operator (no) | id from a verified enrolment cookie | enrolment-cookie holder | no | a |
| 21 | lib/operator-step-up.ts:358 (issueStepUpGrant) | operator.findUnique | Operator (no) | id | operator | no | a |
| 22 | lib/operator-step-up.ts:377 | operator.updateMany | Operator (no) | id + sessionVersion | operator | no | a |
| 23 | lib/rate-limit.ts:72 (checkDbRateLimit) | rateLimitHit.groupBy | RateLimitHit (no) | bucket | anonymous — every rate-limited route | no | a |
| 24 | lib/rate-limit.ts:115 (checkDbRateLimit prune) | rateLimitHit.deleteMany | RateLimitHit (no) | hitAt < now − 1 h (all buckets) | anonymous, 5 % of allowed calls | no | a |
| 25 | lib/rate-limit.ts:315 (resetRateLimit) | rateLimitHit.deleteMany | RateLimitHit (no) | bucket | no runtime caller today (exported, unused in app/lib/auth/proxy) | no | a |

**By class: (a) 25, (b) 0, (c) 0, (d) 0.** No bare call reads or writes any of the 47 policy-protected tables. RLS is
irrelevant to all 25; their protection is the application filter plus the signed cookie/challenge that supplies the id.
The tenant-table traffic goes through `withTenantContext` (transaction-local tenant + bypass reset) or `withRlsBypass`
(transaction-local bypass on); neither reads a session-level setting in a way that survives its own `set_config(…, true)`.

## What this means for SF-87
The brief's step 2 asks for one class-(c) and one class-(d) bare call exercised through its real function. **There is
none to exercise.** The measurement in 02-pooler-measurement.md therefore runs (i) the real class-(a) functions
(`checkRateLimit`, the bare `rateLimitHit` deleteMany in `resetRateLimit`, an Operator read) on a poisoned pooled server
connection, (ii) a plain Prisma query on a tenant table with the lib/prisma.ts pool settings — the exact shape a future
bare class-(c)/(d) call would have — to measure the hazard, and (iii) `withTenantContext` on the same poisoned
connection. The pinned allowlist test keeps (b)/(c)/(d) at zero: a new bare call on any RLS table fails the unit suite.
