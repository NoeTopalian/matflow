# MatFlow State Map — Lane A: Identity & Account States

Read-only code audit of `C:/Users/NoeTo/Desktop/matflow` (Next.js 16 App Router,
Prisma/Neon Postgres, NextAuth v5, multi-tenant gym SaaS).
Every claim carries `file:line` evidence. Anything I reasoned about but did not
execute is tagged **UNVERIFIED**. Nothing in the repository was modified.

---

## 0. HEADLINE TRUTHS

1. **There are two identity tables and no adapter.** `User` (staff) and `Member`
   (student) — `prisma/schema.prisma:81` and `:122`. No `Account`, `Session` or
   `VerificationToken` model exists; NextAuth runs `strategy: "jwt"` with a
   30-day cookie (`auth.ts:121-124`). All revocation therefore depends on the
   `sessionVersion` recheck at `auth.ts:670-695`, which is itself cached for
   10 minutes (`auth.ts:669`).

2. **`User.passwordHash` is NOT NULL; `Member.passwordHash` is nullable.**
   `schema.prisma:86` vs `:127`. That single difference generates most of the
   state machine in this report.

3. **Every Member is born unable to log in.** All four production creation
   paths write `passwordHash: null` — `app/api/members/route.ts:238`,
   `app/api/admin/import/[id]/commit/route.ts:80-95` (field omitted),
   `app/api/member/children/route.ts:94`, `app/api/members/[id]/link-child/route.ts:48`.
   The only null→set transition in the codebase is
   `POST /api/members/accept-invite` (`route.ts:79-84`). `prisma/seed.ts:260-270`
   gives seeded members a real password, so local dev exercises a state
   production cannot reach.

4. **The owner's password is generated and thrown away.**
   `app/api/admin/applications/[id]/approve/route.ts:88-89` hashes
   `randomBytes(18)` and never emails, returns or stores the plaintext
   (`:193` suppresses it in production). The owner's only route in is a
   single-use magic link with a **30-minute** TTL (`:127`).

5. **Nobody can change their own password.** The only `newPassword` handler in
   the repo is `app/api/staff/[id]/route.ts:14,52` — owner-only (`:29-30`) and
   explicitly excluding `role: "owner"` rows (`:90,95`). The owner cannot change
   their own password; members have no password-change route at all. The sole
   self-service path is a 6-digit OTP with a **2-minute** TTL
   (`app/api/auth/forgot-password/route.ts:77`).

6. **Member 2FA bricks the account.** `app/login/totp/setup/page.tsx:26,37` is
   role-aware, but `app/login/totp/page.tsx:20` hardcodes
   `/api/auth/totp/verify`, which reads only the `User` table
   (`app/api/auth/totp/verify/route.ts:42-51`). A member who enrols is redirected
   there by `proxy.ts:187` on every subsequent password login and receives
   `400 "TOTP not enabled"` forever. The correct route
   (`/api/member/totp/verify`) has zero callers **and** is missing from
   `proxy.ts` `PUBLIC_PREFIXES` (`:20-39`), so it would be 307'd even if called.

7. **Non-owner staff 2FA is never challenged.** `auth.ts:335` gates
   `totpPending` on `isOwner`, yet `app/api/auth/totp/setup/route.ts:22-25`
   allows any staff role to enrol and `auth.ts:339-342` nudges every role to do
   so. The two populations for whom TOTP actually functions are exactly
   inverted: owners (works), members (bricks), managers/coaches/admins (silently
   ignored).

8. **Magic link ignores every account state.**
   `app/api/magic-link/verify/route.ts` checks the token and nothing else — no
   `lockedUntil`, no `Tenant.deletedAt`, no `Tenant.subscriptionStatus`, no
   `Member.status`, and `:86` hardcodes `totpPending = false`. The password path
   refuses suspended and soft-deleted tenants at `auth.ts:193-194`; the magic
   link does not.

9. **Magic-link member sessions are unrevocable.**
   `app/api/magic-link/verify/route.ts:98-107` omits the `memberId` claim, so
   the branch at `auth.ts:679-688` queries the `User` table with a `Member` id,
   gets `null`, and skips the mismatch guard at `:690`. Password reset, logout-all,
   tenant suspend and tenant soft-delete all become no-ops against that session.
   The same missing claim makes `app/api/member/home/route.ts:144-146` serve
   **demo data** to a real member.

10. **`Member.status` is never read by any authentication code.** `auth.ts:200-208`
    and `:346-379` build the session without touching it, and
    `app/api/members/[id]/route.ts:317` stamps `cancelledAt` without bumping
    `sessionVersion` or nulling `passwordHash`. A cancelled member keeps logging
    in indefinitely. The kiosk is the only surface that honours the field
    (`app/api/kiosk/[token]/members/route.ts:58`).

11. **There is no soft delete and no email verification for people.**
    `deletedAt` exists only on `Tenant`, `MemberRank`, `Class` and `Product`
    (`grep -n "deletedAt" prisma/schema.prisma`). Staff deletion is a hard
    `deleteMany` (`app/api/staff/[id]/route.ts:155`); member deletion is a hard
    cascade (`lib/member-delete.ts:137`). No `emailVerified` column exists on
    either table; the only verification check in the product is Google's own
    `email_verified` claim (`auth.ts:461-463`).

12. **TOTP secrets are the only credential in the schema stored in cleartext.**
    `schema.prisma:90` and `:160`, against HMAC-hashed magic-link tokens
    (`:587`), reset OTPs (`:606`), the kiosk token (`:58`) and the recovery
    codes (`:92`).

---

## 1. The two identity tables

There are exactly **two** identity tables. There is no `Account`, `Session`,
`VerificationToken` or `Invite` model — NextAuth runs `strategy: "jwt"` with no
adapter (`auth.ts:121-124`), so all session state lives in a signed cookie.

### 1.1 `User` (staff) — `prisma/schema.prisma:81-118`

