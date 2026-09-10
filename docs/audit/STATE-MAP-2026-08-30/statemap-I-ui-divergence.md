> **Note:** Headline sections complete; detail sections truncated (agent stalled) — regenerate on demand.

# State-map I — Where the UI and the server disagree about state (ROUND 2, NEW findings only)

Repo: `c:\Users\NoeTo\Desktop\matflow` — Next.js 16 App Router, React 19, multi-tenant gym SaaS.
Surfaces covered: staff dashboard (`/dashboard`), member portal (`/member`), kiosk (`/kiosk/[token]`), operator UI (`/admin`).
Method: full route inventory (176 `route.ts` handlers) cross-referenced against every `fetch()` in `app/**` and `components/**`, plus targeted reads of the mutation/refresh/catch paths.

Everything on the round-1 known-list is deliberately excluded. `UNVERIFIED` marks anything I could not prove by reading code.

*(Section 0 headline truths are written last — see below.)*

## 0. HEADLINE TRUTHS (NEW only)

1. **`/dashboard/payments` has no server-side role gate at all, and its own header comment says it does.** The file is `"use client"` with no `requireRole`; the only gate is the layout's `requireStaff()` (`app/dashboard/layout.tsx:24`). `app/dashboard/payments/page.tsx:7-9` asserts *"Owner-only route; the API enforces requireOwner() so any direct URL hit by non-owners gets a redirect from the server."* Neither half is true. Any coach/admin who types the URL gets the full Payments hub — PageHeader, "Record payment" button, dispute panel, CSV export link — and then an unexplained "Couldn't load payments — tap to retry".

2. **Two payment route handlers gate with the page-route helper the codebase forbids by name.** `app/api/payments/chase/route.ts:11,26` and `app/api/payments/outstanding/route.ts:11,15` both `import { requireOwner } from "@/lib/authz"` and call it. `lib/api-authz.ts:6-24` is a 50-line comment explaining that this produces a 307 to `/login`, that `fetch()` follows it, that `res.json()` then throws on the leading `<`, and that "the UI renders an empty state … when the truth is that their session expired". Every other route migrated; these two did not.

3. **Removing a staff member never ends their session, while the confirm dialog promises it does.** `components/dashboard/SettingsPage.tsx:957` — *"They will lose access to this gym's dashboard immediately."* `app/api/staff/[id]/route.ts:154-158` is a hard `user.deleteMany` — no `sessionVersion` bump is possible, the row is gone. `auth.ts:686-689` then reads `currentVersion` as `undefined` for a missing user and the guard is `if (currentVersion !== undefined && currentVersion !== token.sessionVersion) return null`, so the check is **skipped** and `sessionVersionCheckedAt` is refreshed. A fired coach keeps a working dashboard JWT for the remaining 30-day `maxAge` (`auth.ts:123`).

4. **The member shop declares "Order Placed!" from a URL query parameter.** `app/member/shop/page.tsx:74-78`: `if (url.searchParams.get("success")) setOrderSuccess({ ref: "Stripe payment", total: 0 })`. No order lookup, no session check, no reference from the server. The success screen (`:139-149`) then says *"Please show this to staff at the front desk to collect your items."* Visiting `/member/shop?success=1` by hand produces the identical screen.

5. **Orders are a complete server capability with zero staff UI.** `app/api/member/checkout/route.ts:101-126` mints `ORD-…` refs and persists `Order` rows for the pay-at-desk path; `app/api/orders/[id]/mark-paid/route.ts` exists. Grep across `components/dashboard/**` and `app/dashboard/**` finds **no** orders list, no order lookup, and no call to `mark-paid`. The member is told to show a reference to staff who have no screen on which to find it.

6. **An API failure crashes the Mark Attendance screen instead of erroring.** `components/dashboard/AdminCheckin.tsx:237-239` does `const data = await res.json(); setMembers(data);` with no `res.ok` check. `/api/checkin/members` answers 401/403/400/404 with `{ error }` (`app/api/checkin/members/route.ts:12,18,22,57`). `members` then holds an object, and `members.filter(...)` at `:265` and `:268` throws `TypeError: members.filter is not a function` during render.

7. **The kiosk has no error state for name search, and its 300 ms auto-fire is not cancelled when the query changes.** `components/kiosk/KioskPage.tsx:133-140` — `if (res.ok) setMatches(...)`, `catch { /* ignore — show no matches */ }`; the only render branch is `:422-423` *"No match yet — keep typing."* A 500, a revoked kiosk token or an offline iPad all tell a registered member they are not on the list. Separately, the auto-fire effect (`:145-157`) depends on `[matches, step]` only — `query` is excluded via `eslint-disable` — so a pending 300 ms timer keeps pointing at the previous single match while the member is still typing.

8. **"Kiosk disabled" is what a manager/admin always sees, and what everyone sees after any error.** `components/dashboard/KioskPanel.tsx:40-49` maps both a non-ok response and a thrown fetch to `setStatus({ enabled: false, issuedAt: null })`. `/api/settings/kiosk` GET is **owner-only** (`app/api/settings/kiosk/route.ts:128-130`), yet `AdminCheckin.tsx:317` renders `KioskPanel` on `/dashboard/checkin`, a page open to `["owner","manager","admin"]` (`app/dashboard/checkin/page.tsx:111`). Every manager and admin therefore reads *"Kiosk disabled · ask the owner to manage"* on a live kiosk.

9. **"Generated undefined instances for next 4 weeks", as a success toast.** `components/dashboard/TimetableManager.tsx:1092-1099` fires `/api/instances/generate` and reads `d.created` with no `res.ok` check. The sibling handler 30 lines above (`:1055-1058`) carries the comment *"Without the res.ok check above, a 200-with-error-body rendered 'Generated undefined class instances'"* — the fix was applied to one call site and not the other.

10. **The operator console reports 2FA as enabled when it cannot tell.** `app/admin/security/SecurityClient.tsx:22-28`: on any non-ok response it sets `{ loading: false, alreadyEnabled: true }`. A super-admin whose TOTP is *not* enrolled is shown the already-protected state after a 500.

11. **Owner onboarding advances on failure, including the final "you're done".** `components/onboarding/OwnerOnboardingWizard.tsx:555-557` — the whole `next()` body is wrapped in `try { … } catch { setStep((s) => s + 1); }`. Every `/api/settings` PATCH in it is `.catch(() => {})` (`:526`, `:534`, `:551`) with no `res.ok` check, and step 9's `onboardingCompleted: true` write (`:546-551`) is followed unconditionally by `setStep(FINAL_STEP)`. The celebration screen renders whether or not the tenant was ever marked onboarded — and `app/dashboard/layout.tsx:33` will bounce them straight back into the wizard on the next visit.

12. **Four more surfaces still turn an HTTP error into an empty or negative state** (UI-RULES §7): `components/dashboard/InitiativesPanel.tsx:54-59` → "No initiatives yet"; `components/dashboard/IntegrationsTab.tsx:41-51` → "Google Drive not connected"; `components/dashboard/IntegrationsTab.tsx:93-102` → an empty folder picker; `components/dashboard/ClassPacksManager.tsx:43-46` → "No class packs yet"; `components/dashboard/SettingsPage.tsx:673-683` → a blank 2FA QR code with no error.

