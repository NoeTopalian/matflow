# MatFlow App Improvement Audit

Audit date: 2026-04-26  
Backup created first: `C:\Users\NoeTo\Desktop\matflow-backup-20260426-025051`

## Executive Summary

MatFlow already has a strong product shape: a tenant-based gym dashboard, member mobile app, QR check-in, onboarding, Stripe Connect, reports, and owner settings. The biggest opportunity is to make the owner backend feel more like a calm operating system for a gym: denser, clearer, more consistent, and more trustworthy.

The current UI has good energy, but it often duplicates identity elements, mixes light and dark styling assumptions, and uses large cards where owners need fast scanning. The current code also has a few important hardening items around route guards, public endpoints, file upload, local storage, and generated HTML rendering.

Priority order:

1. Critical: security and access hardening.
2. High: owner shell/topbar redesign and settings simplification.
3. High: clarify live vs demo/prototype features.
4. Medium: member app polish, onboarding/waiver management, empty states.
5. Polish: motion, typography, density, and consistency.

## Owner Dashboard Display

### Current Issue: Top Club And Account Area

The screenshot shows the sidebar club block with a large green logo circle and the topbar with a green account circle. This creates a repeated "green circle" motif that competes for attention:

- The sidebar already establishes the active workspace: club logo, gym name, and plan.
- The topbar repeats identity with a large avatar, role pill, owner name, and sign-out icons.
- The result feels more like two brand headers stacked together than a backend control surface.
- The owner has to visually parse decorative identity before seeing operational information.

### Recommended Direction

Keep the sidebar as the workspace identity and make the topbar an operator bar.

Recommended topbar structure:

- Left: page title and optional breadcrumb, for example `Dashboard / This week`.
- Center or right: compact operational status chips, such as `Owner`, `2FA on`, `Stripe connected`, `Trial/Pro`.
- Right: single account menu button with initials, name hidden or reduced, and a dropdown for profile, security, logout, logout all devices.
- Remove the separate role pill plus big avatar plus name row. Combine them into one compact account control.
- Use the green primary color for action and active state, not for every identity surface.

Recommended sidebar structure:

- Keep club logo and gym name there only.
- Make the plan badge quieter, for example a small text chip aligned under the gym name.
- Add a small "Workspace" label or dropdown only if multi-gym switching will exist.

### Better Owner Backend Feel

The owner backend should feel like a daily cockpit:

- Less hero sizing; more dense, scannable information.
- Prioritize "what needs attention" over decorative cards.
- Use smaller stat cards with trend/context: active members, overdue payments, unsigned waivers, low attendance, full classes.
- Add a "Today" strip near the top: next classes, expected attendance, quick check-in link.
- Group destructive/security actions behind explicit menus rather than visible icon-only buttons.

## Whole-Site UX Improvements

### Visual Consistency

The app has a strong dark-dashboard design, but the implementation mixes token systems:

- `app/globals.css` defines dark MatFlow tokens.
- `app/dashboard/layout.tsx` overrides many tokens with a light theme.
- Many components still hard-code `text-white`, `text-gray-*`, `rgba(0,0,0,...)`, and dark assumptions.

This creates inconsistent contrast and makes future theme changes fragile.

Recommended fixes:

- Pick one admin dashboard theme for v1 and make all dashboard components use `--sf-*`, `--tx-*`, and `--bd-*` tokens.
- Replace component-level hard-coded text colors with token-based styles.
- Add reusable primitives for page headers, stat cards, tables, drawers, empty states, and confirmation dialogs.
- Avoid nested card-heavy layouts in operational screens; use panels, tables, lists, and compact sections.

### Dashboard Satisfaction

Owners should get immediate confidence that the gym is under control.

Add or improve:

- "Needs attention" module: overdue members, unsigned waivers, low attendance members, classes near capacity, pending onboarding.
- Today timeline: classes, check-ins, attendance progress, quick actions.
- Better stat cards: show direction, period, and why it matters, not only large numbers.
- Quick action grouping: Add Member, Add Class, Check-In, Announcement.
- Keyboard/search first workflows for members and check-in.

### Settings Page

`components/dashboard/SettingsPage.tsx` is too large and mixes unrelated domains:

- Branding.
- Revenue and Stripe.
- Store prototype.
- Staff management.
- Account/security.
- TOTP drawers.
- Product drawers.
- Plan drawers.

