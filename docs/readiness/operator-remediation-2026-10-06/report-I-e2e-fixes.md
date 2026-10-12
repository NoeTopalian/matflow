# Lane I report (saved by lead; agent write refused by hook)
1 Clean-browser support FIXED: impersonate POST mints an identity-less carrier Auth.js JWT ({supportCarrier:true}, 30 min, same cookie name/secure/salt as set-password) only when no club session exists; auth.ts returns null for a carrier whenever support is not live (stop, expiry, binding failure, resolver error, carrier alone). Tests support-carrier-jwt (12; 7 red first), support-carrier-start (5; 3 red first).
2 Activation evidence FIXED: lib/login-event.ts always writes/updates LoginEvent; only the email depends on NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS. activation-verdict accepts the owner's own user.password.set_own / auth.totp.enrolled rows (no actingAs, userId = owner) when no LoginEvent exists; support and D7 checks run first. Tests login-event-always-recorded (7; 4 red), activation-verdict-own-evidence (14).
3 Suspend/unsuspend refuse a soft-deleted club (409; conditional updates include deletedAt: null). Test suspend-soft-deleted-club (4; 3 red).
4 revoke already clears support + step-up nonces — NOT A DEFECT; pinned in operator-access-script.
5 Expired-temp-password wording aligned (auth.ts; set-password aligned by lead).
6 Runbook: env-guards text fixed; support-session section added.
Gates: unit 370 files / 4108 passed; tsc 0; lint pass.
