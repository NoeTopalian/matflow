# MatFlow — Comprehensive Release Plan (2026-05-03)

> Living document. Update commit SHAs + checkbox states as work lands.
> Successor to `docs/FIX-PLAN-2026-04-30.md` and `docs/AUDIT-2026-04-27.md`.

## Executive summary

**Status: not ready for multi-tenant production. Currently shippable as a single-tenant dogfooding deploy only.**

The product is feature-complete for the gym-owner happy path (apply → onboard → invite members → take payments → check members in → track ranks → analyse). Three structural gaps stop you from opening signups to N independent gyms:

1. **Row-Level Security migration is written but uncommitted** (119 files in working tree). Production currently relies on application-layer `WHERE tenantId =` filters only — one missed clause = cross-tenant leak.
2. **Application approval is manual** (`/apply` form persists rows, but you must `curl POST /api/admin/create-tenant` to actually mint a tenant). No admin UI.
3. **14 verified P0/P1 user-facing bugs from FIX-PLAN-2026-04-30** are unfixed (Forgot Password hangs, member schedule empty, member shop empty, profile fields unbound, engagement reads 2723%, etc.). The first real owner will hit these in their first hour.

Plus operational visibility is blind: Sentry wired but opt-in, no deploy alerts, rate-limit hits silent in logs, backups disabled. If something breaks at 2am you'll find out hours later from a customer.

**Realistic effort to closed-beta-ready (5 gyms): ~5 working days of focused work.**
**To open-launch (N gyms): another ~5–10 days on top.**

---

## Part 1 — What has been done

### Recent shipped commits (since 2026-05-01)

| SHA | Commit | What it gave you |
|---|---|---|
| `b4ba10e` | NEXTAUTH_URL defensive trim across 8 call-sites | Magic links + Stripe redirects no longer break if env var has trailing whitespace |
| `b79d02c` | Owner-only `/api/stripe/connect/health` diagnostic | Owner can see exactly which Stripe env vars are missing |
| `5c12acd` | Retire public QR check-in kiosk | Removed unused public route + `/api/checkin` allowlist entry; routes now require auth |
| `299edfb` | Smart auto-check-in on Mark Attendance | Type "Noe T" with one match → auto-checks after 600ms debounce |
| `a160e2c` | TESTING_MODE flag (dev-only initially) | Bypass mandatory 2FA in dev |
| `533f26b` | TESTING_MODE works in production too | User can log in to matflow.studio without 2FA right now |
| `eb042cd` | `/preview/transitions` sandbox (4 styles) | Gave you a way to A/B page transition feels |
| `36739fe` | App-wide page transitions ("Instant" style) | Every nav now softly fades in via `app/template.tsx` |
| `c5f8b57` | Members-style row design on Memberships, Promotions, Settings staff | Visual consistency across owner-facing list surfaces |

### Feature areas that are production-ready

| Area | Status | Notes |
|---|---|---|
| **Auth** (Credentials + Magic-Link + TOTP) | ✅ | TOTP enforcement currently bypassed via TESTING_MODE — flip back when ready |
| **Multi-tenant data model** | ✅ | Schema + composite uniques + every API route filters by tenantId |
| **Member CRUD + invites** | ✅ | HMAC-hashed invite tokens, accept-invite flow, password set on accept |
| **Class scheduling + recurring instances** | ✅ | TimetableManager, generation cron |
| **Mark Attendance (staff tool)** | ✅ | Plus smart auto-checkin (`299edfb`) |
| **Member self-checkin** | ✅ | `/member/home` → "Sign In to Class" sheet, gated by rank/window/coverage |
| **Stripe Connect onboarding** | ✅ | OAuth start + callback + diagnostic endpoint |
| **Stripe webhook handling** | ✅ | All major events: checkout, subscription lifecycle, invoice, dispute, refund, BACS mandate, payment_method changes. Signature-verified. Idempotent via `StripeEvent.@unique` |
| **Class pack purchase + redemption** | ✅ | Atomic credit deduction at check-in |
| **BACS Direct Debit** | ✅ | Per-tenant `acceptsBacs` toggle, mandate verification handled |
| **Soft-delete + audit log** | ✅ | `logAudit()` called from every state-mutating route (sampled) |
| **Recovery codes for TOTP** | ✅ | 8 single-use HMAC-hashed codes generated at enrolment |
| **Branding / theming** | ✅ | primaryColor + secondaryColor + logoUrl propagate to member portal |
| **Owner onboarding wizard** | ✅ | 8 steps, server-persisted, resumable |
| **Page transitions app-wide** | ✅ | `36739fe` — soft 140ms fade-in on every route |
| **Row visual consistency** | ✅ | `c5f8b57` — Memberships/Promotions/Staff match Members style |
| **Rate limiting** | ✅ | `lib/rate-limit.ts` with DB persistence + in-memory fallback |
| **Maintenance mode kill switch** | ✅ | `MAINTENANCE_MODE=true` in Vercel env returns 503 from all but auth+health |
| **Apply form (lead capture)** | ✅ | Persists `GymApplication` row, sends 2 emails (owner notification + applicant confirmation) |

