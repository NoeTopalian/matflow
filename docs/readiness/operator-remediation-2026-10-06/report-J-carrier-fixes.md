# Lane J report (saved by lead; agent write refused by hook)
1 D-I2 FIXED: create-tenant owner starts with mustChangePassword + 72 h expiry; audit names ownerUserId + ownerPasswordChosenBy; activation-verdict treats admin.tenant.create as an operator-issued credential preceding all evidence (OPERATOR_CREATE_ACTIONS), callers fetch it; dated "confirm with the owner" wording. Approve route: operator never sees/chooses the password (lead fixed the production log leak of the activation link).
2 D-I1 FIXED: support stop and clearImpersonationCookie clear with Secure + Max-Age=0 (browsers ignored the bare delete for __Secure- names). Test support-cookie-clearing (5, NODE_ENV=production).
3 LoginEvent via after() with awaited fallback (keepLoginEvent). Test login-event-after-response (3).
4 LoginEvent retention: rows not used for 365 days purged by the retention cron (dry-run aware).
5 Stale carrier treated as no session (hasAuthJsSession).
6 proxy.ts and requireSession treat a session without user.id as signed out. Test session-without-user-is-signed-out (9).
7 Suspend checks step-up after the club read (refusal no longer spends the grant). Test suspend-step-up-order (5).
8 Doc nit fixed.
9 Support swap sets target name/email, stashes/restores the operator's; userTone and Topbar tolerate a missing name. Tests support-swap-identity (4), dashboard-without-user-name (6).
Gates: unit 4155/4156 (one load-timeout flake, passes alone); tsc 0; lint 0 errors.