| Field | Type | Notes / evidence |
|---|---|---|
| `id` | `String @id @default(cuid())` | `schema.prisma:82` |
| `tenantId` | `String` (required) | `schema.prisma:83` — every staff row is tenant-bound |
| `email` | `String` | `schema.prisma:85`; unique only as `@@unique([tenantId, email])` `:116` |
| `passwordHash` | **`String` — NOT NULL** | `schema.prisma:86`. A staff row can never exist without a bcrypt hash. |
| `name` | `String` | `:87` |
| `role` | `String @default("admin")` | `:88`. DB CHECK `owner\|manager\|coach\|admin` — `prisma/migrations/20260430000001_schema_check_constraints/migration.sql` (`User_role_check`). |
| `sessionVersion` | `Int @default(0)` | `:89` |
| `totpSecret` | `String?` | `:90` — stored **in cleartext**, no envelope encryption (see §6) |
| `totpEnabled` | `Boolean @default(false)` | `:91` |
| `totpRecoveryCodes` | `Json?` | `:92` — array of HMAC-SHA256 hashes |
| `failedLoginCount` | `Int @default(0)` | `:93` |
| `lockedUntil` | `DateTime?` | `:94`, indexed `:117` |
| `notifyOnNewLogin` | `Boolean @default(true)` | `:97` |
| `createdAt` / `updatedAt` | | `:98-99` |

**Absent from `User`:** `deletedAt` (no soft delete), `emailVerified`/`emailVerifiedAt`
(no email-verification concept), `status`/`active` flag, `mustChangePassword`,
`invitedAt`. Verified by `grep -n "deletedAt" prisma/schema.prisma` → only
`Tenant:64`, `MemberRank:279`, `Class:365`, `Product:972`.

### 1.2 `Member` (student) — `prisma/schema.prisma:122-216`

| Field | Type | Notes / evidence |
|---|---|---|
| `passwordHash` | **`String?` — NULLABLE** | `:127`. Null = "cannot use the password form"; this is the load-bearing difference from `User`. |
| `status` | `String @default("active")` | `:131`. DB CHECK `active\|inactive\|cancelled\|taster`. |
| `cancelledAt` | `DateTime?` | `:132` |
| `paymentStatus` | `String @default("paid")` | `:133`. CHECK `paid\|overdue\|paused\|free\|pending\|cancelled` |
| `sessionVersion` | `Int @default(0)` | `:136` |
| `accountType` | `String @default("adult")` | `:142`. CHECK widened to `adult\|junior\|kids\|parent` by `20260512000001_member_account_type_parent/migration.sql`. |
| `parentMemberId` | `String?` self-relation | `:150-152`, `onDelete: SetNull` |
| `failedLoginCount` / `lockedUntil` | mirrors `User` | `:154-155`, indexed `:201` |
| `totpEnabled` / `totpSecret` / `totpRecoveryCodes` | mirrors `User` | `:159-161` |
| `waiverAccepted` / `waiverAcceptedAt` / `waiverIpAddress` | | `:143-145` |
| `onboardingCompleted` | `Boolean @default(false)` | `:135` |

**Absent from `Member`:** `deletedAt`, `role` (role is hardcoded `"member"` in
`auth.ts:364` and `:514`), any email-verification field, any `invitedAt`.

**DB invariant:** `Member_kids_must_have_parent` —
`CHECK ("accountType" <> 'kids' OR "parentMemberId" IS NOT NULL)`
(`prisma/migrations/20260515000001_member_kids_check_constraint/migration.sql:26-31`).
This is enforced and **validated**, so any write that sets `accountType='kids'`
without a parent raises a Postgres check violation. See §6 D-3.

### 1.3 Token tables

| Model | Purpose values | Evidence |
|---|---|---|
| `MagicLinkToken` | `login \| first_time_signup \| waiver_open` | `schema.prisma:583-598`; `tokenHash @unique`, HMAC-SHA256 |
| `PasswordResetToken` | (no purpose column) 6-digit OTP, 2-min TTL | `schema.prisma:602-612`; TTL set at `app/api/auth/forgot-password/route.ts:77` |

Neither token table carries a `subjectKind` discriminator — the subject
(User vs Member) is re-discovered at consume time, with **User always winning**
(`app/api/auth/reset-password/route.ts:74-104`, documented as a known defect at
`app/api/auth/forgot-password/route.ts:53-59`).

### 1.4 Every writer of each identity field

**`User.passwordHash`**
| Writer | file:line | Value written |
|---|---|---|
| Owner activation (approve gym application) | `app/api/admin/applications/[id]/approve/route.ts:88-109` | bcrypt(random 24-char) — **never shown to anyone** |
| Add staff (owner-only) | `app/api/staff/route.ts:76-87` | bcrypt of the password the owner typed |
| Edit staff | `app/api/staff/[id]/route.ts:52` | bcrypt of new password; bumps `sessionVersion` `:64` |
| Password reset consume | `app/api/auth/reset-password/route.ts:160-166` | bcrypt(new); bumps `sessionVersion` |
| Operator force-password-reset | `app/api/admin/customers/[id]/force-password-reset/route.ts:65-71` | bcrypt(temp); also clears lock + bumps `sessionVersion` |
| Seed / scripts | `prisma/seed.ts:58,74,87`; `scripts/reset-owner-password.ts:8`; `scripts/setup-test-accounts.mjs:34,57`; `scripts/swap-totalbjj-owner-email.mjs:62` | dev/ops only |

**`Member.passwordHash`**
| Writer | file:line | Value written |
|---|---|---|
| Staff creates member | `app/api/members/route.ts:238` | **`null`** (always — adults too) |
| Staff bulk-invite | `app/api/members/bulk-invite/route.ts:59` | `null` |
| Parent adds child | `app/api/member/children/route.ts:94` | `null` |
| CSV import commit | `app/api/admin/import/[id]/commit/route.ts:80` (`createMany`) | field not supplied ⇒ `null` |
| Accept invite | `app/api/members/accept-invite/route.ts:79-84` | bcrypt(chosen password); bumps `sessionVersion` |
| Password reset consume | `app/api/auth/reset-password/route.ts:186-192` | bcrypt(new); bumps `sessionVersion` |
| DSAR erase | `app/api/admin/dsar/erase/route.ts:290` | back to `null` |

**Consequence:** *every* Member is born with `passwordHash = null`. The only
route from null → set is `POST /api/members/accept-invite` with a valid
`first_time_signup` MagicLinkToken. Password reset explicitly refuses null-password
members (`reset-password/route.ts:94` `passwordHash: { not: null }`).

**`sessionVersion` writers (revocation)**
| Trigger | file:line |
|---|---|
| Member accepts invite | `app/api/members/accept-invite/route.ts:83` |
| Password reset (user or member) | `app/api/auth/reset-password/route.ts:164, 190` |
| Staff edit (role/email/password change) | `app/api/staff/[id]/route.ts:64` |
| "Log out everywhere" | `app/api/auth/logout-all/route.ts:26-34` |
| Operator force-password-reset | `.../force-password-reset/route.ts:71` |
| Operator tenant suspend (all users + members) | `.../suspend/route.ts:113-115` |
| Operator tenant soft-delete (all users + members) | `.../soft-delete/route.ts:100-102` |
| Operator transfer ownership (both users) | `.../transfer-ownership/route.ts:89-95` |
| Operator/staff TOTP reset | `.../totp-reset/route.ts:72`, `.../member-totp-reset/route.ts:83`, `app/api/members/[id]/totp-reset/route.ts:54` |

