# Review of lanes A/B/D (independent architect, read-only) — saved by lead
Replay: units matrix 143, hardening 26, step-up 37, support-readonly 214, support-routes 33, support-binding 18, support-start 12, cannot-activate 18, audit-durability 17, dsar-erase-durability 4, temp-expiry 5, set-password-temp 3 — all passed. Integration both roles: operator-step-up-db 4/4, support-session-binding-db 5/5, audit-durability-db 4/4.
Mutants 7/7 killed (scratchpad/reviewABD/).
Gates: shared secret PASS; operator MFA PARTIAL (D3); support restriction PARTIAL (D1); step-up+durable audit PASS local; CSRF code PASS, browser pending; bootstrap expiry PARTIAL (D2).
D1 Medium auth.ts:926-930 resolveActiveImpersonation throw → treated as no support → operator claims restored → proxy:204 lets POST through; handler auth() re-runs jwt with original cookie and may run as TARGET owner. Fix: if support cookie present or stash, refuse on throw.
D2 Medium legacy mustChangePassword rows (incl. Sean) tempPasswordExpiresAt NULL never expire (auth.ts:466-471, set-password:101).
D3 Medium operator-auth.ts:381-393 unenrolled operator can enrol with password alone; recover creates that state.
D4 Low-Med totp/setup ignores mustChangePassword + expiry (route :22-29, :62-75).
D5 Low operator totp_enrolled + step-up rows best-effort; no operator sign-in audit.
D6 Low auth.ts:1000-1023 pre-19-Sep support token without stash keeps unbound identity.
D7 Low activation-verdict can be satisfied by operator who knows the temp password.
D8 Low operator-access.mjs audit not atomic.
D9 Functional: support needs an existing NextAuth club session in the operator browser.
Step-up missing on suspend/unsuspend, review-lock, restore, create-tenant, approve — acceptable; recommend suspend.
Rollout: Noe must have an enrolled operator row before deploy; rotate MATFLOW_ADMIN_SECRET first (rollback reopens it); D2 + privacy §6 decisions; e2e specs (#31).
