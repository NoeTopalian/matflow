# MatFlow Account Scope And Security Spec

Date: 2026-04-30
Owner: MatFlow
Status: Draft for implementation planning

## Purpose

Define how MatFlow should isolate tenants, separate owner/staff/member access, secure sessions, and maintain that posture over time.

This spec is for:
- cross-tenant data isolation
- account-level access control
- owner/staff/member boundary enforcement
- session and cookie safety
- operational controls needed to keep the system secure after launch

This spec is based on:
- current MatFlow architecture in this repo
- existing audit findings in [docs/AUDIT-2026-04-27.md](C:/Users/NoeTo/Desktop/matflow/docs/AUDIT-2026-04-27.md)
- current feature backlog in [docs/FEATURE_REQUESTS_2026-04-29.md](C:/Users/NoeTo/Desktop/matflow/docs/FEATURE_REQUESTS_2026-04-29.md)
- OWASP Authorization, Authentication, Session Management, and Logging guidance
- NIST SP 800-63B session guidance
- PostgreSQL row-level security documentation

## Core Principles

1. Deny by default.
2. Every request must be scoped by both identity and tenant.
3. UI hiding is never security; the server is the real gate.
4. Public routes must be explicitly allowlisted and independently authenticated by signed tokens, webhook signatures, or bearer secrets.
5. Sensitive state changes must be logged.
6. Security rules must be testable and regression-resistant.

## Current Architecture Baseline

MatFlow currently uses:
- Next.js App Router
- NextAuth v5 beta
- Prisma + Postgres
- app-layer tenant isolation via `tenantId`
- role-based access via `owner | manager | coach | admin | member`
- public routes such as `/login`, `/checkin/[slug]`, and selected webhooks

This is a valid base, but it must be tightened so tenant scoping and role checks are systematic rather than easy to miss.

## Threat Model

The main risks to defend against are:
- member accessing owner/staff data
- staff accessing another tenant's data by guessing IDs
- owner session leaking into public kiosk/member flows
- public endpoints being abused without signature or rate-limit checks
- stale sessions retaining privileges after role changes
- direct object reference bugs caused by bare `id` lookups
- future code drift where a developer forgets tenant or role checks

## Security Targets

MatFlow should meet these practical targets before wider launch:
- no cross-tenant reads or writes from guessed IDs
- no member access to owner/staff routes or APIs
- role downgrades invalidate existing privileged sessions
- all public endpoints authenticate themselves without relying on ambient cookies
- all sensitive changes are auditable by tenant, user, route, and timestamp
- authorization behavior is covered by automated tests

## 1. Identity And Account Model

MatFlow should formally treat these as separate security principals:
- Owner
- Manager
- Coach
- Admin
- Member

Rules:
- A `User` is a staff-side principal.
- A `Member` is a member-side principal.
- Do not blur the two by sharing server routes without explicit role checks.
- Every principal belongs to exactly one tenant in normal operation.

Recommended policy:
- staff-side routes live under `/dashboard/*`
- member-side routes live under `/member/*`
- public routes are explicit and short

## 2. Authorization Model

Use layered authorization:

1. Route-level gate
   - block entire route families early
   - examples:
     - `/dashboard/*` requires non-member
     - `/member/*` requires member
     - public routes must be in an explicit public allowlist

2. Handler-level gate
   - every API route must enforce the correct role
   - examples:
     - owner-only settings and Stripe actions
     - coach-limited class/register access
     - member-only self-service APIs

3. Data-level gate
   - every read and write must also be tenant-scoped
   - role checks alone are not enough

OWASP guidance strongly favors validating authorization on every request and using least privilege. MatFlow should follow that model.

## 3. Tenant Isolation Model

MatFlow should keep app-layer tenant isolation as the primary control:
- every tenant-owned model must be queried with `tenantId`
- no bare `findUnique({ where: { id } })` on tenant-owned tables in request handlers
- post-update read-backs must also be tenant-scoped

Required implementation rule:
- any table with tenant-owned business data must use one of:
  - `where: { id, tenantId }`
  - `where: { tenantId, ... }`
  - relation path anchored from an already tenant-scoped parent

Recommended code standard:
- add a lint rule or helper banning bare `findUnique({ where: { id } })` inside `app/api/**`
- prefer helper wrappers such as:
  - `requireOwner()`
  - `requireStaff()`
  - `requireMember()`
  - `withTenantScope()`

## 4. Database Defense-In-Depth

Short term:
- keep Prisma app-layer tenant scoping as the main control
- add indexes for hot tenant filters
- add uniqueness and transactional protections where races exist

