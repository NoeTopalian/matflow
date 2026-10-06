# Operator / admin security audit — 5 Oct 2026

Code audited **as deployed: `e8afb6a`** (Vercel Production, 2026-10-04T02:34Z). Local `main` is two commits ahead
(`64c2657`, `8fb151a`, unpushed); neither touches admin or auth code (`git diff e8afb6a..HEAD --stat`).

Method: three independent code audits (read-only), new unit tests with mocks, integration suites run against the
Neon **test** branch (`ep-hidden-salad`) only. **No production database, HTTP, Vercel, Neon or GitHub settings were
touched.** No production code was changed.

New tests (all pass; "GAP" / "CURRENT BEHAVIOUR (open finding)" tests pin today's unsafe behaviour and must be
flipped, not deleted, when the fix lands):

| File | Tests |
|---|---|
| `tests/unit/operator-endpoint-authz-matrix.test.ts` | 127 |
| `tests/unit/operator-console-xss.test.tsx` | 7 |
| `tests/unit/impersonation-cannot-activate.test.ts` | 11 |
| `tests/unit/operator-audit-durability.test.ts` | 9 |
| `tests/unit/tenant-lifecycle-constraints.test.ts` | 13 |
| **Together** | `Test Files  5 passed (5)` / `Tests  167 passed (167)`; ESLint clean |

---

## Q1. Can `MATFLOW_ADMIN_SECRET` still grant production admin access without named operator MFA? — **YES**

Accepted paths (`isAdminAuthed`, `lib/admin-auth.ts:107-111`):

| Path | How obtained | Expiry | Revocation | MFA / identity |
|---|---|---|---|---|
| `x-admin-secret` header | the raw secret | none | rotate the secret | none; anonymous. On by default (`ALLOW_ADMIN_SECRET_HEADER` defaults open, `:61-65`). No lockout |
| `matflow_admin` cookie | `POST /api/admin/auth/login` with the secret | 8h browser Max-Age (`:26`), **not enforced server-side** | rotate the secret only — the cookie value **is** the raw secret (`login/route.ts:17,36,46`) | none; login not audited |
| `matflow_op_session` | named operator login | 8h, HMAC (`lib/operator-auth.ts:31,50-95`) | operator `sessionVersion` | TOTP **optional** per operator (`operator-login/route.ts:58-70`) |
| `matflow_op_challenge` | step between password and TOTP | short-lived challenge | — | — |
| `matflow_impersonation` | operator starts impersonation | 60 min fixed (`lib/impersonation.ts:28`) | DELETE impersonate, expiry, target `sessionVersion` bump | inherits whatever got the operator in |

- **ISSUE High:** the secret alone gives full production operator power, including impersonating an owner past their own MFA, with no named actor in the audit (`__matflow_super_admin__`). A copied cookie stays valid until the secret is rotated.
- **ISSUE Medium:** operator TOTP is optional; `Operator.role` is stored but not enforced.
- **ISSUE Low:** `operator-totp/setup` has no `assertSameOrigin` (`:64,97-104`); logout does not revoke server-side.
- **Fix:** refuse the header and the `matflow_admin` cookie when `NODE_ENV=production` (or set `ALLOW_ADMIN_SECRET_HEADER=0` and retire the cookie login); require TOTP at operator login.

## Q2. Does every privileged API and server action enforce operator authorisation itself? — **YES (APIs); no server actions exist for admin**

- `proxy.ts:29` lists `/api/admin` as a public prefix, so every route must self-enforce. All 14 operator routes call `isAdminAuthed` / operator-session checks themselves.
- `operator-endpoint-authz-matrix.test.ts` enumerates `app/api/admin/**` from disk and asserts **unauthenticated, owner, manager, coach and member** callers are refused on every method; positive controls for the bootstrap cookie, header and operator session; revoked operator `sessionVersion` refused. 127 passed.
- Note: several `app/api/admin/*` paths (import, DSAR) are **owner** routes, not operator routes — their gate is `requireApiRole`, covered by the same matrix as owner-allowed.

## Q3. What can an impersonation session do? — **Almost everything an owner can. No server check reads `impersonatedBy`.**

`auth.ts:943-952` forces `totpPending=false`, `requireTotpSetup=false`, `totpEnabled=true`, `mustChangePassword=false`.
Only readers of `impersonatedBy`: the banner, `lib/audit-log.ts:57`, the impersonate route.

