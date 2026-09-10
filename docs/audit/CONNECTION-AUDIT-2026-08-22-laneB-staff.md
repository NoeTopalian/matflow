# Lane B — Staff + Super-Admin Connection-Point Audit (MatFlow)

Date: 2026-08-20 · Method: static analysis (grep/read), no files modified.
Scope: app/dashboard/**, components/dashboard/**, components/layout/**, app/admin/**, owner onboarding wizard, CSV import / bulk-invite.
Coverage: 171 API route files inventoried, 152 fetch() call sites in scope cross-checked against them; all internal nav targets checked against existing page.tsx routes; zod schemas diffed against client payloads; role gates compared UI ↔ page guard ↔ API guard.

Excluded per brief (known in-flight): announcement expiry (composer duration UI + PATCH extend), milestones maxNext=1, member layout scroll fix.

## Summary counts

| Severity | Count |
|---|---|
| BROKEN | 1 |
| RISK | 4 |
| DEBT | 6 |

Clean sweeps worth recording (checked mechanically, no defects found):
- **Fetch ↔ route matrix**: every in-scope fetch path + method resolves to an exported handler. The 3 initial NO_METHOD hits were scanner false positives (DangerZone uses ternary `method: isSuspended ? "DELETE" : "POST"` — both exported; SettingsPage `/api/stripe/connect` is a plain GET, and the route returns the `{ url }` the client destructures).
- **Dead links**: zero nav targets (href / router.push / window.location) point at non-existent pages.
- **No-op handlers**: zero `onClick={() => {}}`-style handlers in scope.
- **Deep links honoured**: `?tab=payments` (MemberProfile.tsx:597), `?filter=` (MembersList.tsx:322-339), `?class=` (checkin page.tsx:106-110), `?new=class` (TimetableManager.tsx:957-964, correctly gated to canManage), `/admin/tenants?status=&stripe=` (TenantsList.tsx reads both), `/admin/activity?action=` (ActivityFeed.tsx:47-49).
- **Admin console guard**: every /api/admin route called by the console is guarded — `isAdminAuthed` (accepts v1 secret cookie/header AND v1.5 operator session), `getOperatorContext(...).authed` (reject route, impersonate), or `requireOperatorSession` (operator-totp/setup). The four /api/admin routes with tenant-NextAuth guards instead (dsar/*, email/test, import/*) are called from the *dashboard*, not the console — consistent, but see DEBT-4.
- **DangerZone**: all six actions (force-password-reset, suspend/re-enable, soft-delete/restore, tenant-owner totp-reset, transfer-ownership GET+POST, impersonate) hit existing guarded routes; response fields the client reads (`tempPassword`, `candidates`, `newOwner.{email,name}`) are all returned. Impersonate works for v1.5 operator sessions (getOperatorContext), not just the v1 secret.
- **Role matrix**: 17 dashboard pages' server guards vs STAFF_NAV roles (components/layout/routes.ts:41-54) vs API guards are mutually consistent — incl. the tricky ones: coach blocked from checkin page and its nav item while /api/checkin still allows coach for the coach register; promotions page redirects coach (page.tsx:23-24) matching nav + requireApiOwnerOrManager on candidates; payments page owner-only matching requireApiOwner on /api/payments, /api/payments/outstanding, /api/payments/chase; WeeklyCalendar's per-class check-in shortcut gated to owner/manager/admin (WeeklyCalendar.tsx:399-401); AdhocChargeDrawer owner-only in UI matching requireApiOwner on /api/members/[id]/charge; MemberProfile canEdit excludes coach matching PATCH /api/members/[id] role list.
- **Payload ↔ schema diffs**: members create/update, memberships, products, staff PATCH, classes create/update (incl. schedules on PATCH — the historic silent-drop is fixed), ranks create, tasks (union schema), refund (conditional subscriptionAction), payments/manual (incl. paidAt from MarkPaidDrawer), settings (privacyContactEmail, socials incl. instagramUrl, billing fields), bulk-invite, checkin — all match. Two exceptions below (BROKEN-1, RISK-1).
- **Onboarding wizard end-to-end**: ranks POST (409-tolerant), classes POST (duration+schedules match classCreateSchema incl. endTime), /api/instances/generate exists (owner/manager), /api/upload exists, settings PATCHes match schema, csv-handoff POST exists (requireApiOwner — wizard is owner-only), ImportPanel upload→preview→commit→GET refresh chain all resolves, TotpEnrollmentStep default apiPrefix `/api/auth/totp` — setup + recovery-codes routes both exist.

## BROKEN (ranked)

### B-1. Add Staff "leave blank to auto-generate" password flow is dead — creation 400s and the credentials panel can never appear
- **Client**: components/dashboard/SettingsPage.tsx:2648 — create-mode label literally reads **"Password (leave blank to auto-generate)"**; :2653 — the Add Staff button is disabled only on missing name/email, so a blank password submits; :937 — `if (sfPassword) body.password = sfPassword;` omits the field when blank; :942 — `if (created.temporaryPassword) setTempPassword(...)` gates the share-credentials panel (:2605-2624 renders Club Code / Email / Temporary Password).
- **Server**: app/api/staff/route.ts:19 — `password: z.string().min(8)` is **required**; :68-70 rejects with 400 "Invalid data"; :74-75 comment confirms the random-fallback was deliberately removed (Lane 1 iter-1 S-01); :88 — response `select` is `{id,name,email,role,createdAt}`, so `temporaryPassword` is **never returned** even on success.
- **User-visible failure**: owner follows the label, leaves password blank, clicks Add Staff → error toast "Invalid data". And even when a password is typed, the "✅ Staff member added! Share these login credentials" panel is unreachable dead UI — the drawer just closes. The client was never updated after the S-01 server fix.

## RISK

### R-1. Editing a rank's discipline is silently discarded ("Rank updated" lies)
- components/dashboard/RanksManager.tsx:131-162 — the edit drawer renders the discipline select enabled (incl. "+ New discipline…"); :144 `onSave({ name, discipline, color, stripes, order })`; :317-325 PATCHes the full object to /api/ranks/[id] and merges the response.
- app/api/ranks/[id]/route.ts:8-12 — updateSchema is `{name, order, color, stripes}` only, not `.strict()` → `discipline` is stripped server-side; the returned row carries the old discipline, so the UI quietly snaps back.
- User-visible: owner moves a belt to another discipline → success toast, nothing changed. Either PATCH should accept `discipline` or the edit form should disable the select.

### R-2. Ad-hoc charge succeeds but the member's Payments tab stays stale
- components/dashboard/AdhocChargeDrawer.tsx:153-165 — on success: toast, clear form, `onClose()` after 1.8s. No success callback exists in its props.
- components/dashboard/MemberProfile.tsx:1762-1768 — drawer mounted with no refresh wiring; :553-573 `loadPayments` runs once on mount only.
- User-visible: owner charges £X, opens the Payments tab → the charge is missing (and the paymentStatus chip is pre-charge) until a full page reload. Cross-surface refresh gap, same page.

### R-3. TOTP recovery endpoint has no UI anywhere — lost-authenticator staff dead-end at login
- app/api/auth/totp/recover/route.ts exists; repo-wide search finds **zero** client callers (matches on "totp/recover" are all the distinct `/totp/recovery-codes` path). app/login/totp/page.tsx (the challenge screen) offers no "use a recovery code" path.
- This is UI-AUDIT-2026-08.md follow-up #3 (docs line 52) — verified **still open**. Recovery codes are generated and shown at enrolment (TotpEnrollmentStep, SettingsPage) but can never be redeemed.

### R-4. /admin/security is a dead end for v1 shared-secret admin sessions
- app/admin/security/page.tsx admits any admin session (isAdminPageAuthed accepts the v1 `matflow_admin` cookie), but app/api/admin/auth/operator-totp/setup/route.ts:35-37/64-66 requires a v1.5 **operator session** and 401s otherwise.
- app/admin/security/SecurityClient.tsx:23-26 surfaces the raw `Unauthorized` with no hint that you must log in with an operator account rather than the shared secret. Secret-mode operator sees a security page that just errors.

## DEBT

### D-1. /api/admin/email/test is a dead route
- POST handler, requireApiOwner-guarded — zero references anywhere in app/** or components/** (repo-wide string search for `email/test`). Unreachable from any UI.

### D-2. /api/admin/create-tenant has no console UI (script/header-secret only)
- Guarded by ADMIN_SECRET header; no client caller. Tenant creation in the console happens solely via applications approve. Fine if intentional; flagging so nobody assumes the console can create tenants directly.

### D-3. `?waiver=signed` is written but never read
- components/dashboard/SupervisedWaiverPage.tsx:80 pushes `/dashboard/members/[id]?waiver=signed`; neither app/dashboard/members/[id]/page.tsx nor MemberProfile reads a `waiver` param (MemberProfile reads only `tab`, :597). The redirect works and the profile shows fresh waiver state, but the intended confirmation signal is silently ignored.

### D-4. /api/admin/** namespace mixes two auth models
- dsar/erase (requireApiRole(["owner"])), dsar/export, email/test, import/* (requireApiOwner) are tenant-NextAuth-guarded and called from the staff dashboard (components/dashboard/DsarActions.tsx:29,71; components/dashboard/ImportPanel.tsx:84-122); everything else under /api/admin is operator-guarded. Currently correct end-to-end, but any future blanket assumption ("everything under /api/admin is operator-gated", e.g. in middleware or a proxy rule) would break these four for owners or open them to the wrong audience. Consider relocating or documenting.

### D-5. Stale doc comment on MemberTotpResetButton
- components/dashboard/MemberTotpResetButton.tsx:7 claims it posts to `/api/admin/customers/[id]/member-totp-reset`; it actually (correctly) posts to `/api/members/[id]/totp-reset` (:46). Comment-only, but it sent this audit down the wrong path and will do the same to the next reader.

### D-6. Bulk-invite single-member toast can mislead on send failure
- components/dashboard/MemberProfile.tsx:943-946 — on `res.ok && invited === 0` it shows "Member already has login access (or no email on file)". app/api/members/bulk-invite/route.ts:133 also returns `invited: 0` with a populated `failed[]` when the email send threw — same toast, wrong story. Client never inspects `failed`.

## Connection-point matrix (problem rows only)

| Client (file:line) | Verb + path | Server contract | Break |
|---|---|---|---|
| SettingsPage.tsx:936-938 (blank pw) | POST /api/tasks…/api/staff | api/staff/route.ts:19 `password` required min 8 | 400 on advertised leave-blank flow (B-1) |
| SettingsPage.tsx:942 / 2605 | resp. of POST /api/staff | route :88 never selects `temporaryPassword` | dead response field → unreachable credentials panel (B-1) |
| RanksManager.tsx:144→317 | PATCH /api/ranks/[id] | ranks/[id]/route.ts:8-12 no `discipline` key, non-strict | field silently dropped, false success toast (R-1) |
| AdhocChargeDrawer.tsx:153-165 ↔ MemberProfile.tsx:553-573,1762 | POST /api/members/[id]/charge | charge succeeds | no refresh path → stale Payments tab / status chip (R-2) |
| (no caller) ↔ app/login/totp/page.tsx | POST /api/auth/totp/recover | route exists, guarded | orphan endpoint; no recovery-code entry UI (R-3) |
| SecurityClient.tsx:23,40 (v1 session) | GET/POST /api/admin/auth/operator-totp/setup | setup route :35-37 requires operator session | page admits v1 cookie, API rejects it; bare "Unauthorized" (R-4) |
| (no caller) | POST /api/admin/email/test | requireApiOwner | dead route (D-1) |
| SupervisedWaiverPage.tsx:80 | nav ?waiver=signed | no reader | ignored deep-link param (D-3) |
| MemberProfile.tsx:943-946 | POST /api/members/bulk-invite | route :133 `{invited, eligible, failed}` | `failed[]` never inspected → misleading toast (D-6) |

## What I could not verify statically

- **Runtime payloads built from drawer/form state objects** (TimetableManager `handleSave(data)`, SettingsPage settings PATCH state objects): I verified the constructing code and field names against schemas, but not every runtime shape permutation.
- **NextAuth session claims under impersonation** — that the impersonated owner's `role`/`tenantId` claims behave identically to a real login (impersonate route logic read, not executed).
- **Email delivery paths** (bulk-invite, force-password-reset comms) — `failed[]` semantics confirmed in code; actual SMTP behaviour untestable statically.
- **Stripe redirects and webhook-driven state** (connect OAuth URL round-trip, refund settlement, subscription cancel actions) — request/response contracts verified; external side untested.
- **Rate-limit interactions** (member PATCH 60/h, admin destructive ops 20/h) under real concurrent use.
- **proxy.ts / middleware layer**: admin pages each carry their own isAdminPageAuthed check (verified on all 7 gated pages), but I did not audit any additional edge/proxy gating referenced in comments (app/admin/tenants/page.tsx:3 mentions a proxy admin-cookie check).
- **Cross-tab/browser staleness beyond same-page composition** (e.g. a second open tab after a mutation) — out of static reach; only same-page refresh wiring (R-2) was assessed.
