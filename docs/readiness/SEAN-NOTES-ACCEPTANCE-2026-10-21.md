# Sean's requirements — authoritative task record (updated 29 Oct 2026; earlier tables kept below as history)

## Sean's seven requirements — acceptance checklist (Noe, 28 Oct 2026, 23:00; supersedes everything below)

Scope confirmed by Noe: these seven, nothing else. Deferred: the public club page (item 8) and "edit the taggings". Stripe activation comes after the Resend stage. Sean's MVP is not ready until all seven are deployed and checked as usable in production.

**State words:**
- *live*: served by production. That is `main` `9dc60b9c`, Vercel production deployment 7352357165, which reported success on 27 Oct 2026 at 06:58 UTC.
- *verified*: exercised on the Neon test branch against the release candidate.
- *production-checked*: the owner has used it in Sean's club.

No item is production-checked yet.

**Evidence is from the release candidate (PR #52, rerun 29 Oct 2026):**
- Product code is `7edfaa63`. After `cbbc6e87` it changes one thing, the refusal sentence: plan and squad refusals now end "For further information, please speak to a coach." (`lib/class-tier-gate.ts`, `app/member/home/page.tsx`). The later commits change only the browser harness, one journey check and the CI time limit.
- All 15 browser journeys passed on the builds of `d27804d2` and `5ab352a1`, whose product code is `7edfaa63`. The counts in the table are from those runs, and every fixture was torn down to 0 rows.
- Every database file ran on `7edfaa63` or `5602b27a`, as both the owner role and the restricted `matflow_app` role with RLS. The two commits have identical product and test code. The final tally is under "Final verification" below.

| # | Requirement | State | Evidence |
|---|---|---|---|
| 1 | Choose which membership plans can attend each class, with clear refusals, keeping bookings | live (#47), verified, not production-checked | **classes-lifecycle 56/0:** before saving, the class editor lists who it would turn away and why; desk, kiosk, coach and booking refuse with the member's sentence, which ends "For further information, please speak to a coach."; a booking survives a squad removal. **allowance-eligibility 26/0.** **DB, both roles:** `class-membership-tier-db` 7/7; `booking-preservation-db` 8/8 (no loss-of-access path deletes a booking, and each kept booking is recorded durably). |
| 2 | Member counts consistent across screens for the same population | live (#47), verified, not production-checked | **reporting-truth 86/0:** Members headline = Reports Active members = CSV; drill-throughs open the same number. **DB:** `member-population-parity` 10/10 both roles. |
| 3 | Joins, rejoins, departures, net movement; imports never create joins | live (#47), verified, not production-checked | **headcount-movement 38/0:** New, Rejoined, Left and Net equal the movement; the imported member appears in none. **DB, both roles:** `t8c-membership-db` 2/2, `teamup-rehearsal` 5/5. |
| 4 | A real member-headcount chart over time, estimates labelled | live (#47), verified, not production-checked | **headcount-movement 38/0:** the axis starts at zero; each month's dot sits at its month-end headcount; today = Active members. **Estimate labels:** covered by unit tests of the chart component (`net-new-members-card`, `membership-movement`). The browser fixture has no import history, so it shows no estimated months. |
| 5 | Editable weekly, monthly and fixed 4-week limits; four visits usable in one week; no staff override | live (#47), verified, not production-checked | **allowances-periods 56/0:** week, calendar month and every 4 weeks; clear to Unlimited; refusals at each boundary; no override; races. **member-booking-notice 8/0.** **DB, both roles:** `sean-four-every-four-weeks-db` 4/4 (all four classes in one week are admitted at the member's door and the desk; a fifth is refused at both with "used 4 of 4"; the next period starts fresh); `tier-class-allowance-db` 21/21. |
| 6 | Counts beside percentages; Joined beside churn; churn shown as a percentage with its counts (Noe, 31 Oct 2026: "Should show % with number"); one period selector | live (#52, deployed 29 Oct) as a count; the percentage with counts is on `feat/churn-percent`, not merged | **reporting-truth 86/0:** churn is a count with no percentage; Joined is the next tile; every share reads "x% (n of m)"; the period selector works by keyboard and changes churn, Joined and the drill-throughs. **percent-teamup 16/0** (conversion "25% (2 of 8)"). **headcount-movement 38/0.** |
| 7 | Class settings for ordinary and competition classes: categories, squad lists, pause, archive, restore | live (#47), verified, not production-checked | **classes-lifecycle 56/0:** create a competition class with a squad and a plan; edit its category; pause closes check-in and booking and resume reopens them; archive states the kept counts and keeps the history; restore. **permissions-matrix 166/0:** only the owner can change these, and never another club's. **DB, both roles:** `class-lifecycle-db` 4/4, `squad-class-tier-db` 7/7. |

**Carried in #52 and left as built** (not part of the seven; no further work):
- App check-in switch.
- Per-product pack expiry.
- Import rules: never overwrite; a plan only on full evidence; a blank or unrecognised CSV payment status recorded as "No payment yet", never "paid".
- Security fixes.
- Pack checkout limited to card. The release therefore needs no Stripe webhook change. Delayed methods such as Bacs return once the async checkout events are subscribed.

**Production check after the merge** (owner, in Sean's club):
1. Edit a class and untick a plan. The editor names who would be turned away. A member on that plan is refused at the desk with the reason, and their existing booking is still listed.
2. The Members headline and the Reports "Active members" figure are the same number for the same group.
3. Reports shows Joined, Rejoined, Left and Net for this month, and the TeamUp import shows no joins.
4. The Reports headcount chart shows real totals, with estimated months labelled.
5. A plan set to "4 every 4 weeks" shows its period dates, and clearing the limit reads Unlimited.
6. On Reports and Analysis, every percentage shows its counts, and Joined sits beside churn. Once `feat/churn-percent` is deployed, churn reads "x% (n of m)": the cancellations in the period of everyone who was a member during it, with both counts in words underneath. The period selector changes the figures.
7. Create a competition class with a squad, then pause, archive and restore a class. Its history stays.

### Final verification (29 Oct 2026; head `5602b27a`, product code `7edfaa63`)

- **Lint, unit and build:** lint exit 0 and 597 unit files with 8,346 tests passed, both on `7edfaa63`. CI "Typecheck + Lint + Vitest" passed on `5602b27a`. Production build exit 0 on `5ab352a1`.
- **Browser journeys, 15 of 15 green:**
  - build of `d27804d2`: smoke 11/0, percent-teamup 16/0, classes-lifecycle 56/0, next-16-4-smoke 9/0, import-review 14/0, allowance-eligibility 26/0, member-booking-notice 8/0, scanner-override 8/0, app-checkin-packs 26/0, payment-evidence 23/0, allowances-periods 56/0, accounts-and-members 54/0;
  - build of `5ab352a1`: reporting-truth 86/0, headcount-movement 38/0, permissions-matrix 166/0, smoke 11/0.
- **Database:** 116 integration files × 2 roles = 232 passes. 226 are green. The other six are below; none is a product defect, and none involves code this release changes.
  - **Restricted role only:** `campaign-db-helper` and `e2e-guard-real-database`. Both read the seeded demo club without a tenant context, which RLS hides by design. Both pass as owner.
  - **`cron-smoke`, both roles, 2 of 18 tests:** the test branch holds about 186 leftover test clubs, so the class-instances job overruns its 240 s limit. The retention guard also refuses, because 2 clubs were soft-deleted more than 30 days ago. Cron code is unchanged here. The test-branch data is not deleted without the owner's word.
  - **`sec-a3-lockout-oracle`, both roles, not completed:** its sampling test makes 368 sequential sign-in attempts under a hard-coded 20-minute limit. It had recorded a green run when the round trip to the test branch was 53 ms; today the round trip measured 203 ms, and the test ran out of time with no mismatch reported. Its positive control passed. The test is unchanged since 9 Oct, and this release does not touch `auth.ts`, `lib/rate-limit.ts` or `lib/login*`.
- **Runner settings needed today:**
  - `tenant-restore-purge-race` needed a 5-minute hook limit for its cleanup; 5/5 both roles.
  - `sec-m1-demo-rotate` needed the test-branch `.env.test` present for the tool it spawns (copied in for the run, then removed); 6/6 both roles.
  - `sec-a2-verify-disown` is intermittent on a slow link (see below); 8/8 both roles on its latest run.
- **Found while verifying, not changed by this release:** the authenticator code is checked with no tolerance for the previous 30-second step. A code that changes between typing and the server's check is refused. This is why `sec-a2-verify-disown` fails intermittently when database round trips are slow. It is live already and is listed for the owner.
- **Harness and CI fixes, no product change:**
  - Screenshots mask addresses in the image instead of rewriting page text. The rewrite raced React hydration and produced error #418 in smoke, on production `main` as well.
  - The TeamUp profile check waits for the streamed label.
  - reporting-truth retries its `/api/reports` read and fails loudly instead of expecting no estimate.
  - The CI test job's limit is 25 minutes, not 15. It was cancelled at 15 min 16 s twice. This was cherry-picked from #53.

---

## Status at 28 Oct 2026, the pre-Resend gate (history; superseded by the checklist above)

**Gate (Noe, 27 Oct 2026, 23:30):** Sean's agreed work must be complete, verified and usable before Sean is asked to pay for Resend. Two items are explicitly deferred to a later stage and are **not delivered**:
- the public searchable club page;
- "edit the taggings" (meaning still unknown, not pursued).

These are separate dependencies, not part of this gate:
- live email/SMS;
- Stripe activation;
- historical payment import (pending a TeamUp transactions export).

**State words:**
- *deployed*: on `main` and served by a successful production deployment;
- *candidate*: verified on `candidate/pre-resend-2026-10-28`, not merged;
- *deferred*: Noe moved it to a later stage.

Pushed is not deployed. Deployed is not "checked by Sean".

| # | Sean's request | Behaviour now | Where | Evidence | State |
|---|---|---|---|---|---|
| 1 | Choose which plans may attend each class | Strict at every door, with no override. The class editor previews who would be refused before saving. Bookings are kept and the refusal is explained. Interim booking-capacity rule unchanged. | `main` `9dc60b9c` (PR #47) | #47 journeys allowance-eligibility 26/0, permissions-matrix 166/0 at `41a356c2` | deployed |
| 2 | One true member count on Members, Reports and Settings ("excludes cancelled and guardians") | Named populations; guardians and payers never inflate training counts; active, current and historical totals labelled | `main` (#47) | reporting-truth 71/0 at `dc544c2a`; DB `member-population-parity`, both roles | deployed |
| 3 | Net new stuck at ±0; joins, rejoins, leavers | One movement definition: new and rejoined distinct, imports never joins, net reconciles | `main` (#47) | headcount-movement 38/0; DB `t8c-membership-db`, both roles | deployed |
| 4 | Real headcount chart, distinct from joining activity | Zero-based headcount series; estimated and partly estimated months labelled; no production back-fill run | `main` (#47) | headcount-movement 38/0 | deployed (history shows as estimated until a back-fill is separately approved) |
| 5 | Plan limits: per week, per calendar month, "4 every 4 weeks" | Clearable limits; several sessions in one week allowed within an N-week cycle; signing up is never refused, only noted. **No staff override anywhere, including direct API fields.** Billing-period allowance stays switched off. | `main` (#47, no-override merged at `41a356c2`) | allowances-periods 56/0, scanner-override 8/0 at `41a356c2`; security tests in the candidate (forged `acknowledged` refused at all five doors) | deployed; security hardening in candidate |
| 6a | Churn % "show the number"; Joined beside churn | Churn = **every cancellation in the selected period**, joiners included; finished courses count in Left only. No percentage until Noe picks the denominator. Joined sits beside churn. | candidate (W2, from #48) | unit and DB red→green; reporting-truth 84/0, headcount-movement 38/0 at `47b8b1b4` | candidate (percentage awaits Noe) |
| 6b | A number beside every % | Reports, Analysis and Conversion: every % shows its counts and base; meaningful counts show their %; no artificial 100%; part periods named ("so far this week vs all last week"); a zero baseline reads "—" | candidate (W3, from #50) | 14 tests red→green; percent-teamup 16/0, reporting-truth 71/0 at `b612c2a5` | candidate |
| 6c | Statistics period (Noe's addition) | One period selector on Reports and Analysis | candidate (#48) | journeys at `b415d7a5`; re-run on the final candidate | candidate |
| 6d | Missing attendance is not zero | Before a club's first attendance record: "—" and "No attendance records for this period (MatFlow's records start …)"; real zeros stay 0 | candidate (W5) | red→green; reporting-truth 86/0, percent-teamup 16/0 at `a85224a5` | candidate |
| 7 | Class types, competition class, settings on any class | Eight categories, squad lists, pause / archive / restore with history | `main` (#47) | permissions-matrix 166/0; DB `squad-class-tier-db` | deployed |
| 8 | App check-in, owner's choice | Settings switch, **on by default**; an off choice is kept; the server refuses when off; desk, kiosk, scanner and coach unaffected | candidate (from #51) | app-checkin-packs 17/0; security tests (self, parent, forged method all refused when off) | candidate |
| 9 | Class packs | Owner chooses "Expires N days after purchase" or "Never expires" per new product. Sold packs keep their recorded terms; expired packs stay expired; validity cannot be edited after sale. | candidate (W1, from #51) | 23 unit + 6 DB tests red→green; app-checkin-packs 26/0 | candidate |
| 10 | Imports fit MatFlow | Refresh never overwrites; exact repeats skip; differences are listed for normal editing. A plan is assigned only when name, billing period, price and currency all agree; a TeamUp file has no price, period or currency, so its new people arrive with no plan, listed, and the access consequence is stated. Preview, commit and retry agree. Erasure scrubs stored import records. | candidate (W4) | 6 DB + 9 unit tests red→green; import-review 14/0; `import-conflicts-db` 17/17 both roles | candidate |
| — | Public club page | — | — | — | **deferred (Noe)** |
| — | "Edit the taggings" | — | — | — | **deferred (Noe)**, meaning unknown |
| — | Historical payments | — | — | — | **pending**: a TeamUp transactions export is needed |

### Verification of the combined candidate (`candidate/pre-resend-2026-10-28`)

**On `77438237`**, the candidate before the final review fixes and this document:

- **Static checks and build:** tsc and lint clean (0 errors). Unit suite 590 files, 8,290 passed. Production build clean.
- **Database suites, run as owner and as the restricted `matflow_app` role with RLS enforced:** 18 of 19 changed or affected files passed both roles.
- **`import-conflicts-db`:** 16 of 17 passed both roles. One test ("a member deleted since the import…") hit its own 90 s limit after three imports over a slow link. The same test passed on the import branch, and nothing on its path changed. It was re-run on the final head (see below).
- **Browser journeys (12):** all passed. smoke 9/0, import-review 14/0, allowance-eligibility 26/0, member-booking-notice 8/0, scanner-override 8/0, reporting-truth 86/0, headcount-movement 38/0, permissions-matrix 166/0, accounts-and-members 54/0, allowances-periods 56/0, app-checkin-packs 26/0, percent-teamup 16/0. Every fixture was torn down to 0 rows.
- **Security:** adversarial testing made 48 attempts. 42 were refused; 6 vulnerabilities were confirmed and fixed, each with a test that was red before the fix and green after. They are:
  - a foreign member pre-read in the check-in engine;
  - unattributed staff marks;
  - coach ticks into cancelled sessions;
  - pack credits minted for unpaid or delayed payments (now minted on payment, keeping the club's payment methods);
  - a refund racing a check-in;
  - a hostile period link.
- **Independent review** (one reviewer, all changes since the earlier reviews): CHANGES REQUIRED, with two medium findings, both fixed on the final head:
  - the import's access-consequence sentence;
  - the Stripe webhook event list.

  Four low findings were also fixed: the coach-tick tenant filter, exact test assertions, a migration comment, and the event-list test.

**Import access consequence, as stated to the owner:** a person imported without a plan cannot check themselves in from the member app until staff assign one. The desk and kiosk can still check them into classes open to everyone. Classes limited to certain plans refuse them.

**Open owner questions** (no code change made; each needs Noe):

1. **Churn percentage denominator.** *Decided 31 Oct 2026:* Noe asked for the percentage with its number; the agent chose option B (everyone who was a member during the period: the members at its start plus every move into active, imports included), which Noe may change to A. Built on `feat/churn-percent`.
   - Option A: cancellations ÷ members active at the start of the period.
   - Option B: cancellations ÷ everyone who was a member at any point in the period.
   - Synthetic example: 40 active on 1 Aug, 10 join, 6 cancel (4 of the 40 and 2 of the joiners). A = 15%, B = 12%.
   - Agent recommendation: B, because the count includes joiners.
2. **Automatic pack spending at staff doors** once the allowance is used up. This is deployed behaviour (PK1) that the owner never explicitly approved.
3. **Churn and filters.** Churn stays club-wide. Should the age-group filter narrow it?
4. **CSV import with a blank or unrecognised payment status.** These are recorded as "paid" (pre-existing). Recording "no evidence" would need a new status value.
5. **Erasure.** After a member is erased, their name and email still sit in some stored import lists that carry no member id: the exceptions CSV, the "not in MatFlow" list, the preview rows and the row errors.
6. **The "estimated next charge" note** guessed from a plan name: keep it or stop it?
7. **Which plans a junior may be put on automatically** (kids or adult).
8. **A £0 pack** never gets credits now; Stripe's handling of a £0 checkout is unconfirmed.

### Decisions in force: owner's words vs agent proposals

**Noe decided (27–28 Oct):**
- No staff allowance override, including API fields; eligibility refuse-only.
- Billing-period allowance stays off.
- App check-in on by default, with a per-club switch; enforced on the server.
- Per-product pack expiry; sold packs keep their terms; expired stays expired.
- Pack changes do not change refunds or automatic credit spending.
- Churn = all cancellations in the period, joiners included, distinct from Left; no invented denominator.
- Reports scope: counts with percentages in the statistics section only.
- Missing attendance is not zero.
- Import plan only on full evidence; otherwise no plan, flagged.
- No coach "one-off" (27 Oct 16:09: "they just shouldn't be allowed unless they have a membership").
- Public page and taggings deferred.

**Agent proposals, not owner decisions:**
- The churn denominator recommendation (option B, below).
- The coverage start (the earliest attendance record of any kind).
- The wording of notes and labels.

**Open owner questions:**
- The churn percentage denominator.
- Automatic pack spending at staff doors once the allowance is used up. This is deployed behaviour, originally an agent default (PK1) and never explicitly approved.
- Three import questions (W4 report).

### Release checklist (candidate → available to Sean)

- [ ] Verification on the exact final candidate head: unit, type check, lint, DB suites under both roles, build, journeys.
- [ ] One independent review of all changes since the earlier reviews.
- [ ] Owner approval to push (every push creates a Vercel preview).
- [ ] Owner approval to merge the release PR at an exact SHA. Merging deploys and migrates production; there is no rollback, only fix forward.
- [ ] Post-deploy: health check, then the owner checks Sean's screens in production.
- [ ] Owner confirms the production Node runtime is 24.22.1 or later (it bundles undici 7.30.1; GHSA-xjj6-f33q-929c).
- [x] ~~Before merge: subscribe the async checkout events~~. This is no longer needed for this release: pack checkout is card-only (`882c2caf`), and a card completes the session paid. Subscribe the events, and allow delayed methods again, only at the Stripe stage.

**Migrations in this release** (all additive):
- `20261027120000_tenant_member_app_checkin`: column, default true.
- `20261027120100_class_pack_no_expiry`: two DROP NOT NULLs.
- `20261027130000_class_pack_drop_expired_check`: a no-op on production.
- `20261027140000_class_pack_expired_needs_date`: a CHECK. It validates against existing rows, which all have dates, because the column was NOT NULL before this release.

The 22 Oct compatibility read (`PR41-RELEASE-COMPAT-2026-10-22.md`) covers #47's migrations, which are already deployed. The migrations above change no existing behaviour for current data, so no new production read is needed.

---

## History: the 22 Oct 2026 record

One record for every requirement Sean raised plus four-week recurring billing and the per-member billing-period allowance. Each item carries: responsible branch, dependencies, approved behaviour, acceptance criteria, tested commit, evidence, unresolved decisions, deployment status.

**States** (each item is in exactly one; *blocked* can attach to any): implementing → verifying → ready for approval → deploying → production verified. A merged PR is *deploying* until its post-deployment checks pass; it is not production verified by being merged.

**Authorisation in force:** Noe's standing approvals and definition of done (22 Oct, in `CLAUDE.md`). Merging PR #41 is **not yet authorised**; approval must name the exact head SHA. Sean's original messages are not in the repo; the wording below is the relayed version each batch worked from.

| # | Requirement | State | Branch / PR | Depends on | Approved behaviour | Acceptance criteria | Tested commit | Evidence | Unresolved decisions | Deployment |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Class membership eligibility** — tick which plans may attend a class ("Beginners members cannot walk into Advanced") | **ready for approval** | `sean/batch-d-plan-limits`, PR #41 (batch-b PR #40 merged in and closed) | — | Roster AND membership list both judged, at every door (desk, kiosk, scanner, coach tick, member booking), under the Member lock; refuse-only, no override; an old client's `tier_not_included` acknowledgement admits no one; existing bookings preserved and shown locked | unit doors; `class-membership-tier-db`, `squad-class-tier-db` both DB roles; journey `allowance-eligibility` J14–J15 | code `b995e383`, candidate `d1841372` | `ELIGIBILITY-ALLOWANCE-EVIDENCE-2026-10-21.md` (morning + evening); CI green on `d1841372` | D5: bookings that current eligibility refuses — keep (default) or clean by rule; whether the class-edit cascade should stop deleting bookings. Production has no bookings and no squad lists today, so no live instance | not deployed; production compat read 22 Oct: nothing activates at Total BJJ (`PR41-RELEASE-COMPAT-2026-10-22.md`) |
| 2 | **Competition rosters and class lifecycle** — class types; comp class as a picked squad; pause a class; archive with history | **ready for approval** | PR #41 (from batch-b) | — | Categories (fundamentals, gi, nogi, kids, competition, open_mat, private, other); roster = picked members; pause vs archive (archive keeps history; 409 removed) | unit; `squad-class-tier-db` both roles; browser on `43bcdadb` (archive/pause UI not re-walked in the evening journeys) | `b995e383` / `d1841372` | as row 1 | D5 (cascade) | not deployed |
| 3 | **Optional attendance allowances** — max classes per week / per month; "4 every 4 weeks" allowing several in one week; editable | **ready for approval** | PR #41 | — | `classLimit` + explicit basis: each week (Mon–Sun), each calendar month, every N weeks (2–8) from a per-plan start date; never rolling; attendance consumes; booking never refused (201 + notice); at the limit staff doors ask and record an audited `allowance_reached` override, self doors refuse; legacy `maxClassesPerWeek` reads as "N each calendar week" | unit (window, gate, doors, editor, migration); `tier-class-allowance-db` 21/21 both roles; `checkin-allowance-review-db` 7/7, `checkin-allowance-race-db` 7/7 (restricted role 22 Oct run 2, owner run 3, both roles 21 Oct, CI 22 Oct); journeys `allowance-eligibility` 25 PASS, `member-booking-notice` 8 PASS, `scanner-override` 4 PASS | `b995e383` / `d1841372` | evidence doc; review rounds 3–6 (5 and 6 APPROVED) | D1 per-member vs per-plan start date for "every N weeks"; D2 keep or remove the staff allowance override (implemented, awaiting policy) | not deployed; **deploy activates enforcement on the demo club's "3x Per Week" tier (18 synthetic members)**; nothing at Total BJJ |
| 4 | **Recurring four-week billing** | **production verified** (code) / **not demonstrated in production** (behaviour) | `main` (`lib/billing-cycle.ts` four_weekly → Stripe week × 4) | Stripe usage decision (member payments deferred 11 Oct) | Tier cycle `four_weekly`; Stripe price `week`×4; renewal every 28 days | (a) direct Stripe test objects; (b) MatFlow's own `ensureTierPrice` + `createSubscriptionForMember` on the connected test account with a test-clock renewal; (c) Stripe's own webhook delivery | `main`; tests on `b995e383` | (a) and (b) demonstrated 21–22 Oct (`four-weekly-billing-*-db`, 7/7); **(c) not demonstrated** (no public endpoint from the dev machine) | D6 whether production clubs will be billed by Stripe at all; the customer club's plans are four-weekly and it has no Stripe subscribers | code live; no production subscription exists |
| 5 | **Allowances aligned with each member's billing period** | **blocked — ships dark** (code and migrations in PR #41; `BILLING_BASIS_AVAILABLE = false` since `032227b4`: the editor does not offer the basis and both routes refuse it until live Stripe webhook delivery is verified AND members carry reliable period data; releasing it later is a one-constant change with no migration) — **not delivered** | PR #41 | row 3; row 4 for Stripe members; Stripe webhook delivery verification (c); D3/D3b | Basis `billing`: Stripe's paid period stored by the webhook on `invoice.payment_succeeded` (`Member.billingPeriodStart/End`), else `nextDueAt` + tier cycle; period unknown ⇒ refused at self doors, asked at staff doors, never a calendar fallback; anchor day kept across month ends; stated period used verbatim | unit (billing describe, round-4/5 cases); `tier-class-allowance-db` billing case; webhook unit tests; Stripe app-flow replay | `b995e383` / `d1841372` | evidence doc; `CLASS-ALLOWANCE-RESET-MODEL-2026-10-21.md` (provenance table + residuals: 28-day tie-break once a year per four-weekly subscriber, local-day projection, £0 first invoice, existing subscribers unknown until next invoice) | D3 backfill of Stripe periods before any plan uses the basis; **D3b: at the customer club no member carries `nextDueAt` or a Stripe subscription (22 Oct), so the basis would refuse/ask everyone there until renewal dates are populated (TeamUp "next payment date" on the next import, or Stripe)** | not deployed |
| 6 | **Consistent member counts** — one Active members number everywhere; Members headline vs Reports | **implementing** | `sean/batch-a-reporting-truth`, PR #37 (draft, `5046d763`) | shared population definitions (reporting order 1) | PR body: T1, T2b, T2c, T7a-2 | population-parity tests (not yet written), DB suites both roles, desktop + mobile journey of Members headline vs Reports | `5046d763` (lint, unit, build only, 17 Oct) | PR #37 body; `MATFLOW-CURRENT-SYSTEM-REPORT-2026-10-15.md` S-rows | A-14 imported-attendance labels (Sean/Noe) | not deployed; refresh against `main` in progress (22 Oct, worker) |
| 7 | **Correct joins, rejoins, departures and net movement** — Net new members shows ±0 | **implementing** | `sean/batch-c-headcount`, PR #39 (draft, `58055659`; local `ad920568` churn doc) | row 6; D4 churn definition | Movement events (T8a–d) + back-fill | 24 DB tests + back-fill preview on an isolated Neon child branch; parity with row 6 | `58055659` (lint, unit, build) | PR #39 body; `CHURN-DEFINITION-PROPOSAL-2026-10-21.md` | D4 churn definition (four decisions); D7 back-fill apply after Noe reads the preview | not deployed |
| 8 | **Historical active-headcount chart** — scale arbitrary; show real headcount | **implementing** | PR #39 | row 7 | Zero-based headcount series from movement events | as row 7 plus a desktop + mobile chart journey | `58055659` | as row 7 | D7 | not deployed |
| 9 | **Quantities beside percentages** on the requested surfaces | **implementing** | PR #37 | row 6 | Counts and denominators beside every percentage | per-surface browser checks desktop + mobile | `5046d763` | PR #37 body | — | not deployed |
| 10 | **Joined-member count beside churn** | **implementing** | PR #37 (display) + PR #39 (definition) | rows 6, 7; D4 | Joined to the right of churn with its count | journey on Reports | `5046d763` | PR #37 body | D4 | not deployed |
| U | At-Risk tile hidden until the first MatFlow register (urgent, 17 Oct) | **verifying** | `sean/at-risk-suppress-until-checkins`, PR #36 (`38f1cd0e`) | — | Tile hidden until a check-in exists | lint, unit, build in PR body; no browser run | `38f1cd0e` | PR #36 | — | not deployed; 17 Oct deadline passed |

## Decisions awaiting Noe (each blocks only its own row)
- **D1** per-member vs per-plan start date for "every N weeks" (row 3).
- **D2** staff allowance override: keep (implemented, audited, always asked) or remove (row 3).
- **D3** backfill Stripe periods for existing subscribers (and the £0-first-invoice case) before any plan uses the billing basis; **D3b** how Total BJJ gets renewal dates at all (TeamUp "next payment date" on import, or Stripe) — without them row 5 is unusable there (row 5).
- **D4** churn definition — the four decisions in `CHURN-DEFINITION-PROPOSAL-2026-10-21.md`; recommended rule and worked example to follow with the batch-c refresh (rows 7, 10).
- **D5** bookings refused by current eligibility: keep (default) or clean by rule; stop the class-edit cascade (rows 1, 2). No live instance in production today.
- **D6** whether production clubs will be billed by Stripe (row 4).
- **D7** batch-c back-fill apply after reading the preview (rows 7, 8).
- **D8** (new, 22 Oct) the demo club's "3x Per Week" tier becomes enforced on deploy — leave it, or clear the limit after deploy (a customer-settings change; not done silently).

## Release packets
- **PR #41** (rows 1, 2, 3, 5): candidate `d1841372` → see the approval packet of 22 Oct; compatibility read in `PR41-RELEASE-COMPAT-2026-10-22.md`; evidence in `ELIGIBILITY-ALLOWANCE-EVIDENCE-2026-10-21.md`.
- **PR #46** (framework advisories): merged `41b608aa`, production verified 22 Oct 21:53 (comment on #46).
- Reporting (rows 6–10): refresh of PR #37 against `main` running 22 Oct; order of work: shared population definitions → counts beside percentages → joined beside churn → movement calculations → historical headcount + back-fill rehearsal (isolated environment; production back-fill needs its own approval).
