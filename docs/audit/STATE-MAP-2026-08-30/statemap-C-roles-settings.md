# MatFlow State Map — Lane C: Roles, Admin Levels, Settings

Read-only code audit. Every claim carries `file:line` evidence. Anything not
provable from source is marked **UNVERIFIED**.
Repo root: `C:\Users\NoeTo\Desktop\matflow` (Next.js 16 App Router, Prisma 7 /
Neon Postgres, NextAuth v5 beta).

---

## 0. HEADLINE TRUTHS

| # | Truth | Evidence |
|---|---|---|
| 0.1 | **There is no role hierarchy — only four hard-coded allow-lists.** `STAFF_ROLES = ["owner","manager","coach","admin"]` and the three helpers `requireApiOwner` / `requireApiOwnerOrManager` / `requireApiStaff` are flat `roles.includes(role)` string matches. No ranking, no inheritance, no permission table. Adding a role means editing every call-site. | `lib/authz.ts:29`, `lib/authz.ts:42-58`, `lib/api-authz.ts:93-110` |
| 0.2 | **`admin` is the DEFAULT role for a new staff `User`, and it sits BELOW `manager`.** `User.role String @default("admin")`. `admin` is in `STAFF_ROLES` but is absent from `requireApiOwnerOrManager`. So the role whose name implies the most power is the weakest staff tier, and it is what you get if a row is created without an explicit role. | `prisma/schema.prisma:88`, `lib/authz.ts:29`, `lib/api-authz.ts:104-106` |
| 0.3 | **`Operator.role` is dead.** The column exists with four documented values (`super_admin \| billing_admin \| support_admin \| read_only`) and a DB default, but **no application code reads it anywhere**. Every operator who authenticates gets full super-admin power — impersonate any owner, delete tenants, reset TOTP. There is no read-only operator. | `prisma/schema.prisma:1039`; grep for `billing_admin\|support_admin\|read_only` across `*.ts,*.tsx,*.mjs` returns only the schema line, the migration, and `scripts/seed-operator-noe.mjs:54` (a write) |
| 0.4 | **`PlatformConfig` is a fully dead table.** Model + migration exist; zero reads and zero writes in application code. The documented purpose (audit-log retention days, feature-flag defaults, operator alert webhooks) is entirely unimplemented. | `prisma/schema.prisma:1053-1058`, `prisma/migrations/20260506000000_operator_platform_config_feature_flags/migration.sql:28`; no other hit in `*.ts/*.tsx` |
| 0.5 | **`Tenant.featureFlags` is a fully dead column.** Declared as the per-tenant feature-flag override store; never read, never written, no API route, no zod schema, no UI. | `prisma/schema.prisma:61-62`; only other hit is the migration at `migration.sql:7` |
| 0.6 | **Two parallel super-admin auth paths are both live, and the weaker one is a bearer secret stored verbatim in a cookie.** `isAdminAuthed()` accepts (a) `x-admin-secret` header, (b) `matflow_admin` cookie **whose value IS `MATFLOW_ADMIN_SECRET`**, or (c) the v1.5 `matflow_op_session` HMAC cookie. Any one suffices. The v1 secret has no per-operator identity, no TOTP, no revocation short of rotating the env var. | `lib/admin-auth.ts:25`, `lib/admin-auth.ts:49-56`, `lib/admin-auth.ts:78-82`, `lib/admin-auth.ts:85-96` |
| 0.7 | **Impersonation grants the operator the target owner's full session for 60 minutes, and ending it requires no credential.** `POST /api/admin/impersonate` needs operator auth; `DELETE` explicitly does not (`readImpersonationCookie()` only). The minted cookie is HMAC-signed with `AUTH_SECRET_VALUE`, `httpOnly`, `SameSite=Strict`, `maxAge = 3600`. | `lib/impersonation.ts:17`, `lib/impersonation.ts:100-106`, `app/api/admin/impersonate/route.ts:94-97` |
| 0.8 | **Impersonation silently defeats 2FA and the sessionVersion revocation clock.** The `jwt()` override sets `totpPending = false`, `requireTotpSetup = false`, `totpEnabled = true` (to hide the 2FA nudge), and re-stamps `sessionVersionCheckedAt = Date.now()` on every request the cookie is present — so the impersonated session's revocation check is perpetually deferred. | `auth.ts:647-654` |
| 0.9 | **The edge gate on `/admin/*` cannot see revocations.** `proxy.ts` verifies the operator cookie's HMAC + expiry only (no Prisma at edge), so a revoked operator (`sessionVersion` bumped) still renders `/admin` page shells for up to the cookie's 8-hour TTL. The code documents this as accepted. | `proxy.ts:47-80`, `proxy.ts:128-155`, `lib/operator-auth.ts:31`, `lib/operator-auth.ts:284` |
| 0.10 | **`/api/admin` and `/admin` are in `PUBLIC_PREFIXES` — the middleware auth wall does not apply to them at all.** Only the bespoke `/admin` page gate at `proxy.ts:139` and each route's own `isAdminAuthed`/`getOperatorContext` call stand between the internet and the operator surface. (Every `/api/admin/**` route was swept: all do check — see §2.4.) | `proxy.ts:28-29`, `proxy.ts:165-169` |
| 0.11 | **Tenant settings are owner-write / all-staff-read.** `PATCH /api/settings` is `role === "owner"` only, but `GET /api/settings` admits **any non-member** — so a `coach` can read the tenant's `subscriptionStatus`, `subscriptionTier`, and staff/member counts. | `app/api/settings/route.ts:70`, `app/api/settings/route.ts:114-115` |
| 0.12 | **Guard style is inconsistent across `app/api/**`: 82 of 171 route files hand-roll `await auth()` + an inline string comparison instead of using `lib/api-authz`.** That is where every divergence in §2.5 lives — the typed helpers cannot enforce what routes do not call. | Sweep in §2.5; e.g. `app/api/settings/route.ts:68`, `app/api/staff/route.ts:23`, `app/api/members/[id]/route.ts` |
| 0.13 | **Two route files still call the PAGE-route helper `requireOwner()` (which answers failure with `redirect("/login")`) from inside a route handler** — the exact bug `lib/api-authz.ts` was written to eliminate. On an expired session Next converts the throw into a 307 to `/login`, `fetch` follows it, the client parses HTML as JSON, and the UI renders "no data" instead of "signed out". | `app/api/payments/chase/route.ts:11` + `:26`, `app/api/payments/outstanding/route.ts:11`; rationale at `lib/api-authz.ts:8-23`. (`app/api/onboarding/csv-handoff/route.ts:9` says `requireOwner()` in its header comment but correctly calls `requireApiOwner()` at `:38` — comment-only drift.) |

---

## 1. THE PRIVILEGE LADDER

### 1.0 The rungs actually implemented

There are **two disjoint identity systems**, not one ladder:

* **Tenant identities** — `User` rows (staff) and `Member` rows (students), both
  authenticated by NextAuth v5 (`auth.ts`) into a single JWT whose `role` claim
  is one of `owner | manager | coach | admin | member`.
  `prisma/schema.prisma:88` (`User.role`, CHECK owner|manager|coach|admin),
  `auth.ts:364` (members are given the literal role `"member"`).
* **Platform identity** — the operator, authenticated by an entirely separate
  cookie stack (`lib/admin-auth.ts`, `lib/operator-auth.ts`). Operators have no
  `tenantId`, never appear in `session.user`, and cannot be expressed in the
  NextAuth `role` claim at all. The only bridge between the two systems is the
  impersonation cookie (§3).

`normalizeRole()` lowercases and trims the DB value before every comparison
(`auth.ts:91-93`), and is applied in `jwt()` (`auth.ts:567`, `:644`) and again
in `session()` (`auth.ts:728`).

### 1.1 Rung-by-rung