**`lockedUntil` / `failedLoginCount` writers**
| Trigger | file:line |
|---|---|
| Failed password (increment, lock at 10) | `auth.ts:246-267` (threshold `auth.ts:105`, duration 1 h `auth.ts:106`) |
| Successful password login (clear) | `auth.ts:286-302` |
| Staff unlocks a **member** | `app/api/members/[id]/unlock/route.ts:62-64` |
| Operator force-password-reset on the **owner** | `.../force-password-reset/route.ts:69-70` |

There is **no** unlock route for a `User` other than the owner-only operator
force-password-reset. See §6 D-1.

---

## 2. Every way an account comes into existence

### 2.1 Staff (`User`) genesis — 2 production paths

| # | Path | Entry point | Writer | Birth state |
|---|---|---|---|---|
| S1 | **Owner activation** (operator approves a `GymApplication`) | `/apply` → `app/api/apply/route.ts:53-69` creates `GymApplication` (no identity yet) → operator `POST /api/admin/applications/[id]/approve` | `app/api/admin/applications/[id]/approve/route.ts:94-116` (nested `users.create`) | `role:"owner"`, `passwordHash = bcrypt(randomBytes(18).base64.slice(0,24))` — **the plaintext is discarded at `:88`, never emailed, never returned in prod (`:193`)**. `sessionVersion 0`, `totpEnabled false`, `lockedUntil null`. Plus a `MagicLinkToken{purpose:"first_time_signup", TTL 30 min}` at `:126-138`. |
| S2 | **Add staff** (owner-only, from Settings) | `POST /api/staff` | `app/api/staff/route.ts:80-89` | `role ∈ {manager,coach,admin}` (`:18` — cannot mint another owner), `passwordHash = bcrypt(owner-typed password)`. **No invite email is sent and no token is minted** — the owner must tell the new staff member the password out of band. Response says `mustChangePassword: false` (`:102`) and no such field exists on `User`. |

Non-production: `prisma/seed.ts:58,74,87` (owner/coach/admin, all `bcrypt("password123")`),
`scripts/setup-test-accounts.mjs`, `scripts/swap-totalbjj-owner-email.mjs`.
There is **no** path that creates a `User` with `role:"manager"` other than the
operator demotion in `transfer-ownership/route.ts:91` and the staff form.

### 2.2 Member genesis — 4 production paths, all passwordless

| # | Path | Writer | Birth state | Invite minted? |
|---|---|---|---|---|
| M1 | Staff creates one member | `app/api/members/route.ts:232-264` | `passwordHash: null` (`:238`), `status "active"`, `accountType` from body | **Yes** — `first_time_signup` token, 7-day TTL (`:287-304`), email `invite_member`; failure is swallowed (`:315-320`) leaving `inviteUrl: null` |
| M2 | CSV / platform import | `app/api/admin/import/[id]/commit/route.ts:80-95` (`createMany`) | `passwordHash` not supplied ⇒ `null`; `status: d.status ?? "active"`; `accountType: d.accountType ?? "adult"` | **No** — hence `POST /api/members/bulk-invite` exists purely to repair this (`app/api/members/bulk-invite/route.ts:3-7` says so explicitly) |
| M3 | Parent adds a child | `app/api/member/children/route.ts:88-94` | `passwordHash: null`, synthesised email `kid-<32hex>@no-login.matflow.local` (`lib/synthesise-kid-email.ts:17-20`), `parentMemberId` = caller | **No** — by design |
| M4 | Staff creates a kid | `app/api/members/route.ts:226,238,248-250` | Same as M3 plus forced `status:"active", waiverAccepted:false, onboardingCompleted:true`; owner-only (`:180`), max kids enforced (`:208`) | **No** |
| M5 | Staff links an existing passwordless row as a child | `app/api/members/[id]/link-child/route.ts:48-59` (`updateMany` requires `parentMemberId: null, passwordHash: null`) | Converts an existing adult-shaped row into a kid | n/a |

Seed is the exception: `prisma/seed.ts:260-270` gives every seeded member
`passwordHash = bcrypt("password123")`, so local dev exercises a state that
**no production path can produce**.

### 2.3 The identity state every new account starts in

```
User   : passwordHash = <bcrypt, always non-null>   totpEnabled=false  lockedUntil=null  sessionVersion=0
Member : passwordHash = NULL                        totpEnabled=false  lockedUntil=null  sessionVersion=0
```

**Which login paths work at birth?**

| Birth state | Password form | Magic link | Google OAuth | Kiosk |
|---|---|---|---|---|
| Owner (S1) — random unknown password | Technically yes, practically **no** (nobody holds the plaintext) | **Yes** — the 30-min activation token; and `/api/magic-link/request` also works because the User row exists | Yes, if enabled | n/a |
| Staff (S2) | Yes (owner-supplied password) | Yes | Yes | n/a |
| Member, `passwordHash = null` (M1–M4) | **No** — `auth.ts:346` requires `memberRow?.passwordHash` truthy; falls through to `return null` at `:411` | **No** — both `magic-link/request:49` and `magic-link/verify:51` filter `passwordHash: { not: null }` | **YES — the null-password filter is missing** (`auth.ts:481-487` only checks the row exists). See §5 C-2. |
| Kid (M3/M4) | No | No (filtered, and the `.local` address has no inbox) | No (no Google account can own `@no-login.matflow.local`) | Indirectly — kiosk check-in is by tenant token + name search (`app/api/kiosk/[token]/members/route.ts:55-60`), not by member credential |

So the **only** null → set transition for a Member is
`POST /api/members/accept-invite` (`route.ts:79-84`) with a live
`first_time_signup` token. Password reset explicitly refuses null-password
members (`app/api/auth/forgot-password/route.ts:64`,
`app/api/auth/reset-password/route.ts:94`).

---

## 3. Every login path and exactly what it admits

### 3.1 The paths

There is **one** login form for both staff and members
(`app/login/page.tsx:393-397` — a single `signIn("credentials", {tenantSlug, email, password})`).
There is no separate member login form and **no self-signup anywhere**; the
only public CTA is "Apply for Account Creation" → `/apply` (`app/login/page.tsx:296`).

