# MatFlow — Functions Index

A doc-per-feature catalogue. Every entry follows the same structure: **Status → Purpose → Surfaces → Data model → API routes → Flows → Security → Known limitations → Test coverage → Files**. Modelled on [waiver-system.md](waiver-system.md), the exemplar.

64 docs. Use Cmd/Ctrl+F.

---

## Auth & Session

| Doc | What it covers |
|---|---|
| [login-credentials.md](login-credentials.md) | Email + password sign-in (bcrypt 12 rounds, constant-time DUMMY_HASH defense) |
| [magic-link.md](magic-link.md) | Passwordless sign-in via HMAC-signed email tokens |
| [forgot-password.md](forgot-password.md) | Reset-code email flow + rate-limited verification |
| [accept-invite.md](accept-invite.md) | Staff/member invite acceptance via signed token landing at `/login/accept-invite` |
| [totp-2fa.md](totp-2fa.md) | TOTP enrolment + login gate via otplib + encrypted secret |
| [sign-out.md](sign-out.md) | Session destruction + cookie clearing |
| [session-version-rotation.md](session-version-rotation.md) | Forced sign-out via `User.sessionVersion` bump (stateless JWT revocation) |
| [session-and-cookies.md](session-and-cookies.md) | NextAuth JWT strategy, 30-day maxAge, cookie config |

## Owner Dashboard

| Doc | What it covers |
|---|---|
| [dashboard-home.md](dashboard-home.md) | Owner landing — KPI tiles, To-Do panel, today's overview |
| [todays-register.md](todays-register.md) | Live class roster for today with check-in counts |
| [timetable-management.md](timetable-management.md) | Class CRUD + schedule grid (now `min-w-[980px]`) |
| [members-list.md](members-list.md) | Searchable member table with bulk actions |
| [member-detail.md](member-detail.md) | Per-member profile (waiver, attendance, subscriptions, family) |
| [attendance-log.md](attendance-log.md) | All historical AttendanceRecord rows with filters |
| [admin-checkin.md](admin-checkin.md) | Coach-driven check-in tool for /admin |
| [ranks-management.md](ranks-management.md) | Per-discipline rank systems + bulk assignment |
| [announcements.md](announcements.md) | Owner-authored member-facing notices |
| [owner-reports.md](owner-reports.md) | Reports tab — initiatives + AI monthly report |
| [memberships-tiers.md](memberships-tiers.md) | Membership tier CRUD + Stripe Price sync |
| [owner-analysis.md](owner-analysis.md) | Analysis tab — engagement %, churn, attendance trends with initiatives overlay |

## Settings

| Doc | What it covers |
|---|---|
| [settings-overview.md](settings-overview.md) | Tab structure + saved-state UX |
| [settings-branding.md](settings-branding.md) | Logo, colours (live-preview), per-tenant theme |
| [settings-revenue.md](settings-revenue.md) | Stripe Connect, BACS toggle, membership/class-pack catalogues |
| [settings-store.md](settings-store.md) | Product CRUD (B9) — name, price, category, in-stock toggle |
| [settings-staff.md](settings-staff.md) | Staff invite + role management |
| [settings-account.md](settings-account.md) | Owner profile, password, 2FA, CSV import entry point |
| [settings-waiver.md](settings-waiver.md) | Waiver text editor + version bump |
| [settings-integrations.md](settings-integrations.md) | Google Drive connect/disconnect, future integrations |

## Member Portal

| Doc | What it covers |
|---|---|
| [member-home.md](member-home.md) | Member landing — next class, upcoming, alerts |
| [member-schedule.md](member-schedule.md) | Browse + subscribe to classes |
| [member-progress.md](member-progress.md) | Attendance counts, rank progress, streak tracking |
| [member-profile.md](member-profile.md) | Self-service profile edits, waiver re-sign, payment status |
| [member-shop.md](member-shop.md) | Product grid → cart → checkout (pay-at-desk OR Stripe) |
| [member-family.md](member-family.md) | Parent ↔ child linking, supervised waivers for minors |
| [member-onboarding.md](member-onboarding.md) | Post-invite step-by-step (profile → emergency contact → waiver) |
| [member-class-pack-purchase.md](member-class-pack-purchase.md) | Buy a class pack via Stripe checkout |

## Payments & Stripe

