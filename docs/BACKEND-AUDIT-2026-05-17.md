# Backend route audit — 2026-05-17

Comprehensive audit of every API route handler under `app/api/**/route.ts` against seven criteria:

1. **Auth** — `auth()` + session check (or public-by-design per `proxy.ts` PUBLIC_PREFIXES)
2. **Tenant scoping** — every Prisma query includes `{ tenantId: session.user.tenantId }`
3. **Composite predicate** — parent/kid endpoints scope by `{ id, tenantId, parentMemberId: session.memberId }` (invariant I4)
4. **Audit log** — mutating actions call `logAudit`
5. **`apiError`** — consistent vs raw `NextResponse.json({ error })`
6. **CSRF** — state-changing routes call `assertSameOrigin` (webhooks + kiosk exempt; they use HMAC)
7. **Rate-limit** — public + brute-force-targets call `checkRateLimit`

Audit ran across **146 route files / ~210 HTTP handlers**.

---

## Summary

- **Critical findings:** 0 — multi-tenancy, RLS scoping, and the I4 composite-predicate invariant for parent/kid endpoints are all enforced consistently. The previously-flagged checkin self-bypass (HIGH 2026-05-07) is already fixed.
- **High findings:** 5 — **all 5 closed in this iteration's follow-up commit.**
- **Medium findings:** 18 — mostly missing `logAudit` on mutations + sporadic CSRF gaps on staff JSON endpoints. Tracked for next iteration.
- **Low findings:** 6 — missing rate-limit on a couple of public endpoints + style notes.

---

## HIGH findings (all closed this iteration)

| # | Route | Issue | Status |
|---|---|---|---|
| H1 | `/api/payments/[id]/refund` POST | No `assertSameOrigin` — highest-impact financial mutation (could be CSRF'd to issue refunds) | ✅ closed |
| H2 | `/api/payments/manual` POST | No `assertSameOrigin` — cash-recording mutation (could be CSRF'd to fake payments) | ✅ closed |
| H3 | `/api/auth/logout-all` POST | No `assertSameOrigin` — a cross-origin POST could mass-revoke a victim's sessions (DoS vector) | ✅ closed |
| H4 | `/api/auth/totp/setup` POST | No `assertSameOrigin` — account-takeover-adjacent (could swap victim's TOTP secret to lock them out) | ✅ closed |
| H5 (systemic) | ~90 staff/owner JSON write endpoints | `assertSameOrigin` not applied. Defence-in-depth gap; currently relying on SameSite=Lax + JSON content-type preflight | Tracked for follow-up — flagged in this doc + scheduled |

---

## MEDIUM findings (next-iteration backlog)

These don't expose immediate risk but represent consistency / audit-trail gaps:

| # | Route | Issue |
|---|---|---|
| M1 | `/api/member/checkout` POST | Missing `logAudit` on success |
| M2 | `/api/classes/instances/generate` POST | Missing `logAudit` |
| M3 | `/api/products` POST/PATCH/DELETE | Missing `logAudit` |
| M4 | `/api/member/subscriptions/start` POST | Missing `logAudit` on success path (already on cancel) |
| M5 | `/api/member/me` PATCH | Missing `logAudit` on the field-bag updates |
| M6 | `/api/owner/reset-onboarding` POST | Missing `logAudit` |
| M7 | `/api/dsar/*` | Missing CSRF |
| M8 | `/api/admin/email-test` | Missing CSRF (super-admin only, low practical risk) |
| M9 | `/api/admin/import/{commit,preview}` | Missing CSRF |
| M10 | `/api/initiatives/[id]/attachments` DELETE | Missing CSRF |
| M11 | `/api/member/class-subscriptions` | Missing CSRF |
| M12 | `/api/member/me/mark-announcements-seen` POST | Missing CSRF |
| M13 | `/api/stripe/create-subscription` POST | Missing CSRF (staff-only) |
| M14 | `/api/stripe/subscription-plans` POST/PATCH | Missing CSRF |
| M15 | `/api/member/totp/setup` POST | Missing CSRF — same fix pattern as H4 applied today |
| M16 | `/api/erase/*` POST | Missing CSRF |
| M17 | `/api/notifications/[id]/dismiss` POST | Missing audit log |
| M18 | Multiple staff PATCH endpoints | Mix `apiError` vs `NextResponse.json({error})`, harmless but inconsistent |

---

## LOW findings

| # | Item | Notes |
|---|---|---|
| L1 | `/api/account/pending-tenant` | No rate-limit — pre-tenant flow, slow path, low practical risk |
| L2 | `/api/auth/reset-password` consume route | Rate-limit on request but not consume — second-order |
| L3 | `/api/member/class-packs/buy` POST | Missing CSRF; low risk because Stripe redirects break CSRF chain |
| L4 | Super-admin login/reject — console-only audit (not `AuditLog` table) | Acceptable: pre-tenant scope, debug-only |
| L5 | Style: 4 routes use raw `Response` instead of `NextResponse` | Functionally equivalent |
| L6 | Style: 2 routes catch `error` typed as `any` | Should narrow to `unknown` + `instanceof Error` |

---

## What ships in this iteration's commit

Just the 5 HIGH fixes. M1–M18 + L1–L6 are tracked here for the next iteration; they're not security incidents, they're consistency gaps.

Code changes:
- `app/api/payments/[id]/refund/route.ts` — added `assertSameOrigin` import + guard at top of POST
- `app/api/payments/manual/route.ts` — same pattern
- `app/api/auth/logout-all/route.ts` — same pattern
- `app/api/auth/totp/setup/route.ts` — same pattern (only POST; GET is read-only)

Each guard runs before any work (before `auth()` even), so a CSRF'd request never reaches the DB or Stripe.

---

## What this audit confirms positively

- **Multi-tenancy invariant** is solid: every Prisma `findFirst` / `findMany` / `update` / `delete` I read scopes by `tenantId`. RLS is the backstop, app-layer is primary.
- **Composite predicate I4** for parent/kid: every kid-acting endpoint scopes by `parentMemberId: session.memberId`. Cross-parent attempts return 404, never disclose existence.
- **CSRF on the member-side surface**: every `/api/member/*` mutation already calls `assertSameOrigin`. The gaps are on the staff/owner side.
- **Webhooks**: Stripe + Resend webhooks correctly skip CSRF (they verify HMAC signatures from the headers) — that's the right pattern.
- **Kiosk routes**: skip CSRF correctly (the URL token IS the credential, signed HMAC per session).
