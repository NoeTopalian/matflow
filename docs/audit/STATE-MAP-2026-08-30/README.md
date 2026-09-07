# STATE-MAP-2026-08-30 — MatFlow state machine register

Nine read-only trace lanes ran against the repo on 30–31 Aug 2026, mapping every state a tenant (club), member, staff account and admin/operator level can be in, how each is saved, what it gates, and where the built machine diverges from `docs/MATFLOW-PIPELINES.md`. This page distils Parts 1–2 of the plan that commissioned them; the full plan is mirrored verbatim at [`.omc/specs/deep-interview-matflow-state-sdlc.md`](../../../.omc/specs/deep-interview-matflow-state-sdlc.md) (source of truth: `C:\Users\NoeTo\.claude\plans\so-im-seeing-issues-abundant-naur.md`).

## Lane files

| Lane | File | Scope |
|---|---|---|
| A | [statemap-A-identity.md](statemap-A-identity.md) | Identity plane — members + staff |
| B | [statemap-B-tenant-billing.md](statemap-B-tenant-billing.md) | Club (tenant) plane + member billing |
| C | [statemap-C-roles-settings.md](statemap-C-roles-settings.md) | Roles, admin levels, settings |
| D | [statemap-D-data-lifecycle.md](statemap-D-data-lifecycle.md) | Data in/out lifecycle |
| E | [statemap-E-entity-states.md](statemap-E-entity-states.md) | Wider entity and feature states |
| F | [statemap-F-mode-conditions.md](statemap-F-mode-conditions.md) | Modes, environment, infrastructure states |
| G | [statemap-G-combinations.md](statemap-G-combinations.md) | Combination cells (money × entitlement, lifecycle × identity, DSAR holes) |
| H | [statemap-H-time-transitions.md](statemap-H-time-transitions.md) | Time as a state machine (headlines complete, detail truncated) |
| I | [statemap-I-ui-divergence.md](statemap-I-ui-divergence.md) | UI truth vs backend state (headlines complete, detail truncated) |

## Part 1 — The state map (what exists today, from code)

### 1.1 Club (tenant) plane — lane B
Saved on `Tenant.subscriptionStatus` (free-text, no enum/CHECK) plus `deletedAt`, `onboardingCompleted`, `stripeConnected`/`stripeAccountId`; trial end, plan/tier, price and suspended-at are **not saved anywhere**. Values actually written: `trial` (default), `active` (only via an undocumented `DELETE` on the suspend route), `suspended`. **`cancelled` is documented in `docs/MATFLOW-PIPELINES.md` §1.9 and never written by any code path.** The SaaS fee is collected out-of-band; `/admin/billing` Platform MRR is hardcoded `-`.

**What each state gates:**

| Door | trial | active | suspended | cancelled | soft-deleted |
|---|---|---|---|---|---|
| Password login (owner/staff/member) | open | open | blocked | **open** (unchecked) | blocked |
| Magic-link login | open | open | **BYPASS** | open | **BYPASS** |
| Google OAuth | open | open | **BYPASS** | open | **BYPASS** |
| Dashboard once inside | full | full | full (no layout gate; JWT killed ≤10 min) | full | full |
| Kiosk `/kiosk/[token]/*` | works | works | **works** (token hash only) | works | **works** |
| Stripe webhooks | processed | processed | **processed** (existence check only) | processed | **processed**; post-purge → 409 retry storm |
| Emails (`lib/email.ts`) | send | send | **send** | send | **send** |
| Public tenant pages | 200 | 200 | 404 | 404 | 404 |
| Crons (monthly-reports, class-instances) | run | run | skipped | skipped | skipped |

**Noe's example answered — an owner logging into a club that stopped paying: nothing different, the full product, indefinitely.** `trial` gates nothing and never expires, no dunning exists, and the only escalation (`suspend`) cancels every member's Stripe subscription and reactivate does not restore them — the commercial lever is unusable, so in practice MatFlow has no enforcement mechanism for its own fee.

### 1.2 Identity plane (members + staff) — lane A
Two tables, no adapter, JWT strategy with a 30-day cookie. Neither table has `deletedAt` or `emailVerified` — "account state" is emergent from five independent columns, with no lifecycle enum for people. Headlines: every member is born unable to log in (all four creation paths write `passwordHash: null`); the owner's generated password is thrown away at approve, so a single-use 30-minute magic link is their only way in; nobody can change their own password; member 2FA bricks the password path forever while non-owner staff 2FA is never challenged — the populations for whom TOTP works are exactly inverted; magic link is an unconditional back door that also omits the `memberId` JWT claim, so session-version revocation is a no-op for it — password reset, sign-out-everywhere, tenant suspend and soft-delete all fail to kill a magic-link member session, which lives its full 30 days and is served demo data; `Member.status` is read by no authentication code, so a cancelled member keeps a working login indefinitely.