### Compliance / legal pages shipped

| Page | Path | Status |
|---|---|---|
| Terms | `/legal/terms` | ✅ |
| Privacy | `/legal/privacy` | ✅ |
| AUP | `/legal/aup` | ✅ |
| Sub-processors | `/legal/subprocessors` | ✅ |

### What's in the working tree but NOT yet committed

| Item | File(s) | Why it matters |
|---|---|---|
| **Row-Level Security migration foundation** | `prisma/migrations/20260503100000_rls_policies_foundation/` | 32 `CREATE POLICY tenant_isolation` rules across all tenant-scoped tables. Not yet enforced. |
| **RLS activation migration** | `prisma/migrations/20260503200000_activate_rls_enforcement/` | `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` for all 32 tables. Needs the next migration to run after every API route is wrapped. |
| **`lib/prisma-tenant.ts`** | `lib/prisma-tenant.ts` | `withTenantContext(tenantId, fn)` sets `app.current_tenant_id` GUC transaction-locally; `withRlsBypass(fn)` for cross-tenant flows (auth resolving slug → tenant, webhooks). |
| **92 of 104 API routes refactored** | `app/api/**/route.ts` | Already wrapping queries in `withTenantContext()`. 12 remaining are intentionally cross-tenant (auth, webhooks, public). |
| **`@sentry/nextjs` added to package.json** | `package.json`, `package-lock.json` | Installed but not configured (no `SENTRY_DSN` documented yet). |
| **Misc related changes** | ~30 other files | Tenant-context propagation across helpers, lib/prisma.ts singleton tweaks, etc. |

**Net: this is a complete, well-scoped RLS migration sitting on disk uncommitted.** It's the single highest-value commit you have available right now.

---

## Part 2 — What needs to be done

### Phase 0 — Stop the bleeding (1–2 days)

Goal: get the working tree clean and the worst user-facing bugs fixed so the next owner who logs in doesn't immediately churn.

| # | Task | Severity | Estimate | Notes |
|---|---|---|---|---|
| 0.1 | Commit the RLS migration set as a single atomic commit | 🔴 P0 | 2 hours | 119 files. Includes the 3 migrations + lib/prisma-tenant.ts + 92 route wrappings. Run `npx vitest run` to ensure the test mocks are updated for `withTenantContext` (currently 111 tests fail because of stale mocks). |
| 0.2 | Update broken integration test mocks to use `withTenantContext` | 🔴 P0 | 3 hours | The 111 failing tests are mostly mocks expecting raw `prisma.X.findMany()` patterns. Update each. |
| 0.3 | Run RLS activation migration against production Postgres + verify | 🔴 P0 | 1 hour | After 0.1 ships. Run `prisma migrate deploy` then probe with `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND rowsecurity=true LIMIT 5;` — expect 25+ rows. |
| 0.4 | Fix B1: Forgot Password hang (`Sending reset code…` never clears) | 🔴 P0 | 1 hour | Per FIX-PLAN-2026-04-30.md |
| 0.5 | Fix B2: `/api/coach/today` returns yesterday's classes | 🔴 P0 | 1 hour | Per FIX-PLAN-2026-04-30.md |
| 0.6 | Fix B3: `/member/schedule` grid empty despite API returning 6 | 🔴 P0 | 2 hours | Per FIX-PLAN-2026-04-30.md |
| 0.7 | Fix B4: `/member/shop` empty despite API returning 8 | 🔴 P0 | 1 hour | Per FIX-PLAN-2026-04-30.md |
| 0.8 | Fix B5: Member profile Phone field unbound (Save would wipe value) | 🔴 P0 | 30 min | Critical data-loss bug |

### Phase 1 — Operational baseline (1 day)

Goal: if production breaks, you find out within 5 minutes with enough info to fix it.

