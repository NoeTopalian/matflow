# Threat model (campaign of 9 Oct 2026) — coordinator draft, refined by the lanes

Candidate `2a6487e` (source build `c837e38`). This is a working model for the campaign, not a claim of completeness;
rows are added as lanes inventory assets (ASSET-INVENTORY.md) and findings land (FINDINGS.md).

## System in one paragraph
MatFlow is a multi-tenant Next.js 16 application on Vercel (edge proxy + Node runtime) over Neon Postgres via the pooled
host, with NextAuth v5 JWT sessions, tenant isolation by application-layer `tenantId` filters backed by Postgres RLS
(`withTenantContext` sets the tenant per transaction; `withRlsBypass` is used by the operator plane and cross-tenant
jobs). Identities: club staff (`User`: owner / manager / coach), members (`Member`, optionally with a password and TOTP),
MatFlow operators (`Operator`, separate table, MFA + allowlist), and a read-only support-session carrier. Inputs: web
forms and JSON APIs, TeamUp CSV/XLSX imports, uploaded photos, Stripe (Standard Connect) webhooks, Resend mail (dark in
production until DNS is done), magic links / reset codes / activation links delivered by email. Jobs: scheduled
retention/purge, backups (S3 dump — currently failing; Neon PITR is the working recovery).

## Actors and what each can reach
| Actor | Entry | Trust | Primary goals of a hostile actor |
|---|---|---|---|
| Anonymous | public pages, login, reset, magic link, invitations, waiver links, health | none | enumeration, credential guessing, token redemption, SSRF/XSS via public forms |
| Member (with/without password) | member portal, self-service profile, bookings, billing | low | read other members, change identity to take a login, escalate to staff |
| Coach / Manager | dashboard, registers, members, imports (manager) | medium | cross-tenant reads via ids, mass assignment, import-driven identity binding |
| Owner | all club functions, staff management, billing, exports, Undo | high within the club | cross-tenant access, operator-plane reach, destructive actions beyond intent |
| Support session (operator acting as owner, read-only) | club UI with a carrier claim | constrained | writes, operator-plane calls, escalation by cookie mixing |
| Operator (allow-listed, MFA) | /admin and /api/admin | highest | the control plane itself: identity rewrites, impersonation, suspensions, purges |
| Revoked / de-listed operator, stale staff session | old cookies | should be none | continued authority after revocation (SEC-013), fail-open on DB error (SEC-012) |
| Compromised service identity | Resend/Stripe/Vercel/Neon keys, CI secrets | varies | mail abuse, webhook forgery, deploy/env mutation, data exfiltration |
| Malicious imported content | TeamUp files, uploads | data | identity misbinding (SEC-053), formula injection (SEC-052), parser exploitation (SEC-050) |

## Trust boundaries
1. Browser ↔ Vercel edge (proxy/middleware): CSRF, cookies, caching, host/redirect handling, Deployment Protection.
2. Edge ↔ Node route handlers: every handler enforces its own authorization (middleware is not the control).
3. Application ↔ Postgres: role identity (owner vs `matflow_app`), RLS, per-transaction tenant context, advisory locks.
4. Application ↔ email/Stripe/TeamUp/Blob: outbound mail gate (`EMAIL_DELIVERY`), webhook signatures, file parsing.
5. Operator plane ↔ club plane: separate cookies, allowlist, MFA, step-up grants, support-session carrier.
6. Build/deploy chain: lockfile → Vercel build → deployment env (old deployments retain their env), migrations on deploy.
7. Recovery: Neon PITR / branches, S3 dumps (failing), restore procedure, rollback constraints (never Instant Rollback).

## Attack chains the lanes must try (cross-boundary)
- C1 Revoked operator keeps a cookie; the DB blips → does the revocation check fail open into /api/admin? (A, SEC-012/013)
- C2 Member claims a staff address through any writer form the guard misses → logs in as staff via a stale token (B+A, SEC-004/029)
- C3 Imported record with a same name as a real member → attendance fallback binds history to the wrong person → owner
  "corrects" the address → the wrong person receives an activation link (D+B, SEC-053/004)
- C4 Owner session + operator cookie in one browser → combined authority on either plane (A, SEC-016)
- C5 Old deployment URL with the old shared admin secret and mail on → operator-plane reach outside the allowlist (E, SEC-066/067)
- C6 Forged Stripe webhook → entitlement or billing state change across tenants (D, SEC-089/090)
- C7 Export/list with a foreign tenant id or cursor → cross-tenant disclosure under the deployed DB role (B, SEC-017/022/021)
- C8 Audit write fails during a privileged change → change lands unrecorded, or the failure looks like success (F, SEC-081)
- C9 Backup/rollback revives an old secret or an old authorization bypass (F, SEC-087)

## Out of scope for this campaign (stated, not hidden)
Third-party probing (Vercel, Neon, Resend, Stripe infrastructure), live production load, phishing/social-engineering
exercises against real people, registration of any external resource. Developer-endpoint and recovery-fraud rows
(SEC-094/095) are tabletop/manual and recorded as such.