| Action | Result |
|---|---|
| Set password (`auth/set-password`) on a pending owner | **ALLOWED** (`:57,63,91`) |
| Enrol TOTP (`totp/setup` GET+POST) | **ALLOWED**, refused only if already enrolled |
| Recovery codes | needs a live code — allowed if the operator enrolled the factor |
| Disable 2FA | refused |
| Transfer ownership | needs the owner password — allowed if the operator set it |
| Add staff with a chosen password / reset staff passwords | **ALLOWED — lasting access** (`staff/route.ts:68`, `staff/[id]` PATCH) |
| DSAR export / erase, import rollback, payments CSV, attendance export | **ALLOWED** |
| Member invite links | **ALLOWED** |
| Change owner email, API tokens, magic links | not possible / do not exist / emailed only |

- **ISSUE High (Q3-1).** Fix: one helper in `lib/api-authz.ts` refusing sessions with `impersonatedBy`, called by set-password, totp/setup, recovery-codes, staff POST/PATCH, both transfer-ownership routes, dsar/erase.
- UNVERIFIED (code reading only): the impersonation cookie outlives a target `sessionVersion` bump and could re-enter on a fresh sign-in within 60 min.

## Q4. Can impersonation falsely count as Sean's activation? — **YES**

| Signal | Result |
|---|---|
| `mustChangePassword` cleared | **ISSUE High** — set-password under impersonation; audit row `user.password.set_own` with `userId=Sean`, operator only in `metadata.actingAs` |
| TOTP enrolled | **ISSUE High** — no audit row written at all |
| LoginEvent / last login | **VERIFIED not written** (only real sign-in calls `recordLoginEvent`, `auth.ts:470,530,765`) |
| Consent / terms | no owner terms model; supervised waiver signed while impersonating is stored as `admin_device:<Sean>` — **ISSUE Medium** |
| Readiness scripts | **ISSUE High** — `owner-account-state.mjs:149` says ALREADY ACTIVATED on `totpEnabled && !mustChangePassword`, which impersonation can produce |

Fix: Q3-1 helper closes the first two; the script must also require `loginEvents > 0` and no `actingAs` on the owner's password/TOTP rows.
**Operational rule until fixed: do not impersonate Sean before he has activated, and treat "ACTIVATED" as true only with a real LoginEvent and Sean's confirmation.**

## Q5. Can password reset + MFA reset become an account-takeover path? — **YES; the operator is the trust boundary**

- **Operator re-authentication:** none at the moment of action. Reset needs a reason (≥5 chars); 2FA reset / transfer need the gym name typed (public). Secret header bypasses operator MFA entirely.
- **Customer identity verification:** none in the product; out of band.
- **Bootstrap expiry:** **none** — temporary password does not expire. Operator sees it once in the response (`force-password-reset:110`).
- **Revocation:** password reset bumps `sessionVersion` (kills all JWTs incl. impersonated), does not touch TOTP/recovery codes; magic links refused while `mustChangePassword`; reset links have 2-min TTL. 2FA reset clears factor, secret and recovery codes and bumps `sessionVersion`. Transfer bumps both users.
- **ISSUE Medium:** no email to the owner on reset, 2FA reset or impersonation start.
- **Fix:** gate secret off (Q1); require operator TOTP for Danger Zone and impersonation; notify the owner's address; add an expiry to the temporary password.

## Q6. Are admin actions protected against CSRF and stored XSS? — **YES, with Low gaps**

- CSRF: state-changing admin routes use `assertSameOrigin`; cookies SameSite. Gaps (Low): `operator-totp/setup` lacks the check; `tests/unit/csrf-coverage.test.ts:87,129-140` allow-lists some routes.
- XSS: **tested cases passed** (wording corrected 6 Oct 2026: tests cannot rule out all XSS, so this is not "VERIFIED"). What `tests/unit/operator-console-xss.test.tsx` covers (7 tests, jsdom):
  - Payloads: `<img src=x onerror=alert(1)>`, `"><script>alert(1)</script>`, `javascript:alert(1)`, `<svg onload=alert(1)>`. A detector self-test proves the check fails on a real injection.
  - Sinks and inputs: **ActivityFeed** (`app/admin/activity`) — club name and slug, actor email and name, action, entity type and id, IP, and the expanded metadata view (`name`, `url`, `html`); **TenantsList** — club name, slug, owner email and name; **ApplicationsClient** — public apply-form fields (gym name, contact name, email in a `mailto:` link, phone, discipline, member count, notes); **tenant detail page** (server component with DangerZone and Login-as-owner) — club name, slug, owner email and name.
  - Assertion per view: the payload is visible as text, and the DOM has no script/iframe/object/embed, no `on*` attribute, no `<img src=x>`, and no `javascript:`/`data:`/`vbscript:` URL in `href`/`src`/`action`/`formaction`.
  - Static guard over every file under `app/admin`: no `dangerouslySetInnerHTML`, `innerHTML` or `document.write`; every data-built `href` starts with a fixed in-app path or fixed scheme.
  - Not covered by these tests: the tenant dashboard and member portal, import previews and import error lists, server error messages, emails, PDF/CSV contents (CSV exports carry the formula guard, tested elsewhere), browser-level workflows and cache controls. Benign stored-input fixtures across those surfaces and an authenticated browser run are still owed (Workstream D).

