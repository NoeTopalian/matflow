# Account-editing browser E2E (production mode, test branch, EMAIL_DELIVERY=off, both roles) — saved by lead
Build: HEAD 30c255b + diff 7676814d60409727 (22 files, 22:06 UTC 8 Oct; includes staff audit-in-tx + undo fix).
A1 own name: PASS normal; restricted FAIL A1.3 only (stale topbar name after immediate reload — display race; DB correct) → FIXED 4c1825c (per-request name refresh); re-run requested.
A2 password change PASS both (reused/wrong code, wrong password, weak+wrong code → generic refusal; valid → all devices signed out; old fails; new + code works).
A3 login-email change PASS both (member collision 409; change + rollback).
A4 manager/coach PASS both (My account nav; profile + password; 403 on staff PATCH; manager Settings → /dashboard?denied=1). Coach Settings: server returns redirect to /dashboard?denied=1; browser then ERR_TOO_MANY_RETRIES via the TLS proxy; direct /dashboard?denied=1 loads → harness artefact (source: single redirect, lib/authz.ts:47).
A5 cross-tenant PASS both. A6 operator name correction PASS both (wrong-action grant 403; audit names operator). A7 owner edits staff PASS both (member collision 409; provisional + signed out + old refused; name-only keeps session). A8 pre-activation path PASS both (zero tokens, zero EmailLog). A9 daily use PASS both (class create/edit, 8 instances, check-in, member profile, payments CSV BOM + header, reports CSV BOM + header).
Logs: zero Resend calls, zero unhandled errors, zero DB timeouts. Cleanup 0 left.

## Re-check on 4c1825c (diff d59de1543cb28e26, 23:26 UTC 8 Oct)
A1 PASS 3/3 normal + 3/3 restricted: save → immediate reload shows the new name; a second already-signed-in device shows it on its next page load; DB matches. Coach Settings refusal PASS on plain http (no proxy) and through the proxy → lands on /dashboard?denied=1; earlier ERR_TOO_MANY_RETRIES not reproduced. 0 unhandled errors, 0 Resend calls; cleanup 0 left.