| # | Path | Code |
|---|---|---|
| L1 | Password (Credentials provider) | `auth.ts:140-449` |
| L2 | Magic link | `POST /api/magic-link/request` → `GET /api/magic-link/verify` (`app/api/magic-link/verify/route.ts:9-136`) |
| L3 | Google OAuth | `auth.ts:129-139` provider + `signIn` callback `auth.ts:455-563`; gated on `ENABLE_GOOGLE_OAUTH` server-side (`auth.ts:34-37`) and on `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH` client-side (`app/login/page.tsx:715`) — **two different env vars** |
| L4 | TOTP second factor | `proxy.ts:187` gate → `app/login/totp/page.tsx:20` → `POST /api/auth/totp/verify` (User-only) / `POST /api/member/totp/verify` (orphan) |
| L5 | Accept-invite auto-signin | `app/login/accept-invite/page.tsx:49,67` — sets the password then calls L1 |
| L6 | Kiosk | `app/api/kiosk/[token]/*` — the URL token hash is matched to `Tenant.kioskTokenHash` (`members/route.ts:44-53`); no personal credential; excluded from middleware entirely (`proxy.ts:223` matcher) |
| L7 | Operator / super-admin | `matflow_admin` or `matflow_op_session` cookie, `proxy.ts:139-155` + `lib/admin-auth.ts` — a separate identity system, not a `User` row |
| L8 | Impersonation | `auth.ts:620-660` — a valid `matflow_impersonation` cookie rewrites the JWT to the target user; **explicitly sets `totpPending:false` and `totpEnabled:true`** (`:647-652`) |
| L9 | E2E bypass | `auth.ts:232-238` — `TESTING_MODE` + localhost-ish IP + `password === E2E_BYPASS_TOKEN` skips bcrypt entirely; `:384-408` falls back to "first owner in the tenant" if no email matches |
| L10 | DEMO_MODE fallback | `auth.ts:421-446` — only when the DB throws AND `NODE_ENV !== production` AND `DEMO_MODE=true` |

### 3.2 Admission matrix — which account states each path admits

`✅ admits` / `❌ refuses` / `⚠️ admits but should not`

| Account state | L1 password | L2 magic link | L3 Google | L6 kiosk |
|---|---|---|---|---|
| `lockedUntil` in the future | ❌ `auth.ts:222,240` throws `AccountLockedError` — **even with the correct password** | ⚠️ **✅ admits** — `magic-link/verify` never reads `lockedUntil` | ⚠️ **✅ admits** — `signIn` callback never reads `lockedUntil` | n/a |
| Member `passwordHash = null` | ❌ `auth.ts:346` | ❌ `verify:51`, `request:49` | ⚠️ **✅ admits** — `auth.ts:481-487` has no `passwordHash` filter | n/a |
| Member `status = "cancelled"` / `"inactive"` | ⚠️ **✅ admits** — `auth.ts:200-208` fetches the row and `:346-379` returns a session with no reference to `status` | ⚠️ ✅ admits | ⚠️ ✅ admits | ❌ **refuses** — `kiosk/[token]/members/route.ts:58` filters `status: { in: ["active","taster"] }` |
| Member with `totpEnabled = true` | ⚠️ admits then **bricks** — `auth.ts:376` sets `totpPending:true`; see §5 D-2 | ✅ admits and **skips TOTP entirely** — `magic-link/verify/route.ts:86,106` hardcode `totpPending = false` (documented trade-off at `:78-85`) | ⚠️ ✅ sets `totpPending` correctly (`auth.ts:523`) → same brick | n/a |
| Owner with `totpEnabled = true` | ✅ then TOTP challenge (`auth.ts:335`) which **works** (`/api/auth/totp/verify` reads `User`) | ✅ **bypasses TOTP** | ✅ then TOTP challenge | n/a |
| Tenant `deletedAt != null` | ❌ `auth.ts:193` | ⚠️ **✅ admits** — verify never loads tenant status, only `slug` (`verify:55-58`) | ⚠️ **✅ admits** — `auth.ts:471-474` only checks existence | ⚠️ ✅ admits — `grep -rn "deletedAt\|suspended" app/api/kiosk` returns **nothing** |
| Tenant `subscriptionStatus = "suspended"` | ❌ `auth.ts:194` | ⚠️ ✅ admits | ⚠️ ✅ admits | ⚠️ ✅ admits |
| Soft-deleted `User` / `Member` | n/a — **no `deletedAt` column exists on either table** | n/a | n/a | n/a |
| DSAR-erased member (`status "cancelled"`, `passwordHash null`, sentinel email) | ❌ (null password) | ❌ (null password) | ❌ in practice (`deleted-…@deleted.invalid` is not a Google address) | ❌ (`status="cancelled"`, `app/api/admin/dsar/erase/route.ts:310`) |
| Unverified email | **The concept does not exist.** No `emailVerified` column on either table; Google's `email_verified` is the only verification check anywhere (`auth.ts:461-463`). |

### 3.3 The TOTP step in detail

```
proxy.ts:165-169  →  PUBLIC_PREFIXES contains "/login"  →  early-return
proxy.ts:187      →  totpPending === true  →  307 to /login/totp   (never fires for /login/*)
proxy.ts:191      →  DEAD CODE: /login/totp already returned at :166
```
`proxy.ts:191-193` (the "you're not pending, get off this page" redirect) is
**unreachable**, because `"/login/totp".startsWith("/login")` is true and
`proxy.ts:165-169` returns first.

`PUBLIC_PREFIXES` contains `/api/auth` (so the staff verify route is exempt from
the `totpPending` gate) and `/api/member/totp/recover` — but **not**
`/api/member/totp/verify` (`proxy.ts:20-39`). So even a corrected client could
not reach the member verify route: `proxy.ts:187` would 307 the POST to
`/login/totp`.

---

## 4. State transition table

There is no `status` enum on `User` at all, and `Member.status` is never read by
any authentication code. "Account state" is therefore an emergent product of
five independent columns: `passwordHash`, `lockedUntil`, `totpEnabled`,
`sessionVersion`, and (for members only) `status`.

### 4.1 Staff (`User`) lifecycle

