# Assurance requirements 14–27 — hub release candidate `512d5e8` (lane AQ2, read-only, 12 Oct 2026)

Answers to the owner's release-assurance requirements 14–27 (verbatim in the coordinator's `ASSURANCE-QUESTIONS.md`), from existing evidence only. No test, server, database connection, provider call, deployment or configuration change was made by this lane. Code was read with `git show 512d5e8:<path>`; nothing was checked out or edited. No secret, connection string or e-mail address appears below; ids are the immutable ids already printed in the release packet.

**Common identity for every section.**
- Executable under assessment: `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` on `security/assurance-2026-10`.
- Documentation head `e5636dc`. `git diff --stat 512d5e8 HEAD -- . ":(exclude)docs"` is empty: the four commits after the candidate (`665bc68`, `fc42f96`, `8768afb`, `e5636dc`) change documentation only.
- Serving production: `e8afb6a` (coordinator, Vercel API `meta.githubCommitSha`, 12 Oct 00:15 UK).
- Delta `e8afb6a..512d5e8`: 187 commits, 1,330 files, +150,831 / −4,485 (mostly documentation, evidence and tests); 98 files under `app/api`; 49 of them privileged (§15); 52 runtime library/config files (§27); six migrations.

**Environment legend.** CODE = static read of the candidate tree. TEST = Neon test branch `ep-hidden-salad`, both database roles (`neondb_owner`, `matflow_app`). PROD = production facts read by the coordinator (dated). NONE = no environment exercised.

**Status vocabulary.** PASS · FAIL · BLOCKED · NOT RUN · NOT APPLICABLE. Where a requirement has parts with different evidence, each part carries its own status. FAIL means the requirement is not met by the evidence today; it is not a recommendation and accepts nothing. The decision columns are left empty.

## Summary

| # | Requirement | Status (by part) |
|---|---|---|
| 14 | Threat model and trust boundaries | PASS (model and application-layer controls) · FAIL (database-enforced isolation and runtime-credential compromise, existing exposure) |
| 15 | Privileged-access review | PASS (email-correction path, code + TEST browser, both roles) · PASS (guard presence on all 49 changed privileged endpoints, static) · NOT RUN (fresh per-route independent re-review of the other endpoints in this lane) |
| 16 | Authentication and account-takeover paths | PASS (subject binding, single use, concurrency, retirement on address change — TEST both roles) · NOT RUN (owner/staff recovery-code redemption in the browser) · FAIL (member second-factor replay SF-90; legacy untagged links SF-05, both existing) |
| 17 | Database integrity and failure handling | PASS (transactional consistency, failure classes, reuse safety — TEST both roles, R10) · FAIL (editable audit and owner-role runtime, existing, unchanged) |
| 18 | Availability and resource limits | FAIL (one bucket/address can exhaust an instance pool; SF-118/119 open) · NOT RUN (production capacity) |
| 19 | Sensitive-data protection | PASS (changed code, rehearsal artefacts of runs 2–3) · FAIL (public-history credentials not proven revoked; SF-138) · NOT RUN (build output inspection; logged error-object contents) |
| 20 | Browser and request security | PASS (CSRF, validation, mass assignment, cache, headers on affected routes; payments COEP change excluded) · FAIL (enforced CSP keeps `unsafe-inline`, SF-30, existing) |
| 21 | Build, dependencies and provenance | PASS (gates, runtime, lockfile, CI permissions and pins) · FAIL (only-approved-source control not yet in force: D-14 pending; build/install with production secrets SF-20) · NOT RUN (the production build at the merge commit; PR CI) |
| 22 | Environment and configuration isolation | PASS (test bypasses and dev modes refused in production code) · BLOCKED (preview/historic deployments and stored-vs-effective values pending owner actions) |
| 23 | Migration and recovery safety | BLOCKED (production-derived rehearsal and restore not done — packet §5, owner) · FAIL (a committed runbook still recommends Instant Rollback) |
| 24 | Monitoring and operational response | FAIL (no baseline, no alert rules in evidence) · NOT RUN (Sentry delivery from production not evidenced) |
| 25 | Independent-review scope | PASS (final executable covered by independent review, gates and browser rehearsal) · NOT RUN (any human or organisationally independent review) |
| 26 | Security acceptance and release decision | Classification complete; owner decisions EMPTY |
| 27 | Evidence integrity and completeness | PASS (diff, routes, migrations, journeys reconciled) · FAIL (stale/contradictory documents listed in §27.3) · BLOCKED (configuration and operational prerequisites) |

---

## 14. Threat model and trust boundaries

**Status:** PASS — assets, attackers and application-layer controls are identified with evidence. FAIL — database-enforced isolation does not exist in production, and nothing protects against a leaked runtime credential. This is existing exposure, unchanged by this release and not accepted here.
**Executable:** `512d5e8`. **Environment:** CODE; TEST (both roles); PROD (coordinator 11 Oct 16:12 UK role inspection).

**Assets in scope for this release.** Club owner login identities (`User.email`, password hash, TOTP secret, recovery codes, `sessionVersion`); member records and their addresses; the operator plane (`Operator` rows, MFA, step-up grants, allowlist); `AuditLog` as the record of privileged changes; sign-in tokens (invitations, login links, reset codes); runtime secrets (database credential, session signing key, mail key, Blob token, Stripe key, legacy admin secret); production data of the real club and the demo club.

| Attacker | What they can reach | Controls that apply (evidence) | What does NOT protect |
|---|---|---|---|
| Unauthenticated caller | login, reset, magic link, invitation acceptance, recovery-code door, health, operator login door | Same-origin check on mutating routes; per-address and per-network lockout with atomic reservation (SF-111, R7); rate limits fail closed on security buckets (SF-113, R7; `lib/rate-limit.ts`); subject-bound tokens (SF-05, `lib/auth-token-binding.ts:75-118`); no existence oracle on sign-in (SF-35, R6); shared admin secret grants nothing in production (`lib/admin-auth.ts:70-72`) | Burst availability: a right password can be refused as "Incorrect email or password" under saturation (SF-118); legacy untagged links until expiry (SF-05 residual) |
| Member | member portal, own profile/TOTP | `requireSession` + member `sessionVersion` (`lib/session-revocation.ts:109-111`); revocation fail-closed (SF-01/44); member routes refuse support sessions (SF-24) | Member TOTP codes replayable within their window (SF-90, OPEN) |
| Staff (coach/manager) | dashboard, registers, imports (manager) | Role guards (`requireApiOwner`, `requireApiRole`); tenant filter on every query; strict bodies on changed routes | RLS is not a backstop in production (below) |
| Club owner | everything in the club, account self-service | `requireApiStaff`/`requireApiOwner`; step-up not required for DSAR erase (SF-61, OPEN Low) | — |
| Compromised operator session | `/api/admin/*` | MFA session cookie bound to `sessionVersion` and expiry, allowlist checked on every resolution (`lib/operator-auth.ts:27-29`; in production an empty list admits nobody, `docs/runbooks/OPERATOR-ACCESS-RECOVERY.md` table), step-up grant per action/target/change/version, 5 min, single use (`lib/operator-step-up.ts:12-55,:73`); sign-out bumps `sessionVersion`; durable audit row before any grant | A stolen live session cookie plus a current authenticator code can perform any single step-up action until sign-out or expiry (8 h); no phishing-resistant MFA (runbook "Phishing-resistant MFA (recorded, not built)") |
| Leaked runtime credentials | the database directly; mail; Blob; Stripe; session signing | Rotation of the Neon password and Resend key (REPORTED by owner 11 Oct 17:07 UK; revocation not evidenced, SF-14) | **Nothing in the application.** Production runs as `neondb_owner` (BYPASSRLS, member of `neon_superuser`, direct host; coordinator 11 Oct 16:12 UK). With that credential an attacker reads and writes every club, rewrites or deletes audit rows (SF-57 not applied), writes `Operator.passwordHash` (SF-73) and forges import provenance (SF-74). With a leaked session signing key, sessions can be forged |
| Malicious imported content | TeamUp CSV/XLSX, uploads | Identity binding rules (SF-06/51/54/67, approved by R through 788d29a); CSV formula guard (SF-38/52); upload pixel cap and per-principal limits (SF-40/86); SVG served as attachment (SF-42) | Raw-SQL takeovers and back-dated audit rows remain open by design until SF-57 and P2 land (SF-67 residual) |

**Application authorisation versus database-enforced isolation.**
- Application authorisation is the control in production. Every tenant query carries `where: { tenantId }` and runs through `withTenantContext` or `withRlsBypass`; operator routes resolve the club from the path.
- Database isolation (RLS) is enforced only when the app connects as `matflow_app`. That role exists on TEST but not on production. The TEST restricted passes in rehearsal run 3 prove the application works under RLS. They do not show production is isolated.
- Even under `matflow_app`, the policies trust two unregistered session settings (`app.bypass_rls`, `app.current_tenant_id`) that the role can set itself (SF-62, root cause by B2). RLS is therefore a backstop against application filter mistakes, not against SQL injection or a compromised runtime.
- 27 bare Prisma calls outside `withTenantContext` (SF-87) are latent under the pooled host. Production currently uses the direct host.

**Evidence.** `docs/security/THREAT-MODEL.md` (actors, boundaries 1–7, chains C1–C9); FINDINGS.md SF-02, SF-57, SF-62, SF-73, SF-74, SF-87; HUB-RELEASE-DECISION §1 row "Production runtime role"; run 3 §1 "Roles".

**Limitations / follow-up.**
- `THREAT-MODEL.md` was written for `2a6487e`. It has no row for the L1/L2 transaction layer or for the release path (PR, merge commit, preview deployment). The content is still accurate, but the document should be dated forward.
- The SF-62 boundary (13–19 agent-days per SF-62-APPLICATION-INTEGRATION.md) and SF-57 remain separate projects. Neither is claimed for this release.

---

## 15. Complete privileged-access review

