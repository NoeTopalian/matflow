| file | sites (line) | class | target |
|---|---|---|---|
| app/admin/billing/page.tsx | 1 (L26) | a | operator console page -> ops client |
| app/admin/page.tsx | 3 (L45, L67, L126) | a | operator console page -> ops client |
| app/admin/tenants/[id]/page.tsx | 1 (L29) | a | operator console page -> ops client |
| app/admin/tenants/page.tsx | 1 (L29) | a | operator console page -> ops client |
| app/api/account/pending-tenant/route.ts | 1 (L47) | b | tenant_id_by_slug |
| app/api/admin/activity/route.ts | 1 (L35) | a | operator API -> ops client |
| app/api/admin/applications/[id]/approve/route.ts | 4 (L80, L93, L106, L163) | a | operator API -> ops client |
| app/api/admin/applications/[id]/reject/route.ts | 2 (L53, L60) | a | operator API -> ops client |
| app/api/admin/applications/route.ts | 1 (L25) | a | operator API -> ops client |
| app/api/admin/auth/operator-totp/setup/route.ts | 1 (L217) | a | operator API -> ops client |
| app/api/admin/create-tenant/route.ts | 1 (L85) | a | operator API -> ops client |
| app/api/admin/customers/[id]/force-password-reset/route.ts | 3 (L72, L75, L107) | a | operator API -> ops client |
| app/api/admin/customers/[id]/login-email/check/route.ts | 1 (L89) | a | operator API -> ops client |
| app/api/admin/customers/[id]/login-email/route.ts | 3 (L68, L109, L149) | a | operator API -> ops client |
| app/api/admin/customers/[id]/member-totp-reset/route.ts | 3 (L72, L80, L99) | a | operator API -> ops client |
| app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts | 3 (L122, L158, L196) | a | operator API -> ops client |
| app/api/admin/customers/[id]/owner-profile/route.ts | 2 (L89, L110) | a | operator API -> ops client |
| app/api/admin/customers/[id]/review-lock/route.ts | 4 (L54, L63, L91, L99) | a | operator API -> ops client |
| app/api/admin/customers/[id]/revoke-access/route.ts | 2 (L114, L138) | a | operator API -> ops client |
| app/api/admin/customers/[id]/soft-delete/route.ts | 5 (L71, L105, L151, L190, L276) | a | operator API -> ops client |
| app/api/admin/customers/[id]/suspend/route.ts | 6 (L83, L128, L226, L255, L288, L307) | a | operator API -> ops client |
| app/api/admin/customers/[id]/totp-reset/route.ts | 3 (L63, L69, L89) | a | operator API -> ops client |
| app/api/admin/customers/[id]/transfer-ownership/route.ts | 3 (L51, L86, L117) | a | operator API -> ops client |
| app/api/admin/impersonate/route.ts | 2 (L156, L211) | a | operator API -> ops client |
| app/api/apply/route.ts | 1 (L53) | e | GymApplication has no RLS; drop the wrapper, runtime client keeps INSERT |
| app/api/auth/disown-login/[token]/route.ts | 1 (L112) | c | token format change: sign tenantId into the disown token (7-day TTL); no resolver exists for LoginEvent.id |
| app/api/auth/forgot-password/route.ts | 1 (L42) | b | tenant_id_by_slug |
| app/api/auth/reset-password/route.ts | 1 (L78) | b | tenant_id_by_slug |
| app/api/auth/totp/recover/route.ts | 1 (L66) | b | tenant_id_by_slug |
| app/api/cron/class-instances/route.ts | 1 (L110) | a | cron -> ops client |
| app/api/cron/monthly-reports/route.ts | 1 (L58) | a | cron -> ops client |
| app/api/cron/retention/route.ts | 10 (L304, L324, L329, L356, L367, L382, L419, L422, L431, L454) | a | cron -> ops client |
| app/api/kiosk/[token]/checkin/route.ts | 1 (L60) | b | tenant_id_by_kiosk_token_hash |
| app/api/kiosk/[token]/classes/route.ts | 1 (L36) | b | tenant_id_by_kiosk_token_hash |
| app/api/kiosk/[token]/members/route.ts | 1 (L51) | b | tenant_id_by_kiosk_token_hash |
| app/api/magic-link/request/route.ts | 1 (L32) | b | tenant_id_by_slug |
| app/api/magic-link/verify/route.ts | 1 (L44) | b | tenant_id_by_magic_link_hash |
| app/api/magic-link/verify/route.ts | 1 (L72) | c | tenant from the preflight resolver; consume inside its signed context |
| app/api/member/totp/recover/route.ts | 1 (L78) | b | tenant_id_by_slug |
| app/api/members/accept-invite/route.ts | 1 (L104) | b | tenant_id_by_magic_link_hash |
| app/api/members/accept-invite/route.ts | 1 (L117) | c | tokenRow.tenantId |
| app/api/stripe/webhook/route.ts | 1 (L137) | b | tenant_id_by_stripe_account INSIDE the claim transaction, then sign mid-transaction (new helper) |
| app/api/tenant/[slug]/route.ts | 1 (L56) | b | tenant_id_by_slug |
| app/api/waiver/kiosk-request/route.ts | 1 (L47) | b | tenant_id_by_kiosk_token_hash |
| app/api/waiver/kiosk-status/route.ts | 1 (L25) | b | API change: lookup is by MagicLinkToken.id (no resolver); require the kiosk device token -> tenant_id_by_kiosk_token_hash, then read the token by id in that context |
| app/api/waiver/kiosk-status/route.ts | 1 (L51) | c | token.tenantId |
| app/api/waiver/open/route.ts | 2 (L25, L77) | b | tenant_id_by_magic_link_hash |
| app/api/webhooks/resend/route.ts | 1 (L124) | b* | NEW resolver tenant_id_by_resend_id (EmailLog.resendId) - not in phase 1 |
| app/api/webhooks/resend/route.ts | 1 (L141) | c | tenant from the resolver above; update in its signed context |
| app/kiosk/[token]/page.tsx | 1 (L29) | b | tenant_id_by_kiosk_token_hash |
| app/leaderboard/[token]/page.tsx | 1 (L33) | b | tenant_id_by_display_token_hash |
| auth.ts | 1 (L441) | b | tenant_id_by_slug (credentials sign-in) |
| auth.ts | 1 (L859) | b | tenant_id_by_slug (Google sign-in; Google disabled in production) |
| auth.ts | 1 (L1084) | b | tenant_id_by_slug (dev-only DEMO_MODE token upgrade; deletable with that fallback) |
| auth.ts | 2 (L1426, L1451) | c | token.tenantId from the verified JWT |
| lib/audit-log.ts | 1 (L245) | a | tenantId=null audit rows; all 7 writers are operator flows -> ops client |
| lib/email.ts | 1 (L416) | b* | NEW boolean function is_provisional_login_address(text) - cross-tenant by design, not in phase 1 |
| lib/impersonation.ts | 1 (L265) | c | imp.targetTenantId from the verified support token |
| lib/leaderboard.ts | 1 (L163) | c | tenantId argument (resolved by display token) |
| lib/notify-member-action.ts | 1 (L71) | c | args.tenantId |
| lib/operator-step-up.ts | 1 (L315) | a | operator step-up digest -> ops client |
| lib/promotion-candidates.ts | 1 (L188) | e | isPromotionReady has no caller in app/, lib/, components/, auth.ts, proxy.ts (dead code) |
| lib/review-lock.ts | 1 (L37) | c | tenantId argument (session tenant; operator soft-delete caller runs as ops) |
| lib/session-revocation.ts | 1 (L108) | c | check.tenantId from the verified JWT |
| lib/stripe/reconcile.ts | 2 (L67, L93) | a | cron (reconcile) -> ops client |
| lib/tenant-purge.ts | 6 (L81, L269, L378, L482, L485, L499) | a | cron purge (destructive, cross-tenant) -> ops client |

total 116 sites in 59 files. a: 78 sites in 30 files; b: 24 sites in 21 files; e: 2 sites in 2 files; c: 12 sites in 11 files. Of class b, 2 need a resolver not in phase 1.
