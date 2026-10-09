# withRlsBypass call-site inventory (lane B, iteration 2)

Generated 9 Oct 2026 from HEAD 6043fed by a static scan (scratch script inventory.mjs): every `withRlsBypass(` in app/, lib/, auth.ts, excluding its definition. "Models touched" lists Prisma delegate calls within 900 characters after each call — a reading aid, not proof of everything a block does. Class = the replacement path under the SF-62 design (02-boundary-design.md):

- PUBLIC-TOKEN / PRE-TENANT: a matflow_sec resolver (slug, kiosk/display token hash, magic-link/reset token hash) then a signed tenant context; GymApplication (no tenant) stays a grant-only platform table.
- WEBHOOK: tenant_id_by_stripe_account / provider id resolver, then signed context; StripeEvent is a platform table (no RLS).
- SHARED-LIB: the session already names the tenant: signed context for that tenant (session-revocation runs on every authenticated request).
- CRON / OPERATOR: the operator credential (matflow_ops) through a separate client, ideally in a separate deployment; audit purge through the narrow function only.

    total call sites: 116 in 59 files
    {"CRON":{"files":4,"calls":14},"OPERATOR":{"files":27,"calls":65},"PRE-TENANT (slug/login)":{"files":3,"calls":7},"PUBLIC-TOKEN":{"files":18,"calls":22},"SHARED-LIB":{"files":5,"calls":5},"WEBHOOK":{"files":2,"calls":3}}

