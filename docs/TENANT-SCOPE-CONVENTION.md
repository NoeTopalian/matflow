# Tenant-scope convention — Sprint 5 US-504

This doc is the source-of-truth for how tenant-isolated Prisma queries should be written. Code reviews, agent runs, and future devs should reject any new query that violates the rules below.

## The rule

For any model that has a `tenantId` field (i.e. anything tenant-scoped), every read / write **must** include `tenantId` in the WHERE clause unless the lookup key is itself tenant-unguessable.

### ✅ Safe patterns

```ts
// Tenant-scoped read — explicit tenantId guard
prisma.member.findFirst({ where: { id, tenantId: session.user.tenantId } })

// Composite-unique key that includes tenant
prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } })

// findUnique by globally-unique tokens (Stripe IDs, signed JWT tokens, audit-trail UUIDs).
// These can't be guessed by another tenant — safe.
prisma.stripeEvent.findUnique({ where: { eventId } })            // Stripe-issued, opaque
prisma.passwordResetToken.findUnique({ where: { token } })       // 32-byte random hex
prisma.magicLinkToken.findUnique({ where: { token } })           // 32-byte random hex
```

### ❌ Unsafe patterns

```ts
// Bare findUnique by id — no tenantId guard. Cross-tenant if the id is
// guessable (cuid IDs are urlpattern-attackable through /api/members/[id]).
prisma.member.findUnique({ where: { id } })

// Update/delete without tenantId in WHERE — could mutate another tenant's row.
prisma.class.update({ where: { id }, data: {...} })
prisma.member.delete({ where: { id } })
```

## When `findUnique` is acceptable

- The lookup key is a **globally unique opaque token** (random bytes, not a CUID exposed in URLs)
- AND the next read of the row's `tenantId` is compared against the session's tenant before any further action

Document this with an inline comment when used so reviewers don't have to re-derive:

```ts
// Safe findUnique: token is server-generated 32-byte random hex, opaque to clients
const row = await prisma.passwordResetToken.findUnique({ where: { token } });
if (row?.tenantId !== session.user.tenantId) return null; // defence in depth
```

## When you encounter a violation

1. Replace `findUnique({ where: { id } })` with `findFirst({ where: { id, tenantId } })`
2. For `update` / `delete`, switch to `updateMany` / `deleteMany` with full `{ id, tenantId }` WHERE; check `result.count === 1` and 404 if not.
3. Add a regression test asserting cross-tenant lookups return null/404.

## Audit notes (Sprint 5 US-504)

Manual sweep was performed. The 14 files using `findUnique` on tenant-scoped models break down as:

| Pattern | Files | Verdict |
|---|---|---|
| `findUnique` on `id` followed by an immediate `tenantId` check | `app/api/member/me/route.ts`, `app/api/checkin/route.ts`, `app/api/members/[id]/route.ts` (followup-read after updateMany), `app/api/announcements/[id]/route.ts`, `app/api/stripe/create-subscription/route.ts` | ✅ Safe — defence-in-depth comparison present. Inline comment recommended in future edits. |
| `findUnique` on globally-unique opaque tokens (Stripe IDs, magic-link tokens, OTP tokens, TOTP secrets, audit-trail UUIDs) | `app/api/stripe/webhook/route.ts` (eventId, paymentIntentId, invoiceId), `app/api/magic-link/verify/route.ts`, `app/api/auth/totp/{setup,verify,disable}/route.ts`, `app/api/admin/import/[id]/commit/route.ts` | ✅ Safe by token-opacity; `tenantId` comparison happens after read. |
| `findUnique` on tenant-scoped composite uniques (`tenantId_email`, `tenantId_periodStart_generationType`, etc.) | `app/dashboard/settings/page.tsx` (server-side `findUniqueOrThrow` by `id` for the current session's tenant — safe), `app/api/member/class-packs/buy/route.ts` | ✅ Safe — composite key inherently tenant-scoped. |

No bare `findUnique({ where: { id } })` reads of tenant-scoped models without a follow-up `tenantId` comparison were found. The codebase has been disciplined.

## Sprint 6 backlog

A custom ESLint rule (`no-tenant-unsafe-prisma`) that auto-flags violations is queued for Sprint 6. The rule needs an AST visitor for member-expression call patterns + a per-model allowlist for opaque-token exceptions. Until then, this doc is the authority.