| Rung | Storage | How granted | How revoked | Guard that enforces it |
|---|---|---|---|---|
| **member** | `Member` row; JWT `role:"member"` + `memberId` | `POST /api/members` by `owner\|manager\|admin` (`app/api/members/route.ts:148`); kid sub-accounts owner-only (`:180`); password set via `POST /api/members/accept-invite` (invite-token gated, public prefix at `proxy.ts:31`) | `Member.sessionVersion` bump (checked `auth.ts:680-692`); tenant suspend/soft-delete bumps every member (`app/api/admin/customers/[id]/suspend/route.ts:115`, `soft-delete/route.ts:102`); `lib/member-delete.ts` for hard delete | `proxy.ts:198` blocks `role==="member"` from `/dashboard/*`; per-route `session.user.role === "member"` checks; most `/api/member/**` routes carry **no role check at all** and instead scope on `session.user.memberId` |
| **coach** | `User.role = "coach"` | `POST /api/staff` — owner only, `z.enum(["manager","coach","admin"])` (`app/api/staff/route.ts:18`, `:58-59`) | `PATCH /api/staff/[id]` role change (owner only, bumps `sessionVersion`) `app/api/staff/[id]/route.ts:59-65`; `DELETE /api/staff/[id]` (`:143-144`) | Included in `STAFF_ROLES` (`lib/authz.ts:29`) → passes `requireApiStaff`/`requireStaff`. **Excluded** from `requireApiOwnerOrManager` |
| **admin** | `User.role = "admin"` — **the schema default** (`prisma/schema.prisma:88`) | Same as coach (`/api/staff` POST) — or implicitly, by any `user.create` that omits `role` | Same as coach | Same as coach: in `STAFF_ROLES`, out of owner/manager. Despite the name it is **not** an elevated role |
| **manager** | `User.role = "manager"` | Same as coach; also **auto-assigned to a demoted owner** during operator ownership transfer (`app/api/admin/customers/[id]/transfer-ownership/route.ts:91`) | Same as coach | `requireApiOwnerOrManager` / `requireOwnerOrManager` (`lib/api-authz.ts:104`, `lib/authz.ts:52`) |
| **owner** | `User.role = "owner"` | (a) tenant creation by operator — `app/api/admin/create-tenant/route.ts:82`; (b) gym-application approval — `app/api/admin/applications/[id]/approve/route.ts:108`; (c) operator ownership transfer — `transfer-ownership/route.ts:95`; (d) seed — `prisma/seed.ts:69`. **There is no in-tenant path to mint an owner:** `/api/staff` POST and PATCH both restrict the enum to `manager\|coach\|admin` (`app/api/staff/route.ts:18`, `app/api/staff/[id]/route.ts:13`) | Only by operator transfer. Tenant-side deletion/edit of an owner is blocked by `role: { not: "owner" }` in the `where` clause (`app/api/staff/[id]/route.ts:90`, `:156`) | `requireApiOwner` / `requireOwner`, or an inline `session.user.role === "owner"` |
| **operator — v1 (shared secret)** | `process.env.MATFLOW_ADMIN_SECRET`; presented as `x-admin-secret` header **or** as the literal value of the `matflow_admin` cookie | `POST /api/admin/auth/login` with the correct secret → `adminCookieSetHeaders(expected)` writes the secret into the cookie (`app/api/admin/auth/login/route.ts:46`, `lib/admin-auth.ts:85-96`). Rate-limited 5 / 15 min per IP (`login/route.ts:17`) | **Only by rotating the env var.** No per-session revocation exists. Cookie `Max-Age` 8 h (`lib/admin-auth.ts:26`) | `isAdminAuthed()` (`lib/admin-auth.ts:78`), `isAdminPageAuthed()` (`:67`), plus the edge check at `proxy.ts:144-146` |
| **operator — v1.5 (per-account)** | `Operator` table (`prisma/schema.prisma:1034`); cookie `matflow_op_session` = `id.sessionVersion.exp.HMAC-SHA256` | `POST /api/admin/auth/operator-login` (bcrypt, `lib/operator-auth.ts:182`), then optional TOTP via `POST /api/admin/auth/operator-totp`. **No UI or API creates an Operator row** — only `scripts/seed-operator-noe.mjs` | `Operator.sessionVersion` increment invalidates the cookie at the route layer (`lib/operator-auth.ts:284`) — but **not at the edge** (`proxy.ts:47-51` comment). 8 h TTL (`lib/operator-auth.ts:31`). Lockout: 5 failures → 15 min (`:33-34`) | Same guards as v1 — `isAdminAuthed` accepts either |

### 1.2 What is missing from the ladder

* **`Operator.role` is never consulted.** `super_admin`, `billing_admin`,
  `support_admin`, `read_only` are documented at `prisma/schema.prisma:1039`
  and set by the seed script (`scripts/seed-operator-noe.mjs:54`), but no guard
  reads them. There is exactly one operator privilege level: total.
* **No "super-admin" role inside a tenant.** The `admin` string in
  `User.role` is a *junior staff* role, and `STAFF_ROLES` treats it as
  equivalent to `coach`.
* **No deny-lists / scoped grants.** Every check is a positive allow-list.
* **Nothing prevents the last owner from being deleted at the DB level** other
  than the `role: { not: "owner" }` filter; the operator transfer path handles
  the "tenant has no owner" case explicitly (`transfer-ownership/route.ts:86`),
  which implies the state is reachable. **UNVERIFIED** whether any other path
  can zero out the owners.

---

## 2. GUARDS AND THE ROUTE → GUARD SWEEP

### 2.1 The four guard families

| Family | File | Failure mode | Correct for |
|---|---|---|---|
| Page gates — `requireSession` / `requireRole` / `requireOwner` / `requireOwnerOrManager` / `requireStaff` | `lib/authz.ts:31-58` | `redirect("/login")` | server components only |
| Route gates — `requireApiSession` / `requireApiRole` / `requireApiOwner` / `requireApiOwnerOrManager` / `requireApiStaff` | `lib/api-authz.ts:77-110` | JSON `401` / `403` via `apiError` | `app/api/**` route handlers |
| Operator gates — `isAdminAuthed` / `isAdminPageAuthed` / `getOperatorContext` | `lib/admin-auth.ts:67-82`, `lib/operator-context.ts:31` | route returns `401`/`403`; page renders a login prompt | `/admin/**` and `/api/admin/**` |
| Edge gate — the `auth(...)`-wrapped proxy | `proxy.ts:100-210` | `NextResponse.redirect` | coarse, pre-route |

The doc-comment at `lib/api-authz.ts:8-23` states the design intent plainly:
a route handler that uses the *page* helpers converts an expired session into a
307 → login HTML → `res.json()` throw → "you have no data" empty state.

### 2.2 What the edge proxy actually enforces

| Check | Line | Effect |
|---|---|---|
| `MAINTENANCE_MODE` kill switch | `proxy.ts:108-126` | 503 everywhere except `/api/health`, `/api/auth`, `/_next`, `/login` |
| `/admin/*` operator cookie (legacy secret **or** op-session HMAC) | `proxy.ts:139-155` | redirect to `/admin/login`; **HMAC + expiry only, no `sessionVersion`** |
| `PUBLIC_PREFIXES` early-return | `proxy.ts:20-39`, `:165-169` | `/login`, `/api/auth`, `/api/tenant`, `/api/apply`, **`/api/admin`**, **`/admin`**, `/api/member/totp/recover`, `/api/members/accept-invite`, `/api/account/pending-tenant`, `/waiver`, `/api/waiver/open`, `/apply`, `/legal`, `/onboarding`, `/preview` bypass the session wall |
| `!req.auth` → `/login` | `proxy.ts:171-173` | the only blanket authentication wall |
| `totpPending` → `/login/totp` | `proxy.ts:187-189` | second-factor completion |
| `role === "member"` blocked from `/dashboard` | `proxy.ts:198-200` | redirect to `/member/home` |
| `role !== "member"` blocked from `/member` | `proxy.ts:203-205` | redirect to `/dashboard` |
| Matcher exclusions | `proxy.ts:222-224` | `api/webhooks`, `api/stripe/webhook`, `api/cron`, `api/health`, `api/kiosk`, `kiosk`, `api/magic-link` never see the middleware at all |

Note: **mandatory 2FA for owners has been removed.** `requireTotpSetup` is
computed (`auth.ts:339`) but is now purely a banner signal — the comment at
`proxy.ts:178-182` documents the removal. Only `totpPending` (mid-login) is
still enforced.

### 2.3 Full route → guard table

Legend — **Helper** = a `lib/authz` or `lib/api-authz` call; **Op** = operator
gate; **auth()** = count of hand-rolled `await auth()` calls in the file;
**Inline role test** = the literal role comparison found in the file (a file
with several methods may show several tests — see §2.5 for the per-method
splits that matter).