| Edge | Trigger | Writer (file:line) | Notes |
|---|---|---|---|
| — → **created (owner)** | Operator approves application | `app/api/admin/applications/[id]/approve/route.ts:94-116` | Password is random and discarded |
| — → **created (staff)** | Owner submits Add-staff form | `app/api/staff/route.ts:80-89` | Owner types the password |
| created → **activated** | Owner clicks the 30-min activation link | `app/api/magic-link/verify/route.ts:24-34,109-134` | Mints the session directly; **does not set a password** |
| any → **locked** | 10 consecutive bad passwords | `auth.ts:246-267` (`lockedUntil = now + 1 h`, `failedLoginCount → 0`) | Also `auth.ts:271-278` audit `auth.account.locked` |
| any → **locked** | User clicks "this wasn't me" in a login-alert email | `app/api/auth/disown-login/[token]/route.ts:59-67` | Bumps `sessionVersion` **and** sets `lockedUntil` |
| locked → **unlocked** | Wait 1 h (`auth.ts:222` is a timestamp comparison) | — | passive only |
| locked → **unlocked** | Operator force-password-reset | `.../force-password-reset/route.ts:65-71` | **owner rows only** (`:54`) |
| locked → **bypassed** | Magic link | `app/api/magic-link/verify/route.ts` | never reads `lockedUntil` |
| any → **password changed** | Self-service via OTP | `app/api/auth/reset-password/route.ts:160-166` | bumps `sessionVersion`; **does not clear `lockedUntil`** |
| any → **password changed** | Owner edits another staff member | `app/api/staff/[id]/route.ts:52,64` | excludes `role: "owner"` rows (`:90,95`) |
| any → **TOTP-enrolled** | `POST /api/auth/totp/setup` | `app/api/auth/totp/setup/route.ts:98-135` | any staff role (`:22-25`) |
| TOTP-enrolled → **un-enrolled** | Operator TOTP reset | `.../totp-reset/route.ts:62-72` | **owner rows only** (`:54`) |
| TOTP-enrolled → **un-enrolled** | Recovery code | `app/api/auth/totp/recover/route.ts:77-97` | endpoint works; **no UI calls it** |
| TOTP-enrolled → **self-disable** | — | **impossible** — `app/api/auth/totp/disable/route.ts:18-27` returns 403 unconditionally |
| any → **role changed** | Operator transfer-ownership | `.../transfer-ownership/route.ts:89-95` | old owner → `manager`, both bumped |
| any → **sessions revoked** | Logout-everywhere / suspend / soft-delete | `app/api/auth/logout-all/route.ts:31-33`; `.../suspend/route.ts:114`; `.../soft-delete/route.ts:101` | |
| any → **deleted** | Owner removes staff | `app/api/staff/[id]/route.ts:155-157` — **hard `deleteMany`**, never the owner | No soft delete; `AuditLog.userId` goes `SetNull` (`schema.prisma:625`) |
| **deactivated** | *state does not exist* | — | No `active` flag, no `deletedAt` on `User`. A staff member you want to disable can only be hard-deleted or have their password changed. |

### 4.2 Member lifecycle

| Edge | Trigger | Writer (file:line) | Notes |
|---|---|---|---|
| — → **created (passwordless)** | 4 paths, §2.2 | `members/route.ts:238`, `import/[id]/commit:80`, `member/children:94`, `link-child:48` | `status "active"`, `passwordHash null` |
| created → **invited** | Same request (M1) or `bulk-invite` | `members/route.ts:287-304`; `members/bulk-invite/route.ts:83-106` | 7-day `first_time_signup` token; prior unused tokens invalidated (`bulk-invite:86-89`) |
| invited → **active (loginable)** | Member sets a password | `app/api/members/accept-invite/route.ts:79-84` | bumps `sessionVersion`; auto-signs-in (`page.tsx:67`) |
| active → **locked** | 10 bad passwords | `auth.ts:246-267` | |
| locked → **unlocked** | Staff clicks unlock | `app/api/members/[id]/unlock/route.ts:62-64` | The **only** first-class unlock UI in the product, and it is member-only |
| locked → **unlocked** | Wait 1 h | — | |
| any → **password reset** | OTP flow | `app/api/auth/reset-password/route.ts:186-192` | requires an existing non-null password (`:94`); **does not clear `lockedUntil`** |
| any → **TOTP-enrolled** | `POST /api/member/totp/setup` | `app/api/member/totp/setup/route.ts:123-126` | requires `passwordHash != null` (`:119`) |
| TOTP-enrolled → **un-enrolled** | Gym staff reset | `app/api/members/[id]/totp-reset/route.ts:48-55` | `totpRecoveryCodes: undefined` = **Prisma no-op**, stale hashes survive |
| TOTP-enrolled → **un-enrolled** | Operator reset | `.../member-totp-reset/route.ts:73-83` | uses `Prisma.JsonNull` — correct |
| TOTP-enrolled → **un-enrolled** | Recovery code | `app/api/member/totp/recover/route.ts:99-107` | works; **no UI calls it** |
| TOTP-enrolled → **self-disable** | — | **impossible** — `stripTotpFields` at `app/api/member/me/route.ts:287` |
| active → **cancelled** | Staff PATCH `status:"cancelled"` | `app/api/members/[id]/route.ts:266,317` — stamps `cancelledAt` | **No `sessionVersion` bump, no `passwordHash` clear** ⇒ existing JWTs live for up to 30 days and a fresh password login still succeeds |
| active → **inactive / taster** | Staff PATCH | same route, `lib/schemas/member.ts:52` | Purely cosmetic for auth |
| cancelled → **active** | Staff PATCH | same route | Blocked only for DSAR tombstones (`:260-263`) |
| any → **kid** | Staff link-child | `app/api/members/[id]/link-child/route.ts:48-59` | requires `passwordHash null` + `parentMemberId null` |
| kid → **adult** | Staff promote | `app/api/members/[id]/promote-to-adult/route.ts:43` | sets `accountType:"adult", parentMemberId:null` — **leaves the `@no-login.matflow.local` email intact and mints no invite** |
| any → **GDPR-erased** | Operator DSAR erase | `app/api/admin/dsar/erase/route.ts:286-312` | name/email/PII scrubbed, `passwordHash null`, TOTP cleared, `status "cancelled"`, `sessionVersion` bumped |
| any → **hard-deleted** | Staff delete | `lib/member-delete.ts:84-138` (`member.deleteMany` at `:137`) with parent resolution `:152-225` | Orphaned kids forced to `accountType:'junior'` to keep the CHECK satisfied (`lib/member-delete.ts:64-65`) |
| **soft-deleted** | *state does not exist* | — | No `deletedAt` on `Member` |

### 4.3 Tenant-level edges that move every identity at once