### 1.2b Member billing plane — lane B §4.4
`Member.status` and `Member.paymentStatus` are both CHECK-constrained, but `paymentStatus` defaults to **`paid`** — a non-Stripe member is "paid" because nobody said otherwise. No soft-delete on `Member`; DSAR erase scrubs PII and keeps the row. **Noe's example answered — a member logging in who hasn't paid: they log in normally.** No login path reads `paymentStatus` or `Member.status`; the only hard block in the whole product is member self check-in (HTTP 402 unless live sub AND paid, or an unexpired credit-bearing pack). Kiosk admits overdue members, staff register bypasses everything, and booking/waitlist/shop/class-pack purchase all read no member billing state.

### 1.3 Roles, admin levels and settings — lane C
No hierarchy — four flat allow-lists — and `admin` is both the schema default for a new `User` and the second-weakest rung, a naming trap already producing divergences. 82 of 171 API route files hand-roll `await auth()` + string compares instead of the typed helpers, which is where drift lives: a coach can strip any member's 2FA, a manager can export the full payment CSV the UI hides from them, and promote/demote have disjoint allow-lists. The operator plane has one privilege level: total — the v1 shared admin secret is still accepted and stored verbatim in a cookie, impersonation suppresses 2FA and re-stamps the revocation clock every request, and per-action audit attribution is a false promise (everything logs as the gym owner). The settings plane has several dead/phantom fields, including an unsettable `currency` that feeds every Stripe charge.

### 1.4 Data lifecycle — lane D
In is built, out is missing. CSV import → bulk-invite → accept-invite is real machinery, but `MemberDraft` carries no emergency contacts, ranks, medical or history. **No member-roster export exists at all** — the only per-person export is DSAR JSON rate-limited 10/hr (200 members = 20 hours). No waiver list view exists anywhere. `Member` has no soft-delete — hard 10-table cascade, or GDPR erase-in-place whose `cancelled` sentinel is load-bearing; erasure leaves the identity inside the connected Stripe account with nothing pointing at it. Tenant soft-delete is fail-open on Stripe; the 30-day purge is fail-closed (can skip a tenant nightly, forever, silently) and runs ≤2 tenants/night inside a shared 240s budget. Four blob-orphan sites exist; every blob delete is swallowed best-effort with no sweep. Bulk-invite is sequential and unthrottled against Resend's 100/day free tier.

### 1.4b Wider entity and feature states — lane E (ralph round 1)
Dead features wearing live clothes: `ClassInstance.isCancelled` can never become true (no update path — ~10 filters and the check-in guard are no-ops); `Class.deletedAt` is never written (paused/removed collapse); `ClassWaitlist` and `Notification` have zero writers; `PlatformConfig`/`Tenant.featureFlags` have zero reads or writes. States with no exit: an ad-hoc `Payment` gets stuck `pending`; a dispute closing on an unmapped status leaves the payment disputed and the member overdue forever; `pay_at_desk` orders land pending with no staff surface for Orders at all; tasks can't reopen; announcements can't unpin or extend; operator sessions cannot be revoked. Stale caches: `MemberClassPack` expiry is written lazily with no sweep; the reconciler's event list has drifted from the webhook's; `EmailLog` has an undocumented 7th status with no CHECK.

### 1.4c Modes, environment and infrastructure states — lane F (ralph round 1)
The boot guard is calibrated backwards: it hard-fails on vars whose absence degrades gracefully (503s), and stays quiet for ones whose absence produces silent *wrong* behaviour — missing blob token means waiver signatures are silently stored as base64 in Postgres with no record. The production refusal is a hardcoded Neon endpoint literal in two files: rotate the prod endpoint and both `isTestingMode()` and `maybe-migrate` fail open with no signal — the highest-leverage latent failure in the mode system. `NODE_ENV=production` does not itself disable TESTING_MODE. Around 30 further silent degradations with no signal are recorded in the lane report (RLS decorative under BYPASSRLS, login rate-limiter degrades to per-instance memory exactly when the DB is stressed, Stripe Connect status fails open, 15 of 18 `sendEmail` call sites discard their result, declared crons may simply never fire, `MAINTENANCE_MODE` is a front-door-only kill switch).

### 1.4d Combination cells — lane G (ralph round 1; corrects two earlier findings)
Money × entitlement: a partial refund of any amount voids a whole class pack permanently; a full refund ignores how many credits were consumed; a lost chargeback never touches the live subscription; a late webhook can return a cancelled member to paid; kiosk check-ins silently burn pack credits for overdue/paused/comped members who needed no coverage. Lifecycle × identity: staff-cancelling a member leaves Stripe coverage live, so a cancelled member can self-check-in while the kiosk can't see them at all; a suspended/soft-deleted tenant still burns single-use invite/reset tokens; impersonation re-copies the target's `sessionVersion` on every request, so no version bump can ever evict it. DSAR erase holes: an in-flight pack checkout re-creates rows on an erased member; the dispute fallback moves a payment row an erase never touched; an erased parent strands active kids; erasure rewrites `EmailLog` recipients and silently lifts bounce suppression. Also recorded: 13 probed-and-fine cells, and 8 statically-unresolvable questions (U-1..U-8) needing runtime probes.

