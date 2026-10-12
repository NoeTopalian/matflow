# Impersonation (support session) inventory — lane B, 6 Oct 2026

Generated from the source tree by scratchpad/remediation/laneB/inventory.mjs (re-run it after route changes).

Policy: lib/support-session.ts. Every non-GET request with a support session is refused (403) by proxy.ts for every path the matcher reaches (all of app/api except /api/auth/*, webhooks, cron, kiosk, magic-link, health), including /api/admin/* and page POSTs (Server Actions). Routes outside the matcher that act on a session carry `refuseSupportSession(...)`. High-risk routes carry the in-route guard too (defence in depth). Mutation allow-list: EMPTY. Exits: DELETE /api/admin/impersonate (stop), POST /api/admin/auth/logout.

GET exports — decision: support may VIEW club data, but may not EXPORT personal-data files or start/complete account connections. Refused GETs: `^\/api\/admin\/dsar\/export\/?$` (Personal-data (subject access) export file.); `^\/api\/payments\/export\.csv\/?$` (Payments CSV export: personal and financial data file.); `^\/api\/admin\/import\/attendance\/export\/?$` (Attendance ledger export file.); `^\/api\/admin\/import\/[^/]+\/exceptions\/?$` (Import exceptions CSV: names and contact details.); `^\/api\/stripe\/connect(\/callback)?\/?$` (Connects a payment account; the callback writes the club's Stripe account.); `^\/api\/drive\/(connect|callback)\/?$` (Connects Google Drive; the callback stores OAuth tokens.); `^\/api\/auth\/totp\/setup\/?$` (GET mints and stores a new authenticator secret on the account.); `^\/api\/member\/totp\/setup\/?$` (GET mints and stores a new authenticator secret on the account.). Allowed GETs include the waiver signature image view, reports, dashboards, member/staff lists, import job views.

Operator plane: a support session cannot use /admin pages (redirect to /dashboard) or operator routes under /api/admin (403) — no nesting, no second support session.

Totals: 174 handlers listed; 163 refused; 2 exits; 9 session-less; UNCOVERED: 0.

Pinned by tests/unit/support-session-readonly.test.ts (every mutating handler on disk through the real proxy; coverage of the rest), tests/unit/support-session-routes.test.ts (direct handler calls: 403 + no DB/Stripe/email/blob), tests/unit/impersonation-cannot-activate.test.ts.

| Route | Method | Gate | What it changes (from source) | Verdict |
|---|---|---|---|---|
| `/api/account/pending-tenant` | POST | public | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/admin/applications/[id]/approve` | POST | operator | tenant.create, magicLinkToken.create, gymApplication.update; email | REFUSED (proxy: operator plane) |
| `/api/admin/applications/[id]/reject` | POST | operator | gymApplication.update | REFUSED (proxy: operator plane) |
| `/api/admin/auth/login` | POST | public | (no direct write found — delegates to lib) | REFUSED (proxy: operator plane) |
| `/api/admin/auth/logout` | POST | public | operator.updateMany; cookie/session | ALLOWED — exit (only removes authority) |
| `/api/admin/auth/operator-login` | POST | public | cookie/session | REFUSED (proxy: operator plane) |
| `/api/admin/auth/operator-totp` | POST | public | operator.update; cookie/session | REFUSED (proxy: operator plane) |
| `/api/admin/auth/operator-totp/setup` | POST | public | operator.updateMany; cookie/session | REFUSED (proxy: operator plane) |
| `/api/admin/auth/step-up` | POST | public | cookie/session | REFUSED (proxy: operator plane) |
| `/api/admin/create-tenant` | POST | operator | tenant.create | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/force-password-reset` | POST | operator | passwordHistory.create, user.update | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/member-totp-reset` | POST | operator | member.update | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/review-lock` | POST | public | tenant.update | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/review-lock` | DELETE | public | tenant.update | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/soft-delete` | POST | operator | tenant.updateMany, user.updateMany, member.updateMany; Stripe | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/soft-delete` | DELETE | operator | (no direct write found — delegates to lib) | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/suspend` | POST | operator | tenant.updateMany, user.updateMany, member.updateMany | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/suspend` | DELETE | operator | tenant.updateMany | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/totp-reset` | POST | operator | user.update | REFUSED (proxy: operator plane) |
| `/api/admin/customers/[id]/transfer-ownership` | POST | operator | user.update | REFUSED (proxy: operator plane) |
| `/api/admin/dsar/erase` | POST | owner | member.updateMany, importedBooking.deleteMany, importSourceMapping.deleteMany, member.update, memberPhoto.deleteMany, signedWaiver.updateMany, …; Stripe; blob; destructive | REFUSED (proxy + in-route guard) |
| `/api/admin/dsar/export` | GET | owner | Personal-data (subject access) export file. | REFUSED (proxy + in-route guard) |
| `/api/admin/email/test` | POST | owner | email | REFUSED (proxy) |
| `/api/admin/impersonate` | POST | operator | cookie/session | REFUSED (proxy: operator plane) |
| `/api/admin/impersonate` | DELETE | operator | cookie/session | ALLOWED — exit (only removes authority) |
| `/api/admin/import/[id]/commit` | POST | owner | importJob.updateMany, importJob.update, member.createMany, importedMembership.createMany, member.updateMany; email | REFUSED (proxy + in-route guard) |
| `/api/admin/import/[id]/exceptions` | GET | owner | Import exceptions CSV: names and contact details. | REFUSED (proxy) |
| `/api/admin/import/[id]/preview` | POST | owner | importJob.update | REFUSED (proxy) |
| `/api/admin/import/[id]/rollback` | POST | owner | importedMembership.deleteMany, attendanceRecord.deleteMany, member.deleteMany, importJob.update, member.updateMany; destructive | REFUSED (proxy + in-route guard) |
| `/api/admin/import/attendance/export` | GET | owner | Attendance ledger export file. | REFUSED (proxy + in-route guard) |
| `/api/admin/import/attendance` | POST | owner | importJob.updateMany, importUploadChunk.deleteMany, importUpload.deleteMany, importJob.create | REFUSED (proxy) |
| `/api/admin/import/attendance` | DELETE | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/admin/import/upload` | POST | owner | importJob.create | REFUSED (proxy) |
| `/api/admin/import/uploads/[id]/chunks/[index]` | PUT | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/admin/import/uploads/[id]/complete` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/admin/import/uploads` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/announcements/[id]` | PATCH | session | announcement.updateMany | REFUSED (proxy) |
| `/api/announcements/[id]` | DELETE | session | announcement.deleteMany; blob | REFUSED (proxy) |
| `/api/announcements` | POST | session | announcement.create | REFUSED (proxy) |
| `/api/apply` | POST | public | gymApplication.create; email | REFUSED (proxy) |
| `/api/audit-log/[id]/undo` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/audit-log/undo-to` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/auth/[...nextauth]` | POST | public | (no direct write found — delegates to lib) | N/A — no session authority (NextAuth sign-in/sign-out) |
| `/api/auth/forgot-password` | POST | public | passwordResetToken.updateMany, passwordResetToken.create; email | N/A — no session authority (public; emails the address on file) |
| `/api/auth/logout-all` | POST | session | member.update, user.update | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/reset-password` | POST | session | passwordResetToken.updateMany, user.update, passwordHistory.create, passwordHistory.deleteMany, member.update | N/A — no session authority (emailed one-time token is the credential) |
| `/api/auth/set-password` | POST | session | user.update, passwordHistory.create, passwordHistory.deleteMany; cookie/session | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/staff-unlock/[id]` | POST | owner | user.update | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/totp/disable` | POST | session | (no direct write found — delegates to lib) | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/totp/recover` | POST | public | user.update | N/A — no session authority (public; recovery code is the credential) |
| `/api/auth/totp/recovery-codes` | POST | session | user.update | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/totp/setup` | GET | session | user.update | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/totp/setup` | POST | session | user.update; cookie/session | REFUSED (in-route guard; outside proxy matcher) |
| `/api/auth/totp/verify` | POST | session | cookie/session | N/A — no session authority (needs totpPending, never on a support session) |
| `/api/checkin/card` | POST | staff | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/checkin` | POST | session | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/checkin` | DELETE | session | attendanceRecord.deleteMany | REFUSED (proxy) |
| `/api/class-packs/[id]` | PATCH | owner/manager | classPack.updateMany | REFUSED (proxy) |
| `/api/class-packs/[id]` | DELETE | owner/manager | classPack.updateMany | REFUSED (proxy) |
| `/api/class-packs` | POST | owner/manager | classPack.create; Stripe | REFUSED (proxy) |
| `/api/classes/[id]/instances/[instanceId]` | PATCH | owner/manager | classInstance.updateMany | REFUSED (proxy) |
| `/api/classes/[id]/instances` | POST | session | classInstance.createMany | REFUSED (proxy) |
| `/api/classes/[id]/roster/[memberId]` | DELETE | session | classRoster.deleteMany, classSubscription.deleteMany | REFUSED (proxy) |
| `/api/classes/[id]/roster` | POST | session | classRoster.create | REFUSED (proxy) |
| `/api/classes/[id]` | PATCH | session | classRoster.deleteMany, classRoster.createMany, classSubscription.deleteMany, class.updateMany | REFUSED (proxy) |
| `/api/classes/[id]` | DELETE | session | class.updateMany | REFUSED (proxy) |
| `/api/classes` | POST | session | class.create, classRoster.createMany, classInstance.createMany | REFUSED (proxy) |
| `/api/coach/instances/[id]/attendance` | POST | staff | attendanceRecord.upsert, attendanceRecord.deleteMany | REFUSED (proxy) |
| `/api/drive/callback` | GET | owner | Connects Google Drive; the callback stores OAuth tokens. | REFUSED (proxy) |
| `/api/drive/connect` | GET | owner | Connects Google Drive; the callback stores OAuth tokens. | REFUSED (proxy) |
| `/api/drive/disconnect` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/drive/index` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/drive/select-folder` | POST | owner | indexedDriveFile.deleteMany, googleDriveConnection.update | REFUSED (proxy) |
| `/api/initiatives/[id]/attachments` | POST | owner/manager | initiativeAttachment.create; blob | REFUSED (proxy) |
| `/api/initiatives/[id]/attachments` | DELETE | owner/manager | initiativeAttachment.deleteMany | REFUSED (proxy) |
| `/api/initiatives/[id]` | PATCH | owner/manager | initiative.updateMany | REFUSED (proxy) |
| `/api/initiatives/[id]` | DELETE | owner/manager | initiative.deleteMany | REFUSED (proxy) |
| `/api/initiatives` | POST | owner/manager | initiative.create | REFUSED (proxy) |
| `/api/instances/generate` | POST | session | classInstance.createMany | REFUSED (proxy) |
| `/api/kiosk/[token]/checkin` | POST | token | (no direct write found — delegates to lib) | N/A — no session authority (kiosk device token) |
| `/api/locations/[id]` | PATCH | owner/manager | location.updateMany, location.update | REFUSED (proxy) |
| `/api/locations/[id]` | DELETE | owner/manager | location.delete | REFUSED (proxy) |
| `/api/locations` | POST | owner/manager | location.create | REFUSED (proxy) |
| `/api/magic-link/request` | POST | public | magicLinkToken.updateMany, magicLinkToken.create; email | N/A — no session authority (public; emails the address on file) |
| `/api/member/checkout` | POST | session | order.create, order.updateMany; Stripe | REFUSED (proxy) |
| `/api/member/children/[id]/photos/[photoId]` | DELETE | session | memberPhoto.deleteMany | REFUSED (proxy) |
| `/api/member/children/[id]/photos` | POST | session | memberPhoto.create | REFUSED (proxy) |
| `/api/member/children/[id]` | PATCH | session | member.updateMany | REFUSED (proxy) |
| `/api/member/children/[id]` | DELETE | session | Stripe; blob | REFUSED (proxy) |
| `/api/member/children` | POST | session | member.create | REFUSED (proxy) |
| `/api/member/class-packs/buy` | POST | session | member.updateMany; Stripe | REFUSED (proxy) |
| `/api/member/class-subscriptions/[classId]` | POST | public | classSubscription.create | REFUSED (proxy) |
| `/api/member/class-subscriptions/[classId]` | DELETE | public | classSubscription.deleteMany | REFUSED (proxy) |
| `/api/member/family/[id]/billing/portal` | POST | session | Stripe | REFUSED (proxy) |
| `/api/member/me/mark-announcements-seen` | POST | session | member.updateMany | REFUSED (proxy) |
| `/api/member/me` | PATCH | session | member.updateMany, signedWaiver.create, memberRank.upsert | REFUSED (proxy) |
| `/api/member/subscriptions/cancel-for-kid` | POST | session | Stripe | REFUSED (proxy) |
| `/api/member/subscriptions/cancel` | POST | session | Stripe | REFUSED (proxy) |
| `/api/member/subscriptions/start-for-kid` | POST | session | Stripe | REFUSED (proxy) |
| `/api/member/subscriptions/start` | POST | session | Stripe | REFUSED (proxy) |
| `/api/member/tasks/[id]/complete` | POST | session | task.updateMany | REFUSED (proxy) |
| `/api/member/totp/recover` | POST | public | member.update | REFUSED (proxy) |
| `/api/member/totp/recovery-codes` | POST | session | member.update | REFUSED (proxy) |
| `/api/member/totp/setup` | GET | session | member.update | REFUSED (proxy) |
| `/api/member/totp/setup` | POST | session | member.update; cookie/session | REFUSED (proxy) |
| `/api/member/totp/verify` | POST | session | cookie/session | REFUSED (proxy) |
| `/api/members/[id]/card/revoke` | POST | staff | member.update | REFUSED (proxy) |
| `/api/members/[id]/charge` | POST | owner | payment.upsert, payment.create; Stripe; email | REFUSED (proxy + in-route guard) |
| `/api/members/[id]/guardian` | POST | owner/manager | member.updateMany, member.update | REFUSED (proxy) |
| `/api/members/[id]/hold` | POST | owner/manager | member.updateMany; Stripe | REFUSED (proxy) |
| `/api/members/[id]/invite-link` | POST | session | magicLinkToken.updateMany, magicLinkToken.create | REFUSED (proxy + in-route guard) |
| `/api/members/[id]/link-child` | POST | owner/manager | member.updateMany | REFUSED (proxy) |
| `/api/members/[id]/photos` | POST | session | memberPhoto.create | REFUSED (proxy) |
| `/api/members/[id]/photos` | DELETE | session | memberPhoto.delete; blob | REFUSED (proxy) |
| `/api/members/[id]/profile-picture` | PUT | public | memberPhoto.update, memberPhoto.create | REFUSED (proxy) |
| `/api/members/[id]/profile-picture` | DELETE | public | memberPhoto.delete; blob | REFUSED (proxy) |
| `/api/members/[id]/promote-to-adult` | POST | owner | member.update | REFUSED (proxy) |
| `/api/members/[id]/rank/demote` | POST | session | memberRank.update, memberRank.create, classSubscription.deleteMany; email | REFUSED (proxy) |
| `/api/members/[id]/rank` | POST | session | memberRank.update, memberRank.upsert, memberPhoto.deleteMany, memberPhoto.create; blob | REFUSED (proxy) |
| `/api/members/[id]/resume` | POST | owner/manager | member.update; Stripe | REFUSED (proxy) |
| `/api/members/[id]` | PATCH | session | member.updateMany; Stripe | REFUSED (proxy + in-route guard) |
| `/api/members/[id]` | DELETE | session | Stripe; blob | REFUSED (proxy + in-route guard) |
| `/api/members/[id]/totp-reset` | POST | owner/manager | member.update | REFUSED (proxy + in-route guard) |
| `/api/members/[id]/unlink-child` | DELETE | owner/manager | member.updateMany | REFUSED (proxy) |
| `/api/members/[id]/unlock` | POST | owner/manager | member.update | REFUSED (proxy) |
| `/api/members/[id]/waiver-link` | POST | session | magicLinkToken.updateMany, magicLinkToken.create | REFUSED (proxy) |
| `/api/members/[id]/waiver/sign` | POST | session | signedWaiver.create, member.update | REFUSED (proxy + in-route guard) |
| `/api/members/accept-invite` | POST | public | magicLinkToken.updateMany, member.update | REFUSED (proxy) |
| `/api/members/bulk-invite` | POST | owner/manager | magicLinkToken.updateMany, magicLinkToken.create; email | REFUSED (proxy + in-route guard) |
| `/api/members` | POST | session | member.create, magicLinkToken.create; email | REFUSED (proxy) |
| `/api/memberships/[id]` | PATCH | owner | membershipTier.updateMany | REFUSED (proxy) |
| `/api/memberships/[id]` | DELETE | owner | membershipTier.update | REFUSED (proxy) |
| `/api/memberships` | POST | owner | membershipTier.create | REFUSED (proxy) |
| `/api/onboarding/csv-handoff` | POST | owner | importJob.create; email; blob | REFUSED (proxy) |
| `/api/orders/[id]/mark-paid` | POST | owner/manager | order.updateMany | REFUSED (proxy) |
| `/api/owner/reset-onboarding` | POST | session | tenant.update | REFUSED (proxy) |
| `/api/payments/[id]/refund` | POST | owner | payment.updateMany, memberClassPack.update; Stripe; email | REFUSED (proxy + in-route guard) |
| `/api/payments/chase` | POST | owner/manager | email | REFUSED (proxy) |
| `/api/payments/export.csv` | GET | owner/manager | Payments CSV export: personal and financial data file. | REFUSED (proxy + in-route guard) |
| `/api/payments/intent` | POST | session | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/payments/manual` | POST | owner/manager | payment.create, member.update | REFUSED (proxy) |
| `/api/products/[id]` | PATCH | owner/manager | product.update | REFUSED (proxy) |
| `/api/products/[id]` | DELETE | owner/manager | product.update | REFUSED (proxy) |
| `/api/products` | POST | owner/manager | product.create | REFUSED (proxy) |
| `/api/push/subscribe` | POST | session | pushSubscription.upsert | REFUSED (proxy) |
| `/api/ranks/[id]` | PATCH | session | rankSystem.updateMany | REFUSED (proxy) |
| `/api/ranks/[id]` | DELETE | session | rankSystem.updateMany | REFUSED (proxy) |
| `/api/ranks` | POST | session | rankSystem.create | REFUSED (proxy) |
| `/api/reports/generate` | POST | owner/manager | monthlyReport.create | REFUSED (proxy) |
| `/api/settings/display` | POST | session | tenant.update | REFUSED (proxy) |
| `/api/settings/kiosk` | POST | session | tenant.update | REFUSED (proxy) |
| `/api/settings` | PATCH | session | tenant.update | REFUSED (proxy + in-route guard) |
| `/api/staff/[id]` | PATCH | session | user.updateMany | REFUSED (proxy + in-route guard) |
| `/api/staff/[id]` | DELETE | session | user.deleteMany | REFUSED (proxy + in-route guard) |
| `/api/staff/[id]/totp-reset` | POST | owner | user.update | REFUSED (proxy + in-route guard) |
| `/api/staff/[id]/transfer-ownership` | POST | session | user.update | REFUSED (proxy + in-route guard) |
| `/api/staff` | POST | session | user.create | REFUSED (proxy + in-route guard) |
| `/api/stripe/connect/callback` | GET | session | tenant.update; Stripe | REFUSED (proxy + in-route guard) |
| `/api/stripe/connect` | GET | session | Stripe | REFUSED (proxy + in-route guard) |
| `/api/stripe/create-subscription` | POST | session | Stripe | REFUSED (proxy) |
| `/api/stripe/disconnect` | POST | session | tenant.update; Stripe | REFUSED (proxy + in-route guard) |
| `/api/stripe/migrate-memberships` | POST | owner | (no direct write found — delegates to lib) | REFUSED (proxy) |
| `/api/stripe/portal` | POST | session | Stripe | REFUSED (proxy) |
| `/api/stripe/subscription-plans` | POST | session | Stripe | REFUSED (proxy) |
| `/api/stripe/webhook` | POST | public | stripeEvent.create, member.updateMany, member.update, payment.upsert, memberClassPack.create, order.updateMany, …; Stripe; email | N/A — no session authority (Stripe-signed webhook) |
| `/api/tasks/[id]/complete` | POST | session | task.update | REFUSED (proxy) |
| `/api/tasks` | POST | session | task.create | REFUSED (proxy) |
| `/api/upload/delete-orphan` | POST | session | blob | REFUSED (proxy) |
| `/api/upload` | POST | public | blob | REFUSED (proxy) |
| `/api/waiver/kiosk-request` | POST | token | magicLinkToken.updateMany, magicLinkToken.create; email | REFUSED (proxy) |
| `/api/waiver/open` | POST | public | signedWaiver.create, member.update, magicLinkToken.update | REFUSED (proxy) |
| `/api/waiver/sign-for-child` | POST | session | signedWaiver.create, member.update | REFUSED (proxy) |
| `/api/waiver/sign` | POST | session | signedWaiver.create, member.update | REFUSED (proxy + in-route guard) |
| `/api/webhooks/resend` | POST | public | emailLog.update | N/A — no session authority (Resend-signed webhook) |
