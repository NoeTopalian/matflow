# MatFlow — Page Documentation Index

All 29 user-facing pages documented. One row per page: route, doc link, purpose, status.

---

## Public

| Route | Doc | Purpose | Status |
|---|---|---|---|
| `/` | [root.md](public/root.md) | Root entry — redirects to `/dashboard` | ✅ |
| `/login` | [login.md](public/login.md) | Three-step auth: club code → email/pw → forgot/reset | ✅ |
| `/login/totp` | [login-totp.md](public/login-totp.md) | TOTP 2FA verification step | ✅ |
| `/apply` | [apply.md](public/apply.md) | Public gym-owner membership application form | ✅ |
| `/preview` | [preview.md](public/preview.md) | Interactive branding preview (static demo, no auth) | ✅ |

---

## Legal

| Route | Doc | Purpose | Status |
|---|---|---|---|
| `/legal/terms` | [terms.md](legal/terms.md) | Platform Terms of Service | ✅ |
| `/legal/privacy` | [privacy.md](legal/privacy.md) | Privacy Policy (UK GDPR) | ✅ |
| `/legal/aup` | [aup.md](legal/aup.md) | Acceptable Use Policy | ✅ |
| `/legal/subprocessors` | [subprocessors.md](legal/subprocessors.md) | Third-party sub-processor list | ✅ |

---

## Onboarding

| Route | Doc | Purpose | Status |
|---|---|---|---|
| `/onboarding` | [owner-wizard.md](onboarding/owner-wizard.md) | 6-step owner setup wizard (owner only) | ✅ |

---

## Dashboard

| Route | Doc | Purpose | Status |
|---|---|---|---|
| `/dashboard` | [home.md](dashboard/home.md) | Owner/staff home — 8 stat cards + weekly calendar | ✅ |
| `/dashboard/members` | [members.md](dashboard/members.md) | Paginated member list with filter query-param support | ✅ |
| `/dashboard/members/[id]` | [members-id.md](dashboard/members-id.md) | Member profile + payments + ranks + attendance | ✅ |
| `/dashboard/timetable` | [timetable.md](dashboard/timetable.md) | Class CRUD + recurring schedules + instance generation | ✅ |
| `/dashboard/checkin` | [checkin.md](dashboard/checkin.md) | Admin check-in (owner/manager/admin, coaches excluded) | ✅ |
| `/dashboard/coach` | [coach.md](dashboard/coach.md) | Coach register — today's classes for this coach | ✅ |
| `/dashboard/attendance` | [attendance.md](dashboard/attendance.md) | Read-only attendance ledger (last 100 records) | ✅ |
| `/dashboard/notifications` | [notifications.md](dashboard/notifications.md) | Gym announcements CRUD (owner/manager only) | ✅ |
| `/dashboard/ranks` | [ranks.md](dashboard/ranks.md) | Rank templates CRUD (owner/manager/coach, admin excluded) | ✅ |
| `/dashboard/reports` | [reports.md](dashboard/reports.md) | Analytics + AI monthly report (owner/manager only) | ⚠️ |
| `/dashboard/analysis` | [analysis.md](dashboard/analysis.md) | Deep insights — 6-month trends (owner only) | ✅ |
| `/dashboard/settings` | [settings.md](dashboard/settings.md) | Tenant config — branding, staff, Stripe, TOTP (owner only) | ⚠️ |

---

## Member

| Route | Doc | Purpose | Status |
|---|---|---|---|
| `/member` | [root.md](member/root.md) | Member section entry — redirects to `/member/home` | ✅ |
| `/member/home` | [home.md](member/home.md) | Member dashboard + 7-step onboarding modal | ✅ |
| `/member/schedule` | [schedule.md](member/schedule.md) | Swipeable weekly class timetable | ✅ |
| `/member/profile` | [profile.md](member/profile.md) | Member self-service profile, billing, journey | ⚠️ |
| `/member/progress` | [progress.md](member/progress.md) | Belt card, attendance stats, subscribed classes | ✅ |
| `/member/shop` | [shop.md](member/shop.md) | Club merchandise store with cart + checkout | ⚠️ |
| `/member/purchase/pack/[id]` | [purchase-pack-id.md](member/purchase-pack-id.md) | Purchase a specific class pack | ⚠️ |

---

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ | Fully working |
| ⚠️ | Partially working — see the page doc for details |
| ❌ | Blocked — not applicable to current pages |