| class | file | calls | models touched (first 900 chars after each call) |
|---|---|---|---|
| CRON | app/api/cron/retention/route.ts | 10 | importJob.count, importJob.findMany, importJob.delete, importJob.update, importUpload.delete |
| CRON | lib/stripe/reconcile.ts | 2 | tenant.findMany, stripeEvent.findMany |
| CRON | app/api/cron/class-instances/route.ts | 1 | tenant.findMany |
| CRON | app/api/cron/monthly-reports/route.ts | 1 | tenant.findMany, monthlyReport.create |
| OPERATOR | app/api/admin/customers/[id]/suspend/route.ts | 6 | tenant.findUnique, member.findMany, tenant.update, auditLog.findFirst |
| OPERATOR | lib/tenant-purge.ts | 6 | tenant.findMany, importJob.findMany, importJob.delete, tenant.findUnique, tenant.delete, auditLog.create |
| OPERATOR | app/api/admin/customers/[id]/soft-delete/route.ts | 5 | tenant.findUnique, member.findMany, tenant.update, user.update, member.update, auditLog.findFirst |
| OPERATOR | app/api/admin/applications/[id]/approve/route.ts | 4 | gymApplication.findUnique, tenant.findUnique, tenant.create, gymApplication.update |
| OPERATOR | app/api/admin/customers/[id]/review-lock/route.ts | 4 | tenant.findUnique, tenant.update |
| OPERATOR | app/admin/page.tsx | 3 | tenant.count, tenant.findMany, gymApplication.count, user.findMany, payment.aggregate |
| OPERATOR | app/api/admin/customers/[id]/force-password-reset/route.ts | 3 | tenant.findUnique, user.findFirst, user.findUnique, passwordHistory.create, user.update |
| OPERATOR | app/api/admin/customers/[id]/login-email/route.ts | 3 | user.findFirst, user.update |
| OPERATOR | app/api/admin/customers/[id]/member-totp-reset/route.ts | 3 | tenant.findUnique, member.findFirst, member.update |
| OPERATOR | app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts | 3 | tenant.findUnique, member.findFirst |
| OPERATOR | app/api/admin/customers/[id]/totp-reset/route.ts | 3 | tenant.findUnique, user.findFirst, user.update |
| OPERATOR | app/api/admin/customers/[id]/transfer-ownership/route.ts | 3 | user.findMany, tenant.findUnique, user.findFirst |
| OPERATOR | app/api/admin/applications/[id]/reject/route.ts | 2 | gymApplication.findUnique, gymApplication.update |
| OPERATOR | app/api/admin/customers/[id]/owner-profile/route.ts | 2 | user.findFirst, user.update |
| OPERATOR | app/api/admin/customers/[id]/revoke-access/route.ts | 2 | tenant.findUnique, user.findFirst, member.findFirst, user.update |
| OPERATOR | app/api/admin/impersonate/route.ts | 2 | user.findUnique |
| OPERATOR | app/admin/billing/page.tsx | 1 | payment.aggregate, payment.groupBy, dispute.aggregate |
| OPERATOR | app/admin/tenants/page.tsx | 1 | tenant.findMany |
| OPERATOR | app/admin/tenants/[id]/page.tsx | 1 | tenant.findUnique |
| OPERATOR | app/api/admin/activity/route.ts | 1 | auditLog.findMany |
| OPERATOR | app/api/admin/applications/route.ts | 1 | gymApplication.findMany |
| OPERATOR | app/api/admin/auth/operator-totp/setup/route.ts | 1 | operator.update |
| OPERATOR | app/api/admin/create-tenant/route.ts | 1 | tenant.create |
| OPERATOR | app/api/admin/customers/[id]/login-email/check/route.ts | 1 | tenant.findUnique, user.findFirst |
| OPERATOR | lib/impersonation.ts | 1 | user.findUnique |
| OPERATOR | lib/operator-step-up.ts | 1 |  |
| OPERATOR | lib/review-lock.ts | 1 | tenant.findUnique |
| PRE-TENANT (slug/login) | auth.ts | 5 | tenant.findUnique, user.findFirst, user.findUnique |
| PRE-TENANT (slug/login) | app/api/apply/route.ts | 1 | gymApplication.create |
| PRE-TENANT (slug/login) | app/api/tenant/[slug]/route.ts | 1 | tenant.findUnique |
| PUBLIC-TOKEN | app/api/magic-link/verify/route.ts | 2 | magicLinkToken.findUnique, tenant.findUnique, magicLinkToken.update |
| PUBLIC-TOKEN | app/api/members/accept-invite/route.ts | 2 | magicLinkToken.findUnique, member.findFirst, member.findUnique |
| PUBLIC-TOKEN | app/api/waiver/kiosk-status/route.ts | 2 | magicLinkToken.findUnique, member.findFirst |
| PUBLIC-TOKEN | app/api/waiver/open/route.ts | 2 | magicLinkToken.findUnique, tenant.findUnique |
| PUBLIC-TOKEN | app/api/account/pending-tenant/route.ts | 1 | tenant.findUnique |
| PUBLIC-TOKEN | app/api/auth/disown-login/[token]/route.ts | 1 | loginEvent.findUnique, user.update, member.update |
| PUBLIC-TOKEN | app/api/auth/forgot-password/route.ts | 1 | tenant.findUnique |
| PUBLIC-TOKEN | app/api/auth/reset-password/route.ts | 1 | tenant.findUnique |
| PUBLIC-TOKEN | app/api/auth/totp/recover/route.ts | 1 | tenant.findUnique, user.findFirst |
| PUBLIC-TOKEN | app/api/kiosk/[token]/checkin/route.ts | 1 | tenant.findFirst |
| PUBLIC-TOKEN | app/api/kiosk/[token]/classes/route.ts | 1 | tenant.findFirst |
| PUBLIC-TOKEN | app/api/kiosk/[token]/members/route.ts | 1 | tenant.findFirst |
| PUBLIC-TOKEN | app/api/magic-link/request/route.ts | 1 | tenant.findUnique, user.findFirst, member.findFirst |
| PUBLIC-TOKEN | app/api/member/totp/recover/route.ts | 1 | tenant.findUnique, member.findFirst |
| PUBLIC-TOKEN | app/api/waiver/kiosk-request/route.ts | 1 | tenant.findFirst |
| PUBLIC-TOKEN | app/kiosk/[token]/page.tsx | 1 | tenant.findFirst |
| PUBLIC-TOKEN | app/leaderboard/[token]/page.tsx | 1 | tenant.findFirst |
| PUBLIC-TOKEN | lib/leaderboard.ts | 1 | attendanceRecord.groupBy, member.findMany |
| SHARED-LIB | lib/audit-log.ts | 1 |  |
| SHARED-LIB | lib/email.ts | 1 | user.findFirst |
| SHARED-LIB | lib/notify-member-action.ts | 1 | tenant.findUnique |
| SHARED-LIB | lib/promotion-candidates.ts | 1 | memberRank.findMany, rankRequirement.findMany |
| SHARED-LIB | lib/session-revocation.ts | 1 | member.findUnique, user.findUnique |
| WEBHOOK | app/api/webhooks/resend/route.ts | 2 | emailLog.findUnique, emailLog.update |
| WEBHOOK | app/api/stripe/webhook/route.ts | 1 | stripeEvent.create, tenant.findFirst |