**Status:** PASS — email-correction path (CODE + TEST browser, both roles). PASS — a server-side guard is present on all 49 changed privileged endpoints (CODE, static). NOT RUN — a fresh independent per-route re-review of the other endpoints in this lane. Every one of them is byte-identical to the reviewed `03ef584`, so earlier reviews cover the code (see below).
**Executable:** `512d5e8`. **Environment:** CODE; TEST.

**Method.** `git diff --name-status e8afb6a 512d5e8 -- app/api/admin app/api/staff app/api/account app/api/auth` gives 49 files. Each was read at `512d5e8` for its exported methods and the guard calls it makes. `git diff --name-only 03ef584 512d5e8 -- app` lists only `app/api/cron/retention/route.ts` and `app/api/members/[id]/rank/route.ts`. So none of the 49 changed after the integrated iteration-2 candidate `03ef584`, which reviewers R6 and R7 reviewed and on which the both-role database sweep ran (112 runs).

**Common guards.**
- **Operator plane (`/api/admin/customers/*`, `impersonate`, `create-tenant`, `applications`):**
  - `assertSameOrigin`;
  - `isAdminAuthed`/`getOperatorContext` (an MFA session cookie, HMAC + expiry + `sessionVersion` equal to the database + TOTP enabled + allowlisted; `lib/operator-auth.ts:27-29,:80-101`; the shared secret is refused in production, `lib/admin-auth.ts:70-72`; every route refuses `!authed`);
  - a per-operator+IP rate limit;
  - a step-up grant for destructive actions (`requireStepUp` + `consumeStepUpGrant` inside the mutation transaction);
  - `withRlsBypass` with explicit `tenantId` filters;
  - `logAudit` in the same transaction.

  The proxy also refuses `/api/admin/*` for a support session (`proxy.ts:298-321`).
- **Club plane:** `requireApiOwner` / `requireApiRole(["owner"])` / `requireApiStaff` / role checks, plus `refuseSupportSession`, `assertSameOrigin` and `withTenantContext`.
- **Anonymous credential doors:** rate limit + token or subject binding.

| Endpoint (A = added, M = modified) | Methods | Server-side guard at `512d5e8` |
|---|---|---|
| A account/login-email | GET, POST | requireApiStaff (own account), same-origin, refuseSupportSession, rate limit, withTenantContext, audit |
| A account/password | POST | same as above |
| A account/profile | GET, PATCH | same as above |
| M admin/applications/[id]/approve | POST | operator gate, same-origin, rate limit, audit |
| M admin/auth/login | POST | legacy shared-secret door: same-origin, rate limit; grants nothing in production (`lib/admin-auth.ts:70-72`); refusal verified in TEST browser flow 2 |
| M admin/auth/logout | POST | same-origin; resolves the session without the allowlist, so a de-listed operator can still sign out; bumps `sessionVersion` |
| M admin/auth/operator-login | POST | same-origin, rate limit; password yields only a challenge or enrolment cookie |
| M admin/auth/operator-totp | POST | same-origin, rate limit, `isOperatorAllowed`, single-use time-step (`consumeOperatorTotp`), audit |
| M admin/auth/operator-totp/setup | GET, POST | same-origin, rate limit, `isOperatorAllowed`, enrolment ticket, audit |
| A admin/auth/step-up | POST | same-origin, full MFA session via `resolveOperatorFromCookie` (allowlist included), rate limit 5/10 min per operator, authenticator code, durable audit before the grant |
| M admin/create-tenant | POST | operator gate, same-origin, rate limit, audit |
| M customers/[id]/force-password-reset | POST | operator gate + step-up, rate limit, audit |
| A customers/[id]/login-email/check | POST | operator gate, same-origin, in-route support refusal (`:76`), rate limit, audit `admin.login_email.checked` |
| A customers/[id]/login-email | POST | operator gate (`:86-90`), rate limit, strict body, step-up bound to `<club>/<owner>/<action>` (`:141-144`), mutation + audit in one transaction; **no in-route support-session check** (proxy only; CR gap 3) |
| M customers/[id]/member-totp-reset | POST | operator gate + step-up, rate limit, audit |
| A customers/[id]/members/[memberId]/contact-email | POST | 16 ordered refusals (CR §3 table), incl. same-origin, operator gate, support refusal (`:138`), strict body, club/member scoping 404, managed-record 409, holder 409, stale version 409, step-up; one transaction |
| A customers/[id]/owner-profile | POST | operator gate + step-up, rate limit, audit |
| M customers/[id]/review-lock | POST, DELETE | operator gate, rate limit, audit |
| A customers/[id]/revoke-access | POST | operator gate + step-up `access.revoke_all`, rate limit, audit (SF-08, R approved) |
| M customers/[id]/soft-delete | POST, DELETE | operator gate + step-up, rate limit, audit |
| M customers/[id]/suspend | POST, DELETE | operator gate + step-up, rate limit, audit |
| M customers/[id]/totp-reset | POST | operator gate + step-up, rate limit, audit |
| M customers/[id]/transfer-ownership | GET, POST | operator gate + step-up, conditional role swap (SF-23), audit |
| M admin/dsar/erase | POST | requireApiRole(["owner"]), same-origin, refuseSupportSession, rate limit, audit; **no step-up** (SF-61 OPEN Low) |
| M admin/dsar/export | GET | requireApiOwner, refuseSupportSession, rate limit, audit |
| M admin/email/test | POST | requireApiOwner, same-origin, rate limit, audit |
| M admin/import/[id]/commit | POST | requireApiOwner, same-origin, refuseSupportSession, withTenantContext, audit |
| M admin/import/[id]/rollback | POST | same as above |
| M admin/import/attendance/export | GET | requireApiOwner, refuseSupportSession |
| M admin/import/attendance | GET, POST, DELETE | requireApiOwner, same-origin, rate limit |
| M admin/import/upload | POST | requireApiOwner, same-origin |
| M admin/import/uploads | POST | requireApiOwner, same-origin, rate limit |
| M auth/[...nextauth] | GET (handlers) | NextAuth; `authorize` with the lockout reservation; revocation in the JWT callback (`auth.ts:1361-1406`) |
| M auth/disown-login/[token] | GET, POST | GET renders a confirmation only; POST same-origin + conditional claim (SF-37) |
| M auth/forgot-password | POST | rate limit; subject-bound reset code; mints nothing for a provisional address |
| M auth/logout-all | POST | `auth()`, same-origin, refuseSupportSession, audit |
| M auth/reset-password | POST | rate limit; legacy hash then subject-bound hash; refused and burned for a provisional address |
| M auth/set-password | POST | `auth()`, same-origin, refuseSupportSession, audit |
| M auth/staff-unlock/[id] | POST | requireApiOwner, same-origin, refuseSupportSession, audit |
| M auth/totp/disable | POST | `auth()` + refuseSupportSession; self-service disable is refused by design (only operator routes clear TOTP) |
| M auth/totp/recover | POST | anonymous door: per-IP 20/h and per-address 5/h; conditional claim `updateMany({totpEnabled:true})` single winner (`:95-101`); `sessionVersion +1`; audit. Clears the factor **without a password** — the password is still required at the next sign-in |
| M auth/totp/recovery-codes | POST | `auth()`, same-origin, refuseSupportSession, audit |
| M auth/totp/setup | GET, POST | `auth()`, same-origin, refuseSupportSession, rate limit, audit |
| M auth/totp/verify | POST | pending-TOTP token only; revocation gate before anything is spent (`refuseRevokedPendingToken`, SF-37); strict body; rate limit |
| M staff/[id] | PATCH, DELETE | `auth()` + requireApiOwner, owner-row protections, same-origin, refuseSupportSession, audit |
| M staff/[id]/totp-reset | POST | requireApiOwner, same-origin, refuseSupportSession, audit |
| M staff/[id]/transfer-ownership | POST | `auth()` + role must be owner, same-origin, refuseSupportSession, rate limit, conditional swap (SF-23) |
| M staff | GET, POST | `auth()` + roles owner/manager (owner-only for owner-level actions), same-origin, refuseSupportSession, audit |