| Route (`app/api…`) | Methods | Helper | Op | `auth()` | Inline role test |
|---|---|---|---|---|---|
| `/account/pending-tenant/route.ts` | POST | — | — | 0 | — |
| `/admin/activity/route.ts` | GET | — | isAdminAuthed | 0 | — |
| `/admin/applications/[id]/approve/route.ts` | POST | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/applications/[id]/reject/route.ts` | POST | — | getOperatorContext | 0 | — |
| `/admin/applications/route.ts` | GET | — | isAdminAuthed | 0 | — |
| `/admin/auth/login/route.ts` | POST | — | — | 0 | — |
| `/admin/auth/logout/route.ts` | POST | — | — | 0 | — |
| `/admin/auth/operator-login/route.ts` | POST | — | — | 0 | — |
| `/admin/auth/operator-totp/route.ts` | POST | — | — | 0 | — |
| `/admin/auth/operator-totp/setup/route.ts` | GET/POST | — | — | 0 | — |
| `/admin/create-tenant/route.ts` | POST | — | getOperatorContext | 0 | — |
| `/admin/customers/[id]/force-password-reset/route.ts` | POST | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/customers/[id]/member-totp-reset/route.ts` | POST | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/customers/[id]/soft-delete/route.ts` | POST/DELETE | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/customers/[id]/suspend/route.ts` | POST/DELETE | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/customers/[id]/totp-reset/route.ts` | POST | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/customers/[id]/transfer-ownership/route.ts` | GET/POST | — | getOperatorContext,isAdminAuthed | 0 | — |
| `/admin/dsar/erase/route.ts` | POST | requireApiRole(["owner"]) | — | 0 | — |
| `/admin/dsar/export/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/admin/email/test/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/admin/impersonate/route.ts` | POST/DELETE | — | getOperatorContext | 0 | — |
| `/admin/import/[id]/commit/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/admin/import/[id]/preview/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/admin/import/[id]/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/admin/import/upload/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/announcements/[id]/route.ts` | PATCH/DELETE | — | — | 2 | ["owner", "manager"] |
| `/announcements/route.ts` | GET/POST | — | — | 2 | === "member";["owner", "manager"] |
| `/apply/route.ts` | POST | — | — | 0 | — |
| `/audit-log/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/auth/[...nextauth]/route.ts` | ? | — | — | 0 | — |
| `/auth/disown-login/[token]/route.ts` | GET | — | — | 0 | — |
| `/auth/forgot-password/route.ts` | POST | — | — | 0 | — |
| `/auth/logout-all/route.ts` | POST | — | — | 1 | — |
| `/auth/reset-password/route.ts` | POST | — | — | 0 | — |
| `/auth/totp/disable/route.ts` | POST | — | — | 1 | — |
| `/auth/totp/recover/route.ts` | POST | — | — | 0 | — |
| `/auth/totp/recovery-codes/route.ts` | POST | — | — | 1 | — |
| `/auth/totp/setup/route.ts` | GET/POST | — | — | 2 | === "member" |
| `/auth/totp/verify/route.ts` | POST | — | — | 0 | — |
| `/blob-image/route.ts` | GET | — | — | 1 | — |
| `/checkin/members/route.ts` | GET | — | — | 1 | ["owner", "manager", "coach", "admin"] |
| `/checkin/route.ts` | POST/DELETE | — | — | 2 | ["owner", "manager", "coach", "admin"] |
| `/class-packs/[id]/route.ts` | PATCH/DELETE | requireApiOwnerOrManager() | — | 0 | — |
| `/class-packs/route.ts` | GET/POST | requireApiOwnerOrManager() | — | 0 | — |
| `/classes/[id]/instances/route.ts` | GET/POST | — | — | 2 | ["owner", "manager"] |
| `/classes/[id]/roster/[memberId]/route.ts` | DELETE | — | — | 1 | ["owner", "manager", "admin"] |
| `/classes/[id]/roster/route.ts` | GET/POST | — | — | 2 | ["owner", "manager", "admin"] |
| `/classes/[id]/route.ts` | GET/PATCH/DELETE | — | — | 3 | ["owner", "manager"] |
| `/classes/route.ts` | GET/POST | — | — | 2 | ["owner", "manager"] |
| `/coach/instances/[id]/attendance/route.ts` | POST | requireApiStaff() | — | 0 | — |
| `/coach/instances/[id]/register/route.ts` | GET | requireApiStaff() | — | 0 | — |
| `/coach/today/route.ts` | GET | requireApiStaff() | — | 0 | — |
| `/cron/class-instances/route.ts` | GET | — | — | 0 | — |
| `/cron/monthly-reports/route.ts` | GET | — | — | 0 | — |
| `/cron/retention/route.ts` | GET | — | — | 0 | — |
| `/cron/stripe-reconcile/route.ts` | GET | — | — | 0 | — |
| `/dashboard/stats/route.ts` | GET | — | — | 1 | ["owner", "manager", "admin", "coach"] |
| `/drive/callback/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/drive/connect/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/drive/disconnect/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/drive/folders/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/drive/index/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/drive/select-folder/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/drive/status/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/health/route.ts` | GET | — | — | 0 | — |
| `/initiatives/[id]/attachments/route.ts` | POST/DELETE | requireApiOwnerOrManager() | — | 0 | — |
| `/initiatives/[id]/route.ts` | PATCH/DELETE | requireApiOwnerOrManager() | — | 0 | — |
| `/initiatives/route.ts` | GET/POST | requireApiOwnerOrManager() | — | 0 | — |
| `/instances/generate/route.ts` | POST | — | — | 1 | ["owner", "manager"] |
| `/kiosk/[token]/checkin/route.ts` | POST | — | — | 0 | — |
| `/kiosk/[token]/classes/route.ts` | GET | — | — | 0 | — |
| `/kiosk/[token]/members/route.ts` | GET | — | — | 0 | — |
| `/magic-link/request/route.ts` | POST | — | — | 0 | — |
| `/magic-link/verify/route.ts` | GET | — | — | 0 | — |
| `/me/gym/route.ts` | GET | — | — | 1 | — |
| `/member/checkout/route.ts` | POST | — | — | 1 | — |
| `/member/children/[id]/photos/[photoId]/route.ts` | DELETE | — | — | 1 | — |
| `/member/children/[id]/photos/route.ts` | GET/POST | — | — | 2 | — |
| `/member/children/[id]/route.ts` | GET/PATCH/DELETE | — | — | 3 | — |
| `/member/children/route.ts` | POST | — | — | 1 | — |
| `/member/class-packs/buy/route.ts` | POST | — | — | 1 | — |
| `/member/class-packs/route.ts` | GET | — | — | 1 | — |
| `/member/class-subscriptions/[classId]/route.ts` | POST/DELETE | — | — | 1 | — |
| `/member/classes/route.ts` | GET | — | — | 1 | — |
| `/member/family/[id]/billing/portal/route.ts` | POST | — | — | 1 | — |
| `/member/family/[id]/billing/route.ts` | GET | — | — | 1 | — |
| `/member/home/route.ts` | GET | — | — | 1 | — |
| `/member/me/children/route.ts` | GET | — | — | 1 | — |
| `/member/me/mark-announcements-seen/route.ts` | POST | — | — | 1 | — |
| `/member/me/payments/route.ts` | GET | — | — | 1 | — |
| `/member/me/recent-demotion/route.ts` | GET | — | — | 1 | — |
| `/member/me/route.ts` | GET/PATCH | — | — | 2 | — |
| `/member/me/subscriptions/route.ts` | GET | — | — | 1 | — |
| `/member/products/route.ts` | GET | — | — | 1 | — |
| `/member/schedule/route.ts` | GET | — | — | 1 | — |
| `/member/subscriptions/cancel-for-kid/route.ts` | POST | — | — | 1 | — |
| `/member/subscriptions/cancel/route.ts` | POST | — | — | 1 | — |
| `/member/subscriptions/start-for-kid/route.ts` | POST | — | — | 1 | — |
| `/member/subscriptions/start/route.ts` | POST | — | — | 1 | — |
| `/member/tasks/[id]/complete/route.ts` | POST | — | — | 1 | — |
| `/member/tasks/route.ts` | GET | — | — | 1 | — |
| `/member/totp/recover/route.ts` | POST | — | — | 0 | — |
| `/member/totp/recovery-codes/route.ts` | POST | — | — | 1 | — |
| `/member/totp/setup/route.ts` | GET/POST | — | — | 2 | — |
| `/member/totp/verify/route.ts` | POST | — | — | 0 | — |
| `/members/[id]/charge/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/members/[id]/link-child/route.ts` | POST | — | — | 1 | !== "owner" |
| `/members/[id]/payment-method/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/members/[id]/payments/route.ts` | GET | — | — | 1 | ["owner", "manager", "admin", "coach"] |
| `/members/[id]/photos/route.ts` | GET/POST/DELETE | — | — | 3 | STAFF_ROLES |
| `/members/[id]/profile-picture/route.ts` | PUT/DELETE | — | — | 1 | — |
| `/members/[id]/promote-to-adult/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/members/[id]/rank/demote/route.ts` | POST | — | — | 1 | ["owner", "manager", "admin"] |
| `/members/[id]/rank/route.ts` | POST | — | — | 1 | ["owner", "manager", "coach"] |
| `/members/[id]/route.ts` | GET/PATCH/DELETE | — | — | 3 | !== "owner";["owner", "manager", "admin"];["owner", "manager", "coach", "admin"] |
| `/members/[id]/totp-reset/route.ts` | POST | requireApiStaff() | — | 0 | — |
| `/members/[id]/unlink-child/route.ts` | DELETE | — | — | 1 | !== "owner" |
| `/members/[id]/unlock/route.ts` | POST | — | — | 1 | STAFF_ROLES |
| `/members/[id]/waiver-link/route.ts` | POST | — | — | 1 | STAFF_ROLES |
| `/members/[id]/waiver/sign/route.ts` | POST | — | — | 1 | ["owner", "manager", "admin", "coach"] |
| `/members/accept-invite/route.ts` | POST | — | — | 0 | — |
| `/members/bulk-invite/route.ts` | POST | requireApiStaff() | — | 0 | — |
| `/members/promotion-alerts/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/members/route.ts` | GET/POST | — | — | 2 | !== "owner";["owner", "manager", "admin", "coach"];["owner", "manager", "admin"] |
| `/memberships/[id]/route.ts` | PATCH/DELETE | requireApiOwner() | — | 0 | — |
| `/memberships/route.ts` | GET/POST | requireApiOwner(),requireApiOwnerOrManager() | — | 0 | — |
| `/onboarding/csv-handoff/route.ts` | POST | requireApiOwner(),requireOwner() | — | 0 | — |
| `/orders/[id]/mark-paid/route.ts` | POST | requireApiOwnerOrManager() | — | 0 | — |
| `/owner/reset-onboarding/route.ts` | POST | — | — | 1 | !== "owner" |
| `/payments/[id]/refund/route.ts` | POST | requireApiOwner() | — | 0 | — |
| `/payments/chase/route.ts` | POST | requireOwner() | — | 0 | — |
| `/payments/export.csv/route.ts` | GET | requireApiOwnerOrManager() | — | 0 | — |
| `/payments/intent/route.ts` | POST | — | — | 1 | — |
| `/payments/manual/route.ts` | POST | requireApiOwnerOrManager() | — | 0 | — |
| `/payments/outstanding/route.ts` | GET | requireOwner() | — | 0 | — |
| `/payments/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/products/[id]/route.ts` | PATCH/DELETE | requireApiOwnerOrManager() | — | 0 | — |
| `/products/route.ts` | GET/POST | requireApiOwnerOrManager(),requireApiStaff() | — | 0 | — |
| `/promotions/candidates/route.ts` | GET | requireApiOwnerOrManager() | — | 0 | — |
| `/push/subscribe/route.ts` | POST | — | — | 1 | — |
| `/ranks/[id]/route.ts` | PATCH/DELETE | — | — | 2 | ["owner", "manager"] |
| `/ranks/route.ts` | GET/POST | — | — | 2 | ["owner", "manager"] |
| `/reports/generate/route.ts` | POST/GET | requireApiOwnerOrManager() | — | 0 | — |
| `/reports/route.ts` | GET | — | — | 1 | ["owner", "manager"] |
| `/revenue/summary/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/settings/kiosk/route.ts` | POST/GET | — | — | 2 | !== "owner" |
| `/settings/route.ts` | GET/PATCH | — | — | 2 | === "member";=== "owner" |
| `/staff/[id]/route.ts` | PATCH/DELETE | — | — | 2 | === "owner" |
| `/staff/assignable/route.ts` | GET | — | — | 1 | STAFF_ROLES |
| `/staff/route.ts` | GET/POST | — | — | 2 | === "owner";["owner", "manager"] |
| `/stripe/connect/callback/route.ts` | GET | — | — | 1 | !== "owner" |
| `/stripe/connect/health/route.ts` | GET | requireApiOwner() | — | 0 | — |
| `/stripe/connect/route.ts` | GET | — | — | 1 | !== "owner" |
| `/stripe/create-subscription/route.ts` | POST | — | — | 1 | ["owner", "manager"] |
| `/stripe/disconnect/route.ts` | POST | — | — | 1 | !== "owner" |
| `/stripe/portal/route.ts` | POST | — | — | 1 | — |
| `/stripe/subscription-plans/route.ts` | GET/POST | — | — | 2 | !== "owner" |
| `/stripe/webhook/route.ts` | POST | — | — | 0 | — |
| `/tasks/[id]/complete/route.ts` | POST | — | — | 1 | === "owner";STAFF_ROLES |
| `/tasks/route.ts` | GET/POST | — | — | 2 | STAFF_ROLES |
| `/tenant/[slug]/route.ts` | GET | — | — | 0 | — |
| `/upload/delete-orphan/route.ts` | POST | — | — | 1 | — |
| `/upload/route.ts` | POST | requireApiOwner() | — | 1 | — |
| `/waiver/[signedWaiverId]/signature/route.ts` | GET | — | — | 1 | — |
| `/waiver/kiosk-request/route.ts` | POST | — | — | 0 | — |
| `/waiver/kiosk-status/route.ts` | GET | — | — | 0 | — |
| `/waiver/open/route.ts` | GET/POST | — | — | 0 | — |
| `/waiver/route.ts` | GET | — | — | 1 | — |
| `/waiver/sign-for-child/route.ts` | POST | — | — | 1 | — |
| `/waiver/sign/route.ts` | POST | — | — | 1 | — |
| `/webhooks/resend/route.ts` | POST | — | — | 0 | — |

