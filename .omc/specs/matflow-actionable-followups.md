# MatFlow — Actionable Follow-ups Execution Plan (Q35-aware, revised)

**Generated**: 2026-05-11 (revised after Q35 + 3-lane review)
**Source**: brain dump (`40-Projects/matflow/feedback-and-feature-requests.md`) + Q35 verdict (`.omc/specs/deep-interview-q35-what-is-matflow-for.md`)
**Status**: revised. Original plan had 6 corrections surfaced by deep-dive review; Q35 verdict moved several deferred items into scope.

## What changed from v1

| v1 entry | Revision |
|---|---|
| A1 banner: `items-start` → `items-center` swap | **Wrong diagnosis** — source already uses `items-center` everywhere. Real cause unknown without screenshot. **Defer banner fix until you can supply a screenshot.** |
| A1 chart: `ResponsiveContainer` fix | **Wrong file diagnosis** — ResponsiveContainer is already used in `ReportsView.tsx`. Real cause is the Sparkline at `components/dashboard/ReportsView.tsx:394` with hardcoded `width={520}` that bypasses the responsive wrapper. **Fix the Sparkline.** |
| A1 banner path `components/dashboard/Recommend2FABanner.tsx` | Wrong path — actual: `components/layout/Recommend2FABanner.tsx`. |
| A2 coach removal | **Killed.** FK confirmed `ON DELETE SET NULL` in `prisma/migrations/20260428000010_class_coach_user/migration.sql:10`. No bug. A regression test alone would fail reviewer check 3 (no pre-fix code to revert to). Replaced with a 2-line note in `progress.txt`. |
| B2 check-in window config | **Reduced priority + split.** Doesn't trace to this brain dump (came from kids/family analysis). Still valuable. If executed: split into B2a (schema + lib + integration test) and B2b (UI + Zod). |
| (missing) PWA push POC, booking ack, UI↔API sync, recurring-billing UI scaffold, landing page | **Added** — Q35 verdict moves these in-scope. |

## Goal

Now that Q35 is "revenue product, 1 paying non-Sean customer by 1 Sept 2026", execute against that target. Each item in this plan is sized for the Ralph reviewer's 6 hard-fail checks. Items are ordered by yield-per-hour given the 12-hr/wk budget and a 16-week runway.

## Phase A — Visible quality wins (this session if possible, else next)

Cheap, concrete, low-risk. Build user confidence in the loop's velocity before tackling big features.

**Commit A1 — Sparkline mobile overflow fix**
- File: `components/dashboard/ReportsView.tsx:394`
- Change: replace fixed `width={520}` with a responsive pattern (`ResponsiveContainer` + `width="100%"`, OR a `max-w-full overflow-x-auto` wrapper, OR explicit aspect-ratio container).
- Test: `tests/e2e/reports-mobile.spec.ts` — render at 375px viewport, assert `document.body.scrollWidth === window.innerWidth` (no horizontal overflow).
- Done criterion: at mobile width, the Sparkline scales to the container; no horizontal page scroll on `/dashboard/reports`.

**Commit A2 — Coach removal characterisation (no production code)**
- File: `progress.txt` only — append a note: "Class.coachUserId FK is ON DELETE SET NULL (confirmed in migration 20260428000010). Coach deletion preserves the class with coach=null. No fix needed."
- No test (would fail reviewer check 3). Pure documentation.

**Phase A deferred until screenshot available**: 2FA banner spacing. Original `items-start` diagnosis was wrong; can't proceed without seeing the actual artefact.

## Phase B — Revenue-path foundation (next 2-3 sessions)

The Q35 verdict makes these mandatory, not optional.

**Commit B1 — Stripe key scope verification (USER ACTION, 2 min)**
- Open Stripe Dashboard → Developers → API keys → click `rk_live_*` → list scopes.
- Document in `.omc/stripe-key-scopes.md`.
- Without this, every subsequent Stripe code change is risky.

**Commit B2 — Member-facing recurring billing UI (scaffold first, ~half day)**
- The biggest gap blocking customer #1. Without this UI, no real gym can self-onboard.
- Phase 1: read `MembershipTier`, `stripeSubscriptionId`, `customer.subscription.*` webhook handlers. Sketch the data flow.
- Phase 2: build the `/member/billing/subscribe/[tierId]/page.tsx` server component that creates a Stripe Checkout Session.
- Phase 3: success/cancel return routes.
- Phase 4: member-facing "active subscription" view.
- Each phase is its own commit, each test-covered.

**Commit B3 — Public landing page (~half day)**
- Currently `matflow.studio` lands on the app (login screen). Cold email has nowhere to send people.
- New route: `app/page.tsx` becomes a marketing landing instead of redirecting to login.
- Sections: hero (BJJ-academy positioning), 3 feature cards (rank tracking, kiosk, branded portal), pricing, "request demo" CTA.
- Existing app moves to `/app` or `/dashboard` direct.