Medium term:
- introduce PostgreSQL Row-Level Security for highest-risk tables if MatFlow moves toward more raw SQL, reporting jobs, or shared service layers

If RLS is introduced later:
- enable RLS only after a clear rollout plan
- set a per-request tenant context in SQL
- use `USING` and `WITH CHECK` policies for read and write isolation
- do not rely on table owner bypass behavior; use `FORCE ROW LEVEL SECURITY` if appropriate

RLS is not required on day one, but it is strong defense-in-depth for a multi-tenant SaaS.

## 5. Session And Cookie Security

MatFlow should follow these session rules:
- cookies must be `Secure`, `HttpOnly`, and `SameSite=Lax` or stricter where possible
- owner/staff sessions and member flows must not share unsafe assumptions
- public kiosk and webhook routes must not depend on ambient session cookies
- sessions must rotate or be invalidated on:
  - password reset
  - logout-all
  - role downgrade
  - account disable
  - suspicious auth recovery events

Required behavior:
- bump `sessionVersion` whenever a user's role changes
- bump `sessionVersion` on logout-all
- require reauthentication for high-risk actions if later needed:
  - Stripe disconnect
  - TOTP disable
  - changing billing contact details

NIST and OWASP both support session invalidation after risk events and privilege changes.

## 6. Public Route Model

Public routes must be explicit and self-authenticating.

Allowed public route classes:
- login and reset flows
- legal pages
- kiosk/check-in pages
- Stripe webhook
- Resend webhook
- cron endpoints with bearer secret

Rules:
- public route access must never imply access to tenant internals
- if a route is public, it must protect itself with one of:
  - signed HMAC token
  - webhook signature verification
  - scoped bearer secret
  - one-time token
- public routes should not reveal whether a tenant or member exists if they can avoid it

Examples:
- QR check-in token validates tenant + member + class window
- Stripe webhook validates Stripe signature
- Resend webhook validates Svix signature
- cron endpoint validates `CRON_SECRET`

## 7. Owner / Member Separation

The product should feel and behave like two separate surfaces:
- back office
- member app

Required boundary rules:
- members cannot access `/dashboard/*`
- owners/staff should not accidentally use member-only APIs for privileged work
- kiosk pages should not inherit back-office session behavior

Recommended product rule:
- keep owner login and member login visually distinct enough to reduce confusion
- if later needed, consider separate subdomains for stronger operational separation:
  - `app.matflow.io` for back office
  - `members.club-domain.com` or `club.matflow.app` for member side

Subdomains are not mandatory yet, but they are the cleanest long-term isolation model.

## 8. Webhook And Third-Party Security

Every integration endpoint must be authenticated independently.

Required controls:
- Stripe webhook:
  - verify signature
  - reject missing account context where required
  - keep idempotency table
  - wrap related writes in transactions
- Resend webhook:
  - verify Svix signature
  - reject unsigned requests
- Google Drive:
  - validate folder IDs
  - encrypt refresh tokens at rest
  - log connect/disconnect/indexing actions

Secret handling:
- never hardcode secrets
- never log raw secrets
- keep JWT secret separate from any data-encryption key

## 9. Data Classification And Audit Logging

Security-sensitive events must be logged consistently.

Minimum audit events:
- login success/failure
- logout-all
- password reset issued/consumed
- TOTP enable/disable/verify
- role change
- tenant settings update
- member waiver signed
- manual payment recorded
- refund created
- Stripe connect/disconnect
- staff invite/create/update/delete

Audit fields:
- request ID
- tenant ID
- actor user/member ID if known
- action name
- entity type
- entity ID
- timestamp
- source IP where appropriate
- user agent where appropriate

Do not log:
- raw passwords
- reset tokens
- session cookies
- full bearer secrets
- raw Stripe/Resend credentials

OWASP logging guidance strongly supports structured, correlation-friendly event logs.

## 10. Secure Error Handling

Client responses must be generic.

Rules:
- never return raw exception messages from Prisma, Stripe, Google, or internal services
- always log the real error server-side
- return stable response shapes such as:
  - `{ ok: false, error: "Unable to complete request." }`

Why:
- prevents leaking SQL details, service internals, or credential patterns
- makes monitoring cleaner

## 11. Rate Limiting And Abuse Protection

Minimum rate limits:
- login:
  - per email + tenant
  - per IP
- forgot password
- magic-link request
- waiver signing
- QR check-in
- class-pack purchase
- admin tenant creation

Recommended extras:
- suspicious repeated failures feed audit logs
- consider temporary lockouts or cool-downs for repeated abuse

## 12. Input Validation And Output Safety

