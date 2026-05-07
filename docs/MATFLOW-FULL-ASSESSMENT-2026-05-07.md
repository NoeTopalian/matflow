# MatFlow Full-Scope Assessment

**Date:** 2026-05-07
**Scope:** entire application — all eight surfaces below
**Method:** code-trace + live Playwright walk on signup; parallel Explore-agent reads across the rest
**Companion doc:** [MATFLOW-SIGNUP-ASSESSMENT-2026-05-07.md](MATFLOW-SIGNUP-ASSESSMENT-2026-05-07.md) (signup pipelines, deeper detail)
**Reference docs:** [MATFLOW-PIPELINES.md](MATFLOW-PIPELINES.md), [MATFLOW-MASTER-PLAN.md](MATFLOW-MASTER-PLAN.md)

---

## Executive summary

**Verdict: MatFlow is in good operational shape.** Tenant isolation is watertight, money paths are transactional and idempotent, and the operator console enforces audit identity on the routes that matter most. There are **3 P1 findings**, all of which are solvable with localised fixes or single-paragraph doc updates.

**The headline P1s:**

1. **Magic-link verify bypasses TOTP for owners** ([app/api/magic-link/verify/route.ts:82-94](../app/api/magic-link/verify/route.ts#L82-L94)) — JWT minted with hardcoded `totpPending: false` and no `requireTotpSetup` flag. Architecturally inconsistent with the no-self-disable invariant in [app/api/auth/totp/disable/route.ts:5-17](../app/api/auth/totp/disable/route.ts#L5-L17). Either fix the verify route or document the carve-out.
2. **DSAR routes obscure operator identity in the audit trail** ([app/api/admin/dsar/erase/route.ts:75-86](../app/api/admin/dsar/erase/route.ts#L75-L86), [app/api/admin/dsar/export/route.ts:43](../app/api/admin/dsar/export/route.ts#L43)) — owner-only auth gate with operator-via-impersonation pattern. Audit log records `userId = owner.id`, not `metadata.actingAs = operator.id`. GDPR Article 17 fulfilment evidence is muddied. Erase log is also fire-and-forget, so a failed write is silently swallowed.
3. **MATFLOW-MASTER-PLAN.md §5 is stale** — claims the wizard collects 4 things; reality is 9 stages per MATFLOW-PIPELINES.md and the wizard code. The two source-of-truth docs disagree.

**What's strong:**
- **Tenant isolation:** RLS policies defined (dormant, waiting on ENABLE migration), `withTenantContext` enforced uniformly, `withRlsBypass` only used in justified contexts (operator actions, webhooks, kiosk, magic-link), zero bare `findUnique({ where: { id } })` on tenant resources in API handlers.
- **Money safety:** Stripe webhook claims `eventId` before handler, rolls back on error, transactional Payment + Member writes via `withTenantContext`, refund path is append-only with idempotency keys.
- **Operator support actions:** force-password-reset, suspend, soft-delete, totp-reset, transfer-ownership all use `getOperatorContext`, bump `sessionVersion`, enforce `reason` (min 5 chars), and confirm-name where appropriate.
- **Member portal:** parent-child isolation, payment-method scoping, kid-account passwordless invariant, kiosk token HMAC + 10-min expiry + tenant cross-check.
- **Reports:** owner/manager-gated, tenant-scoped on every aggregation, capped at `take: 10000` with truncation warning.

---

## Coverage map

| Surface | Audited? | Method | Lead findings |
|---|---|---|---|
| Owner signup pipeline | ✅ | Code-trace + live Playwright | Magic-link TOTP bypass (P1), wizard contradiction (P1 doc), apply-form drift |
| Member signup pipeline | ✅ | Code-trace + live Playwright | Same `purpose` for two flows (P2), `memberCreateSchema` doc drift |
| Operator support actions (§1.8) | ✅ | Code-trace via Explore agent | DSAR audit opacity (P1), DSAR erase fire-and-forget (P2), impersonate DELETE (P3) |
| Stripe Connect + webhooks + refund | ✅ | Code-trace via Explore agent | HMAC `!==` not timing-safe (P2), Customer race (P3 acknowledged) |
| Multi-tenancy + RLS | ✅ | Code-trace via Explore agent | Zero P1; foundation is watertight |
| Member portal (`/member/*` + `/api/member/*`) | ✅ | Code-trace via Explore agent | Zero P1; isolation is correct |
| Check-in + kiosk + waiver | ✅ | Code-trace via Explore agent | Zero P1; HMAC, idempotency, immutability all correct |
| Reports | ✅ | Code-trace via Explore agent | Zero P1; properly gated and scoped |
| Operator console UI walks (`/admin/*`) | ❌ | Out of scope (no operator credentials in this session) | — |
| 147 baseline test failures | ❌ | Out of scope (separate triage track) | — |
| Class scheduling / instance generation edge cases | ❌ | Out of scope | — |

---

## 1. Owner + member signup pipelines

**Detailed findings:** see [MATFLOW-SIGNUP-ASSESSMENT-2026-05-07.md](MATFLOW-SIGNUP-ASSESSMENT-2026-05-07.md). Summary of items at P1/P2:

| ID | Sev | Finding |
|---|---|---|
| 1 | P1 | Magic-link verify bypasses TOTP for owners — see executive summary above |
| 2 | P1 | Pipelines doc says 9-stage wizard; master plan §5 says 4 stages |
| 3 | P2 | `DEMO_MODE` ships hardcoded credential map in production code ([auth.ts:339-361](../auth.ts#L339-L361)) |
| 4 | P2 | `memberCreateSchema` only requires `name`; pipeline doc lists 6 fields |
| 5 | P2 | Apply route silently swallows DB write failure (user sees success) |
| 6 | P2 | `/login/accept-invite` no-token state is a dead end |
| 7 | P2 | `/apply` Terms/Privacy are non-clickable spans |
| 8 | P2 | No captcha or honeypot on `/apply` |
| 9 | P2 | `memberUpdateSchema.status` enum doesn't include `"taster"` |
| 10 | P2 | Apply form `discipline` doesn't round-trip into wizard |
| 11 | P2 | Apply form field names diverge from DB column names; doc uses DB names |
| 12 | P2 | Same `purpose="first_time_signup"` for two flows with different TTLs and routes |

(Plus 9 P3 doc/code drift items detailed in §1.4 and §2.4 of the signup assessment.)

---

## 2. Operator support actions (§1.8)

**Status:** **5 of 8 routes fully compliant**; 3 routes have non-trivial drift, all in DSAR / impersonation.

### 2.1 Compliant routes — confirmed correct

| Route | Auth | `getOperatorContext` | `sessionVersion++` | `actAsUserId` |
|---|---|---|---|---|
| [force-password-reset](../app/api/admin/customers/[id]/force-password-reset/route.ts) | `isAdminAuthed` ✅ | ✅ | ✅ | ✅ |
| [suspend](../app/api/admin/customers/[id]/suspend/route.ts) (POST + DELETE) | `isAdminAuthed` ✅ | ✅ | ✅ all users | ✅ |
| [soft-delete](../app/api/admin/customers/[id]/soft-delete/route.ts) (POST + DELETE) | `isAdminAuthed` ✅ | ✅ | ✅ all users | ✅ |
| [totp-reset](../app/api/admin/customers/[id]/totp-reset/route.ts) | `isAdminAuthed` ✅ | ✅ | ✅ | ✅ |
| [transfer-ownership](../app/api/admin/customers/[id]/transfer-ownership/route.ts) (GET + POST) | `isAdminAuthed` ✅ | ✅ | ✅ both users | ✅ |

All five enforce `reason` (min 5 chars) and confirm-name where appropriate. Master plan §2's "thread `getOperatorContext` through them" backlog item is **complete for these five**.

### 2.2 Drift findings

**P1 — DSAR routes obscure operator identity** ([app/api/admin/dsar/export/route.ts:43](../app/api/admin/dsar/export/route.ts#L43), [app/api/admin/dsar/erase/route.ts:32](../app/api/admin/dsar/erase/route.ts#L32))

The pipeline doc §1.8.7-8 says these are operator-triggered via impersonation. Both routes call `requireOwner()` / `requireRole(["owner"])` and don't gate via `getOperatorContext`. When operator triggers via impersonation, the audit log shows `userId = owner.id`, not `metadata.actingAs = operator.id`. **GDPR Article 17 fulfilment evidence is muddied.** Either accept dual-path auth (`requireOwner() OR getOperatorContext()`) and stamp `actingAs` unconditionally, or document the impersonation-only intent in the doc and explicitly mark these audit rows as operator-attributable via the impersonation event.

**P2 — DSAR erase audit log is fire-and-forget** ([app/api/admin/dsar/erase/route.ts:75-86](../app/api/admin/dsar/erase/route.ts#L75-L86))

`void logAudit(...).catch(() => {})`. The member is erased even if the audit write fails, and the failure is silently swallowed. Pipeline doc §1.8.8 says "the audit row itself is the GDPR fulfilment evidence" — losing that evidence to a transient DB blip is a compliance risk. Make the audit write synchronous, or at minimum surface the error to Sentry.

**P2 — DSAR erase has no `reason` field**

Every other operator action (force-password-reset, suspend, soft-delete, totp-reset, transfer-ownership) requires a `reason` (min 5 chars). DSAR erase doesn't. Compliance audit can't distinguish "user request" from "operator error" from "legitimate Article 17 fulfilment". Add an optional `reason` field; require it when triggered via operator path.

**P3 — Impersonate DELETE doesn't check operator auth** ([app/api/admin/impersonate/route.ts:94-98](../app/api/admin/impersonate/route.ts#L94-L98))

`POST` requires `getOperatorContext().authed`; `DELETE` reads the cookie and clears it for whoever holds it. Comment notes this is intentional ("anyone holding the impersonation cookie should be able to end it"). Cookie is `httpOnly + secure + sameSite=lax`, so practical risk is low — but asymmetric. If kept, a code comment explaining the intent would help future readers.

---

## 3. Stripe Connect + webhooks + refunds

**Status:** **money-safety 8/10. Zero P1 findings.** One P2, one P3.

### 3.1 Compliant invariants — confirmed

| Invariant | Where | Status |
|---|---|---|
| Connect state HMAC + 15-min expiry | [connect/route.ts:17-21](../app/api/stripe/connect/route.ts#L17-L21), [callback/route.ts:34-38](../app/api/stripe/connect/callback/route.ts#L34-L38) | ✅ |
| Webhook signature verified before any DB read | [webhook/route.ts:23-26](../app/api/stripe/webhook/route.ts#L23-L26) | ✅ |
| `StripeEvent.eventId @unique`, claim-then-process pattern, rollback on error | [webhook/route.ts:54-70,514-517](../app/api/stripe/webhook/route.ts#L54-L70) | ✅ |
| Only `HANDLED_EVENT_TYPES` claim eventId (preserves future handlers) | [webhook/route.ts:32-52](../app/api/stripe/webhook/route.ts#L32-L52) | ✅ |
| Refund flow: append-only Payment.status update, MemberClassPack atomically voided in one `withTenantContext` | [refund/route.ts:111-136](../app/api/payments/[id]/refund/route.ts#L111-L136) | ✅ |
| Refund uses Stripe idempotency key | [refund/route.ts:90](../app/api/payments/[id]/refund/route.ts#L90) | ✅ |
| Dispute-lost: Payment refunded, MemberClassPack voided, AttendanceRecord rows preserved | [webhook/route.ts:483-501](../app/api/stripe/webhook/route.ts#L483-L501) | ✅ |
| `apiError()` wrapper used in money-touching routes (no `error.message` leakage) | refund, create-subscription, portal | ✅ |
| Unique indexes on `eventId`, `stripeInvoiceId`, `stripePaymentIntentId`, `stripeDisputeId`, MemberClassPack `stripePaymentIntentId` | [prisma/schema.prisma](../prisma/schema.prisma) | ✅ |

### 3.2 Drift findings

**P2 — Connect callback HMAC compare uses plain `!==`, not timing-safe** ([app/api/stripe/connect/callback/route.ts:29](../app/api/stripe/connect/callback/route.ts#L29))

Pipeline doc §1.7 implies a hardened state check. Plain `!==` leaks comparison length via timing. Practical risk is low (state is per-tenant + 15-min, attacker would need many calls per state) but it's a hygiene fix. Replace with `crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))`.

**P3 — Stripe Customer race acknowledged but unfixed** ([app/api/stripe/create-subscription/route.ts:65-83](../app/api/stripe/create-subscription/route.ts#L65-L83))

Concurrent calls may both create a `Customer`; loser leaks an orphan record. Code comment explicitly accepts this. Pipeline doc §4 documents the edge case. Long-term fix: pass a Stripe `idempotencyKey` derived from `tenantId + memberId` to `customers.create()` so concurrent calls converge on one record. Cosmetic; no money-safety impact today.

**Webhook error response consistency** ([webhook/route.ts:512-519](../app/api/stripe/webhook/route.ts#L512-L519)) — catch-all returns `{ error: "Processing failed" }` directly rather than via `apiError()`. Webhook errors aren't user-visible (Stripe is the consumer), so risk is essentially zero. Cosmetic.

---

## 4. Multi-tenancy + RLS

**Status:** **Foundation is watertight.** Zero P1 findings. Recommend proceeding with the RLS-enable migration after the same audit on `/api/admin/*` write paths (which is largely covered by §2 above).

### 4.1 Confirmed-safe

| Property | Evidence |
|---|---|
| RLS policies defined for 13 tables | [prisma/migrations/20260503100000_rls_policies_foundation/migration.sql](../prisma/migrations/20260503100000_rls_policies_foundation/migration.sql) |
| Policies enforce `app.current_tenant_id` GUC match | same migration |
| `withTenantContext` sets the GUC transaction-local for pgbouncer compatibility | [lib/prisma-tenant.ts:25-36](../lib/prisma-tenant.ts#L25-L36) |
| `withRlsBypass` used only in justifiable contexts (webhooks, kiosk, magic-link, operator actions, pre-session lookups) | [lib/prisma-tenant.ts:46-53](../lib/prisma-tenant.ts#L46-L53) — every call site reviewed |
| No bare `findUnique({ where: { id } })` on `Member`, `Payment`, `Class`, `AttendanceRecord` in API handlers | grep-confirmed |
| `@@unique([tenantId, email])` on Member — cross-tenant email collisions impossible | [prisma/schema.prisma:161](../prisma/schema.prisma#L161) |
| `@@unique([memberId, classInstanceId])` on AttendanceRecord — duplicate check-ins impossible | [prisma/schema.prisma:309](../prisma/schema.prisma#L309) |

### 4.2 RLS enablement readiness

The migration that defines policies is shipped; the migration that flips `ENABLE ROW LEVEL SECURITY` is not yet applied (the policies are dormant). The application layer is already enforcing tenant isolation via `withTenantContext`, so RLS is purely a defence-in-depth backstop. **Recommendation: enable RLS in a staged rollout** — start in preview, run the existing test suite, then promote.

---

## 5. Member portal

**Status:** Properly isolated. Zero P1 findings.

### 5.1 Confirmed-safe routes

- `/api/member/me` (GET, PATCH) — emergency contact, waiver, prefs all scoped to session `memberId + tenantId` ([app/api/member/me/route.ts](../app/api/member/me/route.ts))
- `/api/member/me/children` — lists only `parentMemberId: memberId` records
- `/api/member/me/payments` — filters by `memberId + tenantId`
- `/api/member/children/[id]` — parent-child isolation enforced via join
- `/api/member/checkout` — server validates item prices against tenant DB; client-supplied price rejected on mismatch > 0.1¢ ([app/api/member/checkout/route.ts:66-73](../app/api/member/checkout/route.ts#L66-L73))
- `/api/member/class-subscriptions/[classId]` — DELETE scoped via `class: { tenantId }` join
- `/api/member/products` — tenant-aware; falls back to static catalog for fresh tenants

### 5.2 Notes

- Self-serve waiver is append-only: PATCH only accepts `waiverAccepted: true` once; immutable `SignedWaiver` row created with emergency-contact trio required pre-fill ([app/api/member/me/route.ts:345-428](../app/api/member/me/route.ts#L345-L428))
- Kid sub-accounts cannot reach `/api/member/me` paths because they have no session (passwordless invariant)

---

## 6. Check-in + kiosk + waiver

**Status:** Robust. Zero P1 findings.

### 6.1 Confirmed-safe

| Property | Where |
|---|---|
| Self check-in: enforces session, time window, coverage, rank gate | [app/api/checkin/route.ts:39-62](../app/api/checkin/route.ts#L39-L62), [lib/checkin.ts:106-208](../lib/checkin.ts#L106-L208) |
| Admin check-in: explicit `memberId` param, member belongs-to-tenant verified | same |
| Kiosk check-in: HMAC-verified token, 10-min expiry, tenant cross-check | [lib/kiosk-token.ts:50-91](../lib/kiosk-token.ts#L50-L91), [app/api/kiosk/[token]/checkin/route.ts:58-81](../app/api/kiosk/[token]/checkin/route.ts#L58-L81) |
| Kiosk uses `crypto.timingSafeEqual` for token compare | [lib/kiosk-token.ts](../lib/kiosk-token.ts) |
| Kiosk member search: query length ≥ 2, signed member tokens (not raw IDs), 60/min rate-limit | [app/api/kiosk/[token]/members/route.ts:40-76](../app/api/kiosk/[token]/members/route.ts#L40-L76) |
| Waiver signature: PNG magic-byte check (`0x89504E47`), staff-only, member scoped, 5/15min rate-limit | [app/api/members/[id]/waiver/sign/route.ts:37-90](../app/api/members/[id]/waiver/sign/route.ts#L37-L90) |
| `SignedWaiver` is immutable (append-only) | model design |

**Doc accuracy:** §2.7 claims the 30-min time window is enforced for self check-in but bypassed for kiosk and admin. Confirmed.

---

## 7. Reports

**Status:** Properly gated. Zero P1 findings.

| Property | Where |
|---|---|
| Owner/manager-only auth gate | [app/api/reports/route.ts:15-16](../app/api/reports/route.ts#L15-L16) |
| Generate route uses `requireOwnerOrManager()` redirect-on-fail | [app/api/reports/generate/route.ts:13](../app/api/reports/generate/route.ts#L13) |
| 5/hour/tenant rate-limit on generation | same |
| Every aggregation in `lib/reports.ts` includes `tenantId` filter | [lib/reports.ts:145-200](../lib/reports.ts#L145-L200) |
| `take: 10000` cap with truncation warning | [lib/reports.ts:147-154](../lib/reports.ts#L147-L154) |
| No cross-request caching detected | grep-confirmed |

CLAUDE.md states "When asked for analytics, gym stats, or 'a report on X' query via `getReportsData` if the metric exists there — extend it rather than duplicate." That contract is intact.

---

## 8. Cross-cutting findings

| ID | Sev | Finding |
|---|---|---|
| X-1 | P2 | `DEMO_MODE` fallback ships hardcoded credentials in production code ([auth.ts:339-361](../auth.ts#L339-L361)). Wrap in `process.env.NODE_ENV !== "production"` so they're tree-shaken. |
| X-2 | P3 doc | Pipeline doc §3.5 public-prefix list is incomplete vs [proxy.ts:14-48](../proxy.ts#L14-L48) |
| X-3 | P2 | Apply form `discipline` doesn't round-trip into wizard (free-text label vs ID) |
| X-4 | P2 doc | Apply form field names diverge from DB column names; doc uses DB names |
| X-5 | P3 doc | Master plan §2 says "Other operator routes still pass `SENTINEL_OPERATOR_ID`" — this is **mostly resolved** for the `/api/admin/customers/[id]/*` family. DSAR routes are the remaining exception (see §2.2 P1). |
| X-6 | P3 doc | TOTP-reset route docstring at [app/api/auth/totp/disable/route.ts:9-12](../app/api/auth/totp/disable/route.ts#L9-L12) names three reset paths (`totp-reset`, `member-totp-reset`, `/api/members/[id]/totp-reset`); pipeline doc §1.8.4 only documents the first |

---

## 9. Prioritised backlog (full scope)

This combines findings from the signup assessment with everything in §2-§8. Sorted by severity, then effort.

### P1 — fix or document soon

| # | Area | Finding | Proposed fix | Effort |
|---|---|---|---|---|
| 1 | Auth | ~~Magic-link verify mints a session with `totpPending: false` for owners with TOTP enrolled — TOTP gate bypass.~~ **✅ Resolved 2026-05-07** — chose the fix path. `/api/magic-link/verify` now sets `totpPending: user.role === "owner" && user.totpEnabled === true`, so the proxy pins TOTP-enrolled owners to `/login/totp` challenge before `/dashboard`. | (done) | M |
| 2 | Audit | DSAR export & erase obscure operator identity in audit trail. **✅ Resolved as doc-only 2026-05-07** — PIPELINES.md §1.8.7-8 now explains how operator attribution is reconstructable via the surrounding `admin.impersonate.start/end` rows. Dual-path auth still on the table as a future refactor if regulator scrutiny arrives. | (deferred — see doc) | M (refactor) / XS (doc) |
| 3 | Docs | ~~MATFLOW-MASTER-PLAN.md §5 says wizard collects 4 things; reality is 9 stages.~~ **✅ Resolved 2026-05-07** — §5 rewritten to match the actual 9 stages with remaining-gaps subsection. | (done) | XS |

### P2 — significant friction or hygiene

| # | Area | Finding | Proposed fix | Effort |
|---|---|---|---|---|
| 4 | Audit | ~~DSAR erase audit log is fire-and-forget. Failed write silently swallowed.~~ **✅ Resolved 2026-05-07** — audit row now written *before* the destructive erasure with both awaited; failure returns 500 and skips the erasure entirely. Successful erasure always has a corresponding audit row. | (done) | XS |
| 5 | Audit | DSAR erase has no `reason` field. | Add optional `reason` (min 5 chars when present); include in metadata. | XS |
| 6 | Auth | `DEMO_MODE` ships hardcoded credentials in production code. | Wrap in `process.env.NODE_ENV !== "production"` at module top. | XS |
| 7 | Docs | `memberCreateSchema` required-field list overstated in PIPELINES.md §2.2. | Replace with the actual `lib/schemas/member.ts` shape. | XS |
| 8 | Code | Apply route silently swallows DB write failure. | Return 503 if `gymApplication.create` throws. | S |
| 9 | UX | `/login/accept-invite` no-token state is a dead end. | Add "Back to sign in" + "Need a new invite? Contact your gym". | XS |
| 10 | Compliance | `/apply` Terms/Privacy are non-clickable spans. | Convert to `<Link>` to `/legal/terms`, `/legal/privacy`. | XS |
| 11 | Security | No captcha/honeypot on `/apply`. | Add an invisible honeypot field + server check. | XS |
| 12 | Schema | `memberUpdateSchema.status` doesn't include `"taster"`. | Add `"taster"` to the union. | XS |
| 13 | UX | Apply form `discipline` doesn't round-trip into wizard. | Pre-select wizard discipline from `GymApplication.discipline`. | S |
| 14 | API | Apply form field names ≠ DB column names; doc uses DB names. | Pick one convention; update doc accordingly. | XS |
| 15 | Auth | Same `purpose="first_time_signup"` for owner (30 min) + member (7 day) tokens. | Split into `first_time_signup_owner` and `first_time_signup_member`. | M |
| 16 | Crypto | Connect callback HMAC compare uses plain `!==`. | Use `crypto.timingSafeEqual`. | XS |

### P3 — polish, doc nits, optional cleanup

| # | Area | Finding | Effort |
|---|---|---|---|
| 17 | Docs | `app/api/admin/create-tenant/route.ts:4` docstring stale ("MATFLOW_ADMIN_SECRET header"). | XS |
| 18 | Docs | `/api/members/accept-invite` route docstring stale (says member signs in normally; actually page auto-signs). | XS |
| 19 | Docs | PIPELINES.md §2.2 doesn't note kids are owner-only. | XS |
| 20 | Docs | PIPELINES.md §3.5 public-prefix list incomplete vs proxy.ts. | XS |
| 21 | Docs | PIPELINES.md §1.6 doesn't mention `?resume=1` SetupBanner or dashboard-layout redirect. | XS |
| 22 | Docs | PIPELINES.md §3.1 audit-action list missing `auth.account.locked`. | XS |
| 23 | Docs | PIPELINES.md §1.8.4 TOTP-reset section misses the member-side reset paths referenced in [totp/disable/route.ts:9-12](../app/api/auth/totp/disable/route.ts#L9-L12). | XS |
| 24 | Code | `notes` stored as `""` (not null) when apply message empty. | XS |
| 25 | Auth | Impersonate DELETE doesn't check operator auth (intentional but asymmetric). | Add code comment OR add 403 check. | XS |
| 26 | Stripe | Stripe `Customer` race leaks orphan customer rows. | Pass `idempotencyKey` to `customers.create()`. | XS |
| 27 | Code | Webhook catch-all error response uses raw `error: "Processing failed"` not `apiError()`. | XS |
| 28 | Design | `/api/admin/create-tenant` bypass production-reachable. | Either gate to non-prod or document the production use case. | XS doc / S code |

---

## 10. Verification & limitations

**End-to-end live walks performed:**
- `/apply` form fill + submit + DB persistence confirmed (helper script [scripts/assess-check-application.mjs](../scripts/assess-check-application.mjs))
- `/login` two-step (club code → credentials) UX
- `/login/accept-invite` no-token error state
- `/admin/login` page-load only

**Code-traced (not interactively walked):**
- Operator actions (force-password-reset, suspend, soft-delete, totp-reset, transfer-ownership, impersonate, DSAR)
- Stripe Connect callback, webhook event handlers, refund path
- RLS migration, `withTenantContext`, `withRlsBypass`
- Member portal routes, kiosk, waiver
- Reports module

**NOT covered (out of scope for this pass):**
- 147-test baseline failure triage — separate track per master plan §8
- Full operator console UI walks (would need operator credentials)
- Class scheduling / `instances/generate` edge cases
- Email-rendering correctness (templates exist; content not reviewed)
- Resend webhook handling
- Cron jobs (`/api/cron/*`)
- Vercel deployment / build configuration

**Data hygiene:**
- One `GymApplication` test row created (id `cmoup4ekp0006j8tghr0a3jx7`, email `assess-2026-05-07-owner@example.com`). Cleanable via `DELETE FROM "GymApplication" WHERE email LIKE 'assess-2026-05-07-%'`.
- One helper script created at [scripts/assess-check-application.mjs](../scripts/assess-check-application.mjs).
- No code modified outside this report and the signup-assessment companion.

**Tests not run:** assessment is read-only; the 147-test baseline is unchanged.

---

## Appendix — Strengths worth preserving

While this report concentrates on findings, the codebase has several architectural patterns worth keeping:

1. **`withTenantContext` everywhere.** Tenant isolation as a *coding convention* enforced by a wrapper, with RLS as a backstop. Cleaner than threading `tenantId` through every helper.
2. **HMAC-hashed tokens at rest.** `MagicLinkToken.tokenHash @unique` makes lookups constant-time and removes plaintext-token disclosure risk.
3. **Atomic single-use via `updateMany`.** Prevents the classic check-then-set race on token consumption.
4. **`StripeEvent` claim-then-process pattern.** Webhook idempotency done correctly — claim eventId before handler, rollback on error.
5. **Bcrypt against `DUMMY_HASH` on missing accounts.** Prevents email enumeration via timing.
6. **`sessionVersion` everywhere.** Token revocation via a single integer increment — simple, correct, cheap.
7. **Operator session HMAC at the edge.** `proxy.ts` does Web Crypto HMAC verify without Prisma; full revocation check deferred to route handlers (Node runtime). Right split for the Edge runtime.
8. **CLAUDE.md project conventions are precise** (singleton Prisma, `withTenantContext` requirement, `getReportsData` extension over duplication, British English in user copy).

These should be preserved through any refactors.