## Q7. Which database roles does production actually use? — **UNVERIFIED for runtime**

| Path | Connection | Role |
|---|---|---|
| Tenant requests (`withTenantContext`) | `DATABASE_URL` singleton (`lib/prisma.ts:21,79`) | **UNVERIFIED** — docs assume BYPASSRLS |
| Operator requests and crons (`withRlsBypass`) | same `DATABASE_URL` | same, unverified |
| Maintenance scripts | local `.env` | `neondb_owner`, BYPASSRLS (verified 4 Oct) |

- If runtime is `neondb_owner`, **RLS is not a backstop** — app-level `where: { tenantId }` is the only isolation.
- Pooled connections: **VERIFIED safe** — every GUC write is `set_config(..., true)` inside a transaction; no session-level `SET`.
- Storage: **VERIFIED** tenant-prefixed private blobs; `/api/blob-image` enforces prefix + member ownership.
- Exports: **VERIFIED** tenant-scoped (payments CSV, DSAR, exceptions CSV, attendance ledger).
- Test-branch suites: tenant-isolation 2/2, cross-tenant-authorisation-matrix 5 passed **+ 9 todo (untested)**, cross-tenant-stats 3/3, rls-coverage 1/1, rls-foundation 3 passed + 6 skipped as `neondb_owner` and **9/9 as restricted `matflow_app`** (RLS enforces when the role does not bypass). roster-cross-tenant: 3 todo — **not a pass**.
- **Action (Noe):** confirm which role the Vercel production `DATABASE_URL` uses.

## Q8. Do suspension, review mode and deletion constrain sessions and jobs? — **PARTLY**

- **VERIFIED:** suspend and soft-delete bump every User and Member `sessionVersion` in the same transaction; kiosk and leaderboard tokens refuse suspended/deleted clubs; crons skip them; review mode refuses money movement, bulk invite, erase and deletion with 423.
- **ISSUE Medium — restore-vs-purge race:** purge runs as ~12 transactions without re-reading `deletedAt` and ends with an unconditional delete; restore is unconditional. Fix: conditional `updateMany` / `deleteMany` with count checks and a `stillDue()` check per step.
- **ISSUE Medium — reactivation leaves billing broken:** un-suspend sets `active` regardless of prior status and never reverses period-end cancellations.
- **ISSUE Low–Medium:** impersonation ignores club status.
- **ISSUE Low:** tenant status is only checked at sign-in (sub-second race); Stripe webhooks still email members of suspended clubs; failed Stripe cancels don't stop the suspension.

## Q9. Can a sensitive action succeed without a durable audit record? — **YES**

- `logAudit` is fire-and-forget (`void write(data)`, `lib/audit-log.ts:128`), never in the action's transaction, failures become `console.warn`.
- **ISSUE High:** DSAR erase's "refuse to erase if the audit write fails" catch is unreachable.
- **ISSUE Medium:** reset hands out the temporary password and impersonation starts even when the audit insert fails.
- Attribution: operator session → real `Operator.id` (**VERIFIED**); secret → anonymous sentinel, cookie path without `via` (**Low**); impersonated actions carry `actingAs`, except TOTP enrolment (no row).
- Alteration: no app route edits or deletes audit rows; but the retention cron deletes **all** rows > 365 days, including `admin.*` and `member.dsar_erase` (**Low/Medium**); DB policy does not enforce append-only (Low).
- Secrets: **VERIFIED** the temporary password, tokens and recovery codes are not logged; DSAR emails hashed.
- **Fix:** `logAuditStrict(tx, …)` inside the route's own transaction for Danger Zone, impersonation, DSAR and rollback; exempt `admin.*` / `member.dsar_erase` from retention.