| # | Task | Severity | Estimate | Notes |
|---|---|---|---|---|
| 1.1 | Wire Sentry into production: set `SENTRY_DSN` in Vercel env, add a smoke event | 🔴 P0 | 30 min | `sentry.client.config.ts` + `sentry.server.config.ts` already exist; just need the env var |
| 1.2 | Add `console.warn` to `lib/rate-limit.ts` so attacks surface in Sentry | 🟡 P1 | 15 min | Currently silent — invisible to ops |
| 1.3 | Configure external uptime monitor (UptimeRobot or BetterStack) polling `/api/health` once a minute, alert on 503 | 🟡 P1 | 30 min | Endpoint already exists; just configure the monitor |
| 1.4 | Add Vercel deploy-failure webhook → Slack/email | 🟡 P1 | 30 min | Vercel project settings → Notifications |
| 1.5 | Enable `db-backup.yml` GitHub workflow + provision its 4 secrets (DATABASE_URL_DIRECT, AWS_ACCESS_KEY_ID, BACKUP_S3_BUCKET, BACKUP_S3_REGION) | 🟡 P1 | 1 hour | Workflow is production-grade pg_dump → S3 with 30-day lifecycle |
| 1.6 | Add request-ID middleware (UUID per request, log on errors) | 🟡 P1 | 1 hour | Adds correlation across log lines for a single user complaint |
| 1.7 | Hard-fail boot guards for `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `MATFLOW_ADMIN_SECRET` in production | 🟡 P1 | 30 min | Currently fail at request-time only; misconfigured production ships silently |
| 1.8 | Document runbook: incident response, deploy rollback, restore-from-backup drill | 🟡 P1 | 2 hours | New `docs/RUNBOOK.md` |

### Phase 2 — Onboarding completeness (1–2 days)

Goal: new gym can sign up and get running without you running curl commands.

**Decision required from user before this phase:** *Do you want manual approval (admin UI), or auto-approval (apply directly creates tenant)?*

| # | Task (if you pick **manual approval**) | Severity | Estimate |
|---|---|---|---|
| 2A.1 | Build `/admin/applications` page (super-admin only) listing pending GymApplications with Approve / Reject buttons | 🔴 P0 | 1 day |
| 2A.2 | New `POST /api/admin/applications/[id]/approve` route — wraps existing `create-tenant` logic, sets application status, sends owner activation email | 🔴 P0 | 2 hours |
| 2A.3 | Email template for owner activation ("Your gym is approved! Click here to set your password") | 🟡 P1 | 1 hour |
| 2A.4 | Owner password-set flow on first link click | 🟡 P1 | 1 hour |

| # | Task (if you pick **auto-approval**) | Severity | Estimate |
|---|---|---|---|
| 2B.1 | Modify `/api/apply` route to also create tenant + owner User in same transaction | 🔴 P0 | 3 hours |
| 2B.2 | Email applicant directly with sign-in link + temp password (or magic-link) | 🟡 P1 | 1 hour |
| 2B.3 | Add fraud-prevention: rate-limit per IP (10/day), email verification before tenant becomes active | 🟡 P1 | 2 hours |

### Phase 3 — Closed beta (5 gyms)

Goal: 5 hand-picked gyms onboard in a controlled rollout. You're available to fix bugs same-day.

| # | Task | Severity | Estimate |
|---|---|---|---|
| 3.1 | Set production env vars in Vercel: `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MATFLOW_ADMIN_SECRET`, `RESEND_API_KEY`, append `?pgbouncer=true&connection_limit=1` to `DATABASE_URL` | 🔴 P0 | 30 min |
| 3.2 | Decide TESTING_MODE state: keep on for the beta-owner test loop OR turn off (re-enable mandatory 2FA) | 🔴 P0 | 5 min decision |
| 3.3 | Verify Stripe Connect: hit `/api/stripe/connect/health` as owner — must return `ready: true` | 🔴 P0 | 5 min |
| 3.4 | Smoke-test owner journey end-to-end on a fresh test tenant (apply → approve → first member invite → checkout → check-in → cancel sub) | 🔴 P0 | 2 hours |
| 3.5 | Onboard gym #1 personally — sit beside them or do a screenshare. Note every friction point. | 🔴 P0 | 2 hours |
| 3.6 | Fix friction points from #1, then onboard #2-5 over a week | 🔴 P0 | Ongoing |
| 3.7 | Gather: NPS-style "would you keep using this?" + bug reports + feature requests | 🟡 P1 | Ongoing |

### Phase 4 — Open launch readiness

Goal: anyone can sign up via marketing site.

| # | Task | Severity | Estimate |
|---|---|---|---|
| 4.1 | Fix highest-priority remaining bugs from AUDIT-2026-04-27.md (115+ logged): WP-J P0 (error-message leaks), WP-C (Resend webhook signature), WP-H P1 (Stripe dispute attendance reversal), WP-L P0 (member privilege escalation rate limit on `/api/admin/create-tenant`) | 🔴 P0 | 3–5 days |
| 4.2 | Implement DSAR request UI (audit found `/api/admin/dsar/export` exists but no UI) — required for UK GDPR | 🟡 P1 | 1 day |
| 4.3 | Marketing site / landing page (separate domain or `/` route) | 🟡 P1 | TBD by design |
| 4.4 | Pricing page tied to actual subscription tiers in DB | 🟡 P1 | 1 day |
| 4.5 | Self-service "delete my gym" flow (data export + tenant deletion) | 🟡 P1 | 1 day |
| 4.6 | Status page (e.g. status.matflow.studio) backed by `/api/health` polls | 🟢 P2 | 4 hours |
| 4.7 | Lazy-load `googleapis` (saves ~6MB / ~100ms cold-start) per audit recommendation | 🟢 P2 | 1 hour |
| 4.8 | Performance audit: Lighthouse on real production with a real gym's data; address regressions | 🟢 P2 | 1 day |

### Phase 5 — Long-tail (nice to have, post-launch)

| # | Task | Severity | Estimate |
|---|---|---|---|
| 5.1 | Move TOTP enrolment INTO owner onboarding wizard (instead of post-hoc redirect) — once shipped, can flip TESTING_MODE off in prod and rip the proxy.ts redirect | 🟢 P2 | half day |
| 5.2 | Member-facing 2FA opt-in toggle | 🟢 P3 | half day |
| 5.3 | Recovery code regeneration UI (currently only at first enrolment) | 🟢 P3 | 2 hours |
| 5.4 | Convert `console.error` calls to structured logger with tenantId/userId/requestId fields | 🟢 P2 | 1 day |
| 5.5 | i18n / French translations for Quebec gyms (if relevant market) | 🟢 P3 | TBD |

---

## Part 3 — Decisions needed from you

These block planning, not just execution. Surface them now to avoid mid-Phase rewrites.

| # | Decision | Why it matters |
|---|---|---|
| D1 | **Manual approval (Phase 2A) vs auto-approval (Phase 2B) for new gym signups** | Changes 1+ days of work + the trust model |
| D2 | **TESTING_MODE in production: keep on through beta, or flip off NOW** | If on, owners aren't enrolling in 2FA. When you flip off, existing accounts hit forced enrolment |
| D3 | **Are you willing to delay launch to fix the 115+ AUDIT items, or accept some P1s as known-debt?** | "Ship perfect" never ships; "ship broken" loses customers. Pick where you draw the line. |
| D4 | **Closed-beta size — 5 gyms? 10? 1?** | Affects how much hand-holding capacity you need |
| D5 | **Do you have a marketing site / landing page yet, or are signups invite-only via direct link?** | Determines whether Phase 4.3 is in scope |

---

## Part 4 — Suggested sequencing (concrete week-by-week)

Assuming ~6 productive hours per day, solo:

**Week 1 (this week)**
- Mon-Tue: Phase 0 entirely (RLS commit + activation + 5 P0 bug fixes)
- Wed: Phase 1 entirely (Sentry + monitoring + alerts + backups + boot guards + runbook)
- Thu-Fri: Phase 2 (whichever path you pick — manual or auto approval)

**Week 2**
- Mon: Phase 3.1-3.4 (env + smoke test)
- Tue-Fri: Phase 3.5-3.6 (onboard gym #1, then 2-5 across the week)

**Week 3**
- Mon-Wed: Phase 4.1 (top AUDIT items)
- Thu: Phase 4.2 (DSAR UI)
- Fri: Buffer / iteration on beta feedback

**Week 4**
- Phase 4.3-4.5 (marketing + pricing + self-service delete)
- Open launch by end of Week 4 if Week 3 went smoothly

**Total: ~4 weeks from today to open launch.** Faster if you parallelise (e.g., onboard beta gyms while fixing audit items).

---

## Part 5 — What I (Claude) can help with

| Task type | I'm good at | I'm bad at |
|---|---|---|
| Writing code (specs, components, API routes) | ✅ | n/a |
| Surgical commits that don't touch in-flight WIP | ✅ (proven this session) | n/a |
| Test writing | ✅ | n/a |
| Code review / audit | ✅ | n/a |
| Vercel env / dashboard config | ❌ | I can't drive Vercel UI from this session — Playwright keeps dying |
| Stripe CLI / webhook testing | ❌ | I can plan it; you run the commands |
| Real-user smoke testing | ❌ | You need to be the human |
| Marketing copy / pricing page design | ⚠️ | I can draft; you should refine |

If you want, the next concrete commit I can land in 30 min is:
- **Phase 0.1 + 0.2** (commit RLS + update test mocks) — this single commit is the highest-value unit of work in the entire plan
- **Phase 1.1 + 1.2** (Sentry DSN guard + rate-limit warn) — 30 LOC, ships immediately
- **Phase 0.4-0.8** (5 P0 bug fixes from FIX-PLAN-2026-04-30.md) — each is its own commit

Tell me which and I'll start.
