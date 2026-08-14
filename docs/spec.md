# MatFlow — Running Spec

Accumulated issues and features. Add new items here before implementation.

---

## Priority Order

| Priority | Items | Rationale |
|----------|-------|-----------|
| **P1** | B1, B2, B3, B4 | Quick wins — all under 1 hour, B4 root cause now known |
| **P2** | F1, F2 | GDPR foundations — data quality before scale |
| **P3** | F4 | Kiosk waiver hard-gate — MVP feature, high daily operational impact |
| **P4** | F5, F6 | Coach attendance roll-call — novel vs competitors, complex build |
| **P5** | B5 | Stripe recurring subscriptions — needs full design |
| **Later** | F3, F7, F10, B6, N1 | Valid but not blocking current operations |
| **Done** | F8, F9 | Already fully implemented — no action needed |

---

## Product Decisions (from deep interview)

| Decision | Resolved |
|----------|---------|
| Primary differentiator | Owner control — all-in-one visibility, no per-feature add-on fees |
| MVP bar | Kiosk check-in + payment tracking + coach attendance roll-call + waiver hard-gate |
| Coach attendance flow | Review kiosk auto-sign-ins → verify who actually attended → flag anyone who attended without signing in |
| Waiver gate | Hard block at kiosk — cannot check in without signed waiver; screen shows two options: go to desk OR receive waiver link by email |
| Kiosk device | Tablet only; if WiFi down, owner logs attendance manually |
| Product scope | Total BJJ first (validate), then open as SaaS to other martial arts gyms |

---

## Bugs

### B1 — Comp/Exempt payment: "Invalid data"
- **Where:** Mark Paid Manually modal → select Comp or Exempt → click submit
- **Cause:** `/app/api/payments/manual/route.ts:32` validates `amountPence >= 1`, but Comp/Exempt legitimately submit `0`
- **Fix:** Validation must be method-aware — not a flat `min(0)`. Rules:
  - `comp` / `exempt`: amount must be `0`
  - `cash` / `external` / `other`: amount must be `>= 1`
  - `other`: also requires a non-empty `notes` field
- **Risk:** A flat `min(0)` change would accidentally allow `other` payments with zero amount

### B2 — Waiver section text overflows container
- **Where:** Member profile → Waiver and Compliance card — "Liability waiver missing" text spills outside its box
- **Cause:** `<p>` at `components/dashboard/MemberProfile.tsx:968` has no overflow handling
- **Fix:** Add `truncate` class to that `<p>` element

### B3 — Member Mix chart legend outside card
- **Where:** Dashboard → Member Mix card — legend (e.g. "13 (100%)") renders outside the card boundary
- **Cause:** `components/dashboard/charts/DonutChart.tsx:112-132` — `shrink-0` count leaves no width for label. `AnalysisView.tsx:293-328` is the parent wrapper.
- **Fix:** Fix the legend container in `DonutChart.tsx`; check `AnalysisView.tsx` for any outer container constraints causing the overflow

### B4 — Phone number not visible at 100% zoom
- **Where:** `components/dashboard/MemberProfile.tsx` ~line 1029 — phone field is inside a `className="hidden"` block
- **Root cause:** Field wrapped in a hidden container — likely left from a conditional display that was never wired up
- **Fix:** Remove the `hidden` class or move the phone field outside the hidden container

### B5 — Stripe: recurring subscriptions setup
- **Where:** Payments / Stripe integration
- **Model:** Recurring subscriptions only — members pay monthly automatically; manual methods (cash/comp/exempt) remain as-is alongside Stripe
- **Detail:** Needs full design before touching code — test environment first, live gated behind sign-off
- **Scope:** Stripe Products + Prices for membership plans, subscription creation on member signup, webhook handling (`payment_succeeded`, `payment_failed`, `subscription_cancelled`) with signature verification, customer portal for card management, full test lifecycle suite
- **Payment failure flow:**
  1. Stripe fires `invoice.payment_failed` webhook
  2. Owner is notified: **email** + **dashboard flag** with member name, amount, failure reason
  3. Owner decides — four actions available from the dashboard:
     - **Retry the Stripe payment** — trigger a manual retry
     - **Lock member access** — suspend check-in until resolved
     - **Mark as paid manually** — record cash payment and clear the flag
     - **Send payment reminder to member** — email the member about the failed payment
  4. No automatic access lock — owner is always in control