### 1.4e Time and UI-truth — lanes H and I (ralph round 2; both stalled writing detail, headlines complete)
**Time (H):** the check-in window is computed timezone-naive on a UTC server — every British gym's self/kiosk check-in window is an hour out for the seven BST months; `Tenant.timezone` is fully dead so everything runs UTC; "Generate instances" covers 28 days while the cron's real horizon is 56; **`current_period_end` is never persisted — with webhooks down, cancelled and paying members are indistinguishable**; `paused` has no end date and freezes last until a human notices; abandoned Stripe checkouts stay pending forever.
**UI truth (I):** `/dashboard/payments` has no server gate and its own header comment claims protections that don't exist; hard-deleting a staff member skips the sessionVersion guard, so a fired coach keeps a working JWT for 30 days while the dialog promises "immediately"; the member shop's "Order Placed!" flow has no staff orders screen to find the reference on; Mark Attendance crashes on any API error; **owner onboarding advances on failure**, then the layout bounces the owner back into the wizard; five more surfaces render HTTP errors as empty/negative states.

### 1.5 Cross-plane contradictions that bite — lane B §5.3
X1 the only lever against a non-paying club destroys that club's revenue · X2 tenant state gates humans, not machines (webhooks, kiosk, emails, waiver pages, reconcile sweep) · X3 session invalidation is the real gate and it is ≤10-minute eventually-consistent, never at the edge · X4 `trial` = both "new customer" and "free rider" · X5 member `paid` means two different things · X6 the published terms say a club "may cancel at any time" and no self-serve cancel exists.

## Part 2 — Verdict: is a truly working version present?

| Plane | Verdict | The evidence line |
|---|---|---|
| Club commercial lifecycle | **ABSENT** | One free-text column, nothing writes `cancelled`, `trial` gates nothing and never expires, the only lever destroys the club's own revenue, and two of three login doors ignore the state entirely (lane B) |
| Identity & login | **WORKS-WITH-HOLES** | Password path + owner TOTP + invites genuinely work; but magic link admits locked/suspended/deleted accounts and mints unrevocable member sessions that see demo data; member 2FA bricks; cancelled members keep working logins; nobody can change their own password (lane A) |
| Member billing | **WORKS-WITH-HOLES** | Stripe-linked members track real states via webhooks; but `paid` is also the say-nothing default, and the one hard gate (self check-in 402) hits exactly the cash-paying imported population it shouldn't (lanes A+B) |
| Roles, admin levels, settings | **WORKS-WITH-HOLES** | Tenant-staff gating broadly holds (all 19 `/api/admin` routes gated, CSRF sweep near-complete) — but no least privilege on the platform plane, impersonation's audit promise is false, guard style drifts across half the API surface, and the settings plane is riddled with dead/phantom fields including an unsettable `currency` (lane C) |
| Data lifecycle | **WORKS-WITH-HOLES — the exits are missing** | Import/invite machinery is real; but no roster export, no waiver view, importer can't carry what the waiver wall demands, deletion paths orphan blobs and Stripe identities, and the purge can wedge silently forever (lane D) |
| Time & UI honesty | **WORKS-WITH-HOLES** | Check-in windows an hour out under BST, no local period-end, capacity/waitlist/pause fictions, no-actor date fields (lane H); day-one screens that crash, lie, or advance on failure (lane I) |

**Noe's two examples, answered from evidence:** the unpaid member logs in and lives normally (one advisory card; only self check-in blocks); the owner of a non-paying club gets the full product forever, and if MatFlow ever suspends them it cancels every member subscription irreversibly. Neither behaviour is a decision anyone made — both are the absence of a state machine.

## Decisions

Decisions D-1 through D-8 (locked 31 Aug, Noe) are recorded in Part 5 of the plan — not reproduced here. Headline scope: D-1 trial/grace-period constants, D-2 suspend leaves members unaffected, D-3 TBJJ launches booking + attendance only (member payments migrate later), D-4 read-only portal for cancelled members, D-5 launch-first execution order, D-6 no fixed public price, D-7 build the waitlist properly, D-8 deploy each phase to production as it merges.

## Source

Distilled from `C:\Users\NoeTo\.claude\plans\so-im-seeing-issues-abundant-naur.md` Parts 1–2. Full plan mirrored verbatim at [`.omc/specs/deep-interview-matflow-state-sdlc.md`](../../../.omc/specs/deep-interview-matflow-state-sdlc.md).