Recommended structure:

- Split each tab into its own component.
- Move shared drawer/form components into small local files.
- Keep `SettingsPage.tsx` as tab state and orchestration only.
- Add query-param tab support so `/dashboard/settings?tab=revenue` opens the correct tab after Stripe callbacks.
- Add clear "live" vs "sample" labels for revenue chart and store data.

### Store And Revenue Clarity

The owner Store tab uses local state, while the member shop uses `lib/products.ts`. This will confuse owners because changes in Settings do not affect member-facing products.

Recommended fixes:

- Mark current Store tab as prototype, or remove editing controls until products persist.
- Add a real `Product` model and tenant-scoped product API before presenting it as editable.
- Use Stripe connection status to show what payments can actually do today.
- Replace demo revenue chart with an explicit empty/live state.

### Member App Experience

The member app is visually strong and mobile-focused. Improvements:

- Reduce dependence on local storage for authoritative branding.
- Show onboarding only when the server says it is incomplete, not just local storage.
- Make waiver and health steps feel trustworthy: explain privacy, show who can view data, and make completion status visible in profile.
- Add friendly loading and offline states around schedule, announcements, and check-in.
- Make member shop products tenant-scoped before offering it to real gyms.

## Security And Code Risk Findings

### Critical: Dashboard Page-Level Role Guards

`app/dashboard/layout.tsx` only checks that a session exists. It does not block `member` users from the dashboard layout. Some dashboard pages rely on hidden navigation or API guards rather than page-level access.

Recommended fixes:

- Redirect `member` users away from `/dashboard` to `/member/home`.
- Add page-level role guards for owner-only pages like settings and analysis.
- Add page-level guards for manager/admin/coach permissions to mirror API rules.
- Keep API guards as the final source of truth, but do not expose dashboard pages to the wrong roles.

### Critical: Public Lookup And QR Check-In Abuse Controls

`/api/members/lookup` is intentionally public for QR check-in and returns minimal data, but it can be scraped by tenant slug and query. QR check-in also permits unauthenticated attendance creation when tenant, member, and class instance IDs are known.

Recommended fixes:

- Add rate limiting by IP plus tenant slug.
- Require a minimum query length of 3 or 4 characters.
- Return generic empty responses for invalid tenants where possible.
- Add short-lived QR/session token support for public check-in pages.
- Audit check-in method rules so unauthenticated calls can only use `qr`.

### High: Branding Upload Persistence Bug

In `SettingsPage.tsx`, uploaded files are sent to `/api/upload`, which returns a Vercel Blob HTTPS URL. The settings PATCH only saves `logoUrl` when it starts with `/`, otherwise it sends `null`.

Impact:

- Uploaded logos may work in local storage preview but not persist correctly to the tenant record.
- Other devices/users may not see the updated logo.

Recommended fix:

- Persist trusted HTTPS blob URLs returned by `/api/upload`.
- Keep local base64 only as a preview, never as the final cross-device source of truth.

### High: `localStorage` During Initial Render

`SettingsPage.tsx` reads `localStorage` while initializing state. In a client component this often works after hydration, but it can still create fragility and makes server/client behavior harder to reason about.

Recommended fix:

- Initialize from server props.
- In `useEffect`, merge local demo overrides only when needed.
- Prefer DB/API values for real tenants.

### High: Unsafe HTML Rendering In Analysis

`components/dashboard/AnalysisView.tsx` uses `dangerouslySetInnerHTML` to render generated report markdown-like content. Even if the current report is locally generated, this pattern is risky if answers, AI text, or imported content become less controlled.

Recommended fix:

- Replace with a safe markdown renderer or a tiny renderer that escapes all text and only maps supported markdown tokens to React nodes.
- Do not pass user-provided content through raw HTML.

### High: File Upload Hardening

`/api/upload` allows SVG uploads. SVG can carry script-like content depending on serving and browser behavior.

Recommended fixes:

- Prefer disallowing SVG uploads for tenant logos and announcements.
- If SVG is required, sanitize it and serve with safe content disposition/headers.
- Store image metadata and validate dimensions where practical.

### High: CSP Relaxation

`next.config.ts` currently allows `script-src 'unsafe-inline' 'unsafe-eval'`. This weakens XSS protection.

Recommended fixes:

