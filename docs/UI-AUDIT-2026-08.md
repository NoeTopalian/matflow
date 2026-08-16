# UI Interaction Audit — 2026-08-16

**Scope:** every menu and button, present and working, on mobile (375px/Pixel 5) and desktop (1280–1440px), across all five surfaces.
**Method:** two static wiring sweeps (staff+admin, member+kiosk+public — every `<button>`, `Link`, `router.push`, form and breakpoint wrapper enumerated and cross-checked against routes and API guards) + a Playwright runtime click-through matrix (`tests/e2e/ui-audit-staff.spec.ts`, `tests/e2e/member/ui-audit-member.spec.ts`) run at both viewports as seeded owner and member against the Neon test branch (never prod — the spec hard-refuses `ep-bold-wave`).

## Verdict

**97 findings total** (26 staff/admin + 71 member/kiosk/public). **All 26 BROKEN-tier defects are fixed** in this pass, plus the highest-value MISSING items. What remains is logged below as follow-up, none of it blocking: no dead button, no 404 target, no unreachable menu remains on any surface at either viewport.

Healthy foundations confirmed by the audit: zero `href="#"`, zero 404 navigation targets, zero classic dead buttons (`onClick={()=>{}}` etc. — the one stub found was decorative), complete Sidebar↔MobileNav parity from the shared `STAFF_NAV` manifest, coherent z-index stack on both shells, centralised bottom-nav clearance, all public forms Enter-submittable, and all 7 purchase/billing controls wired to real endpoints.

## BROKEN defects fixed (by surface)

### Staff dashboard
- **GDPR page was orphaned** — `/dashboard/members/[id]/dsar` had zero inbound links; now linked from the member profile "More actions" menu (owner-only).
- **Payments-page "Refund" dead end** — linked `?tab=payments` which the profile ignored, and that tab has no refund control. The profile now honours `?tab=` deep links; the action is relabelled "View payments" until the refund modal moves out of Settings → Revenue.
- **Five role-gate mismatches** silently 403ing: waiver-link share (coach/admin), Record payment + Mark-paid drawer (admin), timetable empty-state "Add Class" (coach/admin), "Generate this week's classes" (admin — which also swallowed failures; it now checks `res.ok` and toasts), and dashboard Check-In CTAs shown to coach (who the page guard bounces). All now gated to the roles their APIs accept.
- **Impersonation banner covered the top bar** (fixed → sticky, occupies flow).
- **Dashboard class pills looked clickable but weren't**, and their per-class "Check in" shortcut was hidden below 640px — link now visible on all viewports (role-gated), false cursor affordance removed; timetable grid cells disabled (not fake-clickable) for coach/admin.
- **MobileNav didn't normalise the role** ("Owner" → empty bottom nav) and offered no session revocation — both fixed; "Sign out all devices" added to the More sheet.
- Photos "Remove" was hover-only (untappable on touch) — always visible on mobile now. Both profile drawers gained safe-area padding. Topbar titles added for the 4 routes that fell back to "Dashboard". Kid accounts no longer see "Send login invite" (missing `accountType` in the page query).
- ~20 nameless icon buttons (rank reorder/edit/delete, timetable actions, week arrows, colour swatches, drawer closes, announcement delete) gained `aria-label`s; hover-reveal controls also reveal on keyboard focus.

### Admin console
- **`AdminTopNav` now renders on all 7 pages** — previously 1 of 7; Billing was unreachable from four pages, Sign out missing from four, three duplicate logout implementations deleted, "Tenants"/"Customers" label drift gone, nav wraps at 375px.
- The dashboard's "Failed payments (7d)" deep link works — `ActivityFeed` now reads `?action=` from the URL.

### Member portal
- **2FA enrolment was entirely dead** — both "Set up" CTAs drove staff-only endpoints that 401 members while the member API mirror sat uncalled. `TotpEnrollmentStep` now takes an `apiPrefix`; members enrol via `/api/member/totp/*` and land back on their profile (not `/dashboard`).
- **Class subscribe rolled back silently on failure** — now toasts; the "reminder 1 hour before" promise (no scheduler exists) replaced with honest copy.
- **Purchase-pack page had a disabled-forever primary CTA** when the gym has no Stripe — replaced with an explanation + way back. **Billing contact box could render a colon followed by nothing** — actionable copy either way now.
- Onboarding waiver checkbox is a real focusable input (label tap works); the fabricated "yearly class count %" (hardcoded ÷150) replaced with the real count; kid-billing card's invisible light-theme tokens on the dark shell fixed; schedule day-grid uses `dvh`.

### Onboarding wizard
- **Steps 7–9 had no Back button** (header was gated `step < 7`) — header now shows throughout.
- **Nested `<button>`-in-`<button>` markup** on the Stripe and white-glove cards (invalid HTML, unreliable touch targets around the file input/textarea) — outer cards are keyboard-accessible `role="button"` divs.

### Kiosk
- **Long class lists were unscrollable** (flex-centred overflow loses its top edge) — scroll container + auto-margin centring; `100dvh` + safe-area so browser chrome/home indicator don't overlap controls; the error screen gained a manual "Try again" (previously only a timer that dies when the tab backgrounds).

### Landing
- "Apply" vanished below 640px with no mobile menu — now visible at all widths.

## Runtime matrix

`npm run test:e2e -- ui-audit` equivalent: `npx playwright test ui-audit --project=chromium --project="Mobile Chrome owner" --project=chromium-member --project="Mobile Chrome member"`. Asserts per route × viewport: renders (<400, visible content), zero console/page errors, no horizontal overflow on mobile, every nav item present in the correct viewport's navigation and navigating, accessible names on all visible controls, last control not obscured by fixed bars, switch geometry exactly 40×22, no fabricated identities, honest pre-fetch shell. Full-page screenshots land in `test-results/ui-audit/` for eyeball review.

## Follow-ups logged (not blocking, in priority order)

1. Member portal desktop shell: no max-width anywhere (`app/member/layout.tsx` main + tab bar) — full-bleed at 1440px; constrain per UI-RULES §4 when the member desktop experience matters.
2. `/dashboard` payments tables (page + Settings `PaymentsTable`) have no mobile card variant — horizontal scroll only; DataTable primitive work.
3. Recovery-code entry has no UI anywhere (`/api/*/totp/recover` uncalled) — a member/staff who loses their authenticator still needs support.
4. Enter-to-submit missing on drawer-style editors (house pattern) and member profile/child modals; adopt `<form>` wrapping with the Input primitive rollout.
5. Landing has no section nav (the `#pricing`/`#apply` ids are orphans); reset-password step has no Back; apply-page Back goes to `/login` not `/`.
6. Settings branding phone-preview is `hidden lg:flex` — no preview below 1024px.
7. Shop: `PAY_AT_DESK` is build-time not per-tenant (mislabels the CTA), fruit-Apple icon on the pay button, post-Stripe success copy says "show this at the front desk".
8. Kiosk on landscape iPad is a narrow 448px column — layout under-uses the primary form factor.
9. Suspect-tier items from both reports (ActivityFeed dead chevron state, FamilySection menu outside-click, ClassPacksWidget stuck `buying` state, `--member-primary` undefined fallback, etc.) — sweep opportunistically under the boy-scout rule.

Full evidence with file:line for every finding: the two static reports are preserved in the session scratchpad; the plan is at `C:\Users\NoeTo\.claude\plans\can-you-thoroughly-assess-concurrent-lerdorf.md`.
