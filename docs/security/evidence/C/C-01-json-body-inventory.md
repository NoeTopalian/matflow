# C-01a JSON/body boundary inventory (generated)

Generated 9 Oct 2026 by `node docs/security/evidence/C/scripts/body-inventory.cjs <repoRoot> --md <out>` over the working tree on `5680c5d` (lanes A/B uncommitted edits included). TypeScript-AST scan of every `app/api/**/route.ts` that reads a body: zod parse calls, `z.object` (strip) vs strict counts, loose constructs (`passthrough`/`catchall`/`looseObject`/`z.record`), schema keys matching a sensitive-name list, and whether a parsed object is spread into a write. A map for reviewers, not a proof; the behavioural proof is `tests/unit/sec-c-body-canary-sweep.test.ts`.

| Route | Methods | Body | Parse | z.object (strip) / strict | Loose | Sensitive keys accepted | Spread into write | Imported schemas |
|---|---|---|---|---|---|---|---|---|
| `/api/account/login-email` | GET POST | json | bodySchema | 1/0 |  | currentPassword |  | emailField <- @/lib/email-normalise |
| `/api/account/password` | POST | json | bodySchema, staffPasswordSchema | 1/1 |  | currentPassword, newPassword |  | PASSWORD_HISTORY_LIMIT, passwordReused, recentPasswordHashes, recordPasswordHistory, staffPasswordSchema, <- @/lib/password-policy |
| `/api/account/pending-tenant` | POST | json | schema | 1/0 |  | tenantSlug |  |  |
| `/api/account/profile` | GET PATCH | json | patchSchema | 1/1 |  |  |  | displayNameSchema <- @/lib/account-profile |
| `/api/admin/applications/[id]/approve` | POST | text | JSON, bodySchema | 1/0 |  |  |  |  |
| `/api/admin/applications/[id]/reject` | POST | text | schema, JSON | 1/0 |  |  |  |  |
| `/api/admin/auth/login` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/admin/auth/operator-login` | POST | json | schema | 1/0 |  | email, password |  |  |
| `/api/admin/auth/operator-totp` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/admin/auth/operator-totp/setup` | GET POST | json | schema | 1/0 |  |  |  |  |
| `/api/admin/auth/step-up` | POST | json | schema | 1/1 | record |  |  |  |
| `/api/admin/create-tenant` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/admin/customers/[id]/force-password-reset` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/admin/customers/[id]/login-email/check` | POST | json | bodySchema | 1/1 |  | email |  | emailField <- @/lib/email-normalise |
| `/api/admin/customers/[id]/login-email` | POST | json | bodySchema | 3/0 |  |  |  | emailField <- @/lib/email-normalise |
| `/api/admin/customers/[id]/member-totp-reset` | POST | json | bodySchema | 1/0 |  | memberId |  |  |
| `/api/admin/customers/[id]/members/[memberId]/contact-email` | POST | json | bodySchema | 1/1 |  |  |  | emailField, normaliseEmail <- @/lib/email-normalise |
| `/api/admin/customers/[id]/owner-profile` | POST | json | bodySchema | 1/1 |  |  |  | displayNameSchema <- @/lib/account-profile |
| `/api/admin/customers/[id]/review-lock` | POST DELETE | json | bodySchema | 1/0 |  |  |  |  |
| `/api/admin/customers/[id]/revoke-access` | POST | json | bodySchema | 3/3 |  |  |  |  |
| `/api/admin/customers/[id]/soft-delete` | POST DELETE | json | bodySchema | 1/0 |  |  |  |  |
| `/api/admin/customers/[id]/suspend` | POST DELETE | json | bodySchema | 1/0 |  |  |  |  |
| `/api/admin/customers/[id]/totp-reset` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/admin/customers/[id]/transfer-ownership` | GET POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/admin/email/test` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/admin/impersonate` | POST DELETE | json | startSchema | 1/0 |  |  |  |  |
| `/api/admin/import/attendance` | POST GET DELETE | json | **none** | 0/0 |  |  |  |  |
| `/api/admin/import/upload` | POST | form | **none** | 0/0 |  |  |  |  |
| `/api/admin/import/uploads` | POST | json | **none** | 0/0 |  |  |  |  |
| `/api/announcements/[id]` | PATCH DELETE | json | updateSchema | 1/0 |  |  | yes |  |
| `/api/announcements` | GET POST | json | createSchema | 0/0 |  |  |  | announcementCreateSchema as createSchema <- @/lib/schemas/announcement |
| `/api/apply` | POST | json | applySchema | 1/0 |  | email |  | notesField <- @/lib/schemas/notes-sanitiser |
| `/api/audit-log/undo-to` | POST | json | bodySchema | 1/0 |  | userId |  |  |
| `/api/auth/forgot-password` | POST | json | bodySchema | 1/0 |  | email, tenantSlug |  |  |
| `/api/auth/reset-password` | POST | json | staffPasswordSchema, bodySchema | 1/0 |  | email, tenantSlug, password |  | PASSWORD_HISTORY_LIMIT, passwordReused, recentPasswordHashes, recordPasswordHistory, staffPasswordSchema, <- @/lib/password-policy |
| `/api/auth/set-password` | POST | json | bodySchema | 1/0 |  | password |  | passwordReused, recentPasswordHashes, recordPasswordHistory, staffPasswordSchema <- @/lib/password-policy |
| `/api/auth/totp/recover` | POST | json | schema | 1/0 |  | email, tenantSlug |  |  |
| `/api/auth/totp/recovery-codes` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/auth/totp/setup` | GET POST | json | **none** | 0/0 |  |  |  |  |
| `/api/auth/totp/verify` | POST | json | **none** | 0/0 |  |  |  |  |
| `/api/checkin/card` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/checkin` | POST DELETE | json | checkinSchema | 1/0 |  | memberId |  |  |
| `/api/class-packs/[id]` | PATCH DELETE | json | patchSchema | 1/0 |  |  | yes |  |
| `/api/class-packs` | GET POST | json | createSchema | 1/0 |  |  |  |  |
| `/api/classes/[id]/instances/[instanceId]` | PATCH | json | cancelSchema | 1/0 |  |  |  |  |
| `/api/classes/[id]/instances` | GET POST | json | genSchema | 1/0 |  |  |  |  |
| `/api/classes/[id]/roster` | GET POST | json | addSchema | 1/0 |  | memberId |  |  |
| `/api/classes/[id]` | GET PATCH DELETE | json | updateSchema | 2/0 |  | memberId |  | scheduleSchema <- @/lib/schemas/class |
| `/api/classes` | GET POST | json | createSchema | 0/0 |  |  |  | classCreateSchema as createSchema <- @/lib/schemas/class |
| `/api/coach/instances/[id]/attendance` | POST | json | schema | 1/0 |  | memberId | yes |  |
| `/api/drive/select-folder` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/initiatives/[id]/attachments` | POST DELETE | form | **none** | 0/0 |  |  |  |  |
| `/api/initiatives/[id]` | PATCH DELETE | json | Date, updateSchema | 1/0 |  |  |  |  |
| `/api/initiatives` | GET POST | json | Date, createSchema | 1/0 |  |  |  |  |
| `/api/instances/generate` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/kiosk/[token]/checkin` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/locations/[id]` | PATCH DELETE | json | updateSchema | 1/0 |  |  |  |  |
| `/api/locations` | GET POST | json | createSchema | 1/0 |  |  |  |  |
| `/api/magic-link/request` | POST | json | schema | 1/0 |  | email, tenantSlug |  |  |
| `/api/member/checkout` | POST | json | bodySchema | 2/0 |  |  |  |  |
| `/api/member/children/[id]/photos` | GET POST | json | createSchema | 1/0 |  |  |  |  |
| `/api/member/children/[id]` | GET PATCH DELETE | json | **none** | 0/0 |  |  |  | assertMayMutateFamily, carriesForbiddenFamilyField, CHILD_FIELDS_MEMBERS_MAY_NEVER_SET <- @/lib/family-authority |
| `/api/member/children` | POST | json | bodySchema | 1/0 |  | accountType |  |  |
| `/api/member/class-packs/buy` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/member/me` | GET PATCH | json | memberSelfUpdateSchema | 0/0 |  |  |  | carriesForbiddenFamilyField <- @/lib/family-authority; stripTotpFields <- @/lib/totp-immutable; memberSelfUpdateSchema <- @/lib/schemas/member |
| `/api/member/subscriptions/cancel-for-kid` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/member/subscriptions/start-for-kid` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/member/subscriptions/start` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/member/totp/recover` | POST | json | schema | 1/0 |  | email, tenantSlug |  |  |
| `/api/member/totp/setup` | GET POST | json | **none** | 0/0 |  |  |  |  |
| `/api/member/totp/verify` | POST | json | **none** | 0/0 |  |  |  |  |
| `/api/members/[id]/card/revoke` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members/[id]/charge` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members/[id]/guardian` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members/[id]/hold` | POST | json | **none** | 0/0 |  |  |  |  |
| `/api/members/[id]/link-child` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members/[id]/photos` | GET POST DELETE | json | postSchema | 1/0 |  |  |  |  |
| `/api/members/[id]/profile-picture` | PUT DELETE | json | putSchema | 1/0 |  |  |  |  |
| `/api/members/[id]/rank/demote` | POST | json | demoteSchema | 1/0 |  |  |  |  |
| `/api/members/[id]/rank` | POST | json | assignSchema | 1/0 |  |  |  | notesField <- @/lib/schemas/notes-sanitiser |
| `/api/members/[id]` | GET PATCH DELETE | json | updateSchema | 0/0 |  |  | yes | memberUpdateSchema as updateSchema <- @/lib/schemas/member; stripTotpFields <- @/lib/totp-immutable |
| `/api/members/[id]/totp-reset` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members/[id]/unlink-child` | DELETE | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members/[id]/waiver/sign` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/members/accept-invite` | POST | json | schema | 1/0 |  | password |  |  |
| `/api/members/bulk-invite` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/members` | GET POST | json | schema | 0/0 |  |  |  | memberCreateSchema <- @/lib/schemas/member |
| `/api/memberships/[id]` | PATCH DELETE | json | patchSchema | 1/0 |  |  | yes | billingCycleSchema <- @/lib/billing-cycle |
| `/api/memberships` | GET POST | json | createSchema | 1/0 |  |  |  | billingCycleSchema <- @/lib/billing-cycle |
| `/api/onboarding/csv-handoff` | POST | form | **none** | 0/0 |  |  |  |  |
| `/api/orders/[id]/mark-paid` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/payments/[id]/refund` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/payments/chase` | POST | json | bodySchema | 1/0 |  | memberId |  |  |
| `/api/payments/intent` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/payments/manual` | POST | json | Date, schema | 1/0 |  | memberId |  |  |
| `/api/payments/outstanding` | GET | json | **none** | 0/0 |  |  |  |  |
| `/api/products/[id]` | PATCH DELETE | json | patchSchema | 1/0 |  |  | yes |  |
| `/api/products` | GET POST | json | createSchema | 1/0 |  |  | yes |  |
| `/api/push/subscribe` | POST | json | schema | 2/0 |  |  |  |  |
| `/api/ranks/[id]` | PATCH DELETE | json | updateSchema | 1/0 |  |  | yes |  |
| `/api/ranks` | GET POST | json | createSchema | 1/0 |  |  |  |  |
| `/api/settings/display` | POST GET | json | bodySchema | 1/0 |  |  |  |  |
| `/api/settings/kiosk` | POST GET | json | bodySchema | 1/0 |  |  |  |  |
| `/api/settings` | GET PATCH | json | updateSchema | 1/1 | record | contactEmail |  |  |
| `/api/staff/[id]` | PATCH DELETE | json | updateSchema | 1/0 |  | email, role, newPassword | yes | emailField <- @/lib/email-normalise; stripTotpFields <- @/lib/totp-immutable; staffPasswordSchema <- @/lib/password-policy |
| `/api/staff/[id]/totp-reset` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/staff/[id]/transfer-ownership` | POST | json | bodySchema | 1/0 |  | password |  |  |
| `/api/staff` | GET POST | json | createSchema | 1/0 |  | email, role, password |  | emailField <- @/lib/email-normalise; staffPasswordSchema <- @/lib/password-policy |
| `/api/stripe/create-subscription` | POST | json | createSubscriptionSchema | 1/0 |  | memberId |  |  |
| `/api/stripe/migrate-memberships` | GET POST | json | applySchema | 1/0 |  |  |  |  |
| `/api/stripe/subscription-plans` | GET POST | json | createPlanSchema | 1/0 |  |  |  |  |
| `/api/stripe/webhook` | POST | text | **none** | 0/0 |  |  |  |  |
| `/api/tasks` | GET POST | json | createSchema, titleSanitiser, bodySanitiser | 2/0 |  |  |  | notesField <- @/lib/schemas/notes-sanitiser |
| `/api/upload/delete-orphan` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/upload` | POST | form | **none** | 0/0 |  |  |  |  |
| `/api/waiver/kiosk-request` | POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/waiver/open` | GET POST | json | bodySchema | 1/0 |  |  |  |  |
| `/api/waiver/sign-for-child` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/waiver/sign` | POST | json | schema | 1/0 |  |  |  |  |
| `/api/webhooks/resend` | POST | text | JSON | 0/0 |  |  |  |  |