| Doc | What it covers |
|---|---|
| [payments-ledger.md](payments-ledger.md) | Payment table, mark-paid endpoint, manual cash payments |
| [stripe-connect-onboarding.md](stripe-connect-onboarding.md) | Connect Standard onboarding for gyms |
| [stripe-subscriptions.md](stripe-subscriptions.md) | Subscription creation tied to MembershipTier |
| [stripe-portal.md](stripe-portal.md) | Customer Portal session for member self-billing |
| [stripe-webhook.md](stripe-webhook.md) | Single endpoint, 14+ event handlers, StripeEvent idempotency |
| [refunds-disputes.md](refunds-disputes.md) | Refund route + chargeback (Dispute) webhook handling |
| [bacs-direct-debit.md](bacs-direct-debit.md) | UK Direct Debit support — `payment_intent.processing` + mandate.updated |

## Shop & Orders

| Doc | What it covers |
|---|---|
| [orders-pay-at-desk.md](orders-pay-at-desk.md) | LB-001 — Order persistence + idempotent mark-paid |
| [orders-stripe-checkout.md](orders-stripe-checkout.md) | Stripe Checkout branch — `shop_order` webhook flips status |
| [products-catalogue.md](products-catalogue.md) | Product table — soft-delete, CHECK on category, price authority for checkout |
| [class-packs-catalogue.md](class-packs-catalogue.md) | ClassPack catalogue — Stripe Product+Price proactively created |
| [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md) | Buy → atomic webhook → credit burn on attendance |

## Operations

| Doc | What it covers |
|---|---|
| [audit-log.md](audit-log.md) | logAudit() helper + owner-only read API with cursor pagination |
| [csv-importer.md](csv-importer.md) | Header-mapped member/rank/tier import with all-or-nothing transaction |
| [google-drive.md](google-drive.md) | OAuth + folder-scoped indexer, encrypted tokens, single-flight refresh |
| [ai-monthly-report.md](ai-monthly-report.md) | Claude Haiku 4.5 causal analysis grounded on tenant DB + Drive |
| [initiatives.md](initiatives.md) | Timeline log of business events feeding chart overlays + AI prompt |
| [apply-form.md](apply-form.md) | B10 — public lead capture with rate limit + DB persistence + 2 emails |
| [legal-pages.md](legal-pages.md) | Public terms / privacy / AUP / subprocessors |

## Infrastructure

| Doc | What it covers |
|---|---|
| [multi-tenant-isolation.md](multi-tenant-isolation.md) | The four layers — schema / session / API helpers / DB constraints |
| [rate-limiting.md](rate-limiting.md) | DB-backed sliding window with in-memory fallback + 5% prune |
| [csp-and-security-headers.md](csp-and-security-headers.md) | CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy |
| [pwa-manifest.md](pwa-manifest.md) | `/manifest.webmanifest` — install, icons, no service worker yet |
| [proxy-middleware.md](proxy-middleware.md) | NextAuth-wrapped middleware — auth gate, TOTP routing, member↔staff split |
| [jwt-brand-refresh.md](jwt-brand-refresh.md) | LB-004 — 5-min throttled re-fetch of tenant branding into JWT |
| [encryption-secrets.md](encryption-secrets.md) | AES-256-GCM helpers + secrets inventory + rotation procedure |
| [database-migrations.md](database-migrations.md) | Prisma Migrate workflow + NOT VALID + VALIDATE pattern |

## Top-level Cross-cutting

| Doc | What it covers |
|---|---|
| [waiver-system.md](waiver-system.md) | Exemplar — waiver text + signature + version, supervised + self-sign |

---

## How these docs are organised

Every doc has the same shape so you can scan quickly:

1. **Status badge** — green (✅ Working), yellow (⚠️ Partial), red (❌ Missing)
2. **Purpose** — one paragraph, why this exists
3. **Surfaces** — where it shows up in the UI / URL paths
4. **Data model** — Prisma snippets for the affected models
5. **API routes** — endpoint inventory with payload shape
6. **End-to-end flows** — step-by-step for the main scenarios
7. **Security** — control matrix
8. **Known limitations** — explicit gaps so future-you doesn't relearn them
9. **Test coverage** — what's tested and what isn't
10. **Files** — file inventory with cross-links

When adding a new feature, copy [waiver-system.md](waiver-system.md), keep the structure, and link from this index.

## When docs go stale

These docs reflect the codebase at a point in time. They will go stale. The convention:

- File paths are clickable — cross-check against current state
- Status badges are accurate at write time, not perpetually
- "Known limitations" age slowest — they tend to remain accurate longest
- A failing test or a code change that contradicts a doc → update the doc in the same PR
