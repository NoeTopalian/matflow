# Admin hub conflict workflow — final report (9 Oct 2026, loop closed)

Format per the brief of 9 Oct 2026. Evidence ledger: `LEDGER.md` (same folder). Release package: `RELEASE-PACKAGE.md`.
Lane reports, logs, screenshots and scratch tests: session scratchpad `adminhub/` (outside the repo; no addresses or
secrets in anything committed).

## Candidate SHA
`7ac814a97fe20e72493d274d37abf6521b3f1bac` (`7ac814a`, local `main`, unpushed) — documentation-only on top of
**`c837e38ad26154570e0d52f5d736d97d0a87e693`**, the last source change and the build the browser rehearsal certified
(BUILD_ID `xP9P9cHvx9xkgqHPXnOa9`). Chain: `48a9182` (wave 1) → `d405f83` (hub routes, UI, member audit hygiene,
dependencies; independently reviewed) → `d52254e` (review fixes) → two test-only commits → `c837e38` (browser-rehearsal
fixes) → `7ac814a` (docs). All on top of the earlier unpushed handover and operator-remediation commits; production still
runs `e8afb6a`.

## Implemented capabilities
1. **Login identity is one claim per club across staff and members** — `claimLoginIdentity` with a transaction-scoped
   advisory lock inside every User/Member email writer (writer-inventory test guards the list); none / one /
   inconsistent-many; legacy-duplicates report script (read-only).
2. **Operator allowlist** — `OPERATOR_ALLOWED_IDS`; production unset = nobody; checked after MFA on every operator
   read and mutation; refusals audited by id digest; a de-listed operator loses a live support session.
3. **Step-up grants v2** — bound to operator, session version, club, subject, action, canonical change and record
   version; verified before preflight, spent inside the mutation transaction with the audit row; replay of a spent
   grant returns the recorded outcome (`alreadyApplied`) on both the member and the owner step.
4. **Audit integrity** — `AuditLog.operatorId` + `requestId` (additive migration, TEST only so far); member and
   self-service audit rows written in the same transaction as the change; login addresses appear only as keyed
   digests everywhere (member PATCH, self-service, transfer-ownership, impersonate, approve, hub routes); Undo never
   restores a login address.
5. **Hub workflow** — `POST …/login-email/check` (holder across staff and members, sign-in capability decided in the
   database, no-store, digest-audited); `POST …/members/[memberId]/contact-email` (step-up, reason, version; preflight
   before spend; refuses erased and no-login records; never touches externalRef, status, credentials, memberships or
   family links); guided **Resolve conflict** sequence on the owner Login email card with honest partial state and
   resume.
6. **Member self-service address change** signs out a password-holding member (sessionVersion +1, cookie cleared,
   `signInAgain`), records `unverified`.
7. **Repaired readiness scripts** — `owner-login-change-check.mjs` (baseline/verify, stable ids, keyed comparisons,
   tenant-scoped, keyed audit digests, nonzero exit) and `release-verify.mjs` (exact SHA, health, migrations,
   mail-dark at the delivery boundary via an interceptor, legacy transports with a well-formed credential,
   authenticated operator access, whole-body JSON).
8. **Dependencies** — next 16.3.8 (pinned to the 16.3 line), undici 6.29.0, sharp 0.35.5, shadcn → devDependencies,
   lint toolchain pinned to 16.3; production audit leaves only the mysql2-via-prisma CLI chain (not applicable).
9. **Inventories and runbooks** — labels, journey J83, authz matrix, support-session inventory, `ACCOUNT-EDITING.md`
   (matrix rows, "What an email means", "Audit history"), `OWNER-LOGIN-EMAIL-CHANGE.md` ("Resolving a conflict").

## Verified evidence (all on the TEST branch, synthetic data; nothing touched production)
- Gates on `c837e38`: `npm run lint` 0 errors (66 pre-existing warnings), UI ratchets at baseline (hex 718);
  `tsc --noEmit` 0; full unit 406 files / 4870 tests; `npm run build` ok.
