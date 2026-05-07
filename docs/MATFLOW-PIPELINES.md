# MatFlow Pipelines — Canonical Reference

> Source-of-truth document covering every actor + lifecycle stage in MatFlow, end-to-end.
> Every claim cites a file path. Audit codes, email templates, and edge cases are
> enumerated rather than summarised. Read this before redesigning any flow.

**Last updated:** 2026-05-05
**Stack:** Next.js 15 App Router · NextAuth v5 · Prisma · Neon Postgres · Stripe Connect · Resend
**Repo root referenced throughout:** `c:\Users\NoeTo\Desktop\matflow`

---

## 0. Glossary

### Actors (top to bottom)

| Actor | Model | Where they live | What they can do |
|---|---|---|---|
| **Operator** (super-admin / Noe) | `Operator` table ([prisma/schema.prisma:807-820](../prisma/schema.prisma#L807-L820)) | `/admin/*` | Manage every tenant, approve applications, support actions, impersonate, DSAR |
| **Owner** | `User` with `role="owner"` ([prisma/schema.prisma:70-98](../prisma/schema.prisma#L70-L98)) | `/dashboard/*` (one tenant) | Manage one gym: members, classes, payments, branding |
| **Manager / coach / admin** | `User` with `role` in `manager|coach|admin` | `/dashboard/*` (subset) | Tenant-scoped staff actions; cannot transfer ownership |
| **Member** | `Member` table ([prisma/schema.prisma:102-159](../prisma/schema.prisma#L102-L159)) | `/member/*` | Self check-in, view their own attendance/payments, manage prefs |
| **Kid member** | `Member` with `accountType="kids"` + `parentMemberId` | n/a (passwordless) | Check-in only via parent or kiosk; cannot log in |

### Core entities

- **Tenant** — one gym/dojo. Slug-keyed. ([prisma/schema.prisma:11-66](../prisma/schema.prisma#L11-L66))
- **MagicLinkToken** — passwordless login + first-time signup tokens. HMAC-hashed. ([prisma/schema.prisma:408-423](../prisma/schema.prisma#L408-L423))
- **AuditLog** — every meaningful action, indexed by `(tenantId, createdAt)`. ([prisma/schema.prisma:441-455](../prisma/schema.prisma#L441-L455))
- **Payment** — single Stripe transaction (succeeded / failed / refunded / disputed / pending). ([prisma/schema.prisma:653-675](../prisma/schema.prisma#L653-L675))
- **MembershipTier** — pricing template; **NOT linked to Member** directly. ([prisma/schema.prisma:782-798](../prisma/schema.prisma#L782-L798))
- **ClassPack / MemberClassPack** — prepaid bundle of N classes; redeemed at check-in. ([prisma/schema.prisma:584-621](../prisma/schema.prisma#L584-L621))
- **GymApplication** — public `/apply` form submissions. ([prisma/schema.prisma:761-778](../prisma/schema.prisma#L761-L778))

### Role hierarchy at a glance

```
Operator (super-admin, multi-tenant)
   │
   │  approves application → creates ↓
   ▼
User.role=owner (per-tenant lead)
   │
   │  invites / promotes ↓
   ▼
User.role=manager | coach | admin  (staff)
   │
   │  invites ↓
   ▼
Member (customer)
   │
   │  parents create ↓
   ▼
Member.accountType=kids (passwordless)
```

---

## 1. Super-admin → Club Owner Pipeline

### 1.1 Application submission (public)

**Route:** `POST /api/apply` ([app/api/apply/route.ts:1-110](../app/api/apply/route.ts))

**Captures:** `gymName`, `contactName`, `email`, `phone`, `discipline`, `memberCount`, `notes` (optional), `ipAddress`, `userAgent`.

**Rate-limit:** 5 submissions per IP per hour ([line 25](../app/api/apply/route.ts#L25)).

**Side effects:**
1. Creates `GymApplication` row with `status="new"` ([lines 48-72](../app/api/apply/route.ts#L48-L72)).
2. Email to applicant: template `application_received` with gym name + contact name.
3. Email to internal queue: template `application_internal` to addresses in env `MATFLOW_APPLICATIONS_TO` (defaults to `hello@matflow.io`) ([lines 90-105](../app/api/apply/route.ts#L90-L105)).
4. Returns `{ ok: true, id: applicationId }`.

**Audit:** none (no tenant context yet).

---

### 1.2 Operator review

**Route (UI):** `/admin/applications` ([app/admin/applications/page.tsx](../app/admin/applications/page.tsx), [ApplicationsClient.tsx](../app/admin/applications/ApplicationsClient.tsx))

**Statuses:** `new | contacted | approved | rejected` (CHECK constraint, schema line 769).

**Filters:** `pending` (matches `new | pending | contacted`) or `all`.

**Operator actions:** approve, reject (with optional reason).

**Auth gate:** `isAdminPageAuthed()` ([line 9](../app/admin/applications/page.tsx#L9)) — accepts both legacy `matflow_admin` cookie and v1.5 `matflow_op_session`.

---

### 1.3 Approve flow

**Route:** `POST /api/admin/applications/[id]/approve` ([app/api/admin/applications/[id]/approve/route.ts](../app/api/admin/applications/[id]/approve/route.ts))

**Body:** `{ primaryColor?: string, subscriptionTier?: string }` (optional)

**What it does (in order):**

1. **Slug generation** — derive from gym name; on collision, append 2-byte hex; up to 5 retries ([lines 64-70](../app/api/admin/applications/[id]/approve/route.ts#L64-L70)).
2. **Tenant + Owner User creation** in one nested write ([lines 80-102](../app/api/admin/applications/[id]/approve/route.ts#L80-L102)):
   - `Tenant`: `name`, `slug`, `primaryColor` (default `#3b82f6`), `subscriptionStatus="trial"`, `subscriptionTier` default `"pro"`.
   - `User`: `email` (lowercased), `passwordHash` = bcrypt of random 24-char base64 (owner never sees this), `name` = contact name, `role="owner"`.
3. **Magic-link token** — 32-byte hex, HMAC-SHA256-hashed for storage, `purpose="first_time_signup"`, 30-min expiry ([lines 112-124](../app/api/admin/applications/[id]/approve/route.ts#L112-L124)).
4. **Application status → `approved`** ([lines 127-132](../app/api/admin/applications/[id]/approve/route.ts#L127-L132)).
5. **Audit log:**
   - Action: `admin.application.approve`
   - Entity: `GymApplication`
   - Metadata: `tenantSlug`, `ownerEmail`, `ownerUserId`, `operatorEmail`
   - `actAsUserId = operator.id` (from `getOperatorContext(req)`)
6. **Activation email** — template `owner_activation`, link format `/api/magic-link/verify?token={token}&tenantSlug={slug}`. In non-production, the link is also returned in the response body for dev convenience ([line 179](../app/api/admin/applications/[id]/approve/route.ts#L179)).

**Errors:**
- 409 if application already approved ([line 61](../app/api/admin/applications/[id]/approve/route.ts#L61))
- 409 if slug collision after 5 retries ([line 105](../app/api/admin/applications/[id]/approve/route.ts#L105))

---

### 1.4 Reject flow

**Route:** `POST /api/admin/applications/[id]/reject` ([app/api/admin/applications/[id]/reject/route.ts](../app/api/admin/applications/[id]/reject/route.ts))

**Body:** `{ reason?: string }`

**Effects:**
1. `GymApplication.status → "rejected"` ([lines 36-41](../app/api/admin/applications/[id]/reject/route.ts#L36-L41))
2. Logged to `console.warn` (Vercel logs / Sentry); **no `AuditLog` row** because there's no tenant context.

---

### 1.5 Direct tenant creation (operator bypass)

**Route:** `POST /api/admin/create-tenant` ([app/api/admin/create-tenant/route.ts](../app/api/admin/create-tenant/route.ts))

Use case: skip the application review process entirely (for known-good gym onboardings or testing).

**Body:**
```json
{
  "gymName": "string",
  "slug": "string (3-40 chars, lowercase alphanumeric + hyphens)",
  "ownerName": "string",
  "ownerEmail": "string",
  "ownerPassword": "string (min 8 chars)",
  "primaryColor": "string?",
  "subscriptionTier": "string?"
}
```

**Rate-limit:** 10 creations per IP per hour ([lines 35-41](../app/api/admin/create-tenant/route.ts#L35-L41)).

**Side effects:**
- Creates `Tenant` + `User(role=owner)` with operator-supplied password (hashed directly, no magic link).
- `AuditLog` action: `admin.tenant.create` with operator attribution.
- Returns `{ success, tenantId, slug, loginUrl, clubCode: slug, ownerEmail }`.

---

### 1.6 Owner first login + onboarding wizard

**Component:** [components/onboarding/OwnerOnboardingWizard.tsx](../components/onboarding/OwnerOnboardingWizard.tsx) (~1380 lines, 9 stages)

The owner clicks the magic link in the activation email, lands on `/api/magic-link/verify`, gets a NextAuth session cookie, and is redirected to `/dashboard`. The dashboard layout ([app/dashboard/layout.tsx:29-31](../app/dashboard/layout.tsx#L29-L31)) checks `Tenant.onboardingCompleted` and redirects unfinished tenants to `/onboarding` — that's how the wizard takes over.

| Stage | What the owner does | Persistence |
|---|---|---|
| **1. Identity** ([lines 616-653](../components/onboarding/OwnerOnboardingWizard.tsx#L616-L653)) | Confirm gym name | `PATCH /api/settings { name }` |
| **2. Discipline** ([lines 655-699](../components/onboarding/OwnerOnboardingWizard.tsx#L655-L699)) | Multi-select 1+ from BJJ / Boxing / Muay Thai / MMA / Kickboxing / Wrestling / Judo / Karate / Other | not persisted directly; drives Stage 3 presets |
| **3. Rank System** ([lines 701-760](../components/onboarding/OwnerOnboardingWizard.tsx#L701-L760)) | Pick rank presets per discipline (BJJ has 4 stripes, others 0) | `POST /api/ranks` per rank |
| **4. Timetable** ([lines 762-831](../components/onboarding/OwnerOnboardingWizard.tsx#L762-L831)) | Add classes: name, coach, location, days, times, capacity | `POST /api/classes`, then `POST /api/instances/generate` |
| **5. Branding** ([lines 833-989](../components/onboarding/OwnerOnboardingWizard.tsx#L833-L989)) | Pick colour theme (12 presets or custom), upload logo, choose logo size (sm/md/lg) | `POST /api/upload` (logo) + `PATCH /api/settings` (colours, font, logoUrl, logoSize) |
| **6. Questionnaire** ([lines 991-1103](../components/onboarding/OwnerOnboardingWizard.tsx#L991-L1103)) | Gym size, goals, referral source | `PATCH /api/settings { onboardingAnswers }` |
| **7. Payment Rail** ([lines 1105-1192](../components/onboarding/OwnerOnboardingWizard.tsx#L1105-L1192)) | Choose `pay_at_desk` or `stripe` (future: `gocardless`) | If Stripe: redirect to `/api/stripe/connect`. Otherwise `PATCH /api/settings { acceptsBacs: false }` |
| **8. TOTP Enrolment** ([lines 1194-1208](../components/onboarding/OwnerOnboardingWizard.tsx#L1194-L1208)) | Mandatory: scan QR, verify code, save 8 recovery codes | See sub-flow below |
| **9. Member Import** ([lines 1210-1334](../components/onboarding/OwnerOnboardingWizard.tsx#L1210-L1334)) | `manual` (later) / `white_glove` (CSV upload) / `self_serve` | If white_glove: `POST /api/onboarding/csv-handoff` (FormData with file + notes) |
| **Final** ([lines 1337-1381](../components/onboarding/OwnerOnboardingWizard.tsx#L1337-L1381)) | Summary screen → "Go to Dashboard" | `PATCH /api/settings { onboardingCompleted: true }` |

#### TOTP enrolment sub-flow ([components/onboarding/TotpEnrollmentStep.tsx](../components/onboarding/TotpEnrollmentStep.tsx))

**Phase 1 — Enrol:**
1. `GET /api/auth/totp/setup` → `{ secret, qrDataUrl, alreadyEnabled? }`
2. If already enabled, skip ([lines 66-69](../components/onboarding/TotpEnrollmentStep.tsx#L66-L69))
3. Owner scans QR or copies secret manually
4. Owner enters 6-digit code
5. `POST /api/auth/totp/setup { code }` → verifies and persists `User.totpEnabled=true`, `totpSecret` ([lines 88-101](../components/onboarding/TotpEnrollmentStep.tsx#L88-L101))

**Phase 2 — Recovery codes:**
1. `POST /api/auth/totp/recovery-codes` → returns 8 codes ([lines 109-124](../components/onboarding/TotpEnrollmentStep.tsx#L109-L124))
2. Codes stored as HMAC-SHA256 hashes in `User.totpRecoveryCodes`
3. UI requires checkbox acknowledgement ("I've saved my recovery codes") before advancing ([lines 330-345](../components/onboarding/TotpEnrollmentStep.tsx#L330-L345))

> **Edge proxy enforcement:** `proxy.ts` ([lines 165-227](../proxy.ts#L165-L227)) reads `requireTotpSetup` from the JWT. If true, the owner is **pinned to `/login/totp/setup`** for every request until enrolment completes. Onboarding wizard is allowed during this state.

#### Wizard v2 re-entry

After `Tenant.onboardingCompleted=true`, the dashboard `SetupBanner` ([app/dashboard/page.tsx:12-48](../app/dashboard/page.tsx#L12-L48)) detects gaps (no Stripe, no membership tier, no class, no member) and links back to `/onboarding?resume=1`. The `?resume=1` query param bypasses the `onboardingCompleted` redirect at [app/onboarding/page.tsx:27](../app/onboarding/page.tsx#L27), so owners can revisit skipped steps without re-running the whole wizard.

---

### 1.7 Stripe Connect onboarding

**Start:** `GET /api/stripe/connect` ([app/api/stripe/connect/route.ts](../app/api/stripe/connect/route.ts))
- Owner-only (line 8)
- Generates CSRF state: `HMAC-SHA256(tenantId:timestamp, AUTH_SECRET) + ":tenantId:timestamp"` ([lines 17-21](../app/api/stripe/connect/route.ts#L17-L21))
- Redirects to `https://connect.stripe.com/oauth/authorize?response_type=code&client_id={…}&scope=read_write&state={state}`

**Callback:** `GET /api/stripe/connect/callback` ([app/api/stripe/connect/callback/route.ts](../app/api/stripe/connect/callback/route.ts))
- Verifies state HMAC, tenantId match, and timestamp (rejects > 15 min old)
- Exchanges code for token via `stripe.oauth.token()` ([line 44](../app/api/stripe/connect/callback/route.ts#L44))
- Persists `Tenant.stripeAccountId = response.stripe_user_id`, `stripeConnected = true`
- `AuditLog` action: `stripe.connect`, metadata `{ stripeAccountId }`
- Redirects to `/dashboard/settings?tab=revenue&connected=true`

**Error redirects** include query params: `error=auth | missing_params | invalid_state | tenant_mismatch | state_expired | exchange_failed`.

---

### 1.8 Operator support actions (post-onboarding)

All require an operator session; all stamp `AuditLog` with `metadata.actingAs = operator.id` so impersonated actions are distinguishable from owner-originated ones.

#### 1.8.1 Force password reset

**Route:** `POST /api/admin/customers/[id]/force-password-reset` ([app/api/admin/customers/[id]/force-password-reset/route.ts](../app/api/admin/customers/[id]/force-password-reset/route.ts))

**Body:** `{ reason: string (min 5 chars) }`

**Effects:**
- Generates 12-char temp password (alphanumeric base32-safe), bcrypts it
- `User.passwordHash = newHash`, `failedLoginCount = 0`, `lockedUntil = null`, `sessionVersion++`
- `AuditLog` action: `admin.owner.force_password_reset`, metadata `{ reason, ownerEmail }`
- Response includes the temp password in plaintext (operator must hand off via support channel; **never shown again**)

#### 1.8.2 Suspend / reactivate

**Route:** `POST /api/admin/customers/[id]/suspend` (suspend) / `DELETE` (reactivate) ([app/api/admin/customers/[id]/suspend/route.ts](../app/api/admin/customers/[id]/suspend/route.ts))

**Suspend:**
- Body: `{ reason: string (min 5 chars) }`
- `Tenant.subscriptionStatus = "suspended"`
- Bumps `sessionVersion` on every user in the tenant (kicks live JWTs)
- `AuditLog` action: `admin.tenant.suspended`, metadata `{ reason, previousStatus }`
- Suspended tenants reject sign-in at auth-time

**Reactivate (DELETE):**
- `Tenant.subscriptionStatus = "active"`
- `AuditLog` action: `admin.tenant.reactivated`, metadata `{ previousStatus }`

#### 1.8.3 Soft-delete / restore

**Route:** `POST /api/admin/customers/[id]/soft-delete` (delete) / `DELETE` (restore) ([app/api/admin/customers/[id]/soft-delete/route.ts](../app/api/admin/customers/[id]/soft-delete/route.ts))

**Soft-delete:**
- Body: `{ reason: string (min 5 chars), confirmName: string }` — operator must type the gym name to confirm
- `Tenant.deletedAt = now()`
- Bumps `sessionVersion` on all users
- `AuditLog` action: `admin.tenant.soft_deleted`, metadata includes `hardDeleteAfter` (now + 30 days, ISO)
- Tenant disappears from default queries (`WHERE deletedAt IS NULL`), rejects all logins, recoverable for 30 days
- Future cron will hard-delete after the grace window

**Restore:**
- `Tenant.deletedAt = null`
- `AuditLog` action: `admin.tenant.restored`

#### 1.8.4 TOTP reset

**Route:** `POST /api/admin/customers/[id]/totp-reset` ([app/api/admin/customers/[id]/totp-reset/route.ts](../app/api/admin/customers/[id]/totp-reset/route.ts))

**Body:** `{ reason: string (min 5 chars), confirmName: string }`

**Effects:**
- `User.totpEnabled = false`, `totpSecret = null`, `totpRecoveryCodes` cleared, `sessionVersion++`
- `AuditLog` action: `admin.owner.totp_reset`, metadata `{ reason, ownerEmail, wasEnrolled: boolean }`
- Owner is pinned to `/login/totp/setup` on next sign-in

##### Member-side TOTP resets

The 2FA-optional spec adds two parallel routes for resetting a member's TOTP (members can opt into TOTP for the member portal):

- `POST /api/admin/customers/[id]/member-totp-reset` ([app/api/admin/customers/[id]/member-totp-reset/route.ts](../app/api/admin/customers/[id]/member-totp-reset/route.ts)) — operator-triggered, audit action `admin.member.totp_reset`
- `POST /api/members/[id]/totp-reset` ([app/api/members/[id]/totp-reset/route.ts](../app/api/members/[id]/totp-reset/route.ts)) — staff-triggered (owner/manager/admin), audit action `member.totp_reset`

The no-self-disable invariant ([app/api/auth/totp/disable/route.ts](../app/api/auth/totp/disable/route.ts)) means once a member or owner has TOTP enrolled, only these routes (or `admin.owner.totp_reset` above) can clear it.

#### 1.8.5 Transfer ownership

**Route:** `GET` (list candidates) / `POST` (transfer) `/api/admin/customers/[id]/transfer-ownership` ([app/api/admin/customers/[id]/transfer-ownership/route.ts](../app/api/admin/customers/[id]/transfer-ownership/route.ts))

**GET:** returns all non-owner users on tenant: `{ candidates: [{ id, email, name, role, totpEnabled }] }`

**POST body:** `{ targetUserId, reason (min 5 chars), confirmName }`

**Effects (transactional):**
- Current owner → `role = "manager"`, `sessionVersion++`
- Target → `role = "owner"`, `sessionVersion++`
- `AuditLog` action: `admin.tenant.ownership_transferred`, metadata includes both emails, IDs, and previous target role
- Both users forced to log in again

#### 1.8.6 Impersonate

**Route:** `POST /api/admin/impersonate` (start) / `DELETE` (end) ([app/api/admin/impersonate/route.ts](../app/api/admin/impersonate/route.ts))

**Start body:** `{ targetUserId, reason (min 5 chars) }`
- Rate-limit: 30 impersonations per IP per hour
- Sets `matflow_impersonation` cookie via `setImpersonationCookie()`. The `auth.ts` `jwt()` callback reads this cookie and atomically swaps the session identity (skipping TOTP).
- `AuditLog` action: `admin.impersonate.start`, metadata `{ reason, targetEmail, targetRole, operatorEmail }`, `userId = target.id`, `actAsUserId = operator.id`
- Response: `{ ok: true, redirectTo: "/dashboard" }`

**End:**
- Reads cookie, logs `admin.impersonate.end` with the original reason, clears the cookie
- Response: `{ ok: true, redirectTo: "/admin/tenants" }`

> Every action taken **during** an impersonation session writes audit rows with `metadata.actingAs = operator.id`, so the audit feed on `/admin` flags them with "(impersonated)".

#### 1.8.7 DSAR export (GDPR Article 15)

**Route:** `GET /api/admin/dsar/export?memberId=...` ([app/api/admin/dsar/export/route.ts](../app/api/admin/dsar/export/route.ts))

**Auth:** **owner-only** (`requireOwner()` at [line 43](../app/api/admin/dsar/export/route.ts#L43)) — the operator triggers this via impersonation.

**Pulls all PII for one member across 9 tables:**
- Member + parent + children
- AttendanceRecord, Payment, Order
- SignedWaiver
- ClassSubscription, MemberClassPack, ClassPackRedemption
- MemberRank, RankHistory
- EmailLog (excludes message bodies)
- AuditLog

**Response:** JSON file with `Content-Disposition: attachment; filename="dsar-{email}-{date}.json"`, `Cache-Control: private, no-store, max-age=0`.

**Audit:** action `member.dsar_export`, metadata includes per-table counts.

**Operator attribution:** because the route uses `requireOwner()` rather than `getOperatorContext()`, the audit row stamps `userId = owner.id` directly. When an operator triggers this via impersonation, attribution is reconstructable by reading the surrounding `admin.impersonate.start` / `admin.impersonate.end` rows on the same `tenantId` — the DSAR row falls inside the `[start, end]` window and the impersonation rows carry `metadata.actingAs = operator.id` and `reason`. A future refactor may add dual-path auth and stamp `actingAs` on the DSAR row directly; tracked as item 2 of [MATFLOW-FULL-ASSESSMENT-2026-05-07.md](MATFLOW-FULL-ASSESSMENT-2026-05-07.md).

#### 1.8.8 DSAR erase (GDPR Article 17)

**Route:** `POST /api/admin/dsar/erase?memberId=...` ([app/api/admin/dsar/erase/route.ts](../app/api/admin/dsar/erase/route.ts))

**Effects:**
- Member.name → `"Deleted member"`
- Member.email → `deleted-{memberId}@deleted.invalid` (sentinel preserves uniqueness)
- Phone, DOB, emergency contact, medical conditions, password hash → null
- Status → `"cancelled"`
- `sessionVersion++`

**What is intentionally NOT erased** (per GDPR Article 17 + audit/finance integrity):
- `AttendanceRecord` rows stay (preserves attendance counts for class history)
- `Payment` rows stay (tax / dispute audit trail)

**Audit:** action `member.dsar_erase`, metadata `{ originalEmailHash, gdprBasis: "Article 17 right to erasure" }` — the audit row itself is the GDPR fulfilment evidence. **The audit row is written before the erasure** and the erasure refuses to proceed if the audit-write throws, so a successful erasure always has a corresponding audit row (item 4 from MATFLOW-FULL-ASSESSMENT-2026-05-07.md, resolved 2026-05-07).

**Operator attribution:** same shape as DSAR export — the audit row stamps `userId = owner.id`. Operator-via-impersonation attribution is reconstructable by stitching the surrounding `admin.impersonate.start` / `admin.impersonate.end` rows on the same `tenantId`. Dual-path auth is a future refactor (item 2 of the assessment).

**Already-erased guard:** rejects if `status="cancelled"` and email starts with `"deleted-"` ([lines 49-51](../app/api/admin/dsar/erase/route.ts#L49-L51)).

---

### 1.9 Tenant lifecycle states

#### `Tenant.subscriptionStatus`

| Value | Meaning | How it transitions |
|---|---|---|
| `trial` | New tenant, full access | Default after approve / direct create |
| `active` | Paying or trial completed; full access | Operator action; payment success |
| `suspended` | Operator-gated; **rejects logins at auth-time** | `POST /api/admin/customers/[id]/suspend` |
| `cancelled` | Trial ended without conversion or operator action | Future automation |

#### `Tenant.deletedAt`

- `null` — active, appears in queries (default filter `WHERE deletedAt IS NULL`)
- timestamp — soft-deleted: hidden from UI, rejects logins, recoverable for 30 days, then hard-delete

#### `Tenant.onboardingCompleted`

- `false` — wizard incomplete; `/dashboard` should redirect to wizard
- `true` — wizard finished

#### `Tenant.stripeConnected`

- `false` — no Stripe account linked; cannot accept card payments
- `true` — Connect OAuth complete; `stripeAccountId` populated; can charge

---

## 2. Owner → Member Pipeline

### 2.1 Entry points (how a member ends up in the system)

| Entry point | Route | Who triggers |
|---|---|---|
| Staff invite | `POST /api/members` | Owner / manager / admin |
| Public kiosk check-in | `/api/kiosk/[token]/checkin` | Member, via signed kiosk URL |
| Magic-link request (existing user) | `POST /api/magic-link/request` | Member or staff (self-serve) |
| Invite token consumption | `POST /api/members/accept-invite` | Member, after receiving email |

> **No public self-serve signup exists.** A `/[tenantSlug]/signup` page does not exist. Adult members can only join via staff invite or be migrated through CSV import.

---

### 2.2 Member sign-up

**Route:** `POST /api/members` ([app/api/members/route.ts:98-229](../app/api/members/route.ts#L98-L229))

**Auth:** owner / manager / admin. **Kid sub-accounts (`accountType="kids"` or `parentMemberId` set) are owner-only** ([app/api/members/route.ts:120](../app/api/members/route.ts#L120)); manager / admin attempts return 403.

**Body schema:** [`memberCreateSchema`](../lib/schemas/member.ts) — only `name` is required. Email is required for adults but the schema enforces that at the route layer (kids get a synthesised `kid-{nanoid}@no-login.matflow.local`).

**Schema fields:** `name` (required), `email`, `phone`, `membershipType`, `dateOfBirth`, `accountType` (`adult | junior | kids`), `parentMemberId`. **Not in the create schema:** `status`, `paymentStatus`, `emergencyContact*`, `medicalConditions`, `notes` — these come in via `PATCH /api/members/[id]` ([memberUpdateSchema](../lib/schemas/member.ts#L18)) or use Prisma defaults (`status=active`, `paymentStatus=paid`).

**Adult flow:**
1. Email required
2. `passwordHash` is null (passwordless until invite consumed)
3. Generates 7-day `MagicLinkToken` with `purpose="first_time_signup"` ([line 193](../app/api/members/route.ts#L193))
4. Sends `invite_member` email with link
5. Returns `{ member, inviteUrl }` so owner has a fallback if email silently fails

**Kid flow:**
1. **Kid invariant** ([lines 125-141](../app/api/members/route.ts#L125-L141)): requires top-level parent (no grandchildren); rejects if `parentMemberId` itself has a `parentMemberId`
2. Synthesised email: `kid-{nanoid}@no-login.matflow.local` ([line 34](../app/api/members/route.ts#L34))
3. No invite email; passwordless permanently

**Audit:** action `member.create` (adult) or `member.create.kid` ([lines 168-169](../app/api/members/route.ts#L168-L169)).

---

### 2.3 Waiver / consent

**Route:** `POST /api/members/[id]/waiver/sign` ([app/api/members/[id]/waiver/sign/route.ts](../app/api/members/[id]/waiver/sign/route.ts))

**Flow:** staff-supervised only. Member signs a PNG signature on the staff device.

**Validation:** PNG magic-byte check ([lines 39-47](../app/api/members/[id]/waiver/sign/route.ts#L39-L47)) — rejects non-PNG payloads.

**Effects:**
1. Uploads signature to Vercel Blob (public URL not exposed directly to client; proxied through `/api/waiver/{signedWaiverId}/signature`)
2. Creates `SignedWaiver` row — **immutable snapshot** of `titleSnapshot`, `contentSnapshot`, `version`, `signerName`, `signatureImageUrl`, `collectedBy` (= `"admin_device:{userId}"`), `ipAddress`, `userAgent`, `acceptedAt` ([prisma/schema.prisma:459-476](../prisma/schema.prisma#L459-L476))
3. Updates `Member.waiverAccepted = true`, `waiverAcceptedAt = now()`, `waiverIpAddress`, plus emergency contact fields

**Rate-limit:** 5 requests per 15 min per staff user.

**Audit:** action `waiver.sign.supervised`, metadata `{ collectedBy, previousEmergencyContact }`.

> No self-serve waiver path exists today — signature collection requires a staff handoff.

---

### 2.4 Membership tier selection

**Model:** `MembershipTier` ([prisma/schema.prisma:782-798](../prisma/schema.prisma#L782-L798))

**Fields:** `name`, `description`, `pricePence`, `currency` (default GBP), `billingCycle` (`monthly | annual | none`), `maxClassesPerWeek?`, `isKids`, `isActive`.

**Routes:**
- `GET /api/memberships` — list active tiers ([app/api/memberships/route.ts:18-31](../app/api/memberships/route.ts#L18-L31)), owner / manager
- `POST /api/memberships` — create tier; owner-only; audit action `membership.tier.create`

> ⚠️ **Important:** `MembershipTier` is a **pricing template**. The `Member` model does **not** link to `MembershipTier`. Coverage at runtime is determined by `Member.stripeSubscriptionId` + `paymentStatus`, not by a tier reference.

Soft-delete via `isActive=false`; no `deletedAt` field on this model (unlike `RankSystem` which does have soft-delete).

---

### 2.5 Payment setup

**Stripe is the only first-class rail.** Cash / cheque / direct bank transfer outside Stripe are not modelled — use "pay at desk" mode if Stripe is not connected.

#### Subscription creation

**Route:** `POST /api/stripe/create-subscription` ([app/api/stripe/create-subscription/route.ts](../app/api/stripe/create-subscription/route.ts))

**Auth:** owner / manager only.

**Pre-flight:** `ensureCanAcceptCharges()` checks `Tenant.stripeAccountStatus` (Fix 3, T-1).

**Flow:**
1. Create or reuse a Stripe `Customer` on the connected account ([lines 65-83](../app/api/stripe/create-subscription/route.ts#L65-L83)). Race condition: concurrent calls may both create a customer; loser leaks one record.
2. Create `Subscription` with `payment_behavior="default_incomplete"`, returns `clientSecret` for the payment form ([lines 86-114](../app/api/stripe/create-subscription/route.ts#L86-L114))
3. Updates `Member.stripeSubscriptionId`, `preferredPaymentMethod` (`card | bacs_debit`)

#### BACS

Gated by `Tenant.acceptsBacs` ([prisma/schema.prisma line 34-35](../prisma/schema.prisma#L34-L35)). When enabled, BACS Direct Debit flows through Stripe Payments (not a separate rail).

#### Class packs

Separate Stripe Checkout flow (not a subscription). On `checkout.session.completed`, a `MemberClassPack` is created with `creditsRemaining` and an expiry date.

---

### 2.6 Stripe webhook events

**Route:** `POST /api/stripe/webhook` ([app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts))

**Idempotency:** every event is recorded in `StripeEvent` with `eventId @unique` ([lines 54-70](../app/api/stripe/webhook/route.ts#L54-L70)). Stripe retries are no-ops.

| Event | Handler lines | Effect |
|---|---|---|
| `checkout.session.completed` | 244-303 | Class pack purchase → `MemberClassPack`; or shop order → `Order.status="paid"` |
| `invoice.payment_succeeded` | 214-242 | `Payment(succeeded)` row, `Member.paymentStatus = "paid"` |
| `invoice.payment_failed` | 136-212 | `Payment(failed)` with `failureReason`, `Member.paymentStatus = "overdue"`. Emails: `payment_failed` to member, `payment_failed_owner` to all owners |
| `customer.subscription.deleted` | 128-135 | `Member.paymentStatus = "cancelled"`, `stripeSubscriptionId = null` |
| `customer.subscription.updated` | 339-360 | Syncs `paymentStatus` from subscription state: `active → paid`, `past_due → overdue`, `paused → paused`, `canceled / incomplete_expired → cancelled` |
| `payment_intent.processing` | 304-313 | BACS pending → `Member.paymentStatus = "pending"` |
| `mandate.updated` (inactive) | 314-324 | BACS mandate dead → `paymentStatus = "overdue"`, `preferredPaymentMethod = "card"` |
| `charge.refunded` | 325-338 | `Payment.status = "refunded"` |
| `invoice.voided` | 361-371 | `Payment.status = "refunded"` |
| `charge.dispute.created` / `.updated` | 429-510 | `Dispute` row created; if `dispute.lost`, related `Payment` refunded and `MemberClassPack` voided ([lines 476-501](../app/api/stripe/webhook/route.ts#L476-L501)) |
| `account.updated` | 115-127 | Refresh `Tenant.stripeAccountStatus`. Audit action: `stripe.webhook.account_updated` |
| `customer.deleted` | 400-419 | Nulls `Member.stripeCustomerId` |
| `payment_method.detached` | 420-428 | Audit action: `stripe.payment_method.detached` |

---

### 2.7 Check-in

**Route:** `POST /api/checkin` ([app/api/checkin/route.ts](../app/api/checkin/route.ts))

**Methods** (`AttendanceRecord.checkInMethod`): `qr | admin | self | auto | kiosk`.

**Identity resolution:**
- Self: from session email
- Admin/staff: explicit `memberId` param

**Coverage decision tree** ([lib/checkin.ts:106-208](../lib/checkin.ts#L106-L208)):

```
                  performCheckin(method, requireCoverage, enforceRankGate)
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
        rank gate                                          time window
   (memberOrder vs                                  (30 min before start →
   requiredRank/maxRank;                             30 min after end)
   unranked = fail-closed                            kiosk skips this
   on requiredRank)
            │
            ▼
        coverage decision
            │
   ┌────────┼─────────┬──────────────┬─────────────────┐
   ▼        ▼         ▼              ▼                 ▼
 active   pack with  manual       uncovered_kiosk   reject
 sub      credits   (admin)      (kiosk only,      (self, no
   →     →                       requireCoverage   coverage)
record  decrement                false)
        & redeem
```

| Method | requireCoverage | enforceRankGate | Notes |
|---|---|---|---|
| `self` | true | true | Member-initiated; full enforcement |
| `admin` | false | false | Staff override; bypasses everything |
| `kiosk` | false | true | Forgiving on coverage (logs as `uncovered_kiosk`); rank gate enforced |

**Idempotency:**
- `AttendanceRecord` has `UNIQUE(memberId, classInstanceId)` — same member can't double-check-in to one class instance
- Pack redemption: `MemberClassPack` is identified by `stripePaymentIntentId`; redemption is atomic ([lib/checkin.ts:121-158](../lib/checkin.ts#L121-L158))

**Override delete:** `DELETE /api/checkin` (staff-only); audit action `attendance.override`.

**Kiosk variant:** `/api/kiosk/[token]/checkin` ([app/api/kiosk/[token]/checkin/route.ts](../app/api/kiosk/[token]/checkin/route.ts)) — token-gated public endpoint, signed by `Tenant.kioskTokenHash` (HMAC-SHA256). Audit action `auth.checkin.kiosk` with IP /24 and UA summary.

---

### 2.8 Class booking

**There is no pre-booking flow.** Class attendance is recorded **only at check-in**.

What does exist:
- **`ClassSubscription`** ([prisma/schema.prisma:311-321](../prisma/schema.prisma#L311-L321)) — member subscribes to a class for **notifications**, not capacity reservation. Routes: `app/api/member/class-subscriptions`.
- **`ClassWaitlist`** ([prisma/schema.prisma:323-335](../prisma/schema.prisma#L323-L335)) — capacity-overflow queue; status: `waiting | promoted | expired`.

---

### 2.9 Recurring billing lifecycle

All driven by Stripe webhooks (see §2.6). Owner-initiated refund path:

**Route:** `POST /api/payments/[id]/refund` ([app/api/payments/[id]/refund/route.ts](../app/api/payments/[id]/refund/route.ts))

**Effects:**
1. Issues Stripe refund
2. `Payment.status = "refunded"`, `refundedAmountPence` set
3. If the refunded payment funded a `MemberClassPack` (matched via `stripePaymentIntentId`), the pack is voided ([lines 120-135](../app/api/payments/[id]/refund/route.ts#L120-L135))
4. Audit action: `payment.refund`

---

### 2.10 Membership cancellation / pause / freeze

**Route:** `PATCH /api/members/[id]` ([app/api/members/[id]/route.ts:83-159](../app/api/members/[id]/route.ts#L83-L159))
- Staff-only (owner / manager / admin)
- Optimistic concurrency: client must send `clientUpdatedAt`; mismatch → 409 ([lines 107-129](../app/api/members/[id]/route.ts#L107-L129))
- Audit action: `member.update`, metadata includes the field list

**Route:** `DELETE /api/members/[id]` ([app/api/members/[id]/route.ts:161-189](../app/api/members/[id]/route.ts#L161-L189))
- **Owner-only**
- **Hard delete** — no `deletedAt` on `Member`
- Audit action: `member.delete`

**Stripe-driven cancellation:** `customer.subscription.deleted` webhook → `Member.paymentStatus = "cancelled"`, `stripeSubscriptionId = null`.

**Pause / freeze:** no explicit endpoint or state machine. `Member.status` can be set to `"inactive"` via PATCH, but this is not coupled to billing.

---

### 2.11 Magic-link login (members)

#### Request

**Route:** `POST /api/magic-link/request` ([app/api/magic-link/request/route.ts](../app/api/magic-link/request/route.ts))

- Public (pre-session)
- Body: `{ email, tenantSlug }`
- Resolves `User OR Member` (members must have non-null `passwordHash` and non-kids account, [lines 37-51](../app/api/magic-link/request/route.ts#L37-L51))
- Generates 32-byte random token; stores HMAC-SHA256 hash; 30-min expiry
- **Anti-stockpile:** invalidates prior unused tokens for this email ([lines 61-64](../app/api/magic-link/request/route.ts#L61-L64))
- **Rate-limit:** 3 per 15 min per email+tenant
- **Silent on rate-limit:** returns `{ ok: true }` regardless to prevent email enumeration ([line 27](../app/api/magic-link/request/route.ts#L27))
- Audit action: `auth.magic_link.request`

#### Verify

**Route:** `GET /api/magic-link/verify?token=...` ([app/api/magic-link/verify/route.ts](../app/api/magic-link/verify/route.ts))

- Hashes incoming token, looks up via `tokenHash @unique`
- **Atomic single-use:** `updateMany WHERE used=false AND expiresAt > now()` ([lines 25-27](../app/api/magic-link/verify/route.ts#L25-L27))
- Mints NextAuth JWT; sets `SESSION_COOKIE_NAME` cookie (`__Secure-authjs.session-token` in prod / `authjs.session-token` in dev) — see [lib/auth-cookie.ts](../lib/auth-cookie.ts)
- 30-day session
- Redirects: User → `/dashboard`; Member → `/member/home`
- Audit action: `auth.magic_link.consume`

---

### 2.12 Account states

#### `Member.status`

CHECK constraint: `active | inactive | cancelled | taster`. Default: `active`.

> **Taster** is explicitly allowed at the schema level — used for trial/drop-in attendance. Kiosk lookup includes `status IN ("active", "taster")`.

#### `Member.paymentStatus`

CHECK constraint: `paid | overdue | paused | free | pending | cancelled`. Default: `paid`.

| State | Set by |
|---|---|
| `paid` | `invoice.payment_succeeded`, `customer.subscription.updated (active|trialing)` |
| `overdue` | `invoice.payment_failed`, `mandate.updated (inactive)`, `customer.subscription.updated (past_due)` |
| `paused` | `customer.subscription.updated (paused)` |
| `pending` | `payment_intent.processing` (BACS) |
| `cancelled` | `customer.subscription.deleted`, `customer.subscription.updated (canceled|incomplete_expired)` |

#### `Member.lockedUntil`

Account lockout after repeated failed login attempts. Mirrors `User.lockedUntil`. Cleared on successful login.

> **No soft-delete on `Member`.** DELETE is hard. DSAR erase is the closest thing to soft-delete: scrubs PII but keeps the row.

---

### 2.13 Notifications & preferences

**Member-side prefs** ([prisma/schema.prisma:136-140](../prisma/schema.prisma#L136-L140)) — all booleans, default `true`:

- `classReminders` — class scheduling / cancellation alerts
- `beltPromotions` — rank promotion notifications
- `gymAnnouncements` — owner announcements (`Announcement` model)
- `notifyOnNewLogin` — new-device sign-in alerts (P1.6)

Updated via `PATCH /api/member/me`.

#### Email templates ([lib/email.ts:12](../lib/email.ts#L12), `TemplateId` union)

| Template | Subject | Trigger |
|---|---|---|
| `welcome` | "Welcome to {gymName}" | First sign-in / member onboarding |
| `payment_failed` | "{gymName}: your last payment didn't go through" | `invoice.payment_failed` |
| `payment_failed_owner` | "[{gymName}] Payment failed for {memberName}" | `invoice.payment_failed` (to all tenant owners) |
| `password_reset` | "{gymName}: your password reset code" | Self-serve password reset (2-min expiry) |
| `import_complete` | "{gymName}: your member import is complete" | After CSV import job finishes |
| `magic_link` | "Your sign-in link for {gymName}" | `POST /api/magic-link/request` |
| `application_received` | "MatFlow: we received your application for {gymName}" | `POST /api/apply` (to applicant) |
| `application_internal` | "[MatFlow] New application: {gymName} ({discipline}, {memberCount})" | `POST /api/apply` (internal) |
| `invite_member` | "You're invited to join {gymName}" | `POST /api/members` (7-day invite) |
| `owner_activation` | "Your MatFlow gym is approved: {gymName}" | `POST /api/admin/applications/[id]/approve` (30-min link) |
| `login_new_device` | "[{gymName}] New sign-in to your account" | `recordLoginEvent` detects new fingerprint |
| `csv_handoff_internal` | "[MatFlow] CSV handoff from {gymName} — please import" | Onboarding wizard stage 9 (white-glove path) |
| `test` | "MatFlow test email" | `/api/admin/email/test` |

#### LoginEvent model

[prisma/schema.prisma:384-404](../prisma/schema.prisma#L384-L404)

Captures new-device sign-ins. Fields: `tenantId`, `userId | memberId` (mutually exclusive), `deviceHash` (HMAC-SHA256 of normalised IP + UA summary), `ipApprox` (/24 IPv4 or /48 IPv6), `uaSummary`, `firstSeenAt`, `lastSeenAt`, `disownedAt`.

When `disownedAt` is set (via "Wasn't me?" link in the new-device email), the next sign-in from that device fingerprint re-fires the alert.

---

## 3. Shared Infrastructure

### 3.1 AuditLog

[prisma/schema.prisma:441-455](../prisma/schema.prisma#L441-L455)

| Field | Notes |
|---|---|
| `id` | cuid PK |
| `userId?` | FK User; null for kiosk / unauthenticated |
| `tenantId` | required (always tenant-scoped) |
| `action` | namespaced string code |
| `entityType` | what was acted on |
| `entityId` | which entity |
| `metadata?` | JSON; `actingAs = operatorId` flags impersonated actions |
| `ipAddress?`, `userAgent?` | first 500 chars of UA |
| `createdAt` | indexed: `[tenantId, createdAt]` |

#### Audit action codes used in this codebase

```
admin.application.approve
admin.tenant.create
admin.owner.force_password_reset
admin.tenant.suspended
admin.tenant.reactivated
admin.tenant.soft_deleted
admin.tenant.restored
admin.owner.totp_reset
admin.tenant.ownership_transferred
admin.impersonate.start
admin.impersonate.end
member.dsar_export
member.dsar_erase
stripe.connect
stripe.webhook.account_updated
stripe.payment_method.detached
member.create
member.create.kid
member.update
member.delete
waiver.sign.supervised
auth.magic_link.request
auth.magic_link.consume
auth.checkin.kiosk
attendance.override
membership.tier.create
class_pack.create
payment.refund
admin.member.totp_reset
member.totp_reset
auth.member.totp.recovery_codes.generated
auth.account.locked
```

#### Operator vs owner distinction

`metadata.actingAs = operator.id` is set by `logAudit()` when an operator-context call originates the action. The `/admin` dashboard renders an "(impersonated)" badge whenever this is present ([app/admin/page.tsx:209-210](../app/admin/page.tsx#L209-L210)).

---

### 3.2 Email pipeline

**File:** [lib/email.ts](../lib/email.ts)

**Provider:** Resend.

**Logging:** every send (and every failure, even when `RESEND_API_KEY` is missing) is recorded to `EmailLog` ([prisma/schema.prisma:635-649](../prisma/schema.prisma#L635-L649)) with status `queued | sent | delivered | bounced | failed | complained`.

**Secret redaction:** error logs scrub `sk_*` and `whsec_*` patterns.

**Entry point:** `sendEmail({ tenantId, templateId, to, vars })` → `{ ok: boolean, logId: string }`.

---

### 3.3 Auth (NextAuth v5)

**File:** [auth.ts](../auth.ts)

**Strategy:** JWT, 30-day max-age.

**Cookie name:** `SESSION_COOKIE_NAME` from [lib/auth-cookie.ts](../lib/auth-cookie.ts):
- Production: `__Secure-authjs.session-token`
- Dev: `authjs.session-token`

> **Historical bug fixed:** previous routes wrote the legacy v4 name `next-auth.session-token`; commits in May 2026 added the central helper.

#### Providers

1. **Credentials** (email + password + tenantSlug)
   - Rate-limit: 5 attempts per 15 min per email
   - Global IP rate-limit: 30 attempts per 30 min
   - Account lockout: 10 consecutive failures → 1-hour lock
   - Timing-constant: bcrypt against `DUMMY_HASH` when email not found
   - Returns `user` with `sessionVersion`, `totpPending` (owner with TOTP enabled), `requireTotpSetup` (owner without)
2. **Google OAuth** (optional, `ENABLE_GOOGLE_OAUTH=true`)
   - Requires `email_verified`
   - No auto-provisioning
   - Tenant context from signed `pendingTenantSlug` cookie
   - Forces account chooser (prevents silent login on shared devices)

#### `jwt()` callback checks

- `sessionVersion` mismatch → invalidate token (forces sign-out)
- `requireTotpSetup` → owner pinned to `/login/totp/setup`
- `totpPending` → owner must complete `/login/totp` challenge
- Brand refresh every 5 minutes — re-fetches tenant colours **without forcing logout**
- Impersonation override: reads `matflow_impersonation` cookie, atomically swaps identity, skips TOTP

---

### 3.4 Operator auth (v1.5)

**File:** [lib/operator-auth.ts](../lib/operator-auth.ts)

**Cookie:** `matflow_op_session` (httpOnly, secure, sameSite=strict, 8-hour max-age)

**Format:** `<operatorId>.<sessionVersion>.<expiryMs>.<hmac>` where `hmac = HMAC-SHA256(AUTH_SECRET, "<id>.<ver>.<exp>")`.

**Verification:** [`verifyOperatorSession`](../lib/operator-auth.ts#L76)
- Splits cookie on `.`
- Recomputes expected HMAC, timing-safe compare
- Verifies `exp > now` and `sessionVersion` is a safe integer

**Login:** [`attemptOperatorLogin`](../lib/operator-auth.ts#L182)
- Always runs bcrypt (even on missing email, against `PLACEHOLDER_HASH` for timing constancy)
- Failed → `failedLoginCount++`; lock after 5 failures (15-min lockout)
- Success → reset counter, clear lock
- Caller issues session via [`issueOperatorSession`](../lib/operator-auth.ts)

**TTLs:** session 8 hours; TOTP challenge 5 minutes.

**Operator roles:** `super_admin | billing_admin | support_admin | read_only`.

#### Two parallel admin auth paths

[lib/admin-auth.ts](../lib/admin-auth.ts) accepts both:

| Path | How presented | Where |
|---|---|---|
| **v1 (legacy)** | `x-admin-secret` header OR `matflow_admin` cookie (= `MATFLOW_ADMIN_SECRET`) | API routes, edge proxy |
| **v1.5 (preferred)** | `matflow_op_session` cookie | API routes, edge proxy, server pages |

Helpers: `checkAdminHeader`, `checkAdminCookie`, `checkOperatorSession`, `isAdminPageAuthed`, `isAdminAuthed`.

---

### 3.5 Edge proxy

**File:** [proxy.ts](../proxy.ts)

#### Public prefixes (lines 14-48)

`/login`, `/api/auth/*`, `/api/magic-link/*`, `/api/tenant-lookup`, `/api/apply`, `/apply`, `/api/stripe/webhook`, `/api/webhooks/*` (Resend — Svix-verified), `/api/cron/*` (Vercel cron — Bearer-secret), `/api/admin/*` (each route enforces operator auth in-handler), `/admin/login` (other `/admin/*` pages have their own gate below), `/api/kiosk/*`, `/kiosk`, `/legal/*`, `/api/onboarding/*`, `/preview/*`, `/api/members/accept-invite` (token-gated), `/api/account/pending-tenant`, PWA assets (`/_next`, `/favicon`, `/manifest.webmanifest`, `/icons`), `/robots.txt`, `/sitemap.xml`, `/.well-known/*`, `/api/health`.

#### Admin gate (lines 137-153)

Routes `/admin/*` (except `/admin/login`) require **either**:
- `matflow_admin` cookie (= `MATFLOW_ADMIN_SECRET`), OR
- `matflow_op_session` cookie with valid HMAC + non-expired `exp` (edge-only signature check; full `sessionVersion` revocation check deferred to route handlers)

Otherwise redirect to `/admin/login`.

#### Conditional gates (lines 165-227)

1. **TOTP setup** — if `requireTotpSetup === true`, owner pinned to `/login/totp/setup` (allowed on onboarding routes during enrolment)
2. **TOTP pending** — if `totpPending === true`, owner pinned to `/login/totp` challenge before reaching dashboard
3. **Role-based routing:**
   - Members → `/member/home` (redirected from `/dashboard/*`)
   - Staff → `/dashboard` (redirected from `/member/*`)

#### Other

- Maintenance mode: `MAINTENANCE_MODE=true` → 503 (except health/auth/_next)
- Request-ID propagation on every response

---

## 4. Edge Cases Catalogue

### Kid invariant
Kids cannot have kids. `POST /api/members` rejects if `parentMemberId` itself has a `parentMemberId`. ([app/api/members/route.ts:124-141](../app/api/members/route.ts#L124-L141))

### Stripe Customer race
Concurrent `create-subscription` calls may both attempt to create a Stripe `Customer`; the loser leaks one customer record. Subsequent idempotency keys prevent double-subscription. ([app/api/stripe/create-subscription/route.ts:65-83](../app/api/stripe/create-subscription/route.ts#L65-L83))

### Dispute lost → pack voided, attendance preserved
A lost chargeback voids the related `Payment` and any `MemberClassPack` funded by it, but **immutable `AttendanceRecord` rows remain** — sessions already attended count as attended. ([app/api/stripe/webhook/route.ts:476-501](../app/api/stripe/webhook/route.ts#L476-L501))

### Refund-funded pack matching
Owner-initiated refund matches `MemberClassPack.stripePaymentIntentId` to the refunded payment; if active, the pack is voided. ([app/api/payments/[id]/refund/route.ts:120-135](../app/api/payments/[id]/refund/route.ts#L120-L135))

### Kiosk forgiving on coverage
Kiosk check-in enforces rank gates but allows uncovered records (`coverage.kind = "uncovered_kiosk"`). Owner sees these later in attendance reports. ([lib/checkin.ts:80](../lib/checkin.ts#L80))

### Optimistic concurrency on member updates
`PATCH /api/members/[id]` requires `clientUpdatedAt`; mismatch returns 409 to prevent silent overwrites between concurrent staff edits. ([app/api/members/[id]/route.ts:107-129](../app/api/members/[id]/route.ts#L107-L129))

### Silent magic-link rate-limit
`POST /api/magic-link/request` returns `{ ok: true }` even when rate-limited or when the email doesn't resolve to any user/member — prevents enumeration. ([app/api/magic-link/request/route.ts:26-27](../app/api/magic-link/request/route.ts#L26-L27))

### Webhook idempotency
`StripeEvent.eventId @unique` short-circuits Stripe retries with a 200 ack and no further processing. ([app/api/stripe/webhook/route.ts:54-70](../app/api/stripe/webhook/route.ts#L54-L70))

### DSAR erase retains audit + finance rows
`AttendanceRecord` and `Payment` are intentionally not erased — they are GDPR-justified for finance / dispute / audit purposes. The `member.dsar_erase` audit row itself is the GDPR fulfilment evidence. ([app/api/admin/dsar/erase/route.ts](../app/api/admin/dsar/erase/route.ts))

### Soft-delete tenant
30-day recovery window; `sessionVersion++` on every user kicks active JWTs immediately. Future cron will hard-delete. ([app/api/admin/customers/[id]/soft-delete/route.ts](../app/api/admin/customers/[id]/soft-delete/route.ts))

### Suspended tenant rejects logins
At auth-time, `Credentials.authorize` rejects sign-ins where `Tenant.subscriptionStatus = "suspended"`.

### Locked owner visible on /admin
The dashboard renders a "Locked-out owners" section pulling `User.role="owner"` AND `lockedUntil > now()`, with a "Reset" link to `/admin/tenants/{tenantId}`. ([app/admin/page.tsx:181-196](../app/admin/page.tsx#L181-L196))

### Owner without TOTP pinned to /login/totp/setup
Edge proxy gate enforces this on every request; cleared once `requireTotpSetup=false` in JWT. ([proxy.ts:165-196](../proxy.ts#L165-L196))

### Magic-link single-use, anti-stockpile
Tokens are single-use (atomic `updateMany WHERE used=false AND expiresAt > now()`) and prior unused tokens for the same email are invalidated when a new request comes in.

### Operator self-service 2FA
Operators enrol their own TOTP at `/admin/security`. Status is now visible at a glance on `/admin` via the "Your 2FA" stat tile (added 2026-05-05). Danger tone if not enrolled.

### 2FA-optional rollout (2026-05-07)

Owner TOTP is no longer mandatory. The previous `proxy.ts` gate that pinned unenrolled owners to `/login/totp/setup` has been removed. Behaviour now:

- **Owners and staff (manager / coach / admin):** TOTP is **strongly recommended** but optional. Onboarding wizard stage 8 has a "Save for later" control. Once enrolled, no role can self-disable — only the operator support action `POST /api/admin/customers/[id]/totp-reset` clears it. Settings page shows a status row (no toggle) when enrolled.
- **Members with a password:** can self-enrol via Settings → Security. Routes mirror the User-side: `GET / POST /api/member/totp/setup`, `POST /api/member/totp/verify`, `POST /api/member/totp/recovery-codes`. Magic-link members and kids never see the toggle.
- **Magic-link path (members):** `/api/magic-link/verify` is **NOT** TOTP-gated. The 30-min single-use token IS the second factor for magic-link logins. Documented in member settings copy.
- **Recommendation banner:** persistent on `/dashboard` (staff) and `/member/home` (members) while `totpEnabled === false`. Non-dismissible — disappears on enrolment.
- **Member TOTP reset:** two unlock paths — operator (`POST /api/admin/customers/[id]/member-totp-reset`) and gym staff (`POST /api/members/[id]/totp-reset`). The staff path eliminates operator support escalations for the common phone-loss case.
- **Disable route widening:** `POST /api/auth/totp/disable` now returns 403 for any authenticated user (was: 403 owners, 401 non-owners). Self-disable is impossible.
- **No-self-disable defence:** `lib/totp-immutable.ts` strips `totpEnabled / totpSecret / totpRecoveryCodes` from every PATCH body on User/Member routes (settings, member/me, members/[id], staff/[id]).

New audit codes:
- `admin.member.totp_reset` — operator cleared a member's TOTP
- `member.totp_reset` — gym staff cleared a member's TOTP
- `auth.member.totp.recovery_codes.generated` — member generated/regenerated recovery codes

---

## Appendix A — Quick reference: API endpoints by actor

### Operator (super-admin)
- `POST /api/admin/auth/operator-login`
- `POST /api/admin/auth/operator-totp` (challenge)
- `GET / POST /api/admin/auth/operator-totp/setup` (self-enrolment)
- `POST /api/admin/auth/logout`
- `GET / POST /api/admin/applications`
- `POST /api/admin/applications/[id]/approve | reject`
- `POST /api/admin/create-tenant`
- `POST / DELETE /api/admin/customers/[id]/suspend`
- `POST / DELETE /api/admin/customers/[id]/soft-delete`
- `POST /api/admin/customers/[id]/force-password-reset`
- `POST /api/admin/customers/[id]/totp-reset`
- `GET / POST /api/admin/customers/[id]/transfer-ownership`
- `POST / DELETE /api/admin/impersonate`
- `GET /api/admin/dsar/export?memberId=...`
- `POST /api/admin/dsar/erase?memberId=...`
- `GET /api/admin/activity` (audit feed)
- `POST /api/admin/email/test`
- `POST /api/admin/import/upload`, `/preview`, `/commit`

### Owner / staff
- `POST /api/members` (create)
- `PATCH / DELETE /api/members/[id]`
- `POST /api/members/[id]/waiver/sign`
- `POST /api/members/accept-invite`
- `GET / POST /api/memberships`
- `POST /api/classes`, `POST /api/instances/generate`
- `GET / POST /api/ranks`
- `POST / GET /api/stripe/connect`, `/callback`, `/portal`, `/health`
- `POST /api/stripe/create-subscription`
- `POST /api/stripe/disconnect`
- `POST /api/payments/[id]/refund`
- `POST /api/checkin`, `DELETE /api/checkin`
- `PATCH /api/settings`
- `POST /api/upload`
- `POST /api/onboarding/csv-handoff`
- `GET / POST /api/auth/totp/setup`
- `POST /api/auth/totp/verify`
- `POST /api/auth/totp/recovery-codes`

### Member
- `POST /api/magic-link/request`, `GET /api/magic-link/verify`
- `PATCH /api/member/me`
- `GET /api/member/classes`
- `GET / POST / DELETE /api/member/class-subscriptions/[classId]`
- `POST /api/checkin` (self)

### Public
- `POST /api/apply`
- `GET /api/tenant-lookup`
- `POST /api/stripe/webhook`
- `POST /api/kiosk/[token]/checkin`

---

## Appendix B — Prisma model index (one-liner per model)

| Model | Purpose | Soft-delete? |
|---|---|---|
| `Tenant` | One gym/dojo | yes (`deletedAt`) |
| `User` | Staff/admin accounts | no |
| `Member` | Customers / students | no (DSAR erase scrubs) |
| `Operator` | Super-admin accounts (v1.5) | no |
| `GymApplication` | Public /apply submissions | no (status flag) |
| `RankSystem` / `MemberRank` / `RankHistory` / `RankRequirement` | Belt/rank progression | yes on RankSystem |
| `Class` / `ClassSchedule` / `ClassInstance` | Class templates and occurrences | yes on Class |
| `AttendanceRecord` | Check-ins (immutable) | no |
| `ClassSubscription` / `ClassWaitlist` | Notif subscription / waitlist | no |
| `MembershipTier` | Pricing template (not linked to Member) | no (`isActive`) |
| `ClassPack` / `MemberClassPack` / `ClassPackRedemption` | Prepaid bundles | no (`status`) |
| `Payment` | Stripe transaction ledger | no |
| `Dispute` | Chargeback tracking | no |
| `Order` / `Product` | Shop orders & inventory (LB-001) | yes on Product |
| `MagicLinkToken` | Passwordless / first-time tokens | n/a (TTL) |
| `PasswordResetToken` | Password reset codes | n/a (TTL) |
| `PasswordHistory` | Reuse-prevention | no |
| `LoginEvent` | New-device detection | no |
| `Notification` | In-app/email alerts | no |
| `Announcement` | Gym-wide bulletins | no |
| `SignedWaiver` | Immutable consent snapshot | no |
| `EmailLog` | Transactional email tracking | no |
| `AuditLog` | Activity trail | no |
| `StripeEvent` | Webhook idempotency | no |

---

## Appendix C — Key environment variables

| Var | Purpose |
|---|---|
| `AUTH_SECRET` | NextAuth + operator HMAC + Stripe Connect state HMAC |
| `MATFLOW_ADMIN_SECRET` | Legacy v1 admin auth (still accepted) |
| `MATFLOW_APPLICATIONS_TO` | Internal email recipients for new applications |
| `RESEND_API_KEY` | Email provider |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` | Stripe |
| `DATABASE_URL` | Neon Postgres |
| `TESTING_MODE`, `DEMO_MODE` | Disable TOTP-setup gate locally |
| `MAINTENANCE_MODE` | 503 everything except health/auth/_next |
| `ENABLE_GOOGLE_OAUTH` | Toggle Google provider |