- **Risk areas:** Webhook signature verification required (prevent replay attacks); what happens if webhook delivery fails (idempotent handlers); cancelled subscription = access remains until period end

### B6 — Branding/kiosk: iPhone display hidden at 100% zoom
- **Where:** Branding or kiosk view — the iPhone mockup/display element is not visible at 100% browser zoom
- **Requirement:** Should be visible and prominent on a widescreen TV (kiosk use case)
- **Status:** Needs investigation — no root cause or file path identified yet. Do not implement until explored.

---

## Auth

### Magic-link: unknown email is silently ignored

`POST /api/magic-link/request` returns `{ ok: true }` whether or not the
email exists in the tenant. No email is sent for unknown addresses. This is
deliberate anti-enumeration — callers cannot probe whether an account exists
by watching the response.

Rate-limit: 3 requests per (tenant, email) per 15 minutes (silent rate-limit,
same `{ ok: true }` response).

Source: `app/api/magic-link/request/route.ts:61`

---

## Deployment / Env

### Profile picture uploads: BLOB_READ_WRITE_TOKEN required

`POST /api/upload` hard-returns 503 if `BLOB_READ_WRITE_TOKEN` is not set in the
Vercel environment. The feature is fully implemented in code but will not work in
production until a Vercel Blob store is provisioned and the token is added.

To fix:
1. In Vercel dashboard → Storage → create or connect a Blob store for this project.
2. `BLOB_READ_WRITE_TOKEN` is auto-added to the project env vars by Vercel.
3. Redeploy.

Deferred surfaces (lower priority, no current Blob dependency):
- Avatar on kid picker in /member/home SignInSheet
- Avatar on RemoveMemberModal kid picker
- Owner-set picture during member-create flow

Source: `app/api/upload/route.ts:142`

---

## Features

### F1 — Phone number format validation
- **Where:** Member creation and edit forms
- **Current state:** `lib/schemas/member.ts` — only `max(30)`, no format check; `type="tel"` on input only
- **Requirement:** International format — validate E.164 on both client and API (e.g. `+447911123456`)
- **Auto-format:** If user enters UK format (`07...`), silently convert to E.164 (`+447...`) without showing an error. Apply only on new input/edits — do not retroactively reject existing records.

### F2 — Birthday field on public signup
- **Current state:** `dateOfBirth: DateTime?` exists in schema and staff edit form (`MemberProfile.tsx:869`), but is absent from the public member signup flow
- **Requirement:** Add DOB field to public signup form — required for new signups only (not retroactive)
- **Age handling:** Owner configures age thresholds for account types (e.g. under-16 = junior). No hard platform minimum — if DOB indicates a minor, route to the appropriate child account type. This is owner-configured, not hardcoded.
- **Validation:** DOB must not be a future date; must be a plausible human age (e.g. not year 1900)

### F3 — Mark Analysis as "Coming Soon"
- **Where:** `/dashboard/analysis` — currently a full AI report generator (owner only)
- **Requirement:** Replace page content with a "Coming Soon" placeholder; nav item stays visible but greyed out and non-clickable
- **File:** `app/dashboard/analysis/page.tsx`, `components/dashboard/AnalysisView.tsx`

### F4 — Kiosk: waiver hard-gate on sign-in
- **Where:** Kiosk check-in flow — when a member signs in and `waiverAccepted` is false
- **Requirement:** Hard block — cannot check in at all. Screen shows two options:
  1. **"Go to the desk to sign your waiver"** — passive message, staff handles it
  2. **"Send waiver link to my email"** — emails a secure, time-limited waiver link to the member's registered email