## Q10. What is independently verified on the deployed build today?

- **Deployed SHA:** `e8afb6a` (Production, 2026-10-04T02:34Z). Local `64c2657`, `8fb151a` unpushed.
- **Verified here:** the code-level answers above, 167 new tests, 102 existing related tests (9 files), test-branch isolation suites listed in Q7.
- **Not run / skipped:** nothing was executed against production; runtime DB role unverified; 9 + 3 cross-tenant cases are `todo`; 6 RLS checks skip under `neondb_owner`; no browser/E2E run of the operator console.
- **Backups:** `db-backup.yml` latest runs all **failed** (2026-10-04, 2026-09-27, 2026-09-20); `gh secret list` count **0**. Neon PITR window **UNVERIFIED**.
- **Isolated restore evidence:** **none.** `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` exists; it has never been executed.

## Unresolved findings, ranked

| # | Severity | Finding | Smallest fix |
|---|---|---|---|
| 1 | High | Shared secret = full anonymous production operator power, no MFA | Refuse secret header/cookie in production; require operator TOTP |
| 2 | High | Impersonation can set passwords, enrol TOTP, create staff | `refuseImpersonation()` helper on credential/access routes |
| 3 | High | Impersonation can fake Sean's activation; readiness script fooled | Fix 2 + script requires LoginEvent and no `actingAs` |
| 4 | High | DSAR erase audit guard unreachable; audit is best-effort | `logAuditStrict` in-transaction |
| 5 | Medium | Restore-vs-purge race | Conditional writes with count checks |
| 6 | Medium | Un-suspend leaves member subscriptions cancelling | Record + reverse cancellations |
| 7 | Medium | No owner notification on reset / 2FA reset / impersonation | Email the owner |
| 8 | Medium | Temporary password never expires | Deadline on `mustChangePassword` |
| 9 | Medium | Waiver signed under impersonation attributed to owner | Add operator to `collectedBy` |
| 10 | Medium | Runtime DB role unverified; RLS likely inert | Confirm Vercel `DATABASE_URL` role |
| 11 | Low/Med | Retention deletes admin + erase audit rows | Exempt from retention |
| 12 | Low | Impersonation ignores club status; status not re-checked per request; webhook emails to suspended clubs; operator TOTP setup CSRF; secret-cookie audit lacks `via` | as per sections |

---

## Remediation register (6 Oct 2026)

The answers above describe the deployed build `e8afb6a` and **remain true in production until the remediation is
deployed**. Nothing below is live. Status vocabulary: CONFIRMED (seen in source/test) · FIXED LOCALLY · INDEPENDENTLY
VERIFIED (a different agent replayed tests, mutation-checked guards, and/or a production-mode browser run passed) ·
DEPLOYED VERIFIED (none yet) · UNVERIFIED/BLOCKED.

**Tested candidate:** `d92435a` + the remediation commit (§ deploy package). Environment: unit tests (379 files, 4,160 tests,
all pass), integration tests on the Neon **test** branch under both the owner role and the restricted `matflow_app` role,
and a production build (`NODE_ENV=production`, bypasses off, outbound providers disabled, HTTPS) driven in a real browser
against the test branch. Single local instance only. Deploy package: `OPERATOR-REMEDIATION-DEPLOY-PACKAGE.md`.

### Gates

| Gate | Verdict (local) |
|---|---|
| No unmitigated confirmed critical/high in scope (incl. bootstrap expiry, suspend provider defect) | **MET locally**, except recovery (below) |
| Shared secret rejected; named-operator MFA mandatory; recovery/enrolment no bypass | **MET** — secret refused in production (header, cookie, login); MFA-only session key; enrolment needs a one-time ticket from the local access script; browser-verified |
| Support authority restricted on every downstream path; no activation/credential takeover | **MET** — read-only support (174 handlers inventoried; central proxy block + in-route guards), bound to the operator's MFA session, 30 min, step-up + reason, tenant admission; browser-verified incl. clean browser, stop, expiry, captured-cookie replay |
| High-impact actions need step-up and durable audit | **MET** — single-use step-up bound to operator/action/target on reset, 2FA reset, member 2FA reset, transfer, soft-delete, suspend, support start; audit rows commit with the change or the action is refused (injected-failure tests + browser trigger test) |
| Restore/purge race fixed | **MET** — row-locked conditional transitions; deterministic barrier tests both orderings, both roles |
| Runtime tenant isolation established; real cross-tenant tests passing | **PARTLY** — 12 placeholder tests now real and passing under both roles (they found and fixed 3 cross-tenant bugs); **production runtime role UNVERIFIED** |
| Missing CSRF control fixed; admin browser workflows verified | **MET** |
| Working backup + isolated restore, or explicit blocker + containment | **NOT MET — BACKUP UNVERIFIED.** Workflow fixed (PostgreSQL 17 client, integrity check) but never run; 0/5 secrets; Neon PITR window unverified; no restore executed. Blocker owned by Noe; runbooks ready. |

