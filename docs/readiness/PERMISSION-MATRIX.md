# Permission matrix — API routes at SHA 9993565 (generated 2026-09-24 by scratchpad/route-matrix.mjs; regenerate, do not hand-edit)

Columns: route | methods | who may call (from the guard the handler calls) | CSRF origin check | rate limit. Location scope: none today (ADR-001 D2/D6). Page and server-action gates are covered by lb-2 (nav ⇄ gate ⇄ API agreement) and are not repeated here.

| Route | Methods | Who | CSRF | RL |
|---|---|---|---|---|
| account/pending-tenant | POST | public / own token | - | - |
| admin/activity | GET | operator | - | - |
| admin/applications/[id]/approve | POST | operator | csrf | rl |
| admin/applications/[id]/reject | POST | public / own token | csrf | rl |
| admin/applications | GET | operator | - | - |
| admin/auth/login | POST | public / own token | - | rl |
| admin/auth/logout | POST | public / own token | - | - |
| admin/auth/operator-login | POST | public / own token | - | rl |
| admin/auth/operator-totp | POST | public / own token | - | rl |
| admin/auth/operator-totp/setup | GET,POST | public / own token | - | rl |
| admin/create-tenant | POST | public / own token | csrf | rl |
| admin/customers/[id]/force-password-reset | POST | operator | csrf | rl |
| admin/customers/[id]/member-totp-reset | POST | operator | csrf | rl |
| admin/customers/[id]/soft-delete | POST,DELETE | operator | csrf | rl |
| admin/customers/[id]/suspend | POST,DELETE | operator | csrf | rl |
| admin/customers/[id]/totp-reset | POST | operator | csrf | rl |
| admin/customers/[id]/transfer-ownership | GET,POST | operator | csrf | rl |
| admin/dsar/erase | POST | role list (see file) | csrf | rl |
| admin/dsar/export | GET | owner | - | rl |
| admin/email/test | POST | owner | csrf | rl |
| admin/impersonate | POST,DELETE | operator | csrf | rl |
| admin/import/[id]/commit | POST | owner | csrf | - |
| admin/import/[id]/preview | POST | owner | csrf | - |
| admin/import/[id] | GET | owner | - | - |
| admin/import/upload | POST | owner | csrf | - |
| announcements/[id] | PATCH,DELETE | any session (staff or member — see file) | csrf | - |
| announcements | GET,POST | any session (staff or member — see file) | csrf | - |
| apply | POST | public / own token | - | rl |
| attribution | GET | owner+manager | - | - |
| audit-log | GET | owner | - | - |
| auth/[...nextauth] | (handler) | public / own token | - | - |
| auth/disown-login/[token] | GET | public / own token | - | rl |
| auth/forgot-password | POST | public / own token | - | rl |
| auth/logout-all | POST | any session (staff or member — see file) | csrf | - |
| auth/reset-password | POST | any session (staff or member — see file) | - | rl |
| auth/staff-unlock/[id] | POST | owner | csrf | - |
| auth/totp/disable | POST | any session (staff or member — see file) | - | - |
| auth/totp/recover | POST | public / own token | - | rl |
| auth/totp/recovery-codes | POST | any session (staff or member — see file) | csrf | - |
| auth/totp/setup | GET,POST | any session (staff or member — see file) | csrf | rl |
| auth/totp/verify | POST | public / own token | - | rl |
| blob-image | GET | any session (staff or member — see file) | - | - |
| checkin/card | POST | staff (owner/manager/coach/admin) | csrf | rl |
| checkin/members | GET | any session (staff or member — see file) | - | - |
| checkin | POST,DELETE | any session (staff or member — see file) | csrf | - |
| class-packs/[id] | PATCH,DELETE | owner+manager | csrf | - |
| class-packs | GET,POST | owner+manager | csrf | - |
| classes/[id]/instances/[instanceId] | PATCH | owner+manager | csrf | - |
| classes/[id]/instances | GET,POST | any session (staff or member — see file) | csrf | - |
| classes/[id]/roster/[memberId] | DELETE | any session (staff or member — see file) | csrf | - |
| classes/[id]/roster | GET,POST | any session (staff or member — see file) | csrf | - |
| classes/[id] | GET,PATCH,DELETE | any session (staff or member — see file) | csrf | - |
| classes | GET,POST | any session (staff or member — see file) | csrf | - |
| coach/instances/[id]/attendance | POST | staff (owner/manager/coach/admin) | csrf | - |
| coach/instances/[id]/register | GET | staff (owner/manager/coach/admin) | - | - |
| coach/today | GET | staff (owner/manager/coach/admin) | - | - |
| cron/class-instances | GET | cron secret | - | - |
| cron/monthly-reports | GET | cron secret | - | - |
| cron/retention | GET | cron secret | - | - |
| cron/stripe-reconcile | GET | cron secret | - | - |
| dashboard/stats | GET | any session (staff or member — see file) | - | - |
| drive/callback | GET | owner | - | - |
| drive/connect | GET | owner | - | - |
| drive/disconnect | POST | owner | csrf | - |
| drive/folders | GET | owner | - | - |
| drive/index | POST | owner | csrf | rl |
| drive/select-folder | POST | owner | csrf | - |
| drive/status | GET | owner | - | - |
| health | GET | public / own token | - | - |
| initiatives/[id]/attachments | POST,DELETE | owner+manager | csrf | - |
| initiatives/[id] | PATCH,DELETE | owner+manager | csrf | - |
| initiatives | GET,POST | owner+manager | csrf | - |
| instances/generate | POST | any session (staff or member — see file) | csrf | - |
| kiosk/[token]/checkin | POST | public / own token | - | rl |
| kiosk/[token]/classes | GET | public / own token | - | rl |
| kiosk/[token]/members | GET | public / own token | - | rl |
| magic-link/request | POST | public / own token | - | rl |
| magic-link/verify | GET | public / own token | - | - |
| me/gym | GET | any session (staff or member — see file) | - | - |
| member/checkout | POST | any session (staff or member — see file) | csrf | - |
| member/children/[id]/photos/[photoId] | DELETE | any session (staff or member — see file) | csrf | - |
| member/children/[id]/photos | GET,POST | any session (staff or member — see file) | csrf | - |
| member/children/[id] | GET,PATCH,DELETE | any session (staff or member — see file) | csrf | - |
| member/children | POST | any session (staff or member — see file) | csrf | - |
| member/class-packs/buy | POST | any session (staff or member — see file) | csrf | rl |
| member/class-packs | GET | any session (staff or member — see file) | - | - |
| member/class-subscriptions/[classId] | POST,DELETE | any session (staff or member — see file) | csrf | - |
| member/classes | GET | any session (staff or member — see file) | - | - |
| member/family/[id]/billing/portal | POST | any session (staff or member — see file) | csrf | - |
| member/family/[id]/billing | GET | any session (staff or member — see file) | - | - |
| member/home | GET | any session (staff or member — see file) | - | - |
| member/me/children | GET | any session (staff or member — see file) | - | - |
| member/me/mark-announcements-seen | POST | any session (staff or member — see file) | csrf | - |
| member/me/payments | GET | any session (staff or member — see file) | - | - |
| member/me/recent-demotion | GET | any session (staff or member — see file) | - | - |
| member/me | GET,PATCH | any session (staff or member — see file) | csrf | - |
| member/me/subscriptions | GET | any session (staff or member — see file) | - | - |
| member/products | GET | any session (staff or member — see file) | - | - |
| member/schedule | GET | any session (staff or member — see file) | - | - |
| member/shop-config | GET | any session (staff or member — see file) | - | - |
| member/subscriptions/cancel-for-kid | POST | any session (staff or member — see file) | csrf | - |
| member/subscriptions/cancel | POST | any session (staff or member — see file) | csrf | - |
| member/subscriptions/start-for-kid | POST | any session (staff or member — see file) | csrf | - |
| member/subscriptions/start | POST | any session (staff or member — see file) | csrf | - |
| member/tasks/[id]/complete | POST | any session (staff or member — see file) | csrf | - |
| member/tasks | GET | any session (staff or member — see file) | - | - |
| member/totp/recover | POST | public / own token | - | rl |
| member/totp/recovery-codes | POST | any session (staff or member — see file) | csrf | - |
| member/totp/setup | GET,POST | any session (staff or member — see file) | csrf | rl |
| member/totp/verify | POST | public / own token | csrf | rl |
| members/[id]/card/revoke | POST | staff (owner/manager/coach/admin) | csrf | - |
| members/[id]/charge | POST | owner | csrf | rl |
| members/[id]/hold | POST | owner+manager | csrf | - |
| members/[id]/link-child | POST | any session (staff or member — see file) | csrf | - |
| members/[id]/payment-method | GET | owner | - | - |
| members/[id]/payments | GET | any session (staff or member — see file) | - | - |
| members/[id]/photos | GET,POST,DELETE | any session (staff or member — see file) | csrf | - |
| members/[id]/profile-picture | PUT,DELETE | any session (staff or member — see file) | csrf | - |
| members/[id]/promote-to-adult | POST | owner | csrf | - |
| members/[id]/rank/demote | POST | any session (staff or member — see file) | csrf | - |
| members/[id]/rank | POST | any session (staff or member — see file) | csrf | - |
| members/[id]/resume | POST | owner+manager | csrf | - |
| members/[id] | GET,PATCH,DELETE | any session (staff or member — see file) | csrf | rl |
| members/[id]/totp-reset | POST | owner+manager | csrf | - |
| members/[id]/unlink-child | DELETE | any session (staff or member — see file) | csrf | - |
| members/[id]/unlock | POST | owner+manager | csrf | - |
| members/[id]/waiver-link | POST | any session (staff or member — see file) | csrf | - |
| members/[id]/waiver/sign | POST | any session (staff or member — see file) | csrf | rl |
| members/accept-invite | POST | public / own token | - | rl |
| members/bulk-invite | POST | owner+manager | csrf | - |
| members/promotion-alerts | GET | owner | - | - |
| members | GET,POST | any session (staff or member — see file) | csrf | rl |
| memberships/[id] | PATCH,DELETE | owner | csrf | - |
| memberships | GET,POST | owner+manager | csrf | - |
| onboarding/csv-handoff | POST | owner | csrf | - |
| orders/[id]/mark-paid | POST | owner+manager | csrf | - |
| owner/reset-onboarding | POST | any session (staff or member — see file) | csrf | - |
| payments/[id]/refund | POST | owner | csrf | rl |
| payments/chase | POST | owner+manager | csrf | rl |
| payments/desk-orders | GET | owner+manager | - | - |
| payments/export.csv | GET | owner+manager | - | rl |
| payments/intent | POST | any session (staff or member — see file) | csrf | - |
| payments/manual | POST | owner+manager | csrf | rl |
| payments/outstanding | GET | owner+manager | - | - |
| payments | GET | owner+manager | csrf | - |
| products/[id] | PATCH,DELETE | owner+manager | csrf | - |
| products | GET,POST | owner+manager | csrf | - |
| promotions/candidates | GET | owner+manager | - | - |
| push/subscribe | POST | any session (staff or member — see file) | csrf | - |
| ranks/[id] | PATCH,DELETE | any session (staff or member — see file) | csrf | - |
| ranks | GET,POST | any session (staff or member — see file) | csrf | - |
| reports/generate | POST,GET | owner+manager | csrf | rl |
| reports | GET | any session (staff or member — see file) | - | - |
| revenue/summary | GET | owner | - | - |
| settings/display | POST,GET | any session (staff or member — see file) | csrf | - |
| settings/kiosk | POST,GET | any session (staff or member — see file) | csrf | - |
| settings | GET,PATCH | owner | csrf | - |
| staff/[id] | PATCH,DELETE | any session (staff or member — see file) | csrf | - |
| staff/assignable | GET | any session (staff or member — see file) | - | - |
| staff | GET,POST | any session (staff or member — see file) | csrf | - |
| stripe/connect/callback | GET | any session (staff or member — see file) | - | - |
| stripe/connect/health | GET | owner | - | - |
| stripe/connect | GET | any session (staff or member — see file) | - | - |
| stripe/create-subscription | POST | any session (staff or member — see file) | csrf | - |
| stripe/disconnect | POST | any session (staff or member — see file) | csrf | - |
| stripe/migrate-memberships | GET,POST | owner | csrf | rl |
| stripe/portal | POST | any session (staff or member — see file) | csrf | - |
| stripe/subscription-plans | GET,POST | any session (staff or member — see file) | csrf | - |
| stripe/webhook | POST | provider signature | - | - |
| tasks/[id]/complete | POST | any session (staff or member — see file) | csrf | - |
| tasks | GET,POST | any session (staff or member — see file) | csrf | - |
| tenant/[slug] | GET | public / own token | - | rl |
| upload/delete-orphan | POST | any session (staff or member — see file) | csrf | - |
| upload | POST | owner | csrf | - |
| waiver/[signedWaiverId]/signature | GET | any session (staff or member — see file) | - | - |
| waiver/kiosk-request | POST | public / own token | - | rl |
| waiver/kiosk-status | GET | public / own token | - | rl |
| waiver/open | GET,POST | public / own token | - | rl |
| waiver | GET | any session (staff or member — see file) | - | - |
| waiver/sign-for-child | POST | any session (staff or member — see file) | csrf | rl |
| waiver/sign | POST | any session (staff or member — see file) | csrf | rl |
| webhooks/resend | POST | public / own token | - | - |

## Routes with no session guard (must be public, token- or signature-gated by design)

- account/pending-tenant
- admin/applications/[id]/reject
- admin/auth/login
- admin/auth/logout
- admin/auth/operator-login
- admin/auth/operator-totp
- admin/create-tenant
- apply
- auth/[...nextauth]
- auth/disown-login/[token]
- auth/forgot-password
- auth/totp/recover
- auth/totp/verify
- health
- kiosk/[token]/checkin
- kiosk/[token]/classes
- kiosk/[token]/members
- magic-link/request
- magic-link/verify
- member/totp/recover
- member/totp/verify
- members/accept-invite
- tenant/[slug]
- waiver/kiosk-request
- waiver/kiosk-status
- waiver/open
- webhooks/resend

Each of the above is either a public door (`apply`, `auth/*`, `magic-link/*`, `tenant/[slug]`, `waiver/*`, `members/accept-invite`, `health`), a token door (`kiosk/[token]/*`), or a provider callback (`webhooks/resend`). `account/pending-tenant` reads its own signed cookie. Any new route appearing here that is not one of those kinds is a finding.