- Remove `unsafe-eval` in production if possible.
- Move toward nonce/hash-based scripts.
- Keep a development-only exception if needed.

### High: Password Reset Verification Rate Limit

Forgot-password requests are rate-limited, but reset-code verification should also be rate-limited by email, tenant, and IP.

Recommended fixes:

- Add rate limiting to `/api/auth/reset-password`.
- Consider storing hashed reset tokens rather than plaintext 6-digit codes.
- Invalidate sessions after password reset by incrementing `sessionVersion`.

### Medium: TOTP Setup And Disable Rate Limits

TOTP login verification is rate-limited, but setup and disable endpoints should also be protected.

Recommended fixes:

- Rate-limit setup confirmation and disable attempts.
- Consider requiring password re-entry before disabling 2FA.
- Show security status in the owner account menu.

### Medium: Stripe Webhook Idempotency

Stripe webhook signatures are verified, which is good. The next step is idempotency and stronger event handling.

Recommended fixes:

- Store processed Stripe event IDs to prevent replay/duplicate processing.
- Ignore events for unknown connected accounts.
- Validate event object shape before update logic.
- Add tests for duplicate webhook delivery.

### Medium: Staff Invite Flow

The staff creation API intentionally does not return a temporary password. The Settings UI still has a branch expecting `temporaryPassword`.

Recommended fixes:

- Replace temporary password UX with a proper invite or reset-email flow.
- Add "Copy invite link" only if invite tokens are implemented.
- Remove misleading temporary credential display.

### Medium: Apply Form Abuse

`/api/apply` accepts public submissions and logs a message.

Recommended fixes:

- Add zod validation.
- Add rate limiting.
- Add spam controls.
- Decide whether the endpoint stores leads or emails support.

## Waiver Management Recommendations

Source reviewed: `C:\Users\NoeTo\.claude\plans\todo\waiver-management.md`.

The current member onboarding waiver is hardcoded in `app/member/home/page.tsx`. Every tenant sees the same generic liability waiver, and owners cannot customize it.

Recommended v1 waiver management:

- Add tenant-level `waiverTitle` and `waiverContent`.
- Add a default waiver constant in `lib/default-waiver.ts`.
- Add a Settings "Waiver" tab where owners can preview, edit, save, and reset to default.
- Add `GET /api/waiver` so member onboarding fetches the live tenant waiver.
- Replace the hardcoded step 7 waiver text with fetched waiver content.

Important future hardening:

- Store the exact waiver title/content/version accepted by each member.
- Store typed signer name.
- Store acceptance timestamp and IP, already partly implemented.
- Add re-sign workflows when a waiver changes.
- Add owner reporting for unsigned members.
- Add legal review note: MatFlow should not present generic waiver copy as legally sufficient for every gym.

## Suggested Implementation Roadmap

### Phase 1: Safety And Trust

- Add dashboard member-role redirect and page-level role guards.
- Add rate limits to public lookup, QR check-in, apply, reset-password verification, and TOTP setup/disable.
- Remove or replace `dangerouslySetInnerHTML`.
- Fix branding logo persistence.
- Clarify live vs demo Store and Revenue states.

### Phase 2: Owner Backend Redesign

- Redesign topbar/sidebar identity model.
- Create reusable admin shell components.
- Tighten dashboard density and hierarchy.
- Add "Needs attention" and "Today" owner modules.
- Replace browser `confirm`/`alert` with consistent confirmation dialogs and toasts.

### Phase 3: Settings And Waiver

- Split `SettingsPage.tsx` into tab components.
- Add query-param tab handling.
- Implement the waiver management plan.
- Replace staff temporary-password UI with invite/reset flow.

### Phase 4: Product Maturity

- Persist Store products per tenant or mark Store as coming soon.
- Make revenue analytics webhook-driven and idempotent.
- Add audit logging for sensitive owner actions.
- Add accessibility and contrast pass across dashboard and member app.

## Acceptance Checklist

- Owner topbar no longer duplicates sidebar identity.
- Owners can see what needs attention within 5 seconds of landing on Dashboard.
- Wrong-role users cannot access dashboard pages.
- Public endpoints have explicit abuse controls.
- Branding changes persist across devices.
- Generated/report text is rendered safely.
- Store and Revenue clearly indicate whether data is live or sample.
- Waiver content is tenant-customizable before real gym rollout.
- Settings is split into maintainable components.

