# Release package — admin hub conflict workflow + operator controls (9 Oct 2026)

**Status: PREPARED, NOT DEPLOYED, NOT AUTHORISED.** Production runs `e8afb6a` (4 Oct). Nothing in this package has
been run against production except read-only checks. Deploying is Noe's decision; this file is what that decision
needs. Candidate SHA: filled in at the end of the loop (§8).

## 1. What ships (on top of the already-local operator remediation + handover + account-editing commits)
| Item | Detail |
|---|---|
| Operator allowlist | `OPERATOR_ALLOWED_IDS` (comma-separated `Operator.id`s). **Production with the variable unset or empty admits nobody.** Checked on every operator read/mutation after MFA; refusals audited (`admin.operator.refused`, id digest only). |
| Step-up grants v2 | Bound to operator, session version, tenant, subject, action, canonical change and record version; spent inside the mutation transaction with the audit row; replay echoes the recorded result. Grants minted by the old build are refused after deploy (enter a new code). |
| Audit columns | `AuditLog.operatorId` (FK Operator, SET NULL), `AuditLog.requestId`, index `(tenantId, requestId)` — migration `20261009010000_audit_operator_request`, additive and nullable. |
| Identity claims | Cross-table login-identity claim (`claimLoginIdentity`, transaction-scoped advisory lock) in every User/Member email writer; a member address change retires that address's sign-in tokens in that club. |
| Hub workflow | Check address; member contact-email change (step-up, reason, audited); guided Resolve-conflict sequence on the owner Login email card. |
| Operator plane | `private, no-store` on every `/api/admin/*` and `/admin/*` response; a de-listed operator loses a live support session on the next request. |
| Scripts | `scripts/readiness/owner-login-change-check.mjs`, `scripts/readiness/release-verify.mjs` (machine-enforced; nonzero exit on any failure). |
| Dependencies | `npm audit fix` (non-breaking): `next` ≥ 16.3.8, `undici`, `sharp`, `source-map-js`, `brace-expansion`; `shadcn` moved to devDependencies. See LEDGER AH-09. |

Migrations applied by the build (`scripts/maybe-migrate.mjs`), all additive/nullable, in order:
`20261006010000_operator_auth_hardening`, `20261006020000_tenant_lifecycle_safety`, `20261006040000_support_session_binding`,
`20261006050000_operator_enrolment_ticket`, `20261007010000_login_email_provisional`, `20261009010000_audit_operator_request`.
The old build tolerates every one of them (rehearsed on the test branch for the first four; the last two are the same
shape). The NEW build requires them: it writes `AuditLog.operatorId/requestId` and `User.loginEmailProvisionalSince`.

## 2. Prerequisites — Noe, in this order (each is a lockout or exposure if skipped)
1. **Operator authenticator enrolled and proven**: sign in at `/admin/login` (Account tab) on the CURRENT site, enrol at
   `/admin/security`, sign out, sign back in and be challenged for the code. Read-only confirmation: production
   `Operator.totpEnabled = true` (lead runs the precheck). Without this the new build locks the console.
2. **`OPERATOR_ALLOWED_IDS`** = Noe's `Operator.id` set in Vercel → Production. The id comes from
   `scripts/operator-access.mjs list` run against production by Noe (operator task; never printed by the lead).
   Without this the new build admits no operator at all.
3. **`EMAIL_DELIVERY=off`** is already set in Vercel Production (non-sensitive, read back as `off` on 9 Oct). It is
   verified at the delivery boundary on the production-mode TEST server with the interceptor (positive control first)
   before the push; after the push the tenant lookup must report `emailDelivery: "off"` and every EmailLog row written
   must be `suppressed`.
4. **Rotate `MATFLOW_ADMIN_SECRET`** to an unknown random value. Rotation does not reach old builds (they keep the
   environment they were built with); it only guarantees that any FRESH build of old code cannot be opened with a
   known value.
5. **Retention dry-run** (read-only): 0 soft-deleted clubs on 9 Oct → nothing would be purged; re-check on the day.
6. **Historical deployments** (see §5): keep the current deployment until the new one is verified; delete the others
   from the dashboard afterwards (the bulk deletion was refused by the lead's permission layer and is not retried).

## 3. Deployment order
1. Prerequisites 1–5 complete and recorded.
2. `git push origin main` from the checkout containing the candidate commits (the push and the resulting deploy are
   Noe's authorised action; the lead does not push without a fresh instruction).
3. Build applies the migrations before `next build`; watch the build log for the six migration names.
4. Post-release checks (§4). Only then: smoke the operator console as Noe (allowlisted, MFA), and only then any
   separately authorised account correction through the hub (§6).

## 4. Post-release checks (machine-enforced)
`node scripts/readiness/release-verify.mjs --target production --sha <candidate 40-hex> --base-url https://matflow.studio
--tenant totalbjj --env-file-for-migrations .env --expect-host ep-bold-wave-abt39t7x --expect-migrations local
--expect-operator-login --operator-session-file <private>` must exit 0:
exact production SHA; `/api/health` = `{status:"ok",db:"ok"}`; every expected migration finished and not rolled back;
`emailDelivery: "off"`; legacy transports (header, cookie, login POST) answer the application's 401/403 JSON to a
well-formed credential (redirect / edge wall / 500 / 429 = INCONCLUSIVE = fail); an authenticated operator request
succeeds. Statement of what the legacy check proves on production: **the transport is closed**, not that any specific
old value is invalid (the old value is never used).

## 5. Historical deployment status (read-only inventory, 9 Oct)
Project protection: SSO for all deployments except custom domains; no password protection, trusted IPs, bypass tokens
or OPTIONS allowlist. Production aliases: `matflow.studio` (custom, public), `matflow-nine.vercel.app`,
`matflow-noetopalians-projects.vercel.app`, `matflow-git-main-noetopalians-projects.vercel.app` (vercel.app → SSO).
64 production deployments (62 READY, 2 ERROR), 0 preview deployments. States kept separate: **serving** — the current
deployment only; **protected, observed** — 2 sampled old URLs (302 → vercel.com/sso-api); **protected by the same
project setting, not individually tested** — the other 61; **deleted** — 2 (oldest). Retirement: INCOMPLETE until Noe
deletes the old deployments. Old builds retain their original configuration (old secret, email on, no allowlist).

## 6. The separately authorised account correction (listed, not performed)
Baseline with `owner-login-change-check.mjs baseline` (private expect-email file outside the repo) → hub: Check address
→ member contact-email change (step-up, reason) → re-check → owner login change (second step-up) → `owner-login-change-
check.mjs verify --path operator` exit 0 (same ids; password, authenticator and recovery codes unchanged; sessionVersion
+1 exactly; audit rows with operatorId/requestId; no live tokens for either original address; no raw address anywhere).
Sean then signs in once with the new address, his own password and his authenticator. Nobody asks him for either.

## 7. Rollback constraints
Never Instant Rollback or Promote (restores the old environment and the old shared secret). Fix forward. If older code
must run: rebuild it fresh (so it reads the rotated secret and `EMAIL_DELIVERY=off`), and revoke the Resend API key at
Resend first if the code predates the mail-dark release; the migrations stay (additive; old code ignores them). While
old code runs: no Danger Zone actions, no support sessions, no restores of soft-deleted clubs (see the operator
remediation package §6 for the full reopened-doors table).

## 8. Candidate identity, gates and coverage
Filled in at the end of the loop: candidate SHA; lint / tsc / full unit / build summaries; integration files run under
both database roles; production-mode browser run build identity; independent review verdict; `npm audit` after fixes;
matrix items not demonstrated.