Required:
- validate all external input server-side with Zod or equivalent
- validate URLs and allow only safe protocols
- validate phone numbers and date ranges
- sanitize tenant-controlled branding fields before injecting into styles
- never use `dangerouslySetInnerHTML` for untrusted content unless sanitized by a trusted HTML sanitizer policy

Special note for MatFlow:
- tenant branding values can become a CSS injection vector if treated too loosely
- announcement/body linkification must use safe element generation, not raw HTML insertion

## 13. Transaction Safety

Any workflow with more than one durable write must be reviewed for atomicity.

Use DB transactions for:
- manual payment create + member payment status update
- refund ledger updates
- webhook ledger/member updates
- class-pack purchase grant + ledger write
- waiver acceptance snapshot + member acceptance flags if both are written together
- password reset token consume + password update + session invalidation

If a workflow is not transactional, document why.

## 14. Testing Requirements

Security and tenant scope must be enforced by tests, not memory.

Required test layers:

1. Route authorization tests
   - member cannot access owner routes
   - owner cannot accidentally use member-only paths where blocked

2. Tenant isolation tests
   - guessed IDs from tenant B never return tenant B data while authenticated as tenant A
   - QR tokens for wrong tenant fail generically

3. Session invalidation tests
   - role downgrade invalidates old session
   - logout-all invalidates prior JWTs

4. Webhook auth tests
   - unsigned Stripe/Resend webhook rejected

5. Regression tests for public routes
   - `/checkin/[slug]` stays public
   - `/api/stripe/webhook` stays reachable without dashboard auth

6. Security smoke tests in CI
   - no new bare `findUnique({ id })` on tenant-owned models
   - no new `return { error: e.message }` style leaks

## 15. Operational Maintenance Spec

Security is not one fix; it needs maintenance.

Required operational practices:
- exact package pinning for critical auth/payment libs where needed
- dependency review at least monthly
- secret rotation procedure documented
- production env vars managed only in platform secret store
- no live secrets committed to repo
- quarterly authorization review:
  - owner routes
  - member routes
  - public prefixes
  - role matrix
- pre-release checklist for any auth/payment/tenant-scope change

Recommended cadence:
- monthly:
  - dependency updates
  - webhook secret verification
  - audit log spot-check
- quarterly:
  - access control review
  - role matrix review
  - security test review
- annually:
  - secret rotation exercise
  - incident response tabletop

## 16. MatFlow Implementation Plan

### Phase 0 - Immediate

Before broader launch:
- enforce proxy-level route family gates
- ensure all owner/staff APIs also validate role server-side
- remove raw error-message leaks
- verify Stripe and Resend webhook signatures
- bump `sessionVersion` on role changes
- add per-IP login rate limit alongside per-email rate limit
- complete tenant-scope sweep on bare `id` reads
- add `Cache-Control: no-store` on sensitive auth/account GETs

### Phase 1 - Launch Hardening

- create shared auth/tenant helpers for API handlers
- add request ID logging
- add regression tests for tenant isolation and role access
- separate encryption key from auth secret
- transaction-wrap multi-write money/auth flows
- standardize API error shape

### Phase 2 - Defense In Depth

- evaluate separate owner/member subdomains
- evaluate Postgres RLS for highest-risk tables
- add admin security review checklist for any new public endpoint
- expand audit dashboards for auth/payment events

## 17. Acceptance Criteria

This spec is achieved when:

- a member cannot access any owner/staff page or owner/staff API
- a staff user from tenant A cannot read or mutate tenant B data by changing IDs
- all public endpoints are explicit and independently authenticated
- role changes invalidate existing privileged sessions
- webhook endpoints reject unsigned requests
- multi-write auth/payment workflows are transactional
- audit logs exist for all sensitive state changes
- CI contains authorization and tenant-isolation regression tests
- no production secret is stored in source control

## 18. Product-Specific Recommendations For MatFlow

For this repo specifically:
- keep Neon/Postgres; Supabase is not required
- keep Prisma + app-layer `tenantId` scope as the baseline
- add stronger helper/lint enforcement so tenant scope is hard to forget
- treat `/checkin/[slug]` as a public kiosk surface with no dependence on dashboard auth
- keep owner billing control as the default product posture
- separate owner and member visual flows more clearly over time, even if they remain on one domain for now

## 19. References

- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OWASP ASVS Access Control: https://github.com/OWASP/ASVS/blob/master/4.0/en/0x12-V4-Access-Control.md
- NIST SP 800-63B: https://pages.nist.gov/800-63-4/sp800-63b.html
- PostgreSQL Row Security Policies: https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- PostgreSQL CREATE POLICY: https://www.postgresql.org/docs/current/sql-createpolicy.html