| Edge | Writer | Effect on identity |
|---|---|---|
| Tenant suspended | `.../suspend/route.ts:113-115` | `subscriptionStatus:"suspended"` + `sessionVersion++` on all users and members. Blocks L1 only (`auth.ts:194`). |
| Tenant soft-deleted | `.../soft-delete/route.ts:100-102` | `deletedAt` + `sessionVersion++` on all. Blocks L1 only (`auth.ts:193`). |
| Tenant restored | `.../soft-delete/route.ts:146` / `.../suspend/route.ts:157` | No `sessionVersion` change needed (already bumped). |

---

## 5. Dead ends — states with no way in, or no way out

| ID | Dead end | Evidence | Way out? |
|---|---|---|---|
| **DE-1** | **Member enrols in 2FA ⇒ permanent lockout of the password path.** `auth.ts:376` sets `totpPending:true` for any member with `totpEnabled`. `proxy.ts:187` 307s them to `/login/totp`. `app/login/totp/page.tsx:20` POSTs to `/api/auth/totp/verify`, which reads `tx.user.findUnique({ id: token.id })` (`app/api/auth/totp/verify/route.ts:42-47`) — the id is a `Member` id, so the row is null and `:49-51` returns `400 "TOTP not enabled"` on **every attempt, forever**. | Enrolment succeeds (`app/api/member/totp/setup/route.ts:123-126`), and `/login/totp/setup/page.tsx:26,37` is *role-aware* while `/login/totp/page.tsx` is not. | Yes, but none of them is discoverable: magic link (bypasses TOTP), staff `POST /api/members/[id]/totp-reset`, operator `member-totp-reset`, or `POST /api/member/totp/recover` (zero callers). |
| **DE-2** | **Non-owner staff 2FA is never challenged.** `auth.ts:335` — `totpPending: !isTestingMode() && isOwner && user.totpEnabled === true`. A manager/coach/admin may enrol (`app/api/auth/totp/setup/route.ts:22-25` allows any staff role) but `isOwner` is false, so the second factor is *never requested*. Same on the Google path (`auth.ts:506`). | | The state is reachable and harmless-looking; the banner even clears (`auth.ts:342`). There is no way to make it *do* anything. |
| **DE-3** | **Under-13 invitee can never set a password.** `app/api/members/accept-invite/route.ts:97` computes `accountType = age < 13 ? "kids"` and writes it at `:99-105`, inside the same `withTenantContext` transaction (`lib/prisma-tenant.ts:45-48` — a real `$transaction`) as the password write at `:81-84`. The invitee has `parentMemberId = null`, so the write violates `Member_kids_must_have_parent` (`prisma/migrations/20260515000001_.../migration.sql:27-30`), the transaction rolls back, and `:114-116` returns `500 "Failed to set password"`. | `app/login/accept-invite/page.tsx:27,55` sends the DOB. | Only by re-submitting with the DOB field left blank — nothing in the UI hints at this. |
| **DE-4** | **Nobody can change their own password.** There is exactly one `newPassword` handler: `app/api/staff/[id]/route.ts:14,52`, which is owner-only (`:29-30`) and excludes `role: "owner"` rows from the update (`:90,95`). So: the owner cannot change their own password; non-owner staff cannot change theirs; members have no password-change route at all (repo-wide grep for `newPassword\|currentPassword\|change-password` returns only that one route). | | Only the forgot-password OTP loop (`/api/auth/forgot-password` → `/api/auth/reset-password`). |
| **DE-5** | **A locked non-owner staff account has no operator remedy.** `auth.ts:240` throws before the password is even considered. `.../force-password-reset/route.ts:54` targets `where: { tenantId, role: "owner" }`. `/api/members/[id]/unlock` is `tx.member.update` only (`route.ts:62`). | | Wait 1 h, or use a magic link (which ignores `lockedUntil` entirely). |
| **DE-6** | **Password reset does not clear the lock.** `app/api/auth/reset-password/route.ts:160-166` and `:186-192` write only `passwordHash` + `sessionVersion`. A user who resets their password because they were locked out is still locked out. | | Wait out the hour. |
| **DE-7** | **A promoted kid is unreachable.** `app/api/members/[id]/promote-to-adult/route.ts:43` sets `accountType:"adult"` but leaves `email = kid-…@no-login.matflow.local` and mints no invite. `bulk-invite` then *selects* them (`route.ts:58` excludes only `accountType: "kids"`) and sends an invite to an RFC-2606 reserved domain — a guaranteed bounce. | `lib/synthesise-kid-email.ts:17-20` | Staff must first PATCH the email via `/api/members/[id]` (allowed — the only email guard there is the `@deleted.invalid` tombstone check at `route.ts:260`). |
| **DE-8** | **Owner activation link is single-use with a 30-minute TTL.** `app/api/admin/applications/[id]/approve/route.ts:127`. The owner's password is random and discarded at `:88`, and `:193` suppresses the link in production responses. If the email is slow, filtered, or the link is clicked twice, the owner has no password and no link. | | Forgot-password OTP (works — `forgot-password/route.ts:62` finds the User). Undiscoverable from the activation email. |
| **DE-9** | **Mixed-case emails.** `auth.ts:145,203,206` looks up by the email string exactly as typed; `app/api/staff/route.ts:83` and `lib/schemas/member.ts:34` store it un-normalised. Every recovery path normalises to lowercase (`forgot-password:47`, `magic-link/request:23`, `member/totp/recover:55`). An account created with `Bob@Gym.com` therefore cannot use magic link, forgot-password or TOTP recovery, and can only log in if the exact casing is retyped. | | Staff can PATCH the email to lowercase. |
| **DE-10** | **`Member.status` has no gate anywhere in auth.** `auth.ts:200-208` loads the row and `:346-379` builds the session with no `status` reference. Cancelling a member (`app/api/members/[id]/route.ts:317`) neither bumps `sessionVersion` nor nulls `passwordHash`. A cancelled member keeps a working login indefinitely. Meanwhile the kiosk *does* filter (`app/api/kiosk/[token]/members/route.ts:58`). | | None — there is no code path that turns "cancelled" into "cannot sign in". |
| **DE-11** | **`proxy.ts:191-193` is unreachable.** `"/login/totp".startsWith("/login")` is true, so `proxy.ts:165-169` early-returns before the check. | | Dead code. |

---

## 6. Ranked defect list — dead ends and contradictions

Ranked by blast radius x likelihood of being hit by a paying gym in week one.

### Rank 1 — Magic-link member sessions can never be revoked, and see fabricated data

`app/api/magic-link/verify/route.ts:98-107` builds the member JWT **without a
`memberId` claim** (compare `auth.ts:372`, which sets it on the password path).
Two consequences, both silent:

1. **Revocation is a no-op.** `auth.ts:679-688` branches on
   `const tokenMemberId = token.memberId as string | null;` — `undefined` here,
   so it falls to `prisma.user.findUnique({ where: { id: token.id } })`.
   `token.id` is a `Member` id, the `User` lookup returns `null`,
   `currentVersion` is `undefined`, and the mismatch guard at `auth.ts:690`
   (`currentVersion !== undefined && currentVersion !== token.sessionVersion`)
   is skipped. Password reset, "log out everywhere", tenant suspend and tenant
   soft-delete all bump `sessionVersion` — and **none of them terminate a
   magic-link member session**, which lives its full 30 days (`auth.ts:123`).
2. **The member sees demo content.** `session.user.memberId` is `undefined`
   (`auth.ts:735`), so `app/api/member/home/route.ts:144-146` takes the
   `!memberId` branch and returns `demoHome(...)` — synthetic classes, badges
   and announcements — with HTTP 200. The sibling route already fixed exactly
   this and says so: "A real session without a member id is a data problem, not
   a demo: fabricating 'Alex Johnson' here showed a real user someone else's
   identity with HTTP 200 (UI-RULES §7 violation)"
   (`app/api/member/me/route.ts:86-90`, which returns 404 instead). The two
   routes disagree about the same condition.

Every other member API degrades the same way: `member/children/route.ts:40`,
`member/classes/route.ts:20`, `member/me/payments/route.ts:9`,
`member/totp/setup/route.ts:31` all read `session.user.memberId`.

### Rank 2 — Member 2FA is a trap (DE-1)

Enrolment is role-aware, the challenge is not: `app/login/totp/setup/page.tsx:26,37`
picks `apiPrefix = isMember ? "/api/member/totp" : "/api/auth/totp"`, while
`app/login/totp/page.tsx:20` hardcodes `/api/auth/totp/verify`. Compounded three
ways: `/api/member/totp/verify` has **zero callers**; it is absent from
`proxy.ts` `PUBLIC_PREFIXES` (`:20-39`) so `proxy.ts:187` would 307 the POST even
if it were called; and `/login/totp/page.tsx` offers no recovery-code entry, so
`/api/member/totp/recover` — which works — is unreachable from the product.

### Rank 3 — Magic link is an unconditional back door

`app/api/magic-link/verify/route.ts` validates the token and nothing else. It
does **not** read `lockedUntil`, `Tenant.deletedAt`, `Tenant.subscriptionStatus`,
or `Member.status`, and `:86` hardcodes `totpPending = false`. Contrast
`auth.ts:193-194`, which refuses both tenant states on the password path.
Net effect: a suspended gym, a soft-deleted gym, a locked account and a
cancelled member all retain a working login for anyone who can reach the mailbox.
`app/api/magic-link/request/route.ts:31-34` has the same omission, so links are
still *issued* for dead tenants.

### Rank 4 — Google OAuth bypasses the entire invite flow

`auth.ts:476-487` looks the member up with **no `passwordHash` filter**, unlike
`magic-link/request:49`, `magic-link/verify:51`, `forgot-password:64` and
`reset-password:94`, which all carry `passwordHash: { not: null }`. A member
created by staff or CSV import who **never accepted their invite** can sign in
with Google, skipping `accept-invite` — the only place a member password and DOB
are ever captured. It also ignores `lockedUntil`, `Member.status`,
`Tenant.deletedAt` and `Tenant.subscriptionStatus`.
Mitigating: the provider is off unless `ENABLE_GOOGLE_OAUTH=true` plus client
id/secret (`auth.ts:34-37`). Aggravating: the button renders off a *different*
variable, `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH` (`app/login/page.tsx:715`), so the
two can diverge in either direction.

### Rank 5 — Cancelling a member does nothing to their access (DE-10)

The churn model (`Member.status`, `cancelledAt`, `paymentStatus`) has no
authentication consequence anywhere. The kiosk is the only surface that honours
it (`app/api/kiosk/[token]/members/route.ts:58`).

### Rank 6 — Nobody can change their own password (DE-4)

Including the owner. Every password change is either an owner acting on a
subordinate (`app/api/staff/[id]/route.ts:52`, which excludes `role: "owner"`
rows at `:90,95`) or an emailed 6-digit OTP with a **2-minute** TTL
(`app/api/auth/forgot-password/route.ts:77`) — the tightest window in the
codebase, against a 30-minute magic link and a 7-day member invite.

### Rank 7 — Lockout is invisible and semi-permanent

`auth.ts:114-118` composes a precise `AccountLockedError`; `auth.ts:108-112` does
the same for rate limiting. `app/login/page.tsx:398-400` discards both and
renders the literal `"Incorrect email or password."`. A locked-out owner cannot
learn they are locked, has no self-service unlock (DE-5), and resetting the
password will not clear the lock (DE-6).

### Rank 8 — Non-owner staff 2FA is decorative (DE-2)

`auth.ts:335` gates `totpPending` on `isOwner`, but
`app/api/auth/totp/setup/route.ts:22-25` was deliberately widened to all staff
roles and `auth.ts:339-342` shows the enrol-in-2FA banner to every role. A coach
can complete enrolment, be told they are protected, and never be challenged.

### Rank 9 — Staff-side member TOTP reset leaves the recovery codes behind

`app/api/members/[id]/totp-reset/route.ts:53` writes `totpRecoveryCodes: undefined`.
In Prisma `undefined` means *omit this field*, so the old HMAC hashes survive the
"reset". The operator equivalent uses `Prisma.JsonNull`
(`app/api/admin/customers/[id]/member-totp-reset/route.ts:82`) and the DSAR path
uses `Prisma.DbNull` (`app/api/admin/dsar/erase/route.ts:308`) — three different
answers to the same question in one codebase. Because
`app/api/member/totp/recover/route.ts:91-104` never checks `totpEnabled` before
consuming a code, a stale code remains redeemable against the row.

### Rank 10 — TOTP secrets are stored in cleartext

`prisma/schema.prisma:90` (`User.totpSecret String?`) and `:160`
(`Member.totpSecret String?`). Compare the surrounding discipline: magic-link
tokens, reset OTPs, the kiosk token and the recovery codes are all HMAC-SHA256
hashed at rest (`schema.prisma:58, 587, 606, 92`). A read-only database
compromise therefore yields working second factors, while yielding nothing for
any other credential in the schema.

### Rank 11 — One `purpose` value, two incompatible meanings

`purpose: "first_time_signup"` is minted by both:

- `app/api/admin/applications/[id]/approve/route.ts:134`, emailed as
  `/api/magic-link/verify?token=…` (`:167`) — meaning *"mint a session"*; and
