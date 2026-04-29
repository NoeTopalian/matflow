# Sprint 3 Pre-Flight Security Audit

**Verdict:** PROCEED (after blockers fixed in same session)
**Date:** 2026-04-29
**Reviewer:** oh-my-claudecode:security-reviewer
**Status:** All P0/P1 findings resolved before Batch K execution started.

## Findings & resolution

### P0 — Magic-link auth bypass on kid sub-accounts (FIXED)

**Risk:** Kid Members are created with `passwordHash = null` (passwordless invariant), but the magic-link request handler at `app/api/auth/magic-link/request/route.ts:36-41` only filtered by `tenantId + email`, not by `passwordHash IS NOT NULL`. An attacker who could guess a synthesised kid email (`kid-{nanoid}@no-login.matflow.local`) would receive a working magic link.

**Fix:** Added `passwordHash: { not: null }` to the lookup in BOTH the request handler and `app/api/auth/magic-link/verify/route.ts` (defence in depth — even if a token row exists, the verify step refuses to mint a session for a passwordless member).

### P1 — GET /api/members has no role check (FIXED)

**Risk:** Pre-existing — any authenticated session (incl. members) could enumerate the entire member list. Sprint 3 makes it materially worse by adding kid PII to the response.

**Fix:** Added `["owner","manager","admin","coach"].includes(role)` gate at the top of GET. Members and unauthenticated callers now receive 403.

### P1 — Synthesised kid email leaks tenantId (FIXED)

**Risk:** Plan v2 specified `kid-{nanoid}@no-login.{tenantId}.matflow.local`. The Tenant CUID would leak into logs / CSV exports / error messages, enabling targeted cross-tenant probing of any endpoint that accepts tenantId as a parameter.

**Fix:** Dropped the tenant component. Email is now `kid-{nanoid}@no-login.matflow.local` with a 16-byte hex nanoid (2^128 collision space). Per-tenant uniqueness is still guaranteed by the `@@unique([tenantId, email])` constraint at the schema level, even if two tenants somehow generated the same nanoid.

### P2 — URL fields need https-only validation (TO DO IN BATCH L)

8 new URL fields go to `app/api/settings/route.ts`. Each must have the same `.refine(u => u.startsWith("https://"))` pattern as the existing `billingContactUrl`. Tracked as a Batch L acceptance criterion.

### P2 — Race condition on link-child (ALREADY ADDRESSED IN PLAN)

`POST /api/members/[id]/link-child` uses `updateMany` with `where: {parentMemberId: null, passwordHash: null}` and rejects when `count !== 1`. Atomic at the DB layer.

### P2 — Audit log metadata (ALREADY ADDRESSED IN PLAN)

Both `member.link.child` and `member.unlink.child` log `metadata: { parentMemberId, childMemberId }`.

### P3 — POST /api/members atomic schema extension (ADDRESSED THIS BATCH)

Single PR extends Zod schema (accountType, parentMemberId) AND adds all server-side guards: synthesised email, forced `passwordHash: null`, parent same-tenant check, hierarchy depth cap, owner-only kid creation. Tested in `tests/unit/kids-tenant-scope.test.ts`.

### P3 — Dependency audit (DEFERRED)

`npm audit` not run during this gate. Tracked in TODO.md backlog.

## Mitigations applied

| Risk | Mitigation | Location |
|---|---|---|
| Magic-link bypass | `passwordHash: { not: null }` filter | `magic-link/request/route.ts`, `magic-link/verify/route.ts` |
| GET /api/members PII leak | staff-only role gate | `api/members/route.ts:GET` |
| Email tenantId leak | drop tenant from email; 16-byte nanoid | `synthesiseKidEmail()` in `api/members/route.ts` |
| URL XSS | https-only Zod refine | `api/settings/route.ts` (Batch L) |
| Race condition | `updateMany` + count===1 check | `link-child/route.ts` |
| Audit metadata | both IDs in metadata | `link-child/route.ts`, `unlink-child/route.ts` |
| Hierarchy depth | parent.parentMemberId IS NULL check | `link-child/route.ts`, `members/route.ts:POST` |

**Verdict updated to PROCEED** after blockers fixed in-session.