**Specific concerns.**
- **Cross-tenant identifiers.** The club comes from the path and the member lookup is `where {id, tenantId}` (contact-email 404 #6/#7). Flow 8 cross-tenant 404 PASS in both roles (run 3 §5).
- **Role escalation.** Strict bodies on every hub route (`login-email/route.ts:72-76`, `contact-email/route.ts:82-88`, `check/route.ts:45`). The owner route selects `role: "owner"` itself. SF-03 forged-key test (23 cases, R approved). Flow 8 mass assignment 400 PASS.
- **Impersonation / support sessions.** Proxy refusal `proxy.ts:298-321`; in-route refusals on check and contact-email; SF-24 backstop on member writes. Flow 1 "support-session refusal" PASS both roles.
- **De-listed operators.** The allowlist is checked at every cookie resolution; flow 1 allow-list refusal PASS. `OPERATOR_ALLOWED_IDS` is SET in Production (12 Oct 01:35 UK) and takes effect only at the next deployment.
- **Revoked sessions.**
  - Operator: `sessionVersion` equality on every request.
  - Club: revocation check on every Node pass, fail-closed (`auth.ts:1361-1406`, `lib/session-revocation.ts:103-126`).
  - Flows 9/9m PASS both roles.

**Email correction — one club, one subject, one change, one version.**
- **Lookup / preflight:** the check route reads holders in the path club only and writes `admin.login_email.checked`.
- **Step-up:** the grant binds operator, operator `sessionVersion`, action, target `<club>/<subject>/<sub-action>`, a digest of the canonical intended change, and a keyed digest of the subject's record version (`lib/operator-step-up.ts:12-55,:122,:172,:186-248`):
  - owner version = `owner:<id>:sv<n>:email=…:provisional=…` (`:214`);
  - member version = id, `sessionVersion`, address, `externalRef`, password-present (`:236-239`).
- **Mutation:** the grant is spent inside the same transaction as the write (`consumeStepUpGrant`), with a conditional `updateMany` on the address just read.
- **Audit:** `operatorId` and `requestId` (= digest of the grant nonce) in the same transaction.
- **Gap (SF-09 / AH-C2, OPEN Low):** the owner route binds the version **at code entry**, not at the check the operator saw. If Sean changed his own address inside the 5-minute window before the grant, the operator's change would overwrite it. The member route compares the version the operator saw (409, grant unspent; `sec-b-version-at-check-db` 4/4).

**Evidence.** CR-REPORT §1, §3–§5 (code at 704ab57; the hub files are unchanged since `c837e38` and since `03ef584`); run 3 §5 flows 1, 3, 4, 5, 5x, 6, 6b, 7, 8, 9, 9m PASS under both roles; FINDINGS SF-03, SF-08, SF-09, SF-23, SF-24, SF-61.

**Limitations / follow-up.**
- The table above is a static presence check. It is not a fresh line-by-line authorisation review of the 46 endpoints outside the hub; for those this lane relies on the R/R2–R9 approvals at earlier SHAs, with the code unchanged since `03ef584`.
- The owner login-email route lacks an in-route support-session check (proxy only) and does not refuse synthetic domains (CR gap 3).
- The remediation for SF-09 is described in `evidence/B/04`.

---

## 16. Authentication and account-takeover paths

**Status:** PASS — subject binding, expiry, single use, concurrent redemption, retirement on address change, no transfer of tokens and no implied mailbox verification (TEST both roles; code). NOT RUN — owner/staff recovery-code redemption in the browser. FAIL — existing gaps: member second-factor replay (SF-90) and legacy untagged links until expiry (SF-05 residual).
**Executable:** `512d5e8`. The auth routes, `lib/auth-token-binding.ts`, `lib/login-email.ts` and the recovery routes are unchanged between `03ef584` and `512d5e8`. **Environment:** TEST (sweep `03ef584`, both roles; browser run 3 on `512d5e8`); CODE.

| Path | Binding / expiry / single use / concurrency | Evidence |
|---|---|---|
| Password | Atomic per-address and per-network reservation before bcrypt; refund on success; no existence oracle | SF-111 (R7), SF-35 (R6); `auth.ts:493-506,:629-631` |
| Staff/owner TOTP | Single-use time-step across instances (`totpLastUsedStep`, conditional update); revocation gate on verify | SF-37 (R3), `app/api/auth/totp/verify/route.ts:32-33` |
| Operator TOTP | Single use (`consumeOperatorTotp`, `lib/operator-auth.ts:226-243`); step-up grant 5 min, single use | flows 1, 5, 5x PASS both roles |
| Member TOTP | **Not single use** — no `totpLastUsedStep` on `Member` | SF-90 OPEN (migration proposed) |
| Recovery codes (staff/owner and member) | Conditional claim → single winner; consumed code removed; `sessionVersion +1`; the factor is cleared without a password, so the next sign-in still needs the password | `sec-a-recovery-code-race-db` 4/4 both roles (two different codes at once; same code twice), `owner-recovery-revocation-db` 5/5 both roles (single use; sessions evicted), `sec-a2-member-recovery-race-db` 4/4 both roles (owner role first run skipped, rerun 4/4) — `evidence/lead/sweep-03ef584.txt` and `-reruns.txt`; browser redemption NOT RUN (run 3 §5) |
| Invitations | Subject tag (HMAC naming the person); 7-day expiry; two concurrent redemptions → one winner | `sec-a-token-subject-binding-db` 7/7 both roles (incl. "two concurrent redemptions … exactly one wins") |
| Reset codes | Hashed with the person; 2-minute codes; expired bound code refused | same test |
| Magic links | Subject tag; 30-minute expiry; a mismatch is audited and refused; passwordless members refused | `magic-link/verify/route.ts:109-111,:145-161` |
| Legacy untagged links | **Accepted on the old address-only rule until expiry** (≤ 7 days for invitations) — every link production has issued so far | SF-05 residual; `lib/auth-token-binding.ts:40-45,:100` |
| Google OAuth | Interim refusal unless an explicit link exists (none can exist yet); production enablement NOT ENABLED per the 9 Oct variable listing, not re-observed | SF-36 (R3/R6) |
| Disown-login | GET renders a confirmation; POST same-origin conditional claim | SF-37 |

**Address change does not transfer tokens or confer verification.**
- Both hub steps retire `reset`, `login` and `first_time_signup` tokens for the **old and the new** address in the club; waiver links are kept (`lib/login-email.ts:290-329`).
- The owner step sets `loginEmailProvisionalSince` and `sessionVersion +1`.
- While the address is provisional: forgot-password mints nothing, reset is refused and the code burned, magic links mint nothing, Google is refused, and outbound mail to the address is refused (CR §5, `lib/email.ts:410-426`).
- Provisional clears only by an operator attestation with its own step-up.
- No verification mail is sent (`EMAIL_DELIVERY=off`). "Unverified" on the member step is audit metadata only.
- Run 3 flow 4: the old address is refused, the new address reaches `/dashboard`, checker 38/38, zero sends, both roles.
- Retirement matches the stored token address exactly after lower-casing. A legacy token row stored with other case or whitespace would survive; current issuers write lower-case (CR §5).

**Remaining differences between populations.**
- **Member:** TOTP replayable within its window (SF-90). Revoke-all of a staff user does not end that person's own member session (SF-50).
- **Owner:** DSAR erase needs no step-up (SF-61). The owner login-email route does not check support sessions in-route (proxy covers it).
- **Operator:** the only population with allowlist, step-up and durable sign-in audit. No phishing-resistant MFA.
- **Staff/owner and member:** recovery codes clear the factor without the password (by design).
- **All:** the per-address cap can be filled by an attacker from unknown networks, so a victim on a new device is refused while mail is off (SF-59 residual).

**Limitations / follow-up.**
- Integration results come from the 10 Oct sweep at `03ef584`. They hold for `512d5e8` only because these files are byte-identical; the shared transaction libraries underneath did change and were reviewed separately by R10.
- The browser driver for recovery-code redemption is still owed (run 3 §5; decision §7). AQ1 Q4 carries the recommendation.

---

## 17. Database integrity and failure handling

**Status:** PASS — mutations and audit writes commit together; rolled-back writes are not reported as success; failed transactions do not contaminate reused connections; failure classes bounded (TEST both roles, R10 reviewer's own probes and mutants). FAIL — audit rows are editable and the runtime is the owner role (existing, unchanged; not accepted by this document).
**Executable:** `512d5e8`. **Environment:** TEST (R10 phase 2 on `1ca92c0` and delta review on `512d5e8`, 52 + 58 runs, both roles); CODE.

| Concern | Evidence at `512d5e8` |
|---|---|
| Mutation + audit atomic | Hub routes do grant spend → re-read → checks → conditional write → token retirement → audit in **one** transaction. Any failure, including the audit write, gives 500 with nothing changed (contact-email `:196-276`; owner route `:149-265`). Run 3 §8 SQL checks found the expected audit rows with operator id and request id |
| Success not reported for rolled-back writes | R10-3 CLOSED: a liveness `SELECT 1` before COMMIT (`lib/prisma-tenant.ts:140`). Swallowed errors (B5a, B5c) and a caught P2002 inside `withRlsBypass` (B5d) all end in `TenantTransactionAbortedError`, no COMMIT, 0 rows. Mutant ML-live → red (DELTA-HANDBACK) |
| Reused-connection contamination | SF-136 CLOSED: the release guard ends a client released inside a transaction (`lib/prisma.ts:84,:145`). MR2 with the guard → write persisted; without → lost. The guard never ended a healthy client in 7 burst runs. `withTenantContext` resets the bypass in the same statement that sets the tenant (B2, `sec-b2-stale-bypass-db` 6/6) |
| Transaction-start timeout | Pool acquisition 10 s (`lib/prisma.ts:33,:62`); B6: pool held 12 s → tenant call fails ~10.0 s, rate limit refuses ~10.06 s, 0 rows, no client left in BEGIN |
| Statement / lock timeout | Transaction-local `statement_timeout` 15 s (60 s extended) and `lock_timeout` 10 s (45 s), set in the first statement (`lib/prisma-tenant.ts:105-111,:224`). B4a/B4b/B4d/B4e: exactly one ROLLBACK each, acquires = releases, next client clean |
| Callback overrun | R10-1 CLOSED: the budget races the callback (`withinBudget`, `:170-196`); the slot is freed at ~15.4 s; the Blob `del()` moved after commit (`rank/route.ts`) |
| Connection loss / cancellation | B2 (server ends session at 3 s) → cut at 15.1 s, dead client dropped, next call works; `sec-l1-connection-drop` 11 + 1 skipped; 57014/57P01 fault cells for revocation (SF-01/44) |
| Rollback failure | Rollback once + release once on every path (R10 phase 1 checklist). The Prisma 1 h timer and the abandon-the-start path remain in the library; the guard neutralises the latter (R10 "unchanged residuals") |
| Retry behaviour | No blind retry in the hub. A lost response is answered from the record (`alreadyApplied`, flow 6b PASS both roles); a spent grant is never accepted twice. Stripe retries a 500 for ~3 days (webhook behaviour change; §26) |
| Uniqueness under concurrency | Advisory lock on (club, canonical address) across `User` and `Member` (`lib/login-email.ts:149-242`); P2002 → 409. **Cross-table and case-folded uniqueness is an application rule, not a database constraint**: the DB unique keys are per table and on the raw value (CR §4). The DB trigger proposal (SF-07) is not applied |
| Version checks under concurrency | Member route version-at-check 409 (`sec-b-version-at-check-db` 4/4); flow 7 stale 409 with grant unspent, resume with a fresh code, PASS both roles; ownership-transfer race fixed (SF-23, 9/9 both roles) |

**Editable audit and owner-role runtime — consequences, stated plainly.**
- Production connects as `neondb_owner`.
- Anyone who holds that credential can do all of the following: change, back-date or delete any audit row; truncate the table; rewrite `Operator` password hashes and the migrations ledger; read and write every club; and forge the release/acquisition rows the importer trusts.
- That includes every historical deployment still holding a valid credential, and anyone holding a leaked value that was not revoked.
- So the audit trail of Sean's correction is evidence against honest mistakes, not against a credential holder.
- SF-57 v2 (append-only trigger) protects nothing while the runtime is the owner role (the owner can disable triggers; R3). It requires the restricted runtime (SF-62 phase 2) first.
- The fact that this exposure already exists in production is not a reason to classify it as accepted. It is listed for an explicit decision in §26.

**Limitations / follow-up.**
- Every result is from TEST at ~45 ms round-trip time. Production's `idle_in_transaction_session_timeout` is stated as 300 s in FINDINGS SF-136 but as UNVERIFIED in `evidence/review-handoff/README.md` item 8 — contradictory (§27.3). A read-only check would settle it.
- SF-139: a persistently slow statement is classified as "busy" (restore answers 503; the purge cron skips silently). Reporting only, Low.

---

## 18. Availability and resource limits

**Status:** FAIL — one login address or one security bucket can saturate an instance's database pool and deny other security buckets on that instance (SF-118/SF-119 OPEN, ledgered Low because they fail closed). NOT RUN — production capacity was never measured.
**Executable:** `512d5e8`. **Environment:** TEST only.

**Mechanism.**
- Production pool `max` 5 per instance with a 10 s acquisition deadline (`lib/prisma.ts:33,:56`).
- A burst at one address holds a pooled connection per waiting reservation while it queues on the per-address advisory lock (lock bound 5 s / 10 s; SF-118).
- When the pool saturates, every other security bucket on that instance (TOTP verify, apply, recovery) is refused with `Retry-After` ≤ 30 s (SF-119; a TOTP bucket got 5 of 60 through, an apply bucket 0 of 60).
- The real owner with the right password can be refused with the misleading "Incorrect email or password" during the burst (SF-118 wording residual).
- A known address can be re-capped roughly every 75 minutes with ~10 requests (SF-59 residual). A victim on a new device stays refused while mail is off.
- Nothing is admitted in any of these cases — security-preserving refusal — but it is an outage for that instance and, for the targeted address, for its owner.

**Reconciling earlier burst failures with the final candidate.**
- **L1 cycle 2:** 15 failed runs of `sec-c3` (unhandled connection-terminated). Kept as failures (ITERATION-2-REPORT §11).
- **R10 phase 2 at `1ca92c0`:** 0 product-caused unhandled rejections in 52 runs. The R10-1 regression (slot held until the callback returns) was found and later closed.
- **R10 delta at `512d5e8`:** 0 product-caused unhandled rejections in 58 runs. The remaining failures were classified as TEST connectivity: every cell skipped after "Connection terminated due to connection timeout" at setup; B12 39/40 once.
- **Rehearsals:**
  - first attempt (`704ab57`, Node 25): P2028 in the revocation check;
  - run 2 (`704ab57`, Node 24): P2028 ×2 per role pass and one bare `/login` (SF-137);
  - run 3 (`512d5e8`): 0 P2028 and 3 pg connection-timeout `unknown` verdicts (restricted main 1, fault server 2), none user-visible.
- The cause of these timeouts on TEST is not established (run 2 §5a; run 3 §4.1).

**Tested concurrency and duration (all TEST, short bursts).**
- R10 B12: 40 concurrent at pool 5 → 40/40, 4.0–4.5 s (3.9 s before the liveness statement).
- R7: 120 concurrent sign-ins; SF-118: 40 concurrent with pools 5 and 20.
- Run 3 fault test: 12/24/40 concurrent `GET /dashboard` and 6/12 tabs (1,189 responses); every response 200.
- Durations are seconds to minutes. No sustained test, no multi-instance test.

**Limits that are known.**
- 5 connections per instance; 10 s acquisition; 15 s tenant budget (60 s extended); lockout lock 10 s; the security-bucket refusal window ≤ 30 s.
- **Unknown:**
  - the number of Vercel function instances under load;
  - the production Neon compute size and its `max_connections`. Production uses the **direct host** (packet §4), so instances × 5 connections land on the compute directly. This conflicts with the project instruction that production use the pooled host — see §27.3.
- No production capacity is claimed from any of the above.

**Limitations / follow-up.** SF-119 fix is outlined in the ledger: stop holding a pooled connection while waiting on the bucket lock. Also correct the SF-118 refusal wording. Read the production compute size and connection limit read-only. Monitoring of the 503 rate and of the "revocation unknown" log line is proposed in §24.

---

## 19. Sensitive-data protection

**Status:** PASS — changed code and the run 2 / run 3 artefacts. FAIL — credentials disclosed in public git history are not proven revoked (SF-14); the operator address is stored in tenant audit metadata (SF-138). NOT RUN — inspection of the production build output; proof that logged error objects never carry an address.
**Executable:** `512d5e8`. **Environment:** CODE; TEST artefacts; PROD (variable metadata only).

**Changed code.**
- **Logs:**
  - the hub and account routes log a fixed message plus the error object on failure (`login-email/route.ts:265`, `contact-email/route.ts:272`, `check/route.ts:160`, `account/login-email/route.ts:185`);
  - `auth.ts:581` logs subject kind, ids and `err.message` only;
  - the rate-limit over-limit warning logs the family and counts only (SF-120 FIXED, R8);
  - the readiness checker stores every address, hash, TOTP secret and recovery-code list as HMAC under a run secret and prints none (CR §6).
- **Errors and caches:** every `/api` response is `private, no-store` (`next.config.ts:146-148`, added in this delta); exports are no-store (SF-29).
- **Tree secret scan on `512d5e8`:** 8 candidates, all pre-existing and outside the delta — documented test fixtures and the demo-seed password (SF-82, SF-109) (`evidence/lead/gates-node24-512d5e8.log`).
- **SF-138:** `admin.impersonate.start` (and the approve, reject and create-tenant routes) store the operator's own address in club-tenant audit metadata (`app/api/admin/impersonate/route.ts:223`). Observed in run 3 under both roles. OPEN Low. It does not touch Sean's correction, which uses no impersonation.

**Release artefacts.**

| Artefact | Location | Masking / cleanup (per run record) |
|---|---|---|
| Run 3 screenshots (41) | lane scratchpad `SP/hub/rh512-e2e/` | all masked (mask check viewed); none committed |
| Run 3 private files | `SP/hub/rh512-private/` | baselines, private expectation files, `state.json`, mail trigger deleted; nothing written under `%LOCALAPPDATA%\matflow-readiness`; worktree removed (run 3 §6) |
| Run 2 screenshots (41) | `SP/hub/rh24-e2e/` | all masked; none committed; private files deleted (run 2 cleanup) |
| First attempt (Node 25) screenshots | other session's `SP/hub/rh-e2e/` | **9 Oct mask defect:** an address was readable in one capture (`REHEARSAL-704ab57.md:57`; synthetic TEST fixture). Run record left unfinished, so its private-file cleanup is **not recorded** |
| Lane RD screenshots `rd/*.png` | RD scratchpad | masking status not recorded |
| Server logs, checker stderr | scratchpads | stated to contain no addresses (run 2) |
| Browser traces | none recorded in runs 2–3; `e2e.yml` uploads a Playwright HTML report on schedule/dispatch only (TEST data) | — |
| Committed run records | `docs/readiness/hub-release-2026-10-12/` | no address, password, code, token or secret (stated in each record; consistent with this lane's reading) |

**Preventing future disclosure versus revoking past disclosure.**
- **Prevention in this release:** masking, no-store, the log-family rule, HMAC-only checker output, mail off, and the operator shared secret refused in production.
- **Revocation — a separate matter:**
  - *Neon password and Resend key:* replacements created and deployed. Revocation is REPORTED by the owner (11 Oct 17:07 UK), not evidenced. The fingerprint check proves only that the local values differ from the leaked ones (SF-14).
  - *Stripe key:* fingerprint MATCH. Only a 25-character prefix leaked (CONTAINMENT C4); roll as hygiene.
  - *CRON secret:* matched the leak and is now absent. It must never be re-set to the old value.
  - *Blob token:* possibly exposed through SF-28 in every older build. Unrotated; rotation only after this release is live (SF-69).
  - *Legacy admin secret:* 53 days old; held by old builds that still accept it (§22).
  - *Public git history* keeps the 7 May values permanently. Only provider-side revocation neutralises them.

**Limitations / follow-up.**
- **Error objects:** whether a logged Prisma/pg error object can carry the pg `detail` text (which can include a conflicting address on a unique violation) was not verified. Neither was what `lib/sentry-scrub.ts` removes before Sentry. A one-off check on TEST would settle both.
- **Build output:** the production build output (client bundles) was not inspected for embedded values. By design only `NEXT_PUBLIC_*` reaches the client.
- **Sean's baseline:**
  - the private baseline file for Sean's real correction must be created outside the repository with a deletion time (decision §6 step 5);
  - the checker refuses in-repository paths only relative to the checkout it runs from (CR §6);
  - mode 0600 is not enforced on Windows.

---

## 20. Browser and request security

**Status:** PASS — CSRF/origin, input validation, mass assignment, cache behaviour and security headers on the affected routes; payments-only COEP change excluded. FAIL — enforced CSP still allows inline scripts (SF-30 PARTIAL). This is existing exposure, unchanged from production.
**Executable:** `512d5e8`. **Environment:** CODE; TEST browser (run 3).

- **CSRF / origin.** `assertSameOrigin` is present on every mutating privileged route (§15 table). Flow 8 Origin/CSRF 403 PASS both roles. The SameSite cookie is the second layer (SF-32 note).
- **Input validation / mass assignment.**
  - `z.strictObject` on the three hub routes and on both TOTP verify routes (SF-98).
  - A forged-key matrix of 23 cases (SF-03) and the canary sweep (SF-33).
  - Flow 8 mass assignment 400 PASS.
  - About 100 other routes still use strip-mode schemas (SF-101, hardening).
- **Redirects.**
  - SF-137: the page gate redirects to bare `/login` on an `unknown` revocation verdict, which drops `?club=`. That is a navigation defect, not an open redirect.
  - Callback/redirect parameters of NextAuth were not re-assessed in this lane.
- **Cache.**
  - `private, no-store, max-age=0, must-revalidate` on `/api/:path*`, `/api/admin/:path*`, `/admin/:path*`, `/api/auth/:path*` and others (`next.config.ts:112-170`; the `/api/*` and `/admin/*` rules are new in this delta, commit `035e27e`).
  - Flow 3 no-store PASS.
- **Security headers (static, all paths):**
  - HSTS 2 years with `preload`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`;
  - COOP `same-origin`, COEP `credentialless`, CORP `same-origin`;
  - `frame-ancestors 'none'` (`next.config.ts:49-100`).

**The CSP that is actually enforced at `512d5e8`.**
- The static policy is sent as `Content-Security-Policy` on every response (`next.config.ts:7-37,:100`). Production values:
  - `default-src 'self'`;
  - `script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com https://js.stripe.com` (no `unsafe-eval` in production);
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`;
  - `img-src 'self' data: blob: https:`;
  - `connect-src` self + Vercel storage/insights + three Sentry ingest regions + Stripe API + Google accounts;
  - `frame-src 'self'` + Stripe;
  - `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`, `upgrade-insecure-requests`.
- **Inline script is therefore permitted by the enforced policy.**
- The per-request nonce policy without `unsafe-inline` (`lib/csp.ts:96-125`, with `strict-dynamic`) is sent as `Content-Security-Policy-Report-Only` unless `MATFLOW_CSP_ENFORCE` is exactly `1`/`true` (`lib/csp.ts:74-81`). That variable is not set in production and was unset in run 3.
- Report-only is monitoring, not protection.
- `style-src 'unsafe-inline'` remains in both policies.

**Payments header change.**
- The COEP removal (commit `4a3968c`) is on `payments/stripe-defects-2026-10` and is **not** an ancestor of `512d5e8` (`git merge-base --is-ancestor` false).
- The latest `next.config.ts` commit in the candidate's history is `035e27e` (cache rule).
- `512d5e8` therefore still sends COEP `credentialless`, as production `e8afb6a` does today. The only change to `next.config.ts` in the delta is the 26 added cache lines.
- The payments change is excluded. It needs its own review with the payments milestone; card frames remain blocked by COEP in both builds, which is irrelevant while Stripe is not live.

**Limitations / follow-up.**
- XSS testing of the hub pages was not run in this lane. R5's 19-page CSP pass (`ebd761d`) concerned the nonce policy.
- `report-to` delivery over https is UNKNOWN (SF-30 residual).
- Enforcing the nonce policy is an owner decision after a preview check. Setting the variable does not change the static header on `/api` paths (SF-107).

---

## 21. Build, dependencies and release provenance

**Status:** PASS — runtime, lockfile, gates and CI hygiene for the candidate. FAIL — "only approved source reaches production" is not yet enforced: the PR + status-check ruleset is pending (D-14). Install and build steps run with production secrets (SF-20, existing). NOT RUN — the production build at the merge commit and the PR CI run do not exist yet.
**Executable:** `512d5e8`. **Environment:** local Node 24.21.0 (gates, rehearsal); CODE (workflows); PROD (ruleset, coordinator 12 Oct).

**Runtime, lockfile, audit.**
- **Gates (`evidence/lead/gates-node24-512d5e8.log`, 12 Oct 05:37Z, Node v24.21.0):**
  - lint 0;
  - `npm audit --omit=dev` 0 vulnerabilities;
  - unit 481 files, 6,599 passed / 1 skipped;
  - isolated build `XEFPlYyNsQ5F-CB6DKMKc`;
  - tsc 0;
  - tree secret scan 8 pre-existing.
- **Run 3:** fresh `npm ci` under the SHASUMS-verified Node 24.21.0 binary: 1,039 packages, no EBADENGINE, `pg` 8.20.0 and `pg-pool` 3.13.0 confirmed.
- **`package.json` at `512d5e8`:**
  - `engines` `>=24.18.1 <25`;
  - overrides `deepmerge-ts ^8.0.0`, `mysql2 ^3.24.5` (SF-11), `pg-pool 3.13.0`.
- **Audit scope:** production dependency tree only. Dev dependencies are covered by the OSV step in `security-supply-chain.yml`, which is not a required check.
- **Unresolved:**
  - generated Prisma client 7.10.0 versus runtime `@prisma/client` 7.4.2 (R10 note);
  - npm reports 4 install scripts "not yet covered by allowScripts" (`@prisma/engines`, `@sentry/cli`, `prisma`, `unrs-resolver`; run 2 §1);
  - the Vercel Node patch level is UNKNOWN (SF-71).

**Build and install scripts with production secrets.**
- On Vercel the install and the build run with the Production environment.
- The root `postinstall` (`prisma generate`) runs.
- The build script `node scripts/maybe-migrate.mjs && next build` runs `prisma migrate deploy` with the production `DATABASE_URL`. That is the same owner identity as the runtime (SF-75); the guard refuses the production endpoint unless `VERCEL_ENV=production` (CR §7).
- Dependency install scripts were skipped by npm's allowScripts in the serving build (SF-71), but a dependency with an allowed script, or Tailwind/Next plugins evaluated at build, executes with those secrets in scope.
- Vercel installs with `npm install`, not `npm ci` (SF-15). The deployed tree is resolved by Vercel, not by the gate's `npm ci`.
- Postinstall-downloaded engine binaries sit outside lockfile integrity (SF-20 OPEN).

**CI and third-party actions (read at `512d5e8`).**
- `ci.yml`, `e2e.yml` and `security-supply-chain.yml` declare `permissions: contents: read`; `db-backup.yml` sets the same at job level.
- Actions are pinned to commit SHAs: `actions/checkout@11bd719…` (v4.2.2), `actions/setup-node@49933ea…` (v4.4.0), `actions/upload-artifact@ea165f8…` (v4.6.2). Semgrep is pinned via `pipx install semgrep==1.180.0`.
- No `pull_request_target` or `workflow_run` exists in any workflow (`git grep` empty).
- `ci.yml` runs on `pull_request` with a throwaway Postgres service and fixed fake secrets. It references no repository secret, so a fork's pull request receives no secret (GitHub withholds secrets from fork PRs regardless).
- Repository secrets appear only in `db-backup.yml`, which runs on schedule/dispatch, never on a PR (and fails at "Validate secrets", SF-77).
- `security-supply-chain.yml` installs with `--ignore-scripts`. Its tree secret-scan step exits 1 on the documented fixtures (SF-82), so it is red as it stands and is not the required check.
- **Vercel:** fork protection is on (E2 O6). A pushed branch creates a preview deployment with the Preview environment (packet §7 step 2).

**How only the approved source reaches production (packet §7).**
1. The ruleset is tightened to require a PR and the `Typecheck + Lint + Vitest` check, with no bypass actor. Today ruleset 24901063 holds only no-deletion and no-force-push; until it is tightened, a direct push to `main` deploys **and migrates** production (SF-15).
2. The branch `release/hub-512d5e8` is created at `512d5e8`, the PR is opened, CI must be green, and it is merged as a merge commit `M`.
3. `git diff M 512d5e8` must be empty (tree identity).
4. The Vercel deployment must show `meta.githubCommitSha = M`.
5. `release-verify --sha M` is run from the `512d5e8` checkout.

**Limitations / follow-up.**
- Source identity is git-tree identity only. The production build ID will differ from `XEFPlYyNsQ5F-CB6DKMKc` and `-VI8m-f5fjlPib2_etBjA`. There is no build provenance or attestation (SF-15).
- GitHub and Vercel account 2FA status is UNKNOWN (SF-15).
- CI on `e8afb6a` was failing when it shipped (SF-72). A green PR run on the merge base is required evidence and does not exist yet.

---

## 22. Environment and configuration isolation

**Status:** PASS — test bypasses and development modes cannot activate in production at `512d5e8` (code). BLOCKED — the treatment of preview and historical deployments, and the read-back of effective values, depend on owner actions not yet evidenced.
**Executable:** `512d5e8`. **Environment:** CODE; PROD (variable names and ages, coordinator 12 Oct 00:30 UK; E2 inventory 9 Oct).

**Which environments hold which credentials (names and targets only).**

| Credential | Production | Preview | Development | Historic deployments |
|---|---|---|---|---|
| Database (`DATABASE_URL`) | yes (rotated 11 Oct; direct host; owner role) | **no** | — | each build kept the value it was built with; old builds hold the pre-rotation value — harmless only if the old password is revoked (unevidenced) |
| Session signing (`NEXTAUTH_SECRET`) | yes | yes; equality with Production UNKNOWN (C6) | — | all builds |
| Mail (`RESEND_API_KEY`) | yes, Production only since 11 Oct | removed | — | old builds hold the old key until it is deleted at Resend |
| Blob (`BLOB_READ_WRITE_TOKEN`) | yes, non-sensitive | yes | yes | all builds; possibly exposed (SF-69) |
| Payments (`STRIPE_SECRET_KEY`, webhook secret) | yes (157 days) | yes (C4/C8) | — | all builds; no live Stripe in use |
| Legacy operator secret (`MATFLOW_ADMIN_SECRET`) | yes, 53 days, rotation pending | yes | — | 62 of 64 builds (9 Oct) hold an older value, **and builds before this release accept it in production** (OPERATOR-ACCESS-RECOVERY "Rollout"; chain C5) |
| `TESTING_MODE` | present (161 days) | present | — | inert in production in every build (CONTAINMENT line 140) |

**Bypasses and development modes at `512d5e8`.**
- `isTestingMode()` is false when `VERCEL_ENV=production` or when `DATABASE_URL` names the production endpoint (`lib/testing-mode.ts`).
- The E2E password bypass requires `E2E_AUTH_BYPASS=true` and is refused whenever `VERCEL` or `VERCEL_ENV` is set (`auth.ts:238-244`).
- `LOGIN_THROTTLE_ENABLED=false` is ignored on any Vercel deployment or against the production database (`auth.ts:225-230`, SF-68).
- The shared admin secret is refused on `NODE_ENV=production` or `VERCEL_ENV=production` (`lib/admin-auth.ts:70-72`).
- The production DB guard in `maybe-migrate.mjs` refuses migration from a non-production environment (CR §7).
- **Caveat:** on a Preview deployment (`VERCEL_ENV=preview`) with `TESTING_MODE=true`, mandatory 2FA is bypassed. Preview has no `DATABASE_URL`, so no real account is reachable there.

**Preview and historical deployments.**
- Disabling automatic previews (packet §7 step 2) stops a **new** preview of the release branch from being built with Preview secrets. It does not retire existing deployments.
- On 9 Oct there were 64 production deployments and 0 previews (E2 O1), protected only by Vercel SSO (`all_except_custom_domains`).
- They are retired only by deletion, under the separately authorised procedure (D-3). Deletion is not containment: a deleted build is restorable for 30 days. Only provider-side revocation contains a credential.

**Stored configuration versus effective running deployment.**

| Setting | Stored (dashboard) | Effective in the serving build | How the release verifies the effective value |
|---|---|---|---|
| `EMAIL_DELIVERY` | encrypted; last read back as off on 9 Oct; owner to re-read | e8afb6a: value from its build (11 Oct) | `release-verify` `emailDelivery: off` from the deployed health output |
| `OPERATOR_ALLOWED_IDS` | set 12 Oct 01:35 UK | **not effective** until the next deployment | `release-verify --expect-operator-login` (authenticated operator request succeeds); owner's own `/admin/login` |
| `MATFLOW_ADMIN_SECRET` | 53 days; rotation pending | grants nothing in the new build's production paths; still honoured by older builds | `release-verify` "legacy transports refused" (401/403 JSON) |
| `DATABASE_URL` / `RESEND_API_KEY` | rotated 11 Oct | serving build reads the new values (deployment created after the change) | health ok; migration state read |
| `CRON_SECRET` | absent | absent | crons answer 503 (expected) |
| `MATFLOW_CSP_ENFORCE`, `ENABLE_GOOGLE_OAUTH` | absent per the 9 Oct listing; not re-read | report-only CSP; Google door refused | not covered by release-verify — re-read names before approval |

**Limitations / follow-up.** Containment step 8 is not done: Preview's own `NEXTAUTH_SECRET`; Preview copies of the admin secret, the Stripe secrets and the Blob token removed; `TESTING_MODE` removed from Production. Deletion of old deployments is the owner's. The names in the last row should be re-read before approval.

---

## 23. Migration and recovery safety

**Status:** BLOCKED — the exact six-migration sequence has not been rehearsed on a production-derived isolated copy, and no restore of production data has ever been executed (packet §5, owner; required before approval). FAIL — `docs/runbooks/DEPLOY-2026-10.md` §5 still names "Instant Rollback" as the preferred recovery, which contradicts the release decision.
**Executable:** `512d5e8` (migrations identical to `704ab57`; `git diff 704ab57 HEAD -- prisma/migrations` empty). **Environment:** TEST (migrations applied; release-verify 100 applied, both roles); PROD (Stage 0 read 12 Oct 01:33 UK: 95 applied, the six missing, 0 failed or in progress, `AuditLog` 120 rows).

**What exists.**
- **Six migrations:** `20261006010000_operator_auth_hardening`, `20261006020000_tenant_lifecycle_safety`, `20261006040000_support_session_binding`, `20261006050000_operator_enrolment_ticket`, `20261007010000_login_email_provisional`, `20261009010000_audit_operator_request`.
- Each is wrapped in BEGIN/COMMIT (pinned by `tests/unit/migrations-are-atomic.test.ts`).
- They make nullable columns only, plus one index (not CONCURRENTLY) and one validated FK on `AuditLog`. No backfill, NOT NULL, drop or rename (CR §7).
- No campaign or payments migration is included.
- **TEST is not production-derived.** It proves the application runs on the migrated schema, not that production data satisfies the FK or that the timings hold.

**Recovery per case.**

| Case | Defined response (evidence) | Rehearsed? |
|---|---|---|
| A migration fails partway | That migration rolls itself back; earlier ones stay; `migrate deploy` exits non-zero; the build stops; `e8afb6a` keeps serving; P3009 until `prisma migrate resolve --rolled-back <name>` (owner, production) | Mechanism drilled 30 Sep on a TEST throwaway schema (DEPLOY-2026-10 §5); not on a production copy |
| Schema succeeds, build fails | Additive nullable schema while `e8afb6a` serves; fix forward with a new build of the same SHA; never Instant Rollback/Promote (packet §5 "Failure state") | Old-code-on-new-schema boot **NOT RUN** (packet §5 step 4) |
| Deployment succeeds, authentication breaks | Stop before approval B; fix forward. Operator access is retained through `scripts/operator-access.mjs` run locally with the database credential (the only emergency path; audited in the same transaction). Club owners have no operator-independent path while mail is off | Not rehearsed in production; the script itself is exercised on TEST by the rehearsal setup |
| Production writes after the recovery point | Restore discards them; packet §5 step 5 defines a 30-minute change window (no imports, no account changes) and reconciliation of later writes; Neon history window is 6 hours (owner-reported) | NOT RUN |
| Rollback would restore a vulnerable path or retired secret | Forbidden: an older build restores the shared admin secret in production, the fail-open revocation (SF-01), untagged tokens only, and the pre-rotation credentials and configuration (CR §7 "Rollback consequence"; decision §4) | n/a (prohibition) |

**Who executes, and access during an authentication incident.**
- **Owner:** Neon console (branch, restore), Vercel (deployments, variables), GitHub (merge), and local scripts holding the database credential.
- **Coordinator:** read-only verification. Agents remain refused production reads except owner-approved manual-mode calls (D-1).
- **Access retained** through the owner's provider accounts (2FA status UNKNOWN, SF-15) and the local database credential. If the owner loses both his authenticator and his workstation, recovery depends on the Neon account alone.

**A backup is not recoverability.**
- No exported backup has ever succeeded (SF-19, SF-77; 22 failed runs).
- The weekly dump omits roles and grants.
- The `backup-2026-10-11` branch is UNVERIFIED.
- The restore runbook has run only on in-memory TEST copies (SF-19; ITERATION-2-REPORT §3).

**Limitations / follow-up.**
- The packet §5 steps 1–6 are the owed evidence. Required results: branch creation time and expiry setting; `migrate status` on the branch (95 + 6 pending, checksum warnings noted — SF-78); timed migration; both boots; RTO/RPO.
- `DEPLOY-2026-10.md` §5 must be corrected or explicitly superseded before release so that an incident does not follow it.

---

## 24. Monitoring and operational response

**Status:** FAIL — no baseline, no alert rules and no thresholds exist in the evidence; the packet defines only "no new unhandled rejection class in Sentry in the first 30 minutes". NOT RUN — that Sentry actually receives production events has not been evidenced in this campaign.
**Executable:** `512d5e8`. **Environment:** CODE; PROD (variable names only).

**What exists.**
- `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` have been set in Production since 15 Sep (E2 metadata).
- `instrumentation.ts`, `instrumentation-client.ts` and `sentry.{server,edge,client}.config.ts` are present; the CSP allows all three ingest regions.
- Sentry captures:
  - revocation-check failures (`lib/session-revocation.ts:136-147`, log line "session-revocation check failed — request REFUSED as unavailable");
  - lockout counter failures (`auth.ts:581-588`);
  - Stripe webhook failures (R10 note).
- `lib/sentry-scrub.ts` exists. Its effect was not verified here.
- Vercel logs on Hobby are kept for about **1 hour** (CONTAINMENT C5), so evidence must be captured within that hour.
- No alerting configuration exists in the repository. **No baseline exists** for authentication failure rates, 5xx rates or database timeouts in production.

**Detection without logging secrets (proposed signals, no baseline behind them).**

| Signal | Source | Proposed stop / escalation (absolute, because no baseline exists) |
|---|---|---|
| Authentication failures | `AuditLog` sign-in and refusal rows; login-page reports; Sentry `area:auth` | any operator sign-in refusal for the allow-listed id; any owner report of being unable to sign in → stop account mutations |
| Elevated 5xx | Vercel logs filtered to `/api/admin/*`, `/api/auth/*`, `/api/account/*` | any 5xx on these prefixes during the window, other than the known cron 503s → stop and investigate |
| Database timeouts | "session-revocation check failed" log line; Sentry P2028 / `TenantTransactionBudgetError` | any occurrence in the first 30 minutes → hold approval B until explained |
| Failed privileged changes | route error lines ("change or audit write failed; nothing changed"); 409/500 in the hub panel; audit rows | any 500 from the hub routes → stop; read state before any retry |
| Unexpected e-mail delivery | `release-verify` `emailDelivery: off`; `EmailLog` row count; Resend dashboard send log | any new `EmailLog` row or Resend send → stop; delivery must be off |

**Window and responsibility.**
- Proposed window: from READY until 30 minutes after Sean's own successful sign-in.
- The owner (Noe) is the only human responder. The coordinator performs read-only checks.

**Incident procedure (short).**
1. **Stop.** No further account mutation, no retry of a hub action, no imports.
2. **Preserve.** Copy Vercel log lines (1-hour retention), Sentry issue ids, the hub panel state and the request ids. Record times in UK.
3. **Assess.** Read actual state, read-only: `owner-login-change-check.mjs verify`, `release-stage0-readonly.mjs`, and the two SQL checks of decision §6 step 10.
4. **Contain.** Revoke the affected sessions (operator sign-out; `revoke-access`), keep mail off, and leave the deployment in place unless it is the cause.
5. **Recover** by the approved path only: fix forward; a branch restore only under packet §5's reconciliation rule; never Instant Rollback; no direct SQL changes, no password or MFA resets as a fix.

**Limitations / follow-up.** A test event from production should confirm Sentry delivery. This is the GO-LIVE-2026-09 Part 1 check, and it was not found executed in the evidence. Thresholds should be revised once a week of production data exists.

---

## 25. Independent-review scope

**Status:** PASS — the final executable `512d5e8` is covered by an independent review of its last code delta, by gates, and by a browser rehearsal on the same SHA. No code changed after those checks. NOT RUN — any human or organisationally independent review: every reviewer is an AI agent lane under briefs written by the same coordinator.
**Executable:** `512d5e8`. **Environment:** as per row.

| Reviewer / lane | Kind | What it inspected / tested | SHA |
|---|---|---|---|
| R (iteration 1) | unit + DB review | lanes A/B/C (13/13 approved), D (five passes, two claims refuted), F; both roles; mutants | ab5f928 … 788d29a |
| R2–R9 | unit + DB review, mutants, own probes | E/E2/B2, A2/F2/E3, D2, C2, A3/D3/F3/C3 and the integrated candidate (R6), A4/C4 (R7), M1 v2 (R8), M2 (R9); five lanes refused on first review; R6 found two Medium defects in the fixes (SF-111/112) | through 704ab57 |
| Lead sweep | DB verification | 112 integration runs, both roles: 105 ok, 3 non-zero (all passed on rerun), 4 no-tests-ran by design | 03ef584 |
| R10 phase 1 | static architecture/code review | transaction layer of L1; found R10-1…R10-4 | 1ca92c0 |
| R10 phase 2 | DB verification, both roles, fault injection, mutants | 52 runs; confirmed R10-1 (Medium regression), R10-2/3/4, new R10-5 | 1ca92c0 |
| R10 delta | DB verification, both roles | L2 delta: R10-1…5 CLOSED; new R10-7 (SF-139), R10-8 (SF-140); Stripe webhook behaviour change; 58 runs | 512d5e8 |
| Lead gates | unit / static | lint, audit, unit, tsc, isolated build, tree secret scan | 512d5e8 |
| CR | code reconciliation (static; no tests) | eleven path fixes, hub routes, checker, migrations; five corrections to the v1 decision | 704ab57 (hub files identical at 512d5e8) |
| First attempt (other session) | browser rehearsal | Node 25, aborted: 28 PASS / 5 FAIL | 704ab57 |
| RD | failure classification | first attempt's five FAILs and the abort | 704ab57 |
| RH run 2 | browser rehearsal, both roles | all hub journeys PASS; P2028 ×2 per role; one bare `/login` (became SF-137); SF-138 found | 704ab57 |
| RH run 3 | browser rehearsal, both roles | every journey PASS; 0 P2028; SF-137 not recurred (code unchanged) | 512d5e8 |
| Coordinator | operational readiness (read-only) | production SHA, variable names and ages, Stage 0 migration state, ruleset; nothing executed | PROD |

**Coverage of the final integration.**
- `512d5e8` = `704ab57` + L1 + L2 + one test commit.
- The L1+L2 library delta was reviewed by R10 (phase 1, phase 2, delta).
- The hub and auth code is byte-identical to the reviewed and rehearsed `704ab57` and `03ef584`.
- Run 3 and the gates ran on `512d5e8` itself.
- After `512d5e8`, only documentation changed.
- **Not covered:** the production build at the merge commit; operational readiness, which was assessed but not executed (recovery, migration rehearsal, configuration); owner recovery-code redemption in the browser.

**Disagreements and corrections (preserved).**
1. **CR versus decision v1:**
   - SF-30 was counted as fixed, but `unsafe-inline` is still enforced;
   - `ab5f928`'s change to the login-email route is body strictness, not subject binding;
   - SF-54/91 feed the attendance import, not address freedom;
   - the checker omits `admin.login_email.checked` and the member `sessionVersion` check;
   - `--expect-migrations local` expects all 100 migrations, not six;
   - the production migration tree ends at `20261003180000`, not `20260930100000`.
2. **R10 versus L1:**
   - L1's `1ca92c0` introduced an unbounded slot hold (R10-1, Medium), so it was not releasable alone;
   - R10-5 showed lock waits reaching the caller as 57014 and producing a 500 on restore;
   - after L2, R10 **refuted** the claim that a slow query "still 500s": it now reaches the caller as P2028, is read as *busy* and answers 503 — a misclassification, ledgered as SF-139.
3. **RD versus the first attempt:**
   - RD classified the five FAILs and the abort as driver/hand-off errors plus one environmental P2028;
   - run 2 then showed the flow-4 symptom is an **application** contract deviation (bare `/login` instead of the SF-44 503), triggered by the environmental timeout;
   - it became SF-137, so "environmental" alone was incomplete.
4. **Run 2 versus run 3:** SF-137 did not recur in run 3, but the code is unchanged, so it stays OPEN. "Did not recur" is not a fix.
5. **Ledger notes:**
   - SF-27's member half was labelled "awaiting review" while code and tests were present (CR §1);
   - `idle_in_transaction_session_timeout` in production is stated as 300 s (SF-136) and as UNVERIFIED (review hand-off) — unresolved.

**Independence limits.**
- All reviewers are agent lanes of the same model family, reading briefs and ledgers written by the coordinator. Shared assumptions are therefore possible: for example, every lane accepted the TEST branch as a stand-in for production.
- The E lanes and the coordinator's cross-owner edits were not independently reviewed (SECURITY-ACCEPTANCE §4).
- The hand-off for a human reviewer exists (`evidence/review-handoff/README.md`) but was not used.

**Unresolved findings at `512d5e8`:** SF-137, SF-138, SF-139, SF-140, the Stripe webhook behaviour change, and the full open list in §26.

---

## 26. Security acceptance and release decision

**Status:** classification complete; **every owner decision column is empty**. Nothing below is accepted by this document. Accountable owner for every row: Noe (sole operator and owner). Review/expiry dates are proposals.
**Executable:** `512d5e8`.

### 26.1 Must fix (or complete) before this release

| Item | Why it blocks, in plain language | Evidence needed | Owner decision |
|---|---|---|---|
| Recovery and migration rehearsal on a production-derived branch (SF-19/77; packet §5) | Without it, nobody has shown that production can be restored, or that the six migrations and the old code behave on real data | branch time and expiry; `migrate status`; timings; two boots; RTO/RPO | |
| `main` protection: PR + required CI check, no bypass (SF-15, D-14) | Today a direct push deploys and migrates production with no check | ruleset read-back after the change | |
| Rotate `MATFLOW_ADMIN_SECRET`; re-read `EMAIL_DELIVERY` = off | The legacy secret is 53 days old and held by old builds; mail must be provably off before any account change | variable age after rotation; release-verify `emailDelivery: off` | |
| Preview-deployment decision for the release push (packet §7 step 2) | A preview of the release branch would run with Preview secrets (admin secret, Stripe, Blob, `TESTING_MODE`) | the setting chosen and recorded | |
| Correct or supersede `DEPLOY-2026-10.md` §5 ("Instant Rollback preferred") | In an incident it would restore old code, retired secrets and the shared-secret door | the corrected runbook | |
| Residual decisions recorded (26.3) | The release proceeds on explicit decisions, not defaults | ticked packet §6 | |

### 26.2 Requires additional evidence before deciding

| Item | Question to settle | Evidence | Owner decision |
|---|---|---|---|
| Neon password and Resend key revocation (SF-14) | Are the leaked credentials dead, or only replaced? This decides whether old deployments can still reach data or send mail | provider dashboards: identifiers and timestamps of the deleted or reset credential (no values) | |
| `ENABLE_GOOGLE_OAUTH`, `MATFLOW_CSP_ENFORCE`, `LOGIN_THROTTLE_ENABLED` names in Production (SF-36, SF-30, SF-68) | Unknown since 9 Oct | variable names re-read | |
| Demo club accounts and the committed demo-seed password (SF-109) | Was the production demo club seeded with the public password? If so, it is a live credential in public history | owner's read of how the demo club was created; rotation if yes | |
| Production `idle_in_transaction_session_timeout`, compute size and connection limit | Contradictory or unknown; affects §17 and §18 limits | read-only settings query (owner-approved) | |
| Sentry delivery from production | Is the only monitoring channel live? | a test event received | |

### 26.3 Proposed explicit owner acceptance

| Residual | Impact | Likelihood assumptions | Exposure | Mitigation | Review / expiry | Planned remediation | Owner decision |
|---|---|---|---|---|---|---|---|
| SF-137 bare `/login` on an `unknown` revocation verdict | A signed-in owner sees the club-code page with no message; the cookie stays intact; a retry works | needs a DB timeout during a page render; seen once in run 2, 0 in run 3 | every staff page under database pressure, including Sean's first sign-in after the change | the owner tells Sean to retry; monitor the revocation log line | 14 days after release | map `unavailable` to a 503 in `requireSession` with a unit test and a browser cell (or FIX FIRST — small, but it changes the candidate and needs gates, review and a rehearsal) | |
| SF-138 operator address in tenant audit metadata | the operator's own address is readable by that club's audit view | every impersonation, approval or tenant creation | operator privacy only; not on Sean's path | none | next candidate | operator id or keyed digest | |
| SF-139 budget cut classified as busy | a persistently slow purge step is skipped silently; restore answers 503 | only under slow statements | reporting only | none | next candidate | distinguish budget from lock wait | |
| SF-140 misleading guard log | a log line says "released inside a transaction" for a dead connection | rare | log noise | none | next candidate | check `_queryable` | |
| Stripe webhook P2002 → 500 | a duplicate event is never acknowledged; Stripe retries for ~3 days and may flag the endpoint | only with a live endpoint | none today (no live Stripe) | **condition:** no live Stripe endpoint before the payments branch lands | at the payments milestone | the payments branch removes those catches | |
| Owner/staff recovery-code redemption not browser-rehearsed | a defect in the page flow would surface only when someone needs recovery | rare event | owner and staff recovery | integration tests 4/4, 5/5 and 4/4, both roles, unchanged code since the sweep | 30 days | add a driver step | |
| SF-30 enforced CSP keeps `unsafe-inline` | any injected inline script runs; amplifies an XSS bug | needs a separate injection bug | all pages; unchanged from production | report-only nonce policy collects violations | 30 days | enforce `MATFLOW_CSP_ENFORCE` after a preview check | |
| SF-05 legacy untagged links | a pre-release invitation or login link for an address still works on the old rule until expiry | needs an outstanding link plus an address change or deletion | ≤ 7 days after deploy | the workflow retires tokens for both addresses in Sean's club | release + 7 days | remove the legacy branch | |
| Owner route: synthetic domains not refused; support check only in proxy; version bound at code entry (CR gap 3; SF-09) | operator error could set an unusable login; an owner self-change inside the 5-minute window could be overwritten | operator mistake or concurrent self-service | the operator plane only | operator checklist "never a synthetic domain"; Sean is told not to change his own address during the window | next candidate | in-route checks; compare the check-time version | |
| Runtime role `neondb_owner`, RLS backstop only, editable audit, Operator rows writable (SF-62/57/73/74/87) | anyone with the runtime credential controls all data and the audit trail; no database-enforced isolation | requires a credential leak or SQL injection; one leak already occurred (7 May) | all clubs, all audit; **unchanged by this release** | credential rotation; application filters; mail off | **set a date** — proposed 30 days | SF-62 phase 1–3 (13–19 agent-days) then SF-57 v2 | |
| SF-118/119/59 availability under burst | one address or bucket can refuse others on an instance; the real owner may be told the wrong reason | needs a deliberate burst | sign-in availability | fails closed; nobody admitted | 30 days | stop holding a connection while waiting; fix the message | |
| SF-90 member TOTP replay | a captured member code works again within its window | needs interception | members with TOTP | none | 30 days | migration plus conditional spend | |
| Old deployments with old secrets (SF-10, C5) | old builds behind Vercel SSO still accept the legacy operator secret and hold pre-rotation credentials | needs Vercel team access plus the old secret | operator plane via an old URL | Vercel SSO; rotation of the Neon/Resend credentials if revoked | delete after release verification | separately authorised deletion | |

### 26.4 Outside this release (justified)

| Item | Justification |
|---|---|
| SF-17 `CRON_SECRET` absent | Retention is deliberately off (one-way door, SF-127); the crons answer 503 by design |
| SF-18 DMARC/SPF | Mail is off; required before mail is enabled |
| SF-69 Blob token rotation | Must follow this release (old builds would leak a new token) |
| SF-131..134 tooling hardening | Readiness-script residuals blocked by D-8; not runtime |
| SF-101, SF-105/108, SF-55, SF-60, SF-61, SF-115 | Hardening or Low residuals not on the changed paths; unchanged exposure; next candidate |
| Payments branch (COEP removal, its seven migrations) | Separate milestone; excluded from `512d5e8` (§20) |

---

## 27. Evidence integrity and final completeness check

**Status:** PASS — the diff, changed routes and libraries, the migration set, the ledger and the required journeys are reconciled below. FAIL — stale or contradictory documents exist (27.3); none changes the code verdict, but two could misdirect an operator. BLOCKED — configuration and operational prerequisites (§22, §23, §26.1).
**Executable:** `512d5e8`.

### 27.1 Reconciliation

| Axis | Reconciled against | Result |
|---|---|---|
| Complete diff from serving | `git diff e8afb6a 512d5e8`: 187 commits, 1,330 files | runtime delta = hub + campaign + L1/L2 + pg pin; no code after `512d5e8` |
| Changed routes | 98 files under `app/api`; 49 privileged | §15 table; all 49 byte-identical to `03ef584` |
| Shared libraries | `auth.ts`, `proxy.ts`, `next.config.ts`, `package.json`/lock, 4 workflows, and lib files incl. `prisma.ts`, `prisma-tenant.ts`, `rate-limit.ts`, `auth-lockout.ts`, `session-revocation.ts`, `auth-token-binding.ts`, `login-email.ts`, `operator-step-up.ts`, `operator-auth.ts`, `csp.ts`, `tenant-lifecycle.ts`, `support-session.ts` | the five transaction-layer files changed after `03ef584` and were reviewed by R10; the rest are covered by R2–R9 |
| Migrations | `prisma/migrations` versus `e8afb6a` and production | exactly six new; production missing exactly these six (Stage 0) |
| Findings ledger | FINDINGS.md SF-01..SF-140 | every open row classified in §26; SF-137..140 present |
| Required journeys | run 3 §5 | all PASS both roles except owner recovery-code redemption (NOT RUN) |
| Configuration and operations | packet §4–§7 | BLOCKED on the owner items in §26.1 |

### 27.2 Failures preserved, and what resolved them

| Original failure | Cause established | Resolving evidence |
|---|---|---|
| L1 cycle 2: 15 failed `sec-c3` runs | SF-135 mechanism plus TEST connectivity | R10 phase 2 and delta: 0 product-caused unhandled; failures kept |
| First attempt: 5 FAIL + abort (`704ab57`, Node 25) | driver/hand-off errors plus environmental P2028; flow 4 = SF-137 | runs 2 and 3; SF-137 still OPEN |
| Run 2: bare `/login` (restricted flow 7), P2028 ×2 per role | SF-137 contract deviation; P2028 cause not established | run 3: not recurred; code unchanged |
| Run 3: restricted server-log standard FAIL (revocation refused 1) | pg connection timeout on TEST | none — recorded, not resolved |
| Run 3: SQL-check FAILs (SF-138 flag; holder-helper artefact) | expected: one ledgered finding, one helper artefact (run 2 §4.4) | classified |
| R10: probe A, B4a, B12 39/40, D-plant exit 1 | reviewer capture window; SF-139; TEST connectivity; intended control | DELTA-HANDBACK "Failures kept" |
| Sweep `03ef584`: 3 non-zero, 4 no-tests-ran | setup skips (reran OK); SF-57 suite skipped by design; fixture sweep | `sweep-03ef584-reruns.txt` |
| Unit: 1 skipped | known Windows-only skip | gates log |
| Tree secret scan: 8 candidates | pre-existing fixtures and the demo-seed password | SF-82, SF-109 (SF-109 needs owner evidence, §26.2) |

### 27.3 Stale, contradictory or incomplete evidence

1. **`docs/runbooks/DEPLOY-2026-10.md` §5** prefers Instant Rollback. The decision and the packet forbid it. *Owner/coordinator: correct before release.*
2. **`HUB-RELEASE-DECISION-2026-10-12.md` §5** still describes a fast-forward push of `704ab57`, and says the PR ruleset is deferred. Superseded by §3a/§7b and packet §7 (PR + merge commit at `512d5e8`). Its §8 verdicts still read "704ab57".
3. **`ledger-vs-candidates.tsv`** is indexed against `2a6487e`. It ends at SF-136 with pre-review statuses and has no rows for SF-137..140.
4. **`idle_in_transaction_session_timeout` in production:** "300 s" in FINDINGS SF-136 versus "UNVERIFIED in production" in `evidence/review-handoff/README.md` item 8.
5. **Production `DATABASE_URL` uses the direct host** (packet §4; decision §1). The project's CLAUDE.md requires the pooled host for production. This decision is unrecorded; it affects SF-87 and §18.
6. **First attempt record** (`REHEARSAL-704ab57-RUN-2026-10-12.md`) was never completed: steps 10–20 are pending and its cleanup is not recorded. It is also **untracked in git** (owned by the other session), so it is not committed evidence. Lane RD's screenshot masking is not recorded.
7. **`THREAT-MODEL.md`** is dated to `2a6487e` (§14).
8. **Production facts are point-in-time:**
   - variable ages (12 Oct 00:30 UK) and Stage 0 (01:33 UK);
   - the owner-reported provider state (11 Oct 17:07 UK);
   - the deployment inventory (9 Oct; 64 builds).

   All need refreshing immediately before approval.

### 27.4 Concluding points (lane AQ2 recommendation — the overall deployment-readiness conclusion is the coordinator's to sign after reconciling with AQ1)

1. **Is the exact candidate ready for deployment?**
   - **Recommendation: not yet.**
   - The code evidence for `512d5e8` is sufficient for this release's purpose:
     - independent review of the final library delta;
     - gates on the SHA;
     - every hub journey passed under both database roles on a fresh production-mode build of the same SHA;
     - no code changed since.
   - The prerequisites in §26.1 are not complete: the production-derived recovery and migration rehearsal, `main` protection, admin-secret rotation and mail read-back, the preview decision, the runbook correction, and the recorded residual decisions.
   - Green test counts do not substitute for these.
2. **What remains exposed after deployment.**
   - The runtime still connects as the owner role: no database-enforced isolation, and the audit trail is editable.
   - Inline script is allowed by the enforced CSP.
   - Legacy untagged links stay valid for up to 7 days.
   - Old deployments still hold old secrets until they are deleted, and leaked credentials are not proven revoked.
   - The Blob token is unrotated.
   - Member TOTP codes can be replayed.
   - Sign-in availability under a deliberate burst is weak (fails closed).
   - SF-137 navigation under database pressure.
   - There is no tested restore of production data, and no monitoring baseline.
3. **Can Sean's correction proceed after the post-release checks?**
   - Yes, provided every packet §7 step 6 check passes and approval B is given on fresh facts (decision §6).
   - The workflow passed end to end under both roles at `512d5e8`: holder check, step-up binding, the two-step change, lost-response replay, stale refusal, token retirement, and checker 38/38.
   - It must not proceed if any of the following fails: release-verify, the operator sign-in, `emailDelivery: off`, or the migration state.
4. **Remaining blockers and owners.**
   - **Noe:**
     - packet §5 rehearsal;
     - admin-secret rotation;
     - `EMAIL_DELIVERY` read-back;
     - preview setting;
     - ruleset tightening (manual-mode prompt);
     - provider revocation evidence;
     - residual decisions;
     - SF-109 answer;
     - deployment approval A;
     - later, approval B with Sean's voice confirmation.
   - **Coordinator:**
     - correct `DEPLOY-2026-10.md` §5 and the stale decision §5/§8 wording;
     - refresh `ledger-vs-candidates.tsv`;
     - re-read the production variable names and ages immediately before approval;
     - reconcile this file with AQ1.
   - **Sean:** confirmation of the replacement address and his own sign-in after the change.
5. **Next concrete action.** Noe creates the `pre-hub-release` branch in the Neon console from production and records its creation time and the project's branch-expiry setting (packet §5 step 1). It is the start of the longest blocking item, and every later rehearsal step depends on it.