- **Email requirement:** All members must have an email on file (enforced at signup — this case should not occur for adults)
- **Kids accounts:** Junior/child members get a separate flow — "A parent or guardian must sign your waiver at the desk" (no email option, since the parent signs, not the child)
- **Post-signing:** Kiosk polls for waiver status and auto-updates — member is let through automatically once the waiver is signed, without needing to retry manually
- **Email confirm UX:** Before sending, kiosk shows masked email (e.g. `j***@gmail.com`) so member can confirm before tapping to send
- **Security:** Waiver link must be a secure signed token expiring after **24 hours** — prevents anyone with the link from signing on behalf of any member
- **Kiosk while waiting:** After sending, screen shows "Waiting for your waiver… this screen will update automatically" and polls until waiver is signed
- **Related:** Waiver sign endpoint at `app/api/waiver/`, parental flow at `app/api/waiver/sign-for-child/route.ts`

### F5 — Attendance verification on a class
- **Who:** Owner / manager (no new role needed)
- **Requirement:** After a class, staff open that session and verify each sign-in against physical presence. This produces a double-verified record: kiosk sign-in + staff confirms they were actually there
- **Late arrivals:** Each attendance record can be marked as `late` — staff flag members who showed up after class started
- **Manual additions:** Staff can add members who attended but forgot to sign in (marks as `staffAdded`)
- **No-shows:** Members who signed in on the kiosk but the coach marks as NOT verified = flagged as a fraudulent/erroneous sign-in
- **Verification window:** Staff can verify within **24 hours** of the class. Can view any past class at any time, but the verify/edit actions lock after 24 hours.
- **Corrections:** If a mistake is made, staff can re-open and correct a verified record within 24 hours of the verification action
- **Schema impact:** `Attendance` model needs: `verified: Boolean`, `late: Boolean`, `staffAdded: Boolean`, `verifiedAt: DateTime?`, `verifiedById: String?` (nullable — retain record if staff account deleted)

