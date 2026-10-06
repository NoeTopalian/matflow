# Lane G report (saved by lead; agent write refused by hook)
Final build = d92435a + uncommitted diff (110 files, diff sha256 prefix cc380295218ff224), built 00:55 UTC, NODE_ENV=production, nobypass,isolated, https proxy 3952; pass 1 test role, pass 2 restricted (matflow_app seen in pg_stat_activity). Single local instance only. Evidence e2e/pre-H/ and e2e/final/.
1 Operator MFA PASS (no bootstrap tab; ticket required; wrong ticket refused; code replay 401; lockout 423 ~15 min; sign-out kills other browsers).
2 Recovery PASS (recover clears TOTP+lock, sv 3→4, audit via local-script, new ticket; old password/token/ticket refused; old authenticator 401).
3 Old secret PASS (login 403 no cookie; header/cookie 403 on activity, suspend, impersonate; console 307 → login; no audit, no change).
4 API denial PASS (unauth/owner/member on activity/suspend/impersonate/step-up refused, no side effects).
5 Step-up + reset gating PASS (transfer without code 403; reset temp shown once, 72 h; grant replay 403; cross-club grant 403; 2FA reset; expired temp message; temp → /set-password only → /login/totp/setup → enrolled → APIs 200; owner landed /onboarding — fixture, adjudicated).
6 Support FAIL authorised path: clean operator browser → impersonate 200 but /dashboard → /login (jwt() needs an Auth.js token; none minted). Restrictions PASS with a club session present: reads 200; member PATCH/DELETE, set-password, TOTP setup GET/POST, staff create, payments CSV, DSAR export, logout-all, /api/admin/activity all 403 supportReadOnly; DB unchanged; pending owner → /set-password with banner, credential calls refused; end → /admin/tenants; captured cookies after stop dead. Suspended club start 409, no cookie.
7 Deletion/restore PASS (soft-delete needs code; restore in window; purgeStartedAt → "Deletion in progress", no Restore, 409).
8 Audit failure PASS (trigger → 500 "nothing was changed", no temp password, hash/mustChange/sv unchanged; trigger dropped).
9 Activation: negative PASS (support activity → not ACTIVATED); positive BLOCKED — LoginEvent only written when NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS=true (not set in prod).
Other: suspend API accepts soft-deleted club (Low); revoke may not clear support nonce (Low); log/UI wording mismatch; runbook stale env-guard line.
Not run: multi-instance; real 30-min / 72-h expiry waits (timestamps forced); operator first enrolment under restricted role.
Cleanup: all synthetic rows removed (0 remaining), triggers gone, ports stopped, private-state scrubbed. .next holds final build.

## Re-run 2 (lane I build, diff prefix ceea52752657b318, built 01:39 UTC) — evidence e2e/final2/
- Flow 6 manager/activated-owner target in CLEAN browser: FAIL — swap works (/api/auth/session shows target) but every /dashboard page 500 (userTone(session.user.name) TypeError; swap never sets token.name/email). Restrictions all PASS both roles (reads 200; member PATCH/DELETE, set-password, TOTP GET/POST, staff create, payments CSV, DSAR export, logout-all, /api/admin/activity 403; DB unchanged). Forced expiry PASS (→ /login, session null, API 401).
- Flow 6 pending-owner via real UI button: PASS both roles (banner on /set-password; credential calls 403; End → /admin/tenants; signed out after stop; captured cookies dead).
- Suspend/unsuspend on soft-deleted club: 409 both, status unchanged — PASS.
- Flows 3, 4 regression PASS.
- Flow 9: negative PASS; operator-reset owner → "ACTIVATED AFTER OPERATOR RESET" (by design); positive control (club C, no operator reset, owner sets own password + enrols + signs in) → "ALREADY ACTIVATED … 1 owner sign-in(s)", VERDICT PASS.
- Cleanup: 0 remaining. Re-run after fix: e2e/flows-console.mjs f6 / f6expiry (fresh seed, enrol.mjs, rebuilt .next).

## Re-run 3 — FINAL (lane J build, diff prefix 6751164ea8e6b516, 119 files, built 02:19 UTC) — evidence e2e/final3/
All requested flows PASS under both roles (test role + restricted matflow_app); 0 unhandled-error lines.
- Flow 6 clean browser, manager target: start (step-up + reason) → banner → dashboard/members/timetable/settings 200, topbar shows TARGET name; all forbidden writes 403 supportReadOnly; DB unchanged; End → /admin/tenants; cookie jar has NO __Secure-authjs.session-token; /api/auth/session null; captured cookies dead.
- Flow 6 activated-owner target: PASS (after fixture fix: club seeded not onboarded → /onboarding).
- Forced expiry: PASS (→ /login, null, 401).
- Existing club session in operator browser: support works; after stop the member's OWN session (own name, no impersonatedBy) is restored.
- Pending-owner via UI: PASS; signed out after stop.
- Flow 9: negative PASS; positive (no operator reset) → ALREADY ACTIVATED, 1 LoginEvent, exit 0.
- Suspend on soft-deleted: 409 both ways; grant not spent (same grant then suspends after restore).
- Flows 3, 4 regression PASS.
Not run: multi-instance; real 30-min wait. Cleanup 0 remaining.
(Lead note: magic-link LoginEvent + retention comment edits landed after this build; covered by unit tests and the final lead build.)