**Verdicts kept separate:** ACTIVITY/ACTIVATION — Sean has not activated; nothing here touched his account; after deploy
his outstanding temporary password expires 20 Oct 2026 23:59 UTC (Noe's decision to keep or change). SECURITY/RECOVERY —
fixed locally and independently verified; **not deployed**; recovery unverified.

### Findings

| # | Finding | Sev | Status |
|---|---|---|---|
| Q1 | Shared secret = anonymous full operator power in production | High | INDEPENDENTLY VERIFIED |
| Q1 | Operator MFA optional; password-only enrolment of unenrolled operators | High (privileged) | INDEPENDENTLY VERIFIED |
| Q1 | Operator TOTP setup without same-origin check | Low | INDEPENDENTLY VERIFIED (browser) |
| Q3 | Support/impersonation unrestricted (credentials, staff, exports, destructive) | High | INDEPENDENTLY VERIFIED |
| Q3 | Support cookie not bound to operator session; ignores club status; fail-open on DB error | Medium | INDEPENDENTLY VERIFIED |
| Q4 | Support could fake owner activation; readiness script fooled; operator-created/reset accounts counted as self-activated | High | INDEPENDENTLY VERIFIED (verdict now requires the owner's own evidence and flags any operator-issued credential: "confirm with the owner") |
| Q4 | Sign-in records only written with a notifications flag that production lacks | High (for the verdict) | INDEPENDENTLY VERIFIED |
| Q4 | Waiver signed under support attributed to owner | Medium | FIXED LOCALLY (refused) |
| Q5 | No step-up for resets, transfer, deletion, suspend, support start | Medium | INDEPENDENTLY VERIFIED |
| Q5 | Temporary passwords never expire (incl. legacy rows) | Medium | INDEPENDENTLY VERIFIED — 72 h; legacy deadline 20 Oct 2026 (Noe's decision) |
| Q5 | No owner notification on reset / 2FA reset / support start | Medium | **OPEN** — not in this remediation |
| Q6 | XSS verdict over-claimed | wording | FIXED — now "tested cases passed" |
| Q7 | Runtime DB role unknown (likely BYPASSRLS) | High if so | **UNVERIFIED/BLOCKED** — `docs/runbooks/RUNTIME-DB-ROLE-CHECK.md` |
| Q7 | Classes dry-run leaked another club's subscriber ids; cross-club belt/coach links; belt-holder count | High/Med/Low | INDEPENDENTLY VERIFIED |
| Q8 | Restore-versus-purge race | High (data loss) | INDEPENDENTLY VERIFIED |
| Q8 | Un-suspend forced `active`; suspension cancelled member billing | Medium | INDEPENDENTLY VERIFIED (policy: suspension no longer touches member billing) |
| Q9 | Audit best-effort; DSAR erase guard unreachable | High | INDEPENDENTLY VERIFIED |
| Q9 | Missing/unattributed audit rows (TOTP enrolment, operator sign-in, step-up) | Med/Low | INDEPENDENTLY VERIFIED |
| Q9 | Retention deleted operator and erasure evidence | Policy | FIXED LOCALLY — kept 6 years; privacy page §6 must be updated (Noe) |
| Q10 | Backups failing; workflow would fail even with secrets (pg 16 vs 17) | High | CHANGED, NEVER RUN — BACKUP UNVERIFIED |
| — | Credentials could reach Sentry (request body, step-up/ticket headers) | Low | FIXED LOCALLY |
| — | Approve route logged a live owner sign-in link when mail unset | Low-Med | FIXED LOCALLY |
| — | Repo Playwright specs assume the old shared-secret / writable-support contract | test debt | **OPEN** |
| — | Webhook emails to members of suspended clubs; club status checked only at sign-in | Low | **OPEN** |

Full working register (53 rows, with evidence paths) and every lane report, independent review and browser ledger are in
the session scratchpad (`remediation/`), not in the repository.
