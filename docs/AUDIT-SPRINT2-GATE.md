# Sprint 2 Pre-Flight Audit (2026-04-27)

## Summary
- Scope A regressions: 3 (P0=0, P1=1, P2=2)
- Scope B planning risks: 7 (P0=1, P1=3, P2=3)
- Verdict: PROCEED (with mitigations baked into Sprint 2 acceptance criteria)
- Top concerns:
  - Magic-link verify endpoint (not yet built) -- cross-tenant token replay is the single biggest auth risk when it ships
  - /api/stripe/portal has no memberSelfBilling gate yet -- must be added in US-005 before UI ships
  - /api/announcements GET blocks members with 403 -- member/home silently falls back to hard-coded demo data; blocking dependency for US-006
  - Waiver link in MemberProfile embeds member email as a plain URL query param -- PII-in-URL risk

---

## Scope A -- Sprint 1 regressions

### A-1 (P2) -- Silent catch in MemberBillingTab
**Location:** `components/member/MemberBillingTab.tsx:44-46`
**Pattern:** `.catch(() => {})` swallows all errors on the payments fetch.
**Risk:** If /api/member/me/payments returns 401 (expired session), the tab silently shows an empty list. Not exploitable but masks auth failures and complicates debugging.
**Mitigation:** Surface errors: `.catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))`.

### A-2 (P2) -- Waiver link leaks member email in URL
**Location:** `components/dashboard/MemberProfile.tsx:234-243` (copyWaiverLink)
**Pattern:** URL contains `?email=<member email>` as a plain query parameter.
**Risk:** Link is copied to clipboard and sent to members externally. Browser history, proxy logs, and referrer headers expose PII. No auth bypass -- login is still required -- but violates PII-in-URL best practice (GDPR consideration for UK deployments).
**Mitigation:** Drop the `email` param. The login page can prefill email from a session or the user enters it after authenticating with the club code.

### A-3 (P1) -- member/home fetches staff-only /api/announcements; silently falls back to demo data
**Location:** `app/member/home/page.tsx:929-944`; `app/api/announcements/route.ts:62-63`
**Pattern:** The GET handler returns 403 for `role === "member"`. MemberHomePage catches the non-ok response and retains DEMO_ANNOUNCEMENTS in state indefinitely.
**Risk:** Every real member always sees hard-coded fake demo announcements, not their gym content. US-006 builds directly on this broken path -- if not fixed first, the auto-show feature will auto-show demo data.
**Mitigation:** Either remove the member-role block in the GET handler and scope results to `session.user.tenantId`, or create a separate `/api/member/announcements` route before US-006 ships. Blocking dependency for US-006.

### A-4 -- WP-A pattern check (findUnique without tenantId)
**Verdict:** Clean. All Sprint 1 DB lookups use `findFirst({ where: { id, tenantId } })` or derive tenantId from session. No new violations introduced.

### A-5 -- WP-J pattern check (e.message leaks) and empty catch blocks
**Verdict:** Clean. Sprint 1 catch blocks show only generic user-facing strings. `lib/class-time.ts` and `lib/dashboard-todo.ts` have no DB access or error surfacing.

### A-6 -- New routes bypassing requireStaff / requireOwner
**Verdict:** Clean. The only new API file in Sprint 1 (`app/api/checkin/route.ts`) correctly checks session role before allowing admin-path check-in, and uses HMAC token verification for the QR path. No unguarded routes added.

---

## Scope B -- Sprint 2 planning risks

### B-1 (P0) -- Magic-link cross-tenant token replay (US-003)
**Attack scenario:** Attacker requests a token for victim@gym-a.com on tenant A, then submits that token to the verify endpoint specifying a different tenantSlug (gym-b). If the handler resolves the token with `findUnique({ where: { token } })` alone -- without filtering on tenantId -- it authenticates the attacker against the wrong tenant.
**Why it matters:** MagicLinkToken.tenantId exists in the schema and the index supports correct scoping, but only if the verify handler explicitly uses it. The field being there does not make the query safe automatically.
**Required implementation:**
```typescript
const record = await prisma.magicLinkToken.findFirst({
  where: {
    token,
    tenantId: resolvedTenantId,  // derived from tenantSlug param, not from the token row
    used: false,
    expiresAt: { gt: new Date() },
  },
});
if (!record) return 401;
```

### B-2 (P1) -- Magic-link atomic consume race condition (US-003)
**Risk:** A find-then-update pattern has a TOCTOU window: two simultaneous requests both pass the "not used" check before either marks it used, enabling a replay within the expiry window.
**Required implementation:** Use `updateMany` + count check as specified in the US-003 AC:
```typescript
const result = await prisma.magicLinkToken.updateMany({
  where: { token, tenantId, used: false, expiresAt: { gt: new Date() } },
  data: { used: true, usedAt: new Date() },
});
if (result.count !== 1) return NextResponse.json({ error: "Invalid or expired link" }, { status: 401 });
```