### F6 — Past class data browser
- **Who:** Owner / manager
- **Requirement:** Browse any past or upcoming class session and see:
  1. **Signed in** — members who checked in via kiosk
  2. **Verified present** — confirmed by staff (from F5)
  3. **Late** — signed in but marked late
  4. **Staff-added** — attended but no kiosk sign-in
  5. **Flagged** — signed in on kiosk but NOT verified by staff (didn't actually attend)
  6. **Subscribed members** — everyone currently enrolled in this class slot (visible as context, not a no-show list)
- **No-show definition:** Only members who signed in via kiosk but weren't verified by staff — NOT all subscribed members who didn't attend
- **Class subscriptions:** Members can subscribe to specific class slots (shows up first in their schedule + notifications). This is a separate feature — **build later**. F6 does not depend on it.
- **Data saved:** All persisted permanently — class history is a core record, never deleted
- **Behavioural goal:** Catches fraudulent sign-ins, builds attendance habit, identifies retention risks

### F7 — Class announcements and messaging
- **Who:** Owner / manager
- **Requirement:** From a class view (past or upcoming), send a message/announcement to all members in that class
- **Delivery:** Email only for now — provider TBD (defer until this reaches P-queue)
- **Scope:** Targeted to that class's enrolled members
- **GDPR:** Operational/service communication under legitimate interest — must include opt-out link; log all sends with timestamp and recipient list (store email addresses in log only as long as required by retention policy)

### F8 — Profile picture: remove and replace
- **Current state:** Avatar upload and DELETE endpoint exist (`AvatarUploader.tsx`, `PUT/DELETE /api/members/[id]/profile-picture`). Verify remove button is surfaced in the UI.
- **Requirement:** Both staff and member can (a) replace photo and (b) remove it entirely — reverts to initials fallback
- **Scope:** Confirm remove action exists in `MemberProfile.tsx` (staff) and `app/member/profile/page.tsx` (member self). If not present, add it.

### F10 — Owner-configurable member tiers + class restrictions
- **Context:** Multiple junior age groups exist (e.g. "Youth" and "Junior" — same category, different ages). Owner needs to define these tiers and assign classes to them.
- **Requirement part 1 — Configurable tiers:** Owner can define member account types/age bands in settings (e.g. Youth = under 10, Junior = 10–15, Adult = 16+). Each tier has a name, age range, and any special rules (e.g. parental consent required).
- **Requirement part 2 — Class restrictions:** When creating or editing a class, owner can restrict it to one or more tiers/ranks (e.g. "Youth BJJ" = Youth only; "Advanced" = Blue belt+). Members outside the allowed tiers/ranks cannot be enrolled or check in.
- **Kiosk impact:** If a member tries to check in to a class their tier doesn't allow, they should be blocked with a clear message.
- **Schema impact:** Member account type needs to be a tenant-configurable enum (not hardcoded). Class model needs a `restrictions[]` field (tiers or ranks). This is a meaningful schema change — design carefully before migrating.
- **Priority:** P-Later — important but complex; do after kiosk and attendance foundations are solid.

### F9 — Kiosk: restricted session (security)
- **Requirement:** Kiosk mode must run under a restricted session — the owner/manager account must never be exposed on the reception tablet
- **Current state:** Owner believes a kiosk link generation may already be set up — **verify this before building**. Check `app/dashboard/checkin/` and any existing kiosk token/link routes.
- **If not implemented:** Owner generates a kiosk link from settings. Link grants a scoped session: check-in only, no back-office access, no member data browsing, no payment access.
- **Scope:** Kiosk session can only: accept sign-ins, show waiver gate, send waiver email link
- **Why:** Physical device in a public space — any member or visitor could walk up to it

---

## Competitive Intelligence (deep research — 29 sources, 112 agents, 17/25 claims adversarially killed)

### Verified gaps MatFlow can exploit
- **Coach roll-call** — no competitor has a first-party coach-initiated roll-call distinct from member self-check-in (F5/F6 is novel)
- **Manual payment recording** — no confirmed competitor offers a unified comp/exempt/cash workflow with audit trail in a single interface (B1 fix + payment UX is a differentiator)
- **Enforced parental consent** — TeamUp delegates waiver compliance to the gym operator; MatFlow enforcing it at platform level is a genuine advantage for junior-heavy clubs

### Verified patterns worth following
- **Kiosk security model** — TeamUp kiosk runs under a separate less-privileged account (see F9)
- **Family account UX** — TeamUp uses a profile-picker (parent sees "Who are you booking for?", child has no separate login). MatFlow's `parentMemberId` model already matches this.
- **Waiver as native feature** — Mindbody relies on Smartwaiver (third-party bolt-on). MatFlow's native waiver gate is architecturally ahead.

### PWA / notifications constraint (confirmed)
- iOS PWA push notifications require home-screen install — Apple constraint through Safari 18.5. Prompt "Add to Home Screen" at onboarding if push is ever added. EU DMA exemption claim was refuted — push works in EU too.

---

## Areas to Audit / Potentially Flaky

| Area | Risk | Notes |
|------|------|-------|
| Stripe integration | High | Test vs live keys may be mixed; check webhook logs in Stripe dashboard (see B5) |
| Reports aggregations | High | `lib/reports.ts` — edge cases with zero check-ins, NaN totals, off-by-one on week boundaries |
| Kiosk attendance | High | No waiver gate currently — members without waivers check in silently (see F4) |
| Multi-tenancy — iter-3 deferred | High | 6 High items deferred from audit iter-2 (see below) |
| PWA/Serwist caching | Medium | Stale API responses — member status or check-in data may show outdated on mobile |
| Kids waiver orphan | Low | If a parent account is deleted, check child records don't orphan/expose incorrectly |

### Serwist / PWA Cache — Test Scenarios

Test each by: (1) load page on installed PWA, (2) make a change on desktop, (3) refresh phone — should reflect change immediately.

| Scenario | Risk if stale | Route to verify |
|----------|--------------|-----------------|
| Member payment status changes | Member appears unpaid at kiosk | `/api/members/[id]` |
| Member checks in — register doesn't update | Attendance record missed | `/api/attendance` or register route |
| Waiver signed — still shows "missing" | Member blocked at kiosk incorrectly | `/api/members/[id]` |
| Class cancelled — member sees it as active | Member turns up to cancelled class | Timetable/class route |
| New member added — not in member list | Staff can't find them | `/api/members` list route |

**If any are stale:** exclude those API routes from Serwist cache or set `NetworkFirst` strategy.

### Audit iter-3 deferred items (High severity — from commit `5df0d7f`)

These were explicitly deferred from iter-2 and must be addressed in iter-3:

| ID | Item | Detail |
|----|------|--------|
| L1-I2-V-03 | Rank promotion photo orphan blob | Old photo blob not deleted when rank photo is replaced — storage leak + potential stale URL |
| L1-I2-V-04 | Announcement image orphan blob | Same pattern — announcement image replacement leaves orphaned blobs |
| L1-I2-S-04 | Missing audit logs (3 routes) | `admin/email/test`, rank-photo-attach side-effect, `instances/generate` — no audit trail |
| L1-I2-S-07 | Rate-limit fail-open under DB error | If rate-limit DB check fails, falls back to in-process memory — can be bypassed if DB is under pressure |
| L1-I2-S-08 | DSAR export raw includes | 8 sibling queries pull sensitive fields unnecessarily — defence-in-depth gap |
| L1-I2-S-09 | Members PATCH sequential `withTenantContext` | 3 sequential connections on status-change path — connection pressure under load |

---

## GDPR / Compliance

| Area | Requirement |
|------|-------------|
| Email communications (F7) | Operational emails under legitimate interest — must include opt-out; log sends with timestamp + recipient list per retention policy |
| Phone numbers (F1) | Operational use only; must be deletable on member data erasure request |
| Waivers | Signed waiver PDFs must be retained for liability; document retention policy needed |
| Kids data | Junior member data is sensitive — parental consent must be explicit and auditable |
| Data erasure | Member deletion must cascade to attendance, payment, and waiver records (anonymise financial records rather than hard-delete for audit trail) |
| Stripe | Payment data stays in Stripe — MatFlow must never store raw card data |

---

## Notifications

### N1 — SMS class notifications
- **Status: Deferred** — not building for now
- When revisited: F1 (phone validation) must land first; use Twilio with GDPR opt-in consent field

---

## Already Implemented (verify before re-doing)

| Item | Status | Commit / File |
|------|--------|---------------|
| Profile pictures + remove | ✓ Shipped | `fa67a51` — Remove button in `AvatarUploader.tsx:190`. F8 is complete. |
| Kids/junior waiver (parental consent) | ✓ Shipped | `app/api/waiver/sign-for-child/route.ts`, `components/member/KidPhotosAndWaiver.tsx` |
| Birthday field (schema + staff edit) | ✓ In schema | `schema.prisma:138`, `MemberProfile.tsx:869` |
| Kiosk token system (F9) | ✓ Shipped | `kioskTokenHash` in schema, `/kiosk/[token]` page, `app/api/kiosk/[token]/` routes. F9 is complete. |
| Account types enum | ⚠️ Partial | `adult\|junior\|kids\|parent` exists but hardcoded — F10 needs owner-configurable tiers |
| Stripe (B5) | ⚠️ Partial | `lib/stripe/subscriptions.ts` exists but staff-only; member self-subscription not built |
| Announcements (F7) | ⚠️ Partial | Gym-wide announcements exist; per-class targeting not built |
