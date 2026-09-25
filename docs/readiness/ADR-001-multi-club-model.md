# ADR-001 — Club, location, group and identity model

Status: PROPOSED 2026-09-24 (decision recorded before any auth/schema edit, as the multi-club execution prompt §4 requires). Applies from SHA `9993565`.

## What exists today (read from `prisma/schema.prisma` and `auth.ts`, not from memory)

- **Tenant = club = customer = data boundary.** 46 models, 34 carry `tenantId`; RLS is ENABLED and FORCED on 41 of 47 tables (the six without are non-tenant: migrations, operator/application tables). Verified on the test branch 2026-09-24 by `pg_class.relrowsecurity/relforcerowsecurity`.
- **Application role bypasses RLS.** The URL the app runs on connects as `neondb_owner`, `rolbypassrls = true` (test branch, measured). `RESTRICTED_DATABASE_URL` connects as `matflow_app`, `rolbypassrls = false`, and is what `scripts/test-rls-enforced.mjs` proves 9/9 against. Production is presumed identical (same Neon project shape) — **unverified until Noe runs the role query in the Neon console** (open item on his list). Consequence: in production, RLS is a backstop only for code paths that use the restricted role, i.e. none today; the application-layer `where: { tenantId }` filter plus `withTenantContext` is the real defence. Decision D4 below.
- **Staff identity is per club.** `User @@unique([tenantId, email])`, `role ∈ owner | manager | coach | admin` (CHECK). The same person at two clubs is two `User` rows with no link between them. There is no `Account` table.
- **Member identity is per club.** `Member @@unique([tenantId, email])`; kids via `parentMemberId`; a payer/guardian is the parent row. A person who is a member at two clubs is two rows.
- **Money routing invariant:** `Tenant.stripeAccountId @unique` — one connected account per club, never shared. Webhooks resolve the tenant from `event.account`.
- **No Location, no Group.** A club with two venues is either one tenant (venue in the class name) or two tenants (two Stripe accounts, two rosters). The plan of record (2026-09-20) says "a multi-site club is ONE tenant; Location is a future attribute".
- **Operator plane** is separate (`app/admin/**`, `lib/admin-auth.ts`, its own login + TOTP + impersonation with audit); it is not an "all-clubs user".

## Decisions

| ID | Decision | Why |
|---|---|---|
| D1 | **Club stays the tenant and the only data boundary.** Location and Group are attributes and associations *inside* or *over* tenants; neither creates a new data boundary and neither weakens `tenantId` scoping. | 34 models and every test already assume it; the alternative reopens every query. |
| D2 | **Location = `Location { id, tenantId, name, timezone?, address? }`, additive.** `Class.locationId?`, `User` staff scope via `StaffLocation (userId, locationId)` join, `MembershipTier` eligibility via `TierLocation` join. Existing clubs get one default location on migration; a null `locationId` means "all locations of this club" so single-venue behaviour is unchanged. Timezone stays on the tenant unless a location overrides it. | Smallest change that gives per-venue timetable, capacity and staff scope without touching money. |
| D3 | **Group = `Group { id, name }` + `GroupTenant (groupId, tenantId, role: owner|manager)` + `GroupUser (groupId, personId)`.** A group is an *authorisation association* for switching and combined reporting only. It never shares member PII across clubs, never shares a Stripe account (D5), and never inherits contract terms. Cross-club reports disclose scope, timezone, currency and freshness and do not sum unlike currencies. | The prompt's "explicit ownership association, not unrestricted data sharing". |
| D4 | **Verified person identity across clubs = `Person { id, email @unique, verifiedAt }` linked from `User.personId?` and `Member.personId?`, populated only by an explicit verified flow** (magic-link proof of the address, or an invite accepted while signed in). Never by matching emails. A club switcher is offered only when a `Person` has ≥2 authorised `User` rows. Selected club travels as a signed, validated claim in the session (`tenantId` already does), not a mutable global. | "Group membership, account linking and ownership transfers must be verified and recoverable, never inferred from matching email addresses." |
| D5 | **`Tenant.stripeAccountId @unique` is kept.** A location never has its own merchant until a documented legal-ownership decision says otherwise. Platform SaaS billing (MatFlow charging clubs) is a separate ledger and provider relationship from club→member money, and is not built here. | Webhook routing invariant; liability decision of 17 Sep (Standard Connect, gyms carry their own losses). |
| D6a | **Staff venue scope is a decision for Noe, not built.** On 17 Sep 2026 Noe decided every staff role may open any register in the club (card-scanner A4-viii, "coaches see all classes"). A per-venue restriction on coaches would reverse that. Slice 2 therefore stops at tier eligibility (built 25 Sep) and, if wanted, a *default filter* ("my venue" on the timetable) rather than an access gate. | Respect the standing decision; do not quietly reverse it inside a multi-club package. |
| D6 | **Permission matrix is server-enforced per action × role × club × location.** Today's guards (`requireApiOwner`, `requireApiOwnerOrManager`, `requireApiStaff`, member session, kiosk/display tokens, operator, cron secret) stay; location scope is added as a second check inside the handler for location-scoped resources (class, instance, attendance, roster). Matrix source of truth: `docs/readiness/PERMISSION-MATRIX.md`, generated from the routes. | Authentication is not authorisation; a coach scoped to venue A must not read venue B's roster. |
| D7 | **Last-owner protection.** Removing or demoting the only `owner` of a tenant is refused; ownership transfer is the operator's audited `transfer-ownership` route (exists) or an owner-initiated transfer to an existing manager (to build). | "Prevent orphaning a club by removing its last owner." |
| D8 | **Application DB role must not bypass RLS in production.** Target: app connects as a non-BYPASSRLS role (`matflow_app` pattern already provisioned on the test branch and in CI), migrations use the owner role. Sequenced after the pilot cutover: switching the runtime role is a production config change with its own rehearsal (connection limits, `withRlsBypass` paths, crons). | The measured `rolbypassrls = true` above. |

## Build sequence (each its own package, each with red-on-revert tests; none started yet)

1. D7 last-owner guard (S) and the permission matrix doc (S) — no schema.
2. D2 Location, additive migration + default-location backfill + class/tier/staff scoping + UI in Club settings (L).
3. D4 Person + verified linking + switcher (M–L; reopens `auth.ts`, so it lands alone with the full auth lane green before and after).
4. D3 Group + combined reporting with disclosed scope (M).
5. D8 runtime role change, rehearsed on the test branch, then a production change window (M, config + rehearsal).

## Non-goals
Location-specific merchants; a general custom-role builder; cross-club member PII sharing; per-location currencies.
