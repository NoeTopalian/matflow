# Route inventory (generated)

Generated 9 Oct 2026 by `node scripts/readiness/asset-inventory.mjs --markdown <out>` run over `git archive 2a6487e app` (the candidate, not the working tree). Guard markers = helpers referenced in the file; a map for reviewers, NOT an authorization proof (lanes B/C own per-route tests). The working tree additionally holds lane A's uncommitted `/api/admin/customers/[id]/revoke-access` (operator, stepUp, sameOrigin, rateLimit).

| Route | Methods | Area | Guard markers in file | Notes |
|---|---|---|---|---|
| `/api/account/login-email` | GET POST | staff/tenant | staff, sameOrigin, rateLimit | email |
| `/api/account/password` | POST | staff/tenant | staff, sameOrigin, rateLimit |  |
| `/api/account/pending-tenant` | POST | staff/tenant | **none** |  |
| `/api/account/profile` | GET PATCH | staff/tenant | staff, sameOrigin, rateLimit |  |
| `/api/admin/activity` | GET | operator | operator |  |
| `/api/admin/applications` | GET | operator | operator |  |
| `/api/admin/applications/[id]/approve` | POST | operator | operator, magicLinkToken, sameOrigin, rateLimit | email |
| `/api/admin/applications/[id]/reject` | POST | operator | operator, sameOrigin, rateLimit |  |
| `/api/admin/auth/login` | POST | operator | sameOrigin, rateLimit, adminSecret |  |
| `/api/admin/auth/logout` | POST | operator | sameOrigin |  |
| `/api/admin/auth/operator-login` | POST | operator | sameOrigin, rateLimit |  |
| `/api/admin/auth/operator-totp` | POST | operator | sameOrigin, rateLimit |  |
| `/api/admin/auth/operator-totp/setup` | GET POST | operator | operator, sameOrigin, rateLimit, adminSecret |  |
| `/api/admin/auth/step-up` | POST | operator | operator, sameOrigin, rateLimit |  |
| `/api/admin/create-tenant` | POST | operator | operator, magicLinkToken, sameOrigin, rateLimit, adminSecret | email |
| `/api/admin/customers/[id]/force-password-reset` | POST | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/customers/[id]/login-email` | POST | operator | operator, stepUp, sameOrigin, rateLimit | email |
| `/api/admin/customers/[id]/login-email/check` | POST | operator | operator, sameOrigin, rateLimit | email |
| `/api/admin/customers/[id]/member-totp-reset` | POST | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/customers/[id]/members/[memberId]/contact-email` | POST | operator | operator, stepUp, sameOrigin, rateLimit | email |
| `/api/admin/customers/[id]/owner-profile` | POST | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/customers/[id]/review-lock` | POST DELETE | operator | operator, sameOrigin, rateLimit |  |
| `/api/admin/customers/[id]/soft-delete` | POST DELETE | operator | operator, stepUp, sameOrigin, rateLimit | stripe |
| `/api/admin/customers/[id]/suspend` | POST DELETE | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/customers/[id]/totp-reset` | POST | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/customers/[id]/transfer-ownership` | GET POST | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/dsar/erase` | POST | operator | role, magicLinkToken, sameOrigin, rateLimit | blob, stripe |
| `/api/admin/dsar/export` | GET | operator | owner, magicLinkToken, rateLimit | email |
| `/api/admin/email/test` | POST | operator | owner, sameOrigin, rateLimit, adminSecret | email |
| `/api/admin/impersonate` | POST DELETE | operator | operator, stepUp, sameOrigin, rateLimit |  |
| `/api/admin/import` | GET | operator | owner |  |
| `/api/admin/import/[id]` | GET | operator | owner |  |
| `/api/admin/import/[id]/commit` | POST | operator | owner, sameOrigin | blob, email |
| `/api/admin/import/[id]/exceptions` | GET | operator | owner |  |
| `/api/admin/import/[id]/preview` | POST | operator | owner, sameOrigin | blob |
| `/api/admin/import/[id]/rollback` | POST | operator | owner, sameOrigin |  |
| `/api/admin/import/attendance` | POST GET DELETE | operator | owner, sameOrigin, rateLimit |  |
| `/api/admin/import/attendance/export` | GET | operator | owner |  |
| `/api/admin/import/upload` | POST | operator | owner, sameOrigin |  |
| `/api/admin/import/uploads` | POST | operator | owner, sameOrigin, rateLimit |  |
| `/api/admin/import/uploads/[id]/chunks/[index]` | PUT | operator | owner, sameOrigin, rateLimit |  |
| `/api/admin/import/uploads/[id]/complete` | POST | operator | owner, sameOrigin, rateLimit |  |
| `/api/announcements` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/announcements/[id]` | PATCH DELETE | staff/tenant | session, sameOrigin | blob |
| `/api/apply` | POST | public-apply | rateLimit | email |
| `/api/attribution` | GET | staff/tenant | ownerOrManager |  |
| `/api/audit-log` | GET | staff/tenant | owner |  |
| `/api/audit-log/[id]/undo` | POST | staff/tenant | owner, sameOrigin, rateLimit |  |
| `/api/audit-log/undo-to` | POST | staff/tenant | owner, sameOrigin, rateLimit |  |
| `/api/auth/[...nextauth]` | GET POST | auth | **none** |  |
| `/api/auth/disown-login/[token]` | GET | auth | rateLimit |  |
| `/api/auth/forgot-password` | POST | auth | magicLinkToken, rateLimit | email |
| `/api/auth/logout-all` | POST | auth | session, sameOrigin |  |
| `/api/auth/reset-password` | POST | auth | session, rateLimit |  |
| `/api/auth/set-password` | POST | auth | session, sameOrigin |  |
| `/api/auth/staff-unlock/[id]` | POST | auth | owner, sameOrigin |  |
| `/api/auth/totp/disable` | POST | auth | session |  |
| `/api/auth/totp/recover` | POST | auth | rateLimit |  |
| `/api/auth/totp/recovery-codes` | POST | auth | session, sameOrigin |  |
| `/api/auth/totp/setup` | GET POST | auth | session, sameOrigin, rateLimit |  |
| `/api/auth/totp/verify` | POST | auth | rateLimit |  |
| `/api/blob-image` | GET | staff/tenant | session | blob |
| `/api/checkin` | POST DELETE | kiosk | session, sameOrigin |  |
| `/api/checkin/card` | POST | kiosk | staff, cardToken, sameOrigin, rateLimit |  |
| `/api/checkin/members` | GET | kiosk | session |  |
| `/api/class-packs` | GET POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/class-packs/[id]` | PATCH DELETE | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/classes` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/classes/[id]` | GET PATCH DELETE | staff/tenant | session, sameOrigin |  |
| `/api/classes/[id]/instances` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/classes/[id]/instances/[instanceId]` | PATCH | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/classes/[id]/roster` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/classes/[id]/roster/[memberId]` | DELETE | staff/tenant | session, sameOrigin |  |
| `/api/coach/instances/[id]/attendance` | POST | staff/tenant | staff, sameOrigin |  |
| `/api/coach/instances/[id]/register` | GET | staff/tenant | staff |  |
| `/api/coach/today` | GET | staff/tenant | staff |  |
| `/api/cron/class-instances` | GET | cron | cronSecret |  |
| `/api/cron/monthly-reports` | GET | cron | cronSecret | anthropic |
| `/api/cron/retention` | GET | cron | cronSecret | blob, stripe |
| `/api/cron/stripe-reconcile` | GET | cron | cronSecret | stripe |
| `/api/dashboard/stats` | GET | staff/tenant | session |  |
| `/api/drive/callback` | GET | staff/tenant | owner | google |
| `/api/drive/connect` | GET | staff/tenant | owner | google |
| `/api/drive/disconnect` | POST | staff/tenant | owner, sameOrigin | google |
| `/api/drive/folders` | GET | staff/tenant | owner | google |
| `/api/drive/index` | POST | staff/tenant | owner, sameOrigin, rateLimit | google |
| `/api/drive/select-folder` | POST | staff/tenant | owner, sameOrigin | google |
| `/api/drive/status` | GET | staff/tenant | owner |  |
| `/api/health` | GET | public-health | **none** | raw SQL |
| `/api/initiatives` | GET POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/initiatives/[id]` | PATCH DELETE | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/initiatives/[id]/attachments` | POST DELETE | staff/tenant | ownerOrManager, sameOrigin | blob |
| `/api/instances/generate` | POST | staff/tenant | session, sameOrigin |  |
| `/api/kiosk/[token]/checkin` | POST | kiosk | kioskToken, rateLimit |  |
| `/api/kiosk/[token]/classes` | GET | kiosk | kioskToken, rateLimit |  |
| `/api/kiosk/[token]/members` | GET | kiosk | kioskToken, rateLimit |  |
| `/api/locations` | GET POST | staff/tenant | ownerOrManager, staff, sameOrigin |  |
| `/api/locations/[id]` | PATCH DELETE | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/magic-link/request` | POST | auth | magicLinkToken, rateLimit | email |
| `/api/magic-link/verify` | GET | auth | magicLinkToken |  |
| `/api/me/gym` | GET | self | session |  |
| `/api/member/checkout` | POST | member | session, sameOrigin | stripe |
| `/api/member/children` | POST | member | session, sameOrigin |  |
| `/api/member/children/[id]` | GET PATCH DELETE | member | session, sameOrigin | blob, stripe |
| `/api/member/children/[id]/photos` | GET POST | member | session, sameOrigin |  |
| `/api/member/children/[id]/photos/[photoId]` | DELETE | member | session, sameOrigin |  |
| `/api/member/class-packs` | GET | member | session |  |
| `/api/member/class-packs/buy` | POST | member | session, sameOrigin, rateLimit | stripe |
| `/api/member/class-subscriptions/[classId]` | POST DELETE | member | session, sameOrigin | raw SQL |
| `/api/member/classes` | GET | member | session |  |
| `/api/member/family/[id]/billing` | GET | member | session |  |
| `/api/member/family/[id]/billing/portal` | POST | member | session, sameOrigin |  |
| `/api/member/home` | GET | member | session |  |
| `/api/member/me` | GET PATCH | member | session, magicLinkToken, sameOrigin |  |
| `/api/member/me/children` | GET | member | session |  |
| `/api/member/me/mark-announcements-seen` | POST | member | session, sameOrigin |  |
| `/api/member/me/payments` | GET | member | session |  |
| `/api/member/me/recent-demotion` | GET | member | session |  |
| `/api/member/me/subscriptions` | GET | member | session |  |
| `/api/member/products` | GET | member | session |  |
| `/api/member/schedule` | GET | member | session |  |
| `/api/member/shop-config` | GET | member | session |  |
| `/api/member/subscriptions/cancel` | POST | member | session, sameOrigin | stripe |
| `/api/member/subscriptions/cancel-for-kid` | POST | member | session, sameOrigin | stripe |
| `/api/member/subscriptions/start` | POST | member | session, sameOrigin | stripe |
| `/api/member/subscriptions/start-for-kid` | POST | member | session, sameOrigin | stripe |
| `/api/member/tasks` | GET | member | session |  |
| `/api/member/tasks/[id]/complete` | POST | member | session, sameOrigin |  |
| `/api/member/totp/recover` | POST | member | rateLimit |  |
| `/api/member/totp/recovery-codes` | POST | member | session, sameOrigin |  |
| `/api/member/totp/setup` | GET POST | member | session, magicLinkToken, sameOrigin, rateLimit |  |
| `/api/member/totp/verify` | POST | member | sameOrigin, rateLimit |  |
| `/api/members` | GET POST | staff/tenant | session, magicLinkToken, sameOrigin, rateLimit | email |
| `/api/members/[id]` | GET PATCH DELETE | staff/tenant | session, sameOrigin, rateLimit | blob, stripe |
| `/api/members/[id]/card/revoke` | POST | staff/tenant | staff, sameOrigin |  |
| `/api/members/[id]/charge` | POST | staff/tenant | owner, sameOrigin, rateLimit | stripe, email |
| `/api/members/[id]/guardian` | POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/members/[id]/hold` | POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/members/[id]/imported-memberships` | GET | staff/tenant | session |  |
| `/api/members/[id]/invite-link` | POST | staff/tenant | session, sameOrigin |  |
| `/api/members/[id]/link-child` | POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/members/[id]/payment-method` | GET | staff/tenant | owner | stripe |
| `/api/members/[id]/payments` | GET | staff/tenant | session |  |
| `/api/members/[id]/photos` | GET POST DELETE | staff/tenant | session, sameOrigin | blob |
| `/api/members/[id]/profile-picture` | PUT DELETE | staff/tenant | session, sameOrigin | blob |
| `/api/members/[id]/promote-to-adult` | POST | staff/tenant | owner, sameOrigin |  |
| `/api/members/[id]/rank` | POST | staff/tenant | session, sameOrigin | blob |
| `/api/members/[id]/rank/demote` | POST | staff/tenant | session, sameOrigin | email |
| `/api/members/[id]/resume` | POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/members/[id]/totp-reset` | POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/members/[id]/unlink-child` | DELETE | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/members/[id]/unlock` | POST | staff/tenant | ownerOrManager, staff, sameOrigin |  |
| `/api/members/[id]/waiver-link` | POST | staff/tenant | staff, session, magicLinkToken, sameOrigin |  |
| `/api/members/[id]/waiver/sign` | POST | staff/tenant | session, sameOrigin, rateLimit |  |
| `/api/members/accept-invite` | POST | staff/tenant | magicLinkToken, rateLimit |  |
| `/api/members/bulk-invite` | POST | staff/tenant | ownerOrManager, staff, magicLinkToken, sameOrigin | email |
| `/api/members/promotion-alerts` | GET | staff/tenant | owner |  |
| `/api/memberships` | GET POST | staff/tenant | owner, ownerOrManager, sameOrigin |  |
| `/api/memberships/[id]` | PATCH DELETE | staff/tenant | owner, sameOrigin |  |
| `/api/onboarding/csv-handoff` | POST | staff/tenant | owner, sameOrigin | blob, email |
| `/api/orders/[id]/mark-paid` | POST | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/owner/reset-onboarding` | POST | staff/tenant | session, sameOrigin |  |
| `/api/payments` | GET | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/payments/[id]/refund` | POST | staff/tenant | owner, sameOrigin, rateLimit | email |
| `/api/payments/chase` | POST | staff/tenant | owner, ownerOrManager, sameOrigin, rateLimit | email |
| `/api/payments/desk-orders` | GET | staff/tenant | ownerOrManager |  |
| `/api/payments/export.csv` | GET | staff/tenant | ownerOrManager, rateLimit |  |
| `/api/payments/intent` | POST | staff/tenant | session, sameOrigin |  |
| `/api/payments/manual` | POST | staff/tenant | ownerOrManager, sameOrigin, rateLimit |  |
| `/api/payments/outstanding` | GET | staff/tenant | owner, ownerOrManager |  |
| `/api/products` | GET POST | staff/tenant | ownerOrManager, staff, sameOrigin |  |
| `/api/products/[id]` | PATCH DELETE | staff/tenant | ownerOrManager, sameOrigin |  |
| `/api/promotions/candidates` | GET | staff/tenant | ownerOrManager |  |
| `/api/push/subscribe` | POST | staff/tenant | session, sameOrigin |  |
| `/api/ranks` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/ranks/[id]` | PATCH DELETE | staff/tenant | session, sameOrigin |  |
| `/api/reports` | GET | staff/tenant | session |  |
| `/api/reports/generate` | POST GET | staff/tenant | ownerOrManager, sameOrigin, rateLimit | anthropic |
| `/api/revenue/summary` | GET | staff/tenant | owner |  |
| `/api/settings` | GET PATCH | staff/tenant | owner, role, session, sameOrigin |  |
| `/api/settings/display` | POST GET | staff/tenant | session, sameOrigin |  |
| `/api/settings/import-reconciliation` | GET | staff/tenant | owner, rateLimit |  |
| `/api/settings/kiosk` | POST GET | staff/tenant | session, kioskToken, sameOrigin |  |
| `/api/staff` | GET POST | staff/tenant | session, sameOrigin | email |
| `/api/staff/[id]` | PATCH DELETE | staff/tenant | owner, session, sameOrigin | email |
| `/api/staff/[id]/totp-reset` | POST | staff/tenant | owner, sameOrigin |  |
| `/api/staff/[id]/transfer-ownership` | POST | staff/tenant | session, sameOrigin, rateLimit |  |
| `/api/staff/assignable` | GET | staff/tenant | session |  |
| `/api/stripe/connect` | GET | staff/tenant | session |  |
| `/api/stripe/connect/callback` | GET | staff/tenant | session |  |
| `/api/stripe/connect/health` | GET | staff/tenant | owner | stripe |
| `/api/stripe/create-subscription` | POST | staff/tenant | session, sameOrigin | stripe |
| `/api/stripe/disconnect` | POST | staff/tenant | session, sameOrigin |  |
| `/api/stripe/migrate-memberships` | GET POST | staff/tenant | owner, sameOrigin, rateLimit | stripe |
| `/api/stripe/portal` | POST | staff/tenant | session, sameOrigin |  |
| `/api/stripe/subscription-plans` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/stripe/webhook` | POST | webhook | stripeSignature | stripe, email |
| `/api/tasks` | GET POST | staff/tenant | session, sameOrigin |  |
| `/api/tasks/[id]/complete` | POST | staff/tenant | session, sameOrigin |  |
| `/api/tenant/[slug]` | GET | staff/tenant | rateLimit | email |
| `/api/upload` | POST | staff/tenant | owner, session, sameOrigin | sharp, blob |
| `/api/upload/delete-orphan` | POST | staff/tenant | session, sameOrigin | blob |
| `/api/waiver` | GET | staff/tenant | session |  |
| `/api/waiver/[signedWaiverId]/signature` | GET | staff/tenant | session | blob |
| `/api/waiver/kiosk-request` | POST | staff/tenant | kioskToken, magicLinkToken, rateLimit | email |
| `/api/waiver/kiosk-status` | GET | staff/tenant | rateLimit |  |
| `/api/waiver/open` | GET POST | staff/tenant | rateLimit |  |
| `/api/waiver/sign` | POST | staff/tenant | session, sameOrigin, rateLimit |  |
| `/api/waiver/sign-for-child` | POST | staff/tenant | session, sameOrigin, rateLimit |  |
| `/api/webhooks/resend` | POST | webhook | svixSignature | email |