**Commit B4 — Cold-email infrastructure prep (~half day, mostly research + setup)**
- Provision separate sending domain (matflow.io)
- SPF/DKIM/DMARC configured
- Warmup tool (Instantly / Smartlead) chosen + initial setup
- Target list of 100 UK BJJ academies in CSV
- Drafted 3-touch email sequence with BJJ-specific subject lines
- *Not* sending emails yet — this is the infrastructure for July outreach.

## Phase C — Competitive parity (next 4-6 weeks)

Required to clear the MAAT bar.

**Commit C1 — Kids parent-app (~2-3 days)**
- Per the earlier deep-dive: parent can currently see kids' data but cannot enrol them in classes or check them in via the mobile app.
- Files: `app/member/family/page.tsx` (new list view), `app/api/member/children` POST (add child), `app/member/sign-in-to-class` extension (multi-child picker).
- Onboarding step 5 changes from yes/no hint to actual kid-creation loop.

**Commit C2 — Coach "my classes" filter (~half day)**
- Original B1 from v1. Still valid.
- Toggle on `/dashboard/timetable` + `/dashboard/coach`.
- Test: e2e at `tests/e2e/coach-my-classes.spec.ts`.

**Commit C3 — Per-tenant check-in window config (~30 min) [if time permits]**
- Original B2. Now split per the deep-dive review:
  - C3a: schema (`checkinWindowBeforeMin Int @default(30)`, `checkinWindowAfterMin Int @default(30)`) + migration + `lib/checkin.ts` rewire + integration test (4 source files + 1 test). Run `prisma migrate dev` against `TEST_DATABASE_URL` before vitest.
  - C3b: Zod schema extension in `app/api/settings/route.ts` + UI controls in `components/dashboard/SettingsPage.tsx`'s "integrations" tab.

## Phase D — Notifications POC (when time permits, ~1 day)

**Commit D1 — PWA push notifications proof of concept**
- The user named "notifications + widgets" as the *main* reason they want an app. A PWA-push POC achieves notifications without Capacitor (which has Apple-IAP politics).
- Wire Serwist's push subscription path. Test: server triggers a notification on rank promotion; member's installed PWA shows it.
- Outcome: validates whether push alone solves the "main rationale for an app". If yes, Capacitor commitment can stay deferred.

## Phase E — Reliability audits (parallel, low-priority)

**Commit E1 — Full UI↔API sync Playwright sweep**
- Brain-dump asked for this explicitly. Click every nav button as each role (member, coach, admin, owner); log any 4xx/5xx; file each as a catalogue item.
- Bounded effort (~2 hours); high yield (catches dead buttons and missing handlers).

**Commit E2 — Stats accuracy smoke test**
- Original A3. Use Playwright to capture displayed dashboard stats, compare to direct Prisma query via `withRlsBypass`.
- 15 minutes. No commit; verification only.

## Phase F — Strategic decisions still on user (can't be done by Claude)

- **Font choice** (Geist / DM Sans / Plus Jakarta Sans / stay Inter). Tell me which; ~10 min global swap.
- **Mobile/Capacitor commitment** — deferred until D1 (PWA push POC) validates whether push alone is enough.
- **Members-only vs combined-app split** — deferred; not needed for revenue customer #1.
- **Owner-toggle payment-control model** — gated on first customer's actual preference, not a pre-emptive decision.
- **Staff notes + to-do feature** — Q35-valid but lower priority than billing+landing+kids. Sprint after first customer.

## Session sequencing (revised)

**Session A (THIS conversation, ~30 min remaining)**:
- Commit A1 (Sparkline overflow fix) — execute now
- Commit A2 (coach removal note) — append to progress.txt

**Session B (fresh conversation, ~1.5-2 hours)**:
- Commit B1 (Stripe scopes — user action, then doc commit)
- Start Commit B2 phase 1-2 (member billing scaffold)

**Session C (fresh conversation, ~2 hours)**:
- Commit B3 (landing page)

**Sessions D-G**: B4, C1, C2 in order. Phase D + E parallelisable when needed.

## Files to modify (Session A — immediate)

- `c:\Users\NoeTo\Desktop\matflow\components\dashboard\ReportsView.tsx` (Sparkline fix)
- `tests/e2e/reports-mobile.spec.ts` (new e2e for overflow check)
- `progress.txt` (A2 documentation note + session-3 summary)
- `.omc/ralph/learnings.md` (iter-4 entry)

## Reviewer-check budget for Session A

- ≤5 files total ✓ (3 files including the test)
- ≤200 non-test prod lines ✓ (Sparkline fix is ~3 lines)
- Regression test exists ✓ (e2e mobile spec)
- Tenant scoping ✓ (no Prisma changes)
- Build/lint/test ✓ (will run)
- No suppression ✓ (genuine fix)

## Verification

Per commit:
1. `npx tsc --noEmit` clean on modified files
2. `npm run build` exit 0
3. New e2e test PASSES via `npx playwright test tests/e2e/reports-mobile.spec.ts`
4. Reviewer's 6 checks all green
5. Push to main

After Session A:
1. Sparkline overflow visibly fixed on `/dashboard/reports` at mobile width
2. Coach removal documented as already-correct in progress.txt
3. Revised plan saved, durable across future sessions