### B-3 (P1) -- Magic-link token entropy (US-003)
**Risk:** Use of `Math.random()`, non-crypto uuid, or tokens shorter than 128 bits makes tokens guessable under targeted brute-force against the unique index.
**Required implementation:** Mirror the pattern already in `app/api/waiver/sign/route.ts:20`:
```typescript
import { randomBytes } from "crypto";
const token = randomBytes(32).toString("hex"); // 256-bit
```

### B-4 (P1) -- /api/stripe/portal missing memberSelfBilling gate (US-005)
**Location:** `app/api/stripe/portal/route.ts` (current, pre-US-005)
**Risk:** The endpoint checks only that `memberId` and `stripeCustomerId` exist. When US-005 adds `Tenant.memberSelfBilling`, if only the UI CTA is hidden and the API is not gated, any member can POST directly to `/api/stripe/portal` and open Stripe regardless of the flag.
**Required addition (inside the existing tenant fetch):**
```typescript
const tenant = await prisma.tenant.findUnique({
  where: { id: member.tenantId },
  select: { stripeAccountId: true, memberSelfBilling: true },
});
if (!tenant?.memberSelfBilling) {
  return NextResponse.json(
    { error: "Self-managed billing is not enabled. Contact your gym for billing queries." },
    { status: 403 }
  );
}
```

### B-5 (P2) -- MembershipTier cross-tenant assignment risk (US-002)
**Risk:** If the MemberProfile tier selector sends a `tierId` in the PATCH body and the server resolves it with `findUnique({ where: { id: tierId } })` without a tenantId filter, an owner could assign a tier from a different tenant. No data exfiltration, but a data-integrity violation and a cross-tenant boundary cross.
**Required implementation:** All tier lookups must use:
```typescript
findFirst({ where: { id: tierId, tenantId: session.user.tenantId } })
```

### B-6 (P2) -- billingContactUrl stored XSS vector (US-005)
**Risk:** If `billingContactUrl` is stored without scheme validation and later rendered as an `href`, a `javascript:` or `data:` URL becomes a stored XSS payload delivered to any member who visits the billing page.
**Required implementation (server-side schema validation):**
```typescript
billingContactUrl: z.string().regex(/^https:\/\//).max(500).optional().nullable()
```

### B-7 (P2) -- /api/member/me/mark-announcements-seen auth requirements (US-006)
**Risk:** If the endpoint accepts a `memberId` from the request body rather than deriving it from the session, a staff user (or a member with a crafted request) could mark any member as having seen announcements, corrupting the unseen-count logic.
**Required implementation:** Derive `memberId` exclusively from session. Update predicate must be:
```typescript
where: { id: session.user.memberId, tenantId: session.user.tenantId }
```
Do not accept memberId from the request body.

### B-8 -- Supervised waiver /api/members/[id]/waiver/sign (US-004) -- design sound, one constraint
The existing `/api/waiver/sign` reference implementation has all required patterns: PNG magic-byte check, `addRandomSuffix: true`, rate limiting, `collectedBy: "self"` audit field, `logAudit` call. US-004 must replicate all five and set `collectedBy: "admin_device:{userId}"`. The sole new constraint: member lookup must use `findFirst({ where: { id, tenantId: session.user.tenantId } })`, not bare `findUnique({ where: { id } })`.

---

## Required mitigations to apply during Sprint 2 execution

- [ ] **US-003:** Token verify handler filters on `{ token, tenantId, used: false, expiresAt: { gt: now } }` -- never bare `{ token }` alone (fixes B-1)
- [ ] **US-003:** Atomic consume via `updateMany` + `count !== 1` rejection; no find-then-update split (fixes B-2)
- [ ] **US-003:** Token generated with `crypto.randomBytes(32).toString("hex")` (fixes B-3)
- [ ] **US-003:** Request endpoint always returns 200 regardless of email existence; Vitest test asserts no-enumeration behaviour
- [ ] **US-003:** Invalidate prior unused tokens for same `email + tenantId` before issuing a new one (anti-stockpile)
- [ ] **US-003:** Rate limit 3 requests / 15 min / email+tenant using existing `checkRateLimit` helper
- [ ] **US-004:** Member lookup uses `findFirst({ where: { id, tenantId } })` not bare `findUnique`
- [ ] **US-004:** `collectedBy = "admin_device:{userId}"` -- Vitest test validates the format string
- [ ] **US-004:** Reuse PNG magic-byte check, `addRandomSuffix: true`, rate-limit, and `logAudit` from `/api/waiver/sign`
- [ ] **US-005:** `/api/stripe/portal` checks `tenant.memberSelfBilling === true` before proceeding; returns explicit 403 if false (fixes B-4)
- [ ] **US-005:** `billingContactUrl` validated server-side as `https://` scheme only (fixes B-6)
- [ ] **US-006:** `/api/member/me/mark-announcements-seen` enforces `role === "member"` + session-derived memberId only (fixes B-7)
- [ ] **US-006 (blocking):** Fix `/api/announcements` GET to serve member-role sessions, OR ship `/api/member/announcements` before US-006 (fixes A-3)
- [ ] **US-002:** All tier CRUD routes and MemberProfile PATCH scope tier lookups to `tenantId` (fixes B-5)
- [ ] **All US:** No empty `catch {}` blocks; use `apiError()` helper or log + return generic message