- Integration under BOTH database roles (owner runner and `matflow_app` with RLS): login-identity-race-db 7/7,
  login-identity-claims-db 13/13, token-scoping-db 7/7, contact-email-change-imports-db 7/7, operator-step-up-db 10/10,
  operator-hub-conflict-db 11/11, account-editing-db 14/14, owner-recovery-revocation-db 5/5, support-session-binding-db
  5/5, operator-member-totp-reset 8/8, plus the reviewer's own race test 4/4 and managed-record test 4/4.
- Red-first: every lane and every fix recorded a failing run on the prior code (ledger rows name them); mutants: 14/13
  route, 6/5 UI, 14 scripts (survivors shown equivalent).
- Independent review of `d405f83`: NOT APPROVED (D1 managed records accepted, D2 hook timeouts) → fixed → APPROVED on
  `d52254e` for D1/D2/D4/D5, with R5 reproduced on the database under both roles.
- Production-mode browser rehearsal (both roles, `EMAIL_DELIVERY=off`, interceptor positive control first, zero
  sends): every control held on the first run; G1–G3 found and fixed; targeted re-run on `c837e38` from one build —
  flows 4, 6b, 7 and release-verify all PASS under both roles; checker verify 38/38; teardown count-checked clean.
- `npm audit --omit=dev`: 2 (mysql2 high + prisma moderate, same chain, Postgres adapter — not applicable).

## Findings fixed in this loop (ledger ids)
AH-01, 01a–01d (cross-table identity), AH-02/B1–B6 (allowlist and operator plane), AH-03/03a–03c (step-up binding,
atomic spend, replay), AH-04 (hub workflow), AH-05 (imports invariant — not a defect), AH-06 (scripts), AH-08 (token
retirement + sign-out), AH-09 (dependencies), AH-C1, AH-E1, AH-E2, AH-H1–H3 (member audit hygiene), AH-R1 (D1), AH-R2
(D2), AH-R4 (D4), AH-R5 (D5), AH-R6 (swap script deleted), AH-G1–G4.

## Open findings (documented, not blocking the release)
AH-C2 (version captured at check time — operator confirms what they saw; documented), AH-D1 (attendance fallback can
match a same-name hand-added member — preview shows it), AH-D2 (tokens not subject-bound — relies on every writer
retiring; guarded), AH-R3 (writer-guard misses upsert / raw SQL / nested forms — no such writer exists), AH-R6 history
(the deleted swap script's fixed address is in already-pushed history), AH-R7 (no standalone "sign out everywhere"
operator control; ownership-transfer effects not database-tested), AH-G5 (DB-forced expiry labelled `used`), AH-G6
(owner-route body not strict; Activity "Who" attribution; /admin page edge redirect without a refusal row), AH-G7
(session-revocation check fails open on a database error — existing logged design), AH-07 (old deployments: retirement
INCOMPLETE until deleted in the dashboard), abandoned synthetic clubs on the TEST branch from earlier runs (7 `lic*`,
2 `lir*` — a purge was refused to the reviewer and not run on its behalf), production runtime database role unknown
(ACCEPTANCE-REGISTER R0-3), 65 pre-existing React-Compiler lint sites under the 16.4 lint config (deferred by pinning).

## Production changes performed
**None.** No push, no deploy, no production account or secret touched, no deployment deleted, no email sent, Sean not
contacted. Only read-only production checks earlier in the day.

## Release status
**READY FOR APPROVAL** — the candidate is verified; the push is gated on the prerequisites below (operator MFA and the
allowlist are lockouts if skipped). Sean's address correction remains a separately authorised action performed through
the hub after the release, never by a database edit.

## Exact next action from Noe
1. Sign in at `/admin/login` on the current site, enrol the authenticator at `/admin/security`, sign out and sign back in
   so a fresh sign-in is challenged for the code.
2. Set Vercel → Production `OPERATOR_ALLOWED_IDS` to your `Operator.id` (from `node scripts/operator-access.mjs list`
   against production, your run); confirm `EMAIL_DELIVERY=off` is still set; rotate `MATFLOW_ADMIN_SECRET`.
3. Tell me "push" — I push `main` (`7ac814a`), watch the six migrations in the build log, run
   `release-verify.mjs --target production` and report exit 0; then you smoke the console.
4. After that, delete the old deployments in the Vercel dashboard (retirement), then say "fix Sean's address" and I run
   the hub sequence: check → member record to the `+member` address → re-check → owner login change → checker verify.