Totals: **171 route files**; **44** import `lib/api-authz`; **82** hand-roll
`await auth()`; **2** wrongly import `requireOwner` from `lib/authz`
(`app/api/payments/chase/route.ts:11`, `app/api/payments/outstanding/route.ts:11`).
Six route files import only `STAFF_ROLES` from `lib/authz` as a constant, which
is fine (`members/[id]/unlock`, `staff/assignable`, `tasks`, `tasks/[id]/complete`,
`members/[id]/photos`, `members/[id]/waiver-link`).

### 2.4 Operator (`/api/admin/**`) routes — all 19 verified gated

Every route under `app/api/admin/**` that is not itself a login endpoint calls
`isAdminAuthed(req)` and/or `getOperatorContext(req)` and checks the result.
Verified individually:

| Route | Gate | Status code on failure |
|---|---|---|
| `/admin/activity` | `isAdminAuthed` | 403 (`route.ts:17`) |
| `/admin/applications` | `isAdminAuthed` | 401 (`route.ts:10`) |
| `/admin/applications/[id]/approve` | `getOperatorContext().authed` | 401 (`route.ts:43`) |
| `/admin/applications/[id]/reject` | `getOperatorContext().authed` | 401 (`route.ts:21`) |
| `/admin/create-tenant` | `getOperatorContext().authed` | 401 (`route.ts:37`) |
| `/admin/customers/[id]/force-password-reset` | `isAdminAuthed` + ctx | 403 (`route.ts:33`) |
| `/admin/customers/[id]/member-totp-reset` | `isAdminAuthed` + ctx | 403 (`route.ts:38`) |
| `/admin/customers/[id]/soft-delete` (POST **and** DELETE) | `isAdminAuthed` + ctx | 403 (`route.ts:29`, `:127`) |
| `/admin/customers/[id]/suspend` (POST **and** DELETE) | `isAdminAuthed` + ctx | 403 (`route.ts:28`, `:139`) |
| `/admin/customers/[id]/totp-reset` | `isAdminAuthed` + ctx | 403 (`route.ts:30`) |
| `/admin/customers/[id]/transfer-ownership` (GET **and** POST) | `isAdminAuthed` + ctx | 403 (`route.ts:34`, `:48`) |
| `/admin/impersonate` POST | `getOperatorContext().authed` | 403 (`route.ts:30`) |
| `/admin/impersonate` DELETE | **none by design** | n/a (`route.ts:95-97`) |
| `/admin/auth/*` | login endpoints — rate-limited, credential-checked | 401/423/429 |

**Namespace collision:** `app/api/admin/dsar/*`, `app/api/admin/email/test` and
`app/api/admin/import/*` live under `/api/admin` but are **tenant-owner**
routes gated by `requireApiOwner()`, not operator routes. Because
`proxy.ts:28` puts the whole `/api/admin` prefix in `PUBLIC_PREFIXES`, these
tenant routes are exempted from the middleware session wall and depend solely
on their own `requireApiOwner()` call. They do call it — but the naming makes
the boundary easy to get wrong on the next route added here.

### 2.5 Routes reachable with a WEAKER guard than their siblings

Ranked by consequence.