- `app/api/members/route.ts:294` and `app/api/members/bulk-invite/route.ts:95`,
  emailed as `/login/accept-invite?token=…` — meaning *"set a password"*.

`app/api/magic-link/verify/route.ts:24-34` does **not** filter on `purpose`, so
the two are interchangeable at the URL level. Consuming happens first (`:25-28`,
an `updateMany` that flips `used: true`) and the subject lookup — which filters
`passwordHash: { not: null }` at `:51` — happens after. **Reasoned from the code
order, not executed (UNVERIFIED):** feeding a member's un-accepted invite token
to `/api/magic-link/verify` burns the token and then redirects to
`/login?error=invalid_link`, leaving the member with no invite and no password.
`app/api/members/accept-invite/route.ts:57` does the reciprocal check correctly
(`tokenRow.purpose !== "first_time_signup"` → 404), so the asymmetry is
one-directional.

### Rank 12 — `proxy.ts:191-193` is dead code (DE-11)

Harmless in itself, but it is the only mechanism that would push a
no-longer-pending user off `/login/totp`, and it never executes.

### Also true, lower severity

- `app/api/staff/route.ts:102` returns `mustChangePassword: false`; no such
  column exists on `User` (`schema.prisma:81-118`). The comment at `:9-14`
  concedes the staff invite flow was never built — "Future feature follow-up:
  introduce a proper InviteToken flow mirroring app/api/members/route.ts".
- `PasswordResetToken` carries no subject discriminator (`schema.prisma:602-612`),
  so when a `User` and a `Member` share an email inside one tenant the `User`
  always wins the reset (`app/api/auth/reset-password/route.ts:74-89`). Known
  and deferred: `app/api/auth/forgot-password/route.ts:53-59`.
- `auth.ts:210` — `const memberRow = !user ? memberRowRaw : null;` — a staff row
  shadows a member row with the same email on **every** path. Combined with the
  above, an owner who is also a member of their own gym can never reset or use
  their member-side password.
- The kiosk performs no tenant-state check at all: a repo grep for
  `deletedAt|suspended|subscriptionStatus` across `app/api/kiosk` returns
  nothing, so a suspended or soft-deleted gym's kiosk keeps taking check-ins.
- `auth.ts:384-408` — the E2E fallback signs the caller in as *the first owner in
  the tenant* when the bypass token is used and no email matches. Correctly
  fenced by `isTestingMode()` (`lib/testing-mode.ts:33-46`, which also refuses
  any process whose `DATABASE_URL` contains the production Neon endpoint) — but
  it is the single most dangerous branch in the file.
- Impersonation (`auth.ts:620-660`) sets `totpEnabled: true` on the token purely
  to suppress a banner (`:650-652`), so the claim documented as "ground-truth
  totpEnabled" at `auth.ts:340-342` is not always ground truth.
- `DEMO_MODE` credentials (`auth.ts:424-445`) are reachable only when the DB
  throws *and* `NODE_ENV !== "production"` *and* `DEMO_MODE === "true"`; a
  boot-time guard at `auth.ts:48-50` throws if `DEMO_MODE` is set in production.
  Correctly fenced.
- `app/api/member/me/route.ts:372-380` refuses to edit an email ending
  `@no-login.matflow.local` or `@deleted.invalid`, but `app/api/members/[id]`
  PATCH only guards the `@deleted.invalid` tombstone (`route.ts:260`). That
  asymmetry is what makes DE-7 repairable — by staff, not by the member.

---

## 7. Method, coverage and limits

**How this was produced.** Static reading only. No dev server, no test run, no
database command, no file in the repository was modified. Every line reference
was re-checked against the file after drafting.

**Files read in full:** `auth.ts`, `proxy.ts`, `prisma/schema.prisma` (models
`Tenant`, `User`, `Member`, `MagicLinkToken`, `PasswordResetToken`),
`app/login/page.tsx`, `app/login/totp/page.tsx`,
`app/api/magic-link/{request,verify}/route.ts`,
`app/api/auth/{forgot-password,reset-password,totp/verify,totp/setup}/route.ts`,
`app/api/member/totp/{setup,verify,recover}/route.ts`,
`app/api/members/{route.ts,accept-invite,bulk-invite}`,
`app/api/staff/{route.ts,[id]/route.ts}`,
`app/api/admin/applications/[id]/approve/route.ts`,
`app/api/apply/route.ts`, `lib/prisma-tenant.ts`, `lib/kiosk-token.ts`,
`lib/testing-mode.ts`, `lib/brand-refresh.ts`, `lib/synthesise-kid-email.ts`,
`lib/schemas/member.ts`, `lib/authz.ts`, and the migrations
`20260430000001_schema_check_constraints`, `20260503300000_account_lockout`,
`20260512000001_member_account_type_parent`,
`20260515000001_member_kids_check_constraint`,
`20260430000002_soft_delete_extensions`.

**Corroboration.** Several findings here are independently recorded in the
repository's own audit notes — `docs/audit/CONNECTION-AUDIT-2026-08-22-laneA-member.md:25-31`
describes the member-TOTP break in the same terms, and
`docs/audit/CONNECTION-AUDIT-2026-08-22-laneB-staff.md:48` records the orphan
recovery endpoint. I re-derived both from source rather than citing the docs as
evidence; the docs are listed only as agreement.

**Not covered by this lane (deliberately):** the operator/super-admin identity
system (`lib/admin-auth.ts`, `lib/operator-auth.ts`, `matflow_op_session`) beyond
its interaction with `User` rows; RLS policy correctness; Stripe-driven state;
waiver signing identity.

**Explicitly UNVERIFIED claims in this report:**

1. Rank 11 — that pasting a member's `first_time_signup` token into
   `/api/magic-link/verify` consumes the token before the `passwordHash: { not: null }`
   lookup fails, burning the invite. This follows from the statement order at
   `app/api/magic-link/verify/route.ts:25-28` vs `:47-54`, but was not executed.
2. DE-3 — that the `accountType: "kids"` write inside
   `app/api/members/accept-invite/route.ts:99-105` raises
   `Member_kids_must_have_parent` and rolls back the password write. The
   constraint is present and `VALIDATE`d, and `withTenantContext` is a real
   `$transaction` (`lib/prisma-tenant.ts:45-48`), so the conclusion is sound —
   but it was not executed against a database.
3. The exact HTTP status a browser observes when `proxy.ts:187` 307-redirects a
   `POST /api/member/totp/verify`. The direction of failure is certain; the
   status the `fetch` caller sees after redirect-following is not.

**Report complete.**