| # | Weaker route | Its guard | Sibling / expected guard | Why it matters |
|---|---|---|---|---|
| A | `POST /api/members/[id]/totp-reset` | `requireApiStaff()` — **coach and admin included** (`route.ts:29`) | Operator equivalent `POST /api/admin/customers/[id]/member-totp-reset` requires operator auth | A **coach** can clear any member's 2FA (`totpEnabled:false`, `totpSecret:null`) and bump their `sessionVersion`. The file's own header calls this deliberate ("eliminates the operator bottleneck"), but it means the weakest staff rung can strip a member's second factor. `app/api/members/[id]/totp-reset/route.ts:1-8`, `:47-55` |
| B | `POST /api/members/[id]/rank` (promote) | `["owner","manager","coach"]` (`route.ts`) | `POST /api/members/[id]/rank/demote` is `["owner","manager","admin"]` | The two halves of the same capability have **different, non-overlapping** allow-lists: a coach can promote but not demote; an admin can demote but not promote |
| C | `POST /api/members/bulk-invite` | `requireApiStaff()` | `POST /api/members` (single create) is `["owner","manager","admin"]` (`app/api/members/route.ts:148`) | A **coach** cannot create one member but can bulk-invite many |
| D | `GET/POST/DELETE /api/classes/[id]/roster` + `DELETE …/roster/[memberId]` | `["owner","manager","admin"]` | `PATCH/DELETE /api/classes/[id]` and `/api/classes` are `["owner","manager"]` | `admin` can restructure a class's roster but not the class |
| E | `GET /api/settings` | any role except `member` (`route.ts:70`) | `PATCH /api/settings` is owner-only (`:114`) | A coach reads `subscriptionStatus`, `subscriptionTier`, member/staff/class counts |
| F | `app/dashboard/promotions/page.tsx` | `requireStaff()` | Nav entry says `["owner","manager"]` (`components/layout/routes.ts:50`) and the data API `GET /api/promotions/candidates` is `requireApiOwnerOrManager()` | Coach/admin can load the page; it then 403s on its own data — an empty page instead of a redirect |
| G | `app/dashboard/timetable/page.tsx` | `requireStaff()` | Class mutation APIs are `["owner","manager"]` | Same shape: page renders, every write fails |
| H | `GET /api/members/[id]/photos` (incl. children's photos) | `STAFF_ROLES` — coach included (`route.ts`) | `GET /api/member/children/[id]/photos` is parent-scoped | Coaches can read minors' photo evidence. Deliberate per `tests/integration/staff-photo-viewer.test.ts` (**UNVERIFIED** as an intentional product decision beyond the test's existence) |
| I | `GET /api/dashboard/stats` and `GET /api/members/[id]/payments` | `["owner","manager","admin","coach"]` | `GET /api/payments`, `GET /api/revenue/summary` are `requireApiOwner()` | Per-member payment history and dashboard financial stats are visible to coaches while the aggregate views are owner-only |
| J | `POST /api/payments/chase`, `GET /api/payments/outstanding` | `requireOwner()` from `lib/authz` — **page helper in a route handler** | should be `requireApiOwner()` | Correct role, wrong failure mode: 307-to-login instead of 403/401 (see §0.13) |
| K | `app/member/**` pages | **no server-side gate at all** — `app/member/layout.tsx` contains no `auth()`/`require*` call | `app/dashboard/layout.tsx:24` calls `requireStaff()` | Member pages rely 100 % on `proxy.ts`. Any matcher change that excludes `/member` removes the only gate. (The data APIs are separately gated, so the exposure is shell-only.) |

---

## 3. IMPERSONATION

### 3.1 Mechanics, end to end

| Step | What happens | Evidence |
|---|---|---|
| 1. Operator opens `/admin/tenants/[id]` | Page gated by `isAdminPageAuthed()` (op-session cookie **or** legacy secret cookie) | `app/admin/tenants/[id]/page.tsx` |
| 2. Clicks "Login as {owner}", types a reason (≥5 chars enforced client-side) | Modal text promises: *"It is recorded in the audit log alongside every action during this session."* | `app/admin/tenants/[id]/LoginAsOwnerButton.tsx:56-57`, `:72` |
| 3. `POST /api/admin/impersonate` | `getOperatorContext(req).authed` required (403 otherwise); rate-limited **30 / hour per IP**; body `{ targetUserId, reason }` where `reason` is `z.string().min(5).max(500)` | `app/api/admin/impersonate/route.ts:29-38`, `:23-26` |
| 4. Target lookup | `withRlsBypass` — reads any `User` in any tenant. **No check that the target is an owner**; any `User` id is acceptable. `Member` rows cannot be impersonated (lookup is `tx.user`) | `route.ts:53-58` |
| 5. Cookie minted | `matflow_impersonation` = `base64url(JSON payload).base64url(HMAC-SHA256)`; payload `{adminUserId, targetUserId, targetTenantId, reason, exp}` signed with `AUTH_SECRET_VALUE` | `lib/impersonation.ts:34-50` |
| 6. Cookie attributes | `httpOnly: true`, `secure` in production only, `sameSite: "strict"`, `path: "/"`, `maxAge: 3600` | `lib/impersonation.ts:100-106` |
| 7. Every subsequent request | `auth.ts` `jwt()` reads the cookie (Node runtime only), loads the target, and **overwrites the JWT identity**: `id`, `tenantId`, `tenantSlug/Name`, brand colours, `role`, `sessionVersion`, `memberId:null` | `auth.ts:620-659` |
| 8. Redirect | `{ redirectTo: "/dashboard" }` — operator lands in the tenant dashboard as the owner | `route.ts:91` |
| 9. Banner | `ImpersonationBanner` (server component) reads the cookie directly and renders a sticky red bar with minutes remaining and an "End impersonation" button — **only inside `/dashboard`** | `components/layout/ImpersonationBanner.tsx:8-19`, mounted at `app/dashboard/layout.tsx:49` |
| 10. End | `DELETE /api/admin/impersonate` — **no credential of any kind is required**; it logs `admin.impersonate.end` then clears the cookie | `app/api/admin/impersonate/route.ts:94-111`, `lib/impersonation.ts:117-120` |

### 3.2 Lifetimes

| Cookie | Name | TTL | SameSite | Path | Constant |
|---|---|---|---|---|---|
| Impersonation | `matflow_impersonation` | **60 min** | Strict | `/` | `lib/impersonation.ts:17` |
| Operator session (v1.5) | `matflow_op_session` | **8 h** | Strict | `/` | `lib/operator-auth.ts:31`, `:114-122` |
| Operator TOTP challenge | `matflow_op_challenge` | **5 min** | Strict | `/api/admin/auth` | `lib/operator-auth.ts:32`, `:144-153` |
| Legacy admin secret (v1) | `matflow_admin` | **8 h** | Strict | `/` | `lib/admin-auth.ts:26`, `:85-96` |
| Tenant NextAuth JWT | (NextAuth default) | **30 days** | — | — | `auth.ts:121-123` |

### 3.3 What an operator can do while impersonating

Everything the target `User.role` can do — the JWT is indistinguishable from a
real login except for two extra claims. Concretely, if the target is an owner:
change all gym settings (`PATCH /api/settings`), mint/rotate the kiosk token,
add and delete staff, view and export payments, issue refunds, run DSAR export
and erase, connect/disconnect Stripe. Plus:

* **2FA is bypassed.** `token.totpPending = false` and `requireTotpSetup = false`
  are forced, so the target's enrolled authenticator is never challenged
  (`auth.ts:647-648`). The header comment states this is intentional: "the admin
  secret authorised the access at start-time" (`auth.ts:618-619`).
* **The 2FA nudge banner is suppressed** by forcing `token.totpEnabled = true`
  (`auth.ts:652`) — a lie about the target's real state that is written into the
  session.
* **The revocation clock is reset every request.** `token.sessionVersionCheckedAt
  = Date.now()` is re-stamped inside the impersonation branch (`auth.ts:654`),
  which sits *above* the `shouldRecheck` computation (`auth.ts:674-675`). The
  10-minute DB re-check therefore never fires while the cookie is live.
* **The operator keeps their operator cookies.** Nothing clears
  `matflow_op_session` / `matflow_admin` when impersonation starts, so `/admin`
  and the impersonated `/dashboard` are usable simultaneously in the same browser.

### 3.4 Audit trail — and its hole

| Event | Recorded? | Actor recorded |
|---|---|---|
| `admin.impersonate.start` | Yes | `userId` = **target**, `metadata.actingAs` = operator id, plus `metadata.reason`, `targetEmail`, `targetRole`, `operatorEmail` | `app/api/admin/impersonate/route.ts:75-89`, `lib/audit-log.ts:29-38` |
| `admin.impersonate.end` | Yes | same shape | `route.ts:99-108` |
| **Every action performed during the session** | Logged as normal — but **attributed to the target owner only** | `logAudit` is called by each route with `userId: session.user.id` (now the target) and **no `actAsUserId`** |

The hole is provable: `session.user.impersonatedBy` and
`session.user.impersonationReason` are written by the session callback
(`auth.ts:740-746`) and are then **read by nothing** — a repo-wide grep for
`impersonatedBy` returns only `auth.ts` and no consumer. `lib/audit-log.ts` has
no awareness of impersonation; it only stamps `metadata.actingAs` when a caller
passes `actAsUserId` explicitly, which only the `/api/admin/**` routes do.

Consequence: the modal's promise at
`app/admin/tenants/[id]/LoginAsOwnerButton.tsx:56-57` — *"recorded in the audit
log alongside every action during this session"* — is **not true**. The audit
log shows a start marker, a set of ordinary owner actions, and an end marker;
correlating them requires reading timestamps between the two markers.

### 3.5 Other impersonation gaps

| Gap | Evidence |
|---|---|
| `DELETE /api/admin/impersonate` requires no auth and no CSRF token. The exposure is a nuisance-only forced logout, and `SameSite=Strict` on the cookie blunts cross-site abuse, but it is the only mutating admin route with zero gate | `app/api/admin/impersonate/route.ts:94-97`; contrast every other admin route in §2.4 |
| `POST /api/admin/impersonate` has **no `assertSameOrigin` CSRF guard**, unlike the tenant mutation routes | compare `app/api/settings/route.ts:109` with `app/api/admin/impersonate/route.ts:28-33` |
| The banner only mounts in `app/dashboard/layout.tsx:49`. An impersonated session that navigates to `/member/*` is bounced by `proxy.ts:203`, so this is mostly moot, but any future non-dashboard staff surface would show no banner | `app/dashboard/layout.tsx:49` |
| **UNVERIFIED — potential TTL escape:** the jwt callback *mutates* the NextAuth token in place and there is no code path that reverts `token.id`/`token.role` when the impersonation cookie disappears. Whether the overridden identity outlives the 60-minute cookie depends on whether NextAuth v5 re-issues the session cookie from the mutated token. I could not prove either behaviour from this repo alone; there is no test covering post-expiry reversion (`tests/e2e/admin/impersonation-cookie.spec.ts` covers cookie attributes only) | `auth.ts:620-660` (no `else` branch); `tests/e2e/admin/impersonation-cookie.spec.ts` |
| No cap on concurrent impersonations, and no notification to the impersonated owner | no such code found |

---

## 4. EVERY SETTINGS SURFACE AND ITS STORAGE

### 4.1 Tenant settings written by `PATCH /api/settings` (owner only)

Guard: `session.user.role === "owner"` (`app/api/settings/route.ts:114-115`) plus
`assertSameOrigin` CSRF (`:109`). Validation: the single `updateSchema` at
`app/api/settings/route.ts:19-65`. Every save busts the 60-second branding cache
tag `gym-branding-<tenantId>` (`:143`) and writes an audit row
`tenant.settings.update` recording only the **field names**, not values (`:145-153`).

| Setting | Column (`prisma/schema.prisma`) | Default | Zod validation (`app/api/settings/route.ts`) | Read by |
|---|---|---|---|---|
| Gym name | `Tenant.name` :13 | — (required at create) | `z.string().min(1).max(100)` :20 | JWT `tenantName` (`auth.ts:571`), every branded surface |
| Primary colour | `primaryColor` :17 | `#3b82f6` | `/^#[0-9a-fA-F]{6}$/` :21 | JWT claim, `/api/me/gym` |
| Secondary colour | `secondaryColor` :18 | `#2563eb` | same regex :22 | JWT claim |
| Text colour | `textColor` :19 | `#ffffff` | same regex :23 | JWT claim |
| Background colour | `bgColor` :20 | `#111111` | same regex :24 | login page theme |
| Font family | `fontFamily` :21 | Inter, sans-serif | `z.string().max(200)` :25 — **no allow-list at write time** | Guarded at *render* by `isSafeFontFamily` (`lib/fonts.ts:34`, used at `app/login/page.tsx:80`, `:90`) |
| Logo size | `logoSize` :16 | `md` | `z.enum(["sm","md","lg"])` :26 | `app/dashboard/layout.tsx:37-38` |
| Logo URL | `logoUrl` :15 | `null` | URL **or** root-relative path **or** `data:image/...;base64` capped at 3 MB :27-34 | sidebar, member app, login |
| Onboarding done | `onboardingCompleted` :25 | `false` | `z.boolean()` :35 | `app/dashboard/layout.tsx:33` → redirect to `/onboarding` |
| Onboarding answers | `onboardingAnswers` Json :26 | `null` | `z.record(z.string(), z.unknown())` :36 — **arbitrary JSON, unbounded** | **no reader found** (see §4.7) |
| Waiver title / body | `waiverTitle` :51, `waiverContent` :52 | `null` (fallback `lib/default-waiver.ts`) | `max(200)` / `max(20000)` :37-38 | `/api/waiver`, kiosk, `/waiver/open` |
| Kids waiver title / body | `kidsWaiverTitle` :53, `kidsWaiverContent` :54 | `null` | `max(200)` / `max(20000)` :39-40 | supervised-waiver flow |
| Accepts BACS | `acceptsBacs` :36 | `false` | `z.boolean()` :41 | `lib/stripe/subscriptions.ts:61` — rejects `bacs_debit` when false |
| Member self-billing | `memberSelfBilling` :37 | `false` | `z.boolean()` :42 | `app/api/stripe/portal/route.ts:39-44` (403 when off), `components/member/MemberBillingTab.tsx:112` |
| Billing contact email / URL | `billingContactEmail` :38, `billingContactUrl` :39 | `null` | `.email().max(120)` / https-only `.max(300)` :43-50 | member billing page |
| Privacy contact email / URL | `privacyContactEmail` :40, `privacyPolicyUrl` :41 | `null` | `.email()` / `httpsUrl()` :52-53 | member profile, legal pages |
| Socials x6 + group chat | `instagramUrl` … `websiteUrl` :42-47, `groupChatUrl` :50 | `null` | `httpsUrl()` — `.url().max(300)` + must start `https://` :12-17, :55-62 | member profile gym card |
| Check-in window before / after | `checkinWindowBeforeMin` :34, `checkinWindowAfterMin` :35 | `30` / `30` | `z.number().int().min(0).max(180)` :63-64 (DB CHECK 0-180 too) | `lib/checkin.ts:123`, `:180` |

### 4.2 Tenant settings written elsewhere

| Setting | Route | Guard | Validation | Notes |
|---|---|---|---|---|
| Kiosk token | `POST /api/settings/kiosk` → `kioskTokenHash`, `kioskTokenIssuedAt` (`schema.prisma:59-60`) | `session.user.role !== "owner"` → 403 (`route.ts:45`, `:128`) + CSRF | `z.enum(["enable","regenerate","disable"])` (`:30-32`) | Raw token returned **once** (`:119`); only the HMAC hash is stored (`lib/token-hash.ts`). `enable` on an already-enabled tenant → 409 |
| Stripe Connect | `stripeAccountId`, `stripeConnected` | `/api/stripe/connect*`, `/api/stripe/disconnect` — inline `role !== "owner"` | — | `stripeAccountStatus` Json cached by `lib/stripe-account-status.ts:99` off the `account.updated` webhook |
| Onboarding reset | `POST /api/owner/reset-onboarding` → `onboardingCompleted:false` | inline `role !== "owner"` | — | `app/api/owner/reset-onboarding/route.ts:23` |
| `subscriptionStatus` | operator suspend / unsuspend | `isAdminAuthed` | — | `suspend/route.ts:113` (suspended), `:157` (active). **Enforced at login**: `auth.ts:194` refuses sign-in when suspended |
| `deletedAt` | operator soft-delete / restore | `isAdminAuthed` | — | `soft-delete/route.ts:100`, `:146`. Enforced at `auth.ts:193` |
| `subscriptionTier` | set only at tenant creation (`create-tenant/route.ts:82` region, `approve/route.ts:102`) | operator | zod enum in the create schema | **Never gates a feature** — see §4.7 |

### 4.3 Sub-entity configuration surfaces

| Surface | Storage | Write route | Guard | Zod schema |
|---|---|---|---|---|
| Membership tiers | `MembershipTier` (`schema.prisma:1003`) | `POST /api/memberships`, `PATCH/DELETE /api/memberships/[id]` | `requireApiOwner()` for writes; `requireApiOwnerOrManager()` for GET | `app/api/memberships/route.ts:9-23` — `pricePence` int >= 0, `currency` `/^[A-Z]{3}$/`, `billingCycle` enum, `maxClassesPerWeek` 1-30, Stripe ids regex-checked |
| Classes / timetable | `Class`, `ClassSchedule` | `POST /api/classes`, `PATCH/DELETE /api/classes/[id]` | inline `["owner","manager"]` | `lib/schemas/class.ts:17-29`; `scheduleSchema` shared between POST and PATCH deliberately (`:3-8` explains the earlier silent-discard bug). **`color: z.string().max(20)` has no hex check** — unlike the tenant colours |
| Class instance generation | `ClassInstance` | `POST /api/instances/generate`, `POST /api/classes/[id]/instances` | inline `["owner","manager"]` | — |
| Rank systems / belts | `RankSystem`, `RankRequirement` | `POST /api/ranks`, `PATCH/DELETE /api/ranks/[id]` | inline `["owner","manager"]` | — |
| Class packs | `ClassPack` | `/api/class-packs` | `requireApiOwnerOrManager()` | `app/api/class-packs/route.ts:15` currency 3-char |
| Shop products | `Product` | `/api/products`, `/api/products/[id]` | `requireApiOwnerOrManager()` for writes, `requireApiStaff()` for read | — |
| Announcements | `Announcement` | `/api/announcements`, `/api/announcements/[id]` | inline `["owner","manager"]` | `lib/schemas/announcement.ts` |
| Staff roster + roles | `User` | `POST /api/staff`, `PATCH/DELETE /api/staff/[id]` | inline `role === "owner"` | `z.enum(["manager","coach","admin"])` — owner not mintable (`app/api/staff/route.ts:18`, `app/api/staff/[id]/route.ts:13`) |
| Google Drive link | `GoogleDriveConnection` | `/api/drive/*` | `requireApiOwner()` (all 7 routes) | — |

### 4.4 Member-facing preferences

Storage: columns on `Member` (`prisma/schema.prisma:162-172`). Write route:
`PATCH /api/member/me` — self-scoped via `session.user.memberId`, CSRF-guarded
(`app/api/member/me/route.ts:272-282`). **The notification booleans are typed
with bare `typeof x === "boolean"` checks, not zod** — only the identity trio
(name / email / phone) goes through `memberSelfUpdateSchema` (`:324`).

| Preference | Column | Default | Settable? | Read (does it do anything)? |
|---|---|---|---|---|
| `classReminders` | :163 | `true` | Yes — `route.ts:400` | **NO.** No send path consults it |
| `beltPromotions` | :164 | `true` | Yes — `:401` | **NO** |
| `gymAnnouncements` | :165 | `true` | Yes — `:402` | **NO** |
| `taskAssignments` | :172 | `true` | **NO** — absent from the PATCH body type and from every route | **Yes** — `lib/notify-member-action.ts:52`, `:89` gate member-action emails on it |
| `notifyOnNewLogin` (Member) | :167 | `true` | **NO** — no write path found | **Yes** — `lib/login-event.ts:92` |
| `notifyOnNewLogin` (User / staff) | :97 | `true` | **NO** — no write path found | **Yes**, but owners are force-overridden at `lib/login-event.ts:92` |
| `preferredPaymentMethod` | :148 | `card` | Not directly — written only by Stripe machinery (`lib/stripe/subscriptions.ts:180`, `app/api/stripe/webhook/route.ts:606`) | payment-method display |
| Identity: name / email / phone | :126-129 | — | Yes, zod-validated (`lib/schemas/member.ts:83`) | everywhere. Kid and GDPR-tombstone emails are structurally locked (`route.ts:372-381`) |
| `accountType` self-set | :142 | `adult` | Yes but clamped to parent / adult (`route.ts:397`) | kids policy |
| TOTP fields | :159-161 | `false` / null | **Never via this route** — `stripTotpFields` strips them at entry (`route.ts:287`, `lib/totp-immutable.ts`); dedicated `/api/member/totp/*` routes only | login |

The member Notifications settings card has been **deleted from the UI** with a
comment stating exactly why — a control that controls nothing is a promise the
product cannot keep (`app/member/profile/page.tsx:26-35`). The API fields and DB
columns were deliberately left behind.

### 4.5 Operator / platform settings

| Surface | Storage | Write path | Guard | Status |
|---|---|---|---|---|
| Operator account (email, password, name) | `Operator` (`schema.prisma:1034`) | **none in the app** — `scripts/seed-operator-noe.mjs` only | n/a | No self-service, no operator-management UI |
| Operator TOTP | `Operator.totpEnabled` / `totpSecret` | `POST /api/admin/auth/operator-totp/setup` | must already hold a valid op session (`route.ts:37`, `:66`) | Bumps `sessionVersion` and re-issues the cookie (`:101-106`) |
| Operator role / permissions | `Operator.role` :1039 | seed script only | n/a | **DEAD — read by nothing** |
| Platform-wide config | `PlatformConfig` :1053 | **none** | n/a | **DEAD — table never queried** |
| Per-tenant feature flags | `Tenant.featureFlags` :62 | **none** | n/a | **DEAD — column never read or written** |
| Legacy admin secret | `process.env.MATFLOW_ADMIN_SECRET` | env var | n/a | Live; also the literal cookie value |

### 4.6 Env-var-as-settings

Declared in `.env.example`: `AUTH_SECRET`, `DATABASE_URL`, `DEMO_MODE`,
`ENABLE_GOOGLE_OAUTH`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`MAINTENANCE_MODE`, `MATFLOW_ADMIN_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
`NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH`, `NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS`,
`NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `STRIPE_CLIENT_ID`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TESTING_MODE`. Several more are
read in code but are undeclared there: `CRON_SECRET`, `E2E_BYPASS_TOKEN`,
`BLOB_READ_WRITE_TOKEN`, `RESEND_API_KEY`, `RESEND_FROM`,
`RESEND_WEBHOOK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`ANTHROPIC_API_KEY`, `MATFLOW_APPLICATIONS_TO`, `APP_URL`, `GOOGLE_REDIRECT_URI`.

Behaviour-changing flags actually read in code:

| Flag | Effect | Guard against misuse | Evidence |
|---|---|---|---|
| `MAINTENANCE_MODE=true` | 503 on every path except `/api/health`, `/api/auth`, `/_next`, `/login` | none needed | `proxy.ts:108-126` |
| `TESTING_MODE=true` | Bypasses 2FA enforcement and the login rate limit | Refused when `VERCEL_ENV=production` **and** when `DATABASE_URL` points at the production Neon endpoint | `lib/testing-mode.ts:24-37` |
| `E2E_BYPASS_TOKEN` | **Password bypass** — any account signs in with this string as the password | Requires `isTestingMode()` **and** a loopback client IP | `auth.ts:170-171`, `:234-238`. The loopback set includes the literal string unknown, so a request with no resolvable IP qualifies; `isTestingMode()` is the only real barrier |
| `DEMO_MODE=true` | Hard-coded demo users with fixed roles (owner, coach, admin, member) | **Throws at module load** in production | `auth.ts:44-50`, `:424-437` |
| `MATFLOW_ADMIN_SECRET` | Grants full operator access | Boot guard makes it required in production | `lib/admin-auth.ts`, `lib/env-guards.ts:40` |
| `ENABLE_GOOGLE_OAUTH` | Adds the Google provider | Requires a verified Google email plus a pre-existing account; **no auto-provisioning** | `auth.ts:29-32`, `:128-134`, `:462`, `:486` |
| `NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS` | Gates the new-device email | — | `lib/login-event.ts` |
| `CRON_SECRET` | Bearer token for `/api/cron/*` (excluded from middleware) | routes 503 when unset | `proxy.ts:223`, `lib/env-guards.ts:51` |

`lib/env-guards.ts:20-53` is the production boot contract: `DATABASE_URL`,
`RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_CLIENT_ID` and `MATFLOW_ADMIN_SECRET` throw at start-up if unset;
`SENTRY_DSN`, `CRON_SECRET` and `RESEND_WEBHOOK_SECRET` only warn.

### 4.7 Dead settings (saved but never read) and phantom settings (read but never settable)

| Field | Class | Evidence |
|---|---|---|
| `Tenant.featureFlags` | **Dead + phantom** — never written, never read | `schema.prisma:61-62`; only other hit is the migration |
| `PlatformConfig` (whole table) | **Dead + phantom** | `schema.prisma:1053`; no query anywhere |
| `Operator.role` | **Dead** — written by the seed script, read by nothing | `schema.prisma:1039`, `scripts/seed-operator-noe.mjs:54` |
| `Tenant.timezone` (default Europe/London) | **Dead + phantom** — zero occurrences in `app/`, `lib/`, `components/` | `schema.prisma:31` |
| `Tenant.address` | **Dead + phantom** — zero occurrences | `schema.prisma:32` |
| `Tenant.country` | **Phantom** — displayed to the operator at `app/admin/tenants/[id]/page.tsx:34`, but no write path exists (absent from `updateSchema` and from both tenant-create payloads) | `schema.prisma:33` |
| `Tenant.currency` (default GBP) | **Phantom** — read as the default for Stripe checkout, ad-hoc charges, tier pricing and family billing (`app/api/member/checkout/route.ts:173`, `app/api/members/[id]/charge/route.ts:124`, `app/api/stripe/subscription-plans/route.ts:27`, `app/api/member/family/[id]/billing/route.ts:98`) but **no route can set it**. A non-GBP gym is stuck on GBP | `schema.prisma:30`; absent from `app/api/settings/route.ts:19-65` |
| `Tenant.subscriptionTier` | **Cosmetic** — the only readers are two labels (`app/dashboard/settings/page.tsx:114` Plan, `app/admin/tenants/[id]/page.tsx:99` Tier). No feature, limit or quota is gated on it | `schema.prisma:24` |
| `Tenant.onboardingAnswers` | **Dead** — written by the wizard through `/api/settings`, no reader found | `schema.prisma:26`, `app/api/settings/route.ts:36` |
| `Member.classReminders`, `beltPromotions`, `gymAnnouncements` | **Dead** — settable, never consulted; UI removed | `app/member/profile/page.tsx:26-35`, `app/api/member/me/route.ts:400-402` |
| `Member.taskAssignments` | **Phantom** — read at `lib/notify-member-action.ts:89`, no write path | `schema.prisma:172` |
| `Member.notifyOnNewLogin`, `User.notifyOnNewLogin` | **Phantom** — read at `lib/login-event.ts:92`, no write path; and for owners the stored value is overridden to true regardless | `schema.prisma:97`, `:167` |
| `session.user.impersonatedBy` and `impersonationReason` | **Dead** — set in `auth.ts:743-745`, read by nothing | see section 3.4 |
| `requireTotpSetup` session claim | **Near-dead** — no longer a gate; drives a banner only | `auth.ts:339`, `proxy.ts:178-182` |
| Push notifications (`PushSubscription`, `lib/push.ts`) | **Dormant channel** — the comment at `app/member/profile/page.tsx:30-33` states that no client subscribes and that `public/sw.js` carries no push handler. **UNVERIFIED** beyond that comment plus the existence of `POST /api/push/subscribe` | `app/member/profile/page.tsx:30-33` |

---

## 5. ROLE AND SETTINGS CONTRADICTIONS, RANKED

Ranked by blast radius times likelihood, highest first.

| # | Severity | Contradiction | Evidence | Why it bites |
|---|---|---|---|---|
| 1 | **Critical** | **No least privilege for platform staff.** `Operator.role` declares four tiers but nothing reads it, so every operator who can sign in can impersonate any owner, soft-delete any tenant, force-reset any password and clear any TOTP | `prisma/schema.prisma:1039` vs zero readers; `app/api/admin/customers/[id]/*` all gate on `isAdminAuthed` only | The moment a second person needs `/admin` (support, bookkeeper), they get destructive powers. There is no read-only or billing-only operator |
| 2 | **Critical** | **The impersonation audit trail does not exist for actions.** Only start and end carry the operator identity; everything in between is logged as the gym owner. The confirmation modal explicitly promises the opposite | `app/api/admin/impersonate/route.ts:75-108` vs `lib/audit-log.ts:29-38`; `session.user.impersonatedBy` has zero readers (`auth.ts:743`); promise at `app/admin/tenants/[id]/LoginAsOwnerButton.tsx:56-57` | An owner disputing a change made during a support session cannot be told who made it, and the product told them it could |
| 3 | **High** | **A manager can exfiltrate the full payment history they are not allowed to view.** `GET /api/payments/export.csv` is `requireApiOwnerOrManager()` and includes member name, email and amount for every payment; `GET /api/payments` and `/dashboard/payments` are owner-only | `app/api/payments/export.csv/route.ts:14`, `:29` vs `app/api/payments/route.ts:21` and `app/dashboard/payments/page.tsx` | Export-endpoint bypass. The role gate on the UI is defeated by one direct GET |
| 4 | **High** | **A coach can strip a member second factor.** `POST /api/members/[id]/totp-reset` is `requireApiStaff()`, so the weakest staff rung can set `totpEnabled:false` and null the secret | `app/api/members/[id]/totp-reset/route.ts:29`, `:47-55` | Deliberate per the file header, but the account-recovery power sits at the bottom of the ladder. A compromised coach login becomes a member-account takeover primitive |
| 5 | **High** | **The v1 shared admin secret is still a fully accepted credential and is stored verbatim in a cookie.** No per-session revocation, no identity, no TOTP; audit rows fall back to the sentinel | `lib/admin-auth.ts:49-56`, `:78-82`, `:85-96`; `lib/operator-context.ts:29`, `:45-52` | Any cookie-jar exposure on the `/admin` origin yields a durable platform-wide credential. Rotating it logs out every operator |
| 6 | **High** | **Impersonation suppresses 2FA and freezes the revocation clock.** `totpPending:false`, `requireTotpSetup:false`, `totpEnabled:true` (a lie) and `sessionVersionCheckedAt` re-stamped every request | `auth.ts:647-654`, evaluated before the `shouldRecheck` gate at `:674-675` | An owner who force-logs-out everyone cannot evict an active impersonation session within the normal 10-minute window |
| 7 | **Medium-High** | **The edge gate on `/admin/*` cannot see a revoked operator** — HMAC and expiry only, so page shells render for up to 8 hours after revocation | `proxy.ts:47-51` (comment), `:139-155` | Documented and partly mitigated (APIs reject), but revocation is not immediate at the surface a user sees |
| 8 | **Medium-High** | **`admin` is both the schema default and the second-weakest role.** Any `user.create` that omits `role` yields `admin`; the name reads as elevated and the settings UI even gives it a Settings icon | `prisma/schema.prisma:88`, `lib/authz.ts:29`, `components/dashboard/SettingsPage.tsx:89` | High chance a future writer assumes `admin` outranks `manager` and gates something with it |
| 9 | **Medium** | **`DELETE /api/admin/impersonate` has no auth and no CSRF; `POST` has no CSRF.** Every other mutating route calls `assertSameOrigin` | `app/api/admin/impersonate/route.ts:28-33`, `:94-97` vs `app/api/settings/route.ts:109` | Low direct impact given SameSite=Strict cookies, but it is the one hole in an otherwise complete CSRF sweep |
| 10 | **Medium** | **Guard style is not enforced anywhere.** 82 of 171 route files hand-roll `await auth()` plus a string compare; 2 use the redirect-based page helper inside a route handler | counts in section 2.3; `app/api/payments/chase/route.ts:11`, `app/api/payments/outstanding/route.ts:11` | The typed union in `lib/api-authz.ts` exists so `tsc` proves the migration complete. Half the surface opted out, so the compiler proves nothing |
| 11 | **Medium** | **Promote and demote have divergent, non-overlapping allow-lists.** Promote is owner / manager / coach; demote is owner / manager / admin | `app/api/members/[id]/rank/route.ts` vs `app/api/members/[id]/rank/demote/route.ts` | A coach can award a belt but cannot correct the mistake; an admin can take a belt away but not give one |
| 12 | **Medium** | **`Tenant.currency` is a phantom setting** — read as the default for every Stripe charge, settable by no route | section 4.7 | A non-UK gym is permanently GBP. Hard blocker for the first EUR or USD customer, with no admin workaround short of a direct DB write |
| 13 | **Medium** | **`subscriptionTier` gates nothing.** starter / pro / elite / enterprise are labels only | `prisma/schema.prisma:24`; only readers are two display strings | Every tenant has every feature. Plan-based pricing is unenforceable today |
| 14 | **Medium** | **No per-tenant kill switch.** `Tenant.featureFlags` and `PlatformConfig` are both fully dead, so enabling or disabling a feature for one gym needs a deploy | sections 4.5 and 4.7 | The two tables that exist for exactly this purpose are unwired |
| 15 | **Medium** | **Page gate, nav manifest and API gate disagree on the same feature.** `/dashboard/promotions` is `requireStaff()`, the nav lists it as owner+manager, its data API is `requireApiOwnerOrManager()` | `app/dashboard/promotions/page.tsx`, `components/layout/routes.ts:50`, `app/api/promotions/candidates/route.ts` | A coach who guesses the URL gets a permanently empty page rather than a redirect. Same pattern on `/dashboard/timetable` |
| 16 | **Low-Medium** | **Three member notification toggles are writable and inert**, and the one that does work (`taskAssignments`) cannot be changed by anyone | `app/api/member/me/route.ts:400-402`; `lib/notify-member-action.ts:89` | The UI was correctly removed, but the API still accepts and persists them, so an integration or a returning developer will re-expose a control that does nothing |
| 17 | **Low-Medium** | **`GET /api/settings` is readable by every staff role**, exposing subscription status and tier plus member, staff and class counts | `app/api/settings/route.ts:70` | Commercial data visible to coaches |
| 18 | **Low** | **Validation gaps.** `onboardingAnswers` accepts unbounded arbitrary JSON; `fontFamily` is a free 200-char string sanitised only at render; `Class.color` is `z.string().max(20)` with no hex check while tenant colours use a strict regex | `app/api/settings/route.ts:36`, `:25`; `lib/fonts.ts:34`; `lib/schemas/class.ts:26` | Storage bloat and inconsistent trust boundaries. The font case is safe today only because two render sites remember to call `isSafeFontFamily` |
| 19 | **Low** | **Member notification booleans bypass zod** — bare `typeof` checks while the identity trio is schema-validated in the same handler | `app/api/member/me/route.ts:400-402` vs `:324` | Inconsistent, and the pattern invites the next field to skip validation too |
| 20 | **Low** | **Member pages have no server-side gate**; the only barrier is the middleware matcher | `app/member/layout.tsx` (no `auth()` call) vs `app/dashboard/layout.tsx:24` | Shell-only exposure today because the data APIs gate separately, but one matcher edit away from mattering |

### 5.1 What I could not prove

| Question | Status |
|---|---|
| Does the impersonated identity survive past the 60-minute cookie TTL, given that `jwt()` mutates the token in place with no revert branch? | **UNVERIFIED** — depends on NextAuth v5 cookie re-issue behaviour; no test covers post-expiry reversion (`tests/e2e/admin/impersonation-cookie.spec.ts` asserts cookie attributes only) |
| Is coach access to minors photo evidence (`GET /api/members/[id]/photos`, `STAFF_ROLES`) a deliberate product decision? | **UNVERIFIED** — `tests/integration/staff-photo-viewer.test.ts` exists, implying intent, but no written policy was found |
| Is the push channel truly dormant? | **UNVERIFIED** — asserted by the comment at `app/member/profile/page.tsx:30-33`; I did not read `public/sw.js` to confirm the absence of a push handler |
| Can any code path leave a tenant with zero owners? | **UNVERIFIED** — `transfer-ownership/route.ts:86` handles the no-current-owner case, implying it is reachable, but no path creating that state was found |
| Do the DB CHECK constraints named in schema comments actually exist in the deployed database? | **UNVERIFIED** — read from migration SQL and comments only; no database was queried (read-only audit) |

---

*End of Lane C state map. Sections 0 to 5 complete. All file references are
relative to the repository root.*
