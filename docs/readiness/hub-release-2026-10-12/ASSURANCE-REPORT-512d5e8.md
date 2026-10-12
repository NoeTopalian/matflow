# Hub release `512d5e8` — assurance report (12 Oct 2026, 11:30 UK)

Answers the owner's thirteen release questions and the fourteen release-assurance requirements (14–27), from existing evidence. Prepared by the coordinating agent from two independent read-only lanes (AQ1: questions 1–13; AQ2: requirements 14–27), one targeted test run, and corrections made after the lanes reported. Nothing here deploys, changes production, or touches Sean's account. Every owner decision column is empty: no risk is accepted by this document. Secrets, connection strings and e-mail addresses do not appear anywhere in it.

Status vocabulary throughout: PASS · FAIL · BLOCKED · NOT RUN · NOT APPLICABLE. A requirement with parts carries a status per part.

## A. Bottom line (signed by the coordinator)

1. **Is the exact candidate ready for deployment? No — not yet.** The executable `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` is ready on engineering evidence: independently reviewed (R10, APPROVED WITH RESIDUALS), gates green on Node 24.21.0, and every hub journey in the rehearsal plan PASSED on its own production build under both database roles (run 3), except the required recovery-code redemption browser step (Decision §7), which was not run; it is covered by database tests at `512d5e8` only (section D) and is an owner risk row (section B). Deployment is blocked by owner prerequisites that have no evidence yet: the recovery and migration rehearsal on a production-derived branch; `main` protection (pull request plus green CI, no bypass); `EMAIL_DELIVERY` read back as `off` and `MATFLOW_ADMIN_SECRET` rotated; the preview-deployment decision; the residual decisions in section B; and provider-side revocation evidence for the leaked Neon password and Resend key.
2. **What remains exposed after deployment.** The application runs as the database owner role, so row-level isolation is a backstop the application can bypass and audit rows are editable (SF-62/57/73/74; unchanged by this release; not "accepted" merely because it exists today). SF-137 (a signed-in owner shown the login page under database pressure). Burst availability (SF-118/119/59). Member second-factor codes not single-use (SF-90). Inline scripts still allowed by the enforced CSP (SF-30). Old Vercel deployments holding pre-rotation configuration until they are deleted. The Stripe key whose prefix leaked and the leaked `CRON_SECRET` (local only). No monitoring baseline or alert thresholds.
3. **Can Sean's correction proceed after the post-release checks?** Yes, provided every post-release check in packet section 7 passes. The exact two-step workflow passed on TEST in both roles (flows 4, 6, 6b, 7; checker 38/38). The replacement address for the member record agreed on 9 Oct (private record) is permitted by the code (section D). No e-mail is sent. If any post-release check fails, Sean's account is not touched.
4. **Remaining blockers and owners.** Noe: section C, in dependency order (including the evidence to gather before deciding, C step 4). The coordinator: re-read the production variable names immediately before approval, dry-run the Q12 queries on TEST, and the follow-ups in Q13. Sean: voice confirmation of his intended login address and his own sign-in after the change.
5. **Next concrete action:** sign in to the current operator console with password and authenticator and confirm the code is challenged (two minutes; nothing else is safe to change if this fails). Then the `EMAIL_DELIVERY` read-back (C step 2).

## B. Decision table in plain English (decision column empty)

The full table, with every row's failure, trigger, recommendation, mitigation and effect on Sean's correction, is RELEASE-PACKET-512d5e8.md section 6 (including the rows added at 11:25) and Q1 below. Summary of what you are being asked to decide:

| Risk | Plain-English effect | Recommendation | On Sean's path? | Decision |
|---|---|---|---|---|
| SF-137 | Under database pressure a signed-in owner sees the club-code page with no message; still signed in; reload works; contract violated; code unchanged | ACCEPT for this release, fix next — or FIX FIRST (small) | only if the database is slow during his sign-in | |
| SF-138 | Your own address is written into a club's audit log when you open a support session | ACCEPT, fix next | no | |
| SF-139 | A slow (not locked) purge step is logged as busy, not failed | ACCEPT | no | |
| SF-140 | One misleading log line about a dead connection | ACCEPT | no | |
| Stripe duplicate events → 500 | A duplicate event would be retried, not silently lost; matters only with a live endpoint (none reported in Decision §3a; not re-read — owner to confirm on Stripe → Developers → Webhooks) | ACCEPT on condition: owner confirms no live endpoint now, and none is created before the payments branch ships | no | |
| Recovery-code browser journey not run | Covered by database tests now re-run on `512d5e8`, both roles, all PASS (section D) | ACCEPT, add a browser step later | no | |
| SF-30 CSP | Inline scripts still allowed (unchanged from today) | ACCEPT | no | |
| SF-05 legacy links | Links issued before the release work until expiry (≤ 7 days); the workflow retires those for both addresses in Sean's club | ACCEPT | covered | |
| Owner route: synthetic domains not refused; support check only in the proxy; version bound at code entry (SF-09) | A typing error could set an unusable login. SF-09: if Sean changes his own address inside the 5-minute window before the grant, the operator's change overwrites it (trigger: concurrent owner self-service) | ACCEPT with an operator checklist rule ("never a synthetic domain"); Sean is told not to change his address during the window | **yes — type carefully; SF-09 affects his correction** | |
| SF-118/119/59 burst availability | A burst at one address can refuse the real owner with the wrong message | ACCEPT (fails closed) | only if under attack | |
| SF-90 member TOTP reuse | A captured member code works again within its window | ACCEPT, schedule fix | no | |
| Old deployments | Older builds behind Vercel SSO still accept the legacy operator secret | ACCEPT until release verification, then delete | no | |
| SF-131..134 | Readiness-script hardening | ACCEPT | no | |
| Drivers not in repo specs | Hub journeys proven by scratchpad drivers | ACCEPT, promote later | no | |
| Owner-role runtime database access, editable audit | Anyone with the runtime credential controls all data and the audit trail | Explicit owner decision required. Proposed: ACCEPT for this release only, as an explicit time-boxed decision on the stated impact and likelihood (one leak already occurred on 7 May; revocation unevidenced), review date release + 30 days, remediation SF-62 phases 1–3 then SF-57 v2. Not a default acceptance because the exposure already exists | no | |
| `main` protection | A direct push deploys and migrates production today | FIX FIRST (manual-mode prompt at release time) | no | |
| `CRON_SECRET` absent: class-instance and monthly-report crons not running | Without it the daily class-instance cron and the monthly-reports cron answer 503 and do nothing; ClassInstance rows stop being generated and members cannot check in once the current window lapses (same in production today) | Either name who presses the manual "Generate" and when, or set a new `CRON_SECRET` (never the leaked value) **only after `512d5e8` is serving and verified (Q10) and `RETENTION_CRON_ENABLED` is confirmed unset**. Never set it while `e8afb6a` or any older build serves: those builds have no retention gate, so the 03:30 UTC sweep would run and hard-delete clubs past the 30-day grace (one-way door, SF-127; `docs/security/RELEASE-SEQUENCE.md` 3.5/4.3 keeps it unset until Stage 4) | no (affects the club's check-in, not the correction) | |

## C. Remaining path (owner actions, dependency order)

1. Operator console sign-in with authenticator challenged (proves access before any change).
2. `EMAIL_DELIVERY`: in Vercel → Settings → Environment Variables (Production), read it; it must be exactly `off`; if it is not readable or not `off`, Edit → `off` → Save; record the "updated" time (Q5 step 1).
3. Rotate `MATFLOW_ADMIN_SECRET` (Production only; delete its Preview copy); confirm `OPERATOR_ALLOWED_IDS` is present.
4. Evidence before deciding (Q6; packet §6 "Items that need evidence"; §26.2):
   - credential revocation: Neon negative test with the leaked password (expect authentication failure; record time and outcome only); Resend API-keys page showing no key created on or before 7 May 2026;
   - Stripe → Developers → Webhooks shows no live endpoint for production (the condition of the Stripe row in section B);
   - SF-109: was the production demo club seeded with the committed demo password (rotate if yes);
   - re-read the names `ENABLE_GOOGLE_OAUTH`, `MATFLOW_CSP_ENFORCE`, `LOGIN_THROTTLE_ENABLED` in Production, and record the production compute size and connection limit;
   - one Sentry test event received from production;
   - whether Preview's `NEXTAUTH_SECRET` equals Production's (compare names and updated times, or rotate Preview's copy; §26.2).
5. Residual decisions (section B), including the publication of the branch history to the public repository (§19 "Publication on push").
6. Preview-deployment setting for the release branch push (packet section 7 step 2).
7. Recovery and migration rehearsal on `rehearsal-hub-512` (packet section 5, corrected): manual mode; delete the branch within 24 hours.
8. Release: manual mode; push `release/hub-512d5e8` and open the pull request; CI green; then ruleset tightening (D-14, no bypass actor); `pre-hub-release` restore-point branch created just before the merge; deployment approval A ("deploy 512d5e8"); merge commit; tree equal to `512d5e8`; 30-minute change window (Q3 order; packet §7 still lists the ruleset first, see §27.3).
9. Post-release checks (packet section 7 step 6); stop on any failure.
10. Sean: approval B, then the two-step hub workflow and verification (Q11, Q12).

## D. Corrections and evidence added after the lanes reported (12 Oct 11:15–11:30 UK)

- **Recovery-code database tests re-run on the exact candidate** (code identical to `512d5e8`; Node 24.21.0; TEST branch; guarded runners), 10:15–10:18 UTC — all exit 0, 0 unhandled rejections (`docs/readiness/hub-release-2026-10-12/evidence/recovery-db-tests-512d5e8.txt`; committed in `cf17d78`):

  | Test file | Owner role | Restricted role (`matflow_app`, RLS enforced) |
  |---|---|---|
  | owner-recovery-revocation-db | 5/5 | 5/5 |
  | sec-a-recovery-code-race-db (concurrent redemption) | 4/4 | 4/4 |
  | sec-a2-member-recovery-race-db | 4/4 | 4/4 |
  | totp-login-paths (subsequent login forced to enrolment) | 14/14 | 14/14 |

  This closes the "integration tests NOT RUN at `512d5e8`" gap in Q4. It also meets Q1 residual 6's acceptance condition, and replaces the `03ef584`-based evidence in §16 Limitations and the §26.3 recovery-code row (now: 5/5, 4/4, 4/4 and 14/14, both roles, at `512d5e8`). Two gaps remain as stated in Q4: no single test chains redemption → fresh sign-in → enrolment, and none redeems after a login-address change.
- **`docs/runbooks/DEPLOY-2026-10.md` section 5** recommended Instant Rollback; it is now marked SUPERSEDED with the fix-forward rule (an older deployment restores retired secrets and the legacy operator door; runbook line 190, `cf17d78`).
- **Packet section 3** wrongly called the `.skip` entry a marker file; it is a row in `_prisma_migrations` (94 real migrations plus that row).
- **Packet section 5** ran the migration rehearsal on the restore-point branch, which would have destroyed it as a restore point; it now has a two-branch paragraph: `rehearsal-hub-512` (migrated, booted, deleted within 24 h) and `pre-hub-release` (untouched restore point, created immediately before the merge). The wording residues found by the cross-check (step 1 naming the wrong branch; "before the release push"; the ruleset step's position; section 6 rows 9 and 10) were corrected in the packet on 12 Oct 13:10 UK (§27.3 item 10).
- **Packet section 6** was missing six residuals; added with empty decision boxes, plus a list of items needing evidence before deciding.
- **Packet section 7** still tightens the ruleset (step 3) before the push and pull request (step 4). This report's order (Q3: push, PR, green CI, then the ruleset) supersedes it; the packet correction is owed (§27.3).
- **Decision document** sections 5 and 8 still described `704ab57` and a fast-forward push; marked superseded.
- **Review hand-off README** still said production's idle-in-transaction timeout was unverified; it now records 300 s, read-only on 11 Oct (`db-role-inspect`, run at Noe's instruction). Its time stamp reads "16:12 UK"; the inspection was at 15:12 UK / 16:12 Italy (§27.3).
- **Denial register**: the status note records the D-9 outcome (independent review of L1) as later obtained under manual-mode approval (R10). Its D-11 statement overstates: D-11 refused running the repository's campaign e2e suite (`tests/e2e/campaign/**`) on `1ca92c0`; that was not re-requested and its outcome remains unobtained. The hub journeys were separately rehearsed with scratchpad drivers under manual mode (RH runs 2–3 on `704ab57`/`512d5e8`). D-8, D-10, D-12, D-14 as recorded. The register note needs that correction (§27.3).

**The agreed replacement address for the member record (reconciled).** The 9 Oct plan recorded the conflicting member record's new contact address (private record; not repeated here). At `512d5e8` the code lower-cases and trims it, checks it is unique within the club across staff and member login addresses, refuses a `@no-login.matflow.local` address and the erasure sentinel `deleted-…@deleted.invalid` (also refused when it is the member's current address; other `@deleted.invalid` addresses are not refused; `contact-email/route.ts:78-79,:164`), and does not fold plus-aliases into the base address — so the agreed address does not collide with his login address and is accepted (no plus-alias folding; unique in the club; not a synthetic domain). No e-mail is sent. Because the holder has no password, the audit row records `canSignIn=false`, `unverified=false` and `sessionsRevoked=false` (`contact-email/route.ts:225-248`: `unverified` and `sessionsRevoked` equal `canSignIn`); `Member.unverifiedEmail` is not written. It is not asked for again unless the fresh hub check differs (Q11 inputs). Conditions before use: the hub's Check address must show the holder is still that cancelled imported member, with no password and no other holder. Caveat: if the club ever invites that member record, whether the invite reaches Sean depends on his mail provider; deliverability is unchecked.

## E. Reconciliation between the two lanes

The lanes agree on every status that both cover. Where they differed, the later evidence wins: AQ1 recorded the recovery integration tests as NOT RUN at `512d5e8`; they now PASS (section D). AQ2 recommended creating the Neon branch as the first action; AQ1 recommended the operator sign-in check first; the coordinator takes AQ1's ordering because a failed operator sign-in invalidates every later step and costs two minutes. AQ2's "create `pre-hub-release` first" (27.4 item 5 as originally written) was also wrong in substance: the rehearsal branch is `rehearsal-hub-512`, and `pre-hub-release` is created only at C step 8, just before the merge; 27.4 item 5 now says so. AQ2's list of stale documents (27.3) is resolved by section D for the runbook, the decision document and the hand-off timeout value; the remaining items, and the packet, register and README wording residues found afterwards, are listed in 27.3 as still open.

Further reconciliations made by the coordinator (they override the lanes' original text, which has been updated in place):
- **Recovery-code tests.** The 512d5e8 re-run (section D) meets Q1 residual 6's condition and replaces the `03ef584` evidence in Q4, §16 and §26.3.
- **Part 2 statuses.** Section D closes the FAIL part of §23 (runbook superseded, `cf17d78`), the §26.1 `DEPLOY-2026-10.md` row, §25 disagreement 5, §17's idle-timeout limitation and the idle-timeout part of the §26.2 row (300 s, read-only, 11 Oct; source FINDINGS SF-135).
- **Owner-role runtime database access and editable audit.** One position everywhere (section B, Q1 residual 9, §17, §26.3): an explicit, time-boxed owner decision with a review date (proposed release + 30 days; SF-62 phases 1–3, then SF-57 v2), never a default acceptance because the exposure already exists. The packet §6 row wording "ACCEPT as unchanged existing exposure" does not comply with requirement 17 and should be reworded to match (27.3).
- **Release order.** Q3's order (push, PR, green CI, then the ruleset, then the restore point and the merge) is the one used in section C, Q13 and §21; packet §7 is out of date on this point. Deployment approval A comes after the restore point and immediately before the merge (C step 8; Q13 checklist step 9): the push and pull request precede it and do not deploy; approval A authorises the merge and packet §7 steps 5–6. Packet §7's heading ("executed only on Noe's explicit 'deploy 512d5e8'") is superseded accordingly.
- **`CRON_SECRET` and the retention gate.** The serving build `e8afb6a` has no `RETENTION_CRON_ENABLED` gate (`ed567c4` is not its ancestor), so the absent `CRON_SECRET` alone stops its retention sweep. One rule everywhere (section B, Q1 residual 3 and e, §22, §26.4, Q13): a new `CRON_SECRET` only after `512d5e8` is serving and verified, with `RETENTION_CRON_ENABLED` confirmed unset; never while `e8afb6a` or an older build serves.
- **`EMAIL_DELIVERY`.** One procedure (read back, edit only if not `off`) in A, C, Q5, Q13 and §26.1; the variable is verified through `GET /api/tenant/<slug>`, not the health route.
- **Decision rows.** Packet §6 has seventeen rows (eleven plus six added 11:25 UK); Q1 and Q13 count seventeen. One further owner decision not in the packet is listed in section B and Q1 (e): the absent `CRON_SECRET`.

## F. Follow-up answers (12 Oct 2026, 13:45 UK)

**F.1 Did the 43 report fixes change code? No.** They changed documentation only. The final executable is unchanged: **`512d5e8d622f0a9cf514d1f5b5663e4e07c8939e`**. Since `512d5e8` the branch has further commits: all touch `docs/` only except `8d6c93c`, which adds the read-only tooling script `scripts/readiness/class-window-readonly.mjs`. The release branch is cut at `512d5e8` itself (packet section 7), so none of these enters the deployed executable. No verification is affected: the gates, the R10 review, rehearsal run 3 and the recovery-code database runs all refer to `512d5e8`'s code (`git diff 512d5e8 HEAD -- app lib auth.ts proxy.ts prisma package.json package-lock.json next.config.ts tests` is empty).

**F.2 Class generation for Total BJJ.**
- **How check-in depends on it** (code at the serving build `e8afb6a`, identical at `512d5e8`). Member self check-in, kiosk check-in and card check-in all require a pre-generated `ClassInstance` for the class and day (`app/api/checkin/route.ts`, `app/api/kiosk/[token]/checkin/route.ts`, `app/api/checkin/card/route.ts`). The member schedule returns `classInstanceId: null` when none exists, and the member home then offers no check-in. Instances are created in four ways: (a) for 56 days when a class is created or edited (`ROLLING_WINDOW_DAYS`); (b) by the timetable's **"Generate 4 weeks"** button (owner or manager; 28 days from the club's today; writes only missing rows) and the per-class "Generate schedule instances" button; (c) for today only, when a staff member opens Coach → Today (`ensureTodayInstances`); (d) nightly by the class-instances cron, which answers 503 and does nothing while `CRON_SECRET` is absent. When the window lapses, check-in fails silently for members and the register is empty (`app/api/cron/class-instances/route.ts:4-14`).
- **Last usable scheduled class date: NOT YET ESTABLISHED for production.** It needs one read-only query of production data. The tool is `scripts/readiness/class-window-readonly.mjs` (`8d6c93c`): one READ ONLY transaction, host-guarded, printing class ids, timetable labels and dates only, with no personal data. On the TEST branch's copy of the club (a seeded timetable) it reports an earliest last instance of 2 December 2026, 51 days remaining and 164 future instances. That is the test copy, not production. Production command, which Noe runs himself or approves the coordinator running in manual mode:
  `node scripts/readiness/class-window-readonly.mjs .env ep-bold-wave-abt39t7x totalbjj`
  It prints each class's last generated date and `RESULT: earliest last instance = <date>; days remaining = <n>`.
- **Smallest safe remediation** (no `CRON_SECRET` on the serving build).
  1. If the production result shows fewer than about 21 days, Sean or a manager presses **Timetable → Generate 4 weeks** once. That extends every active class 28 days from today and writes only missing instances. Repeat every three weeks until step 2.
  2. The durable fix, after `512d5e8` is serving and verified: set a NEW `CRON_SECRET` (Production only, Sensitive, never the leaked value), with `RETENTION_CRON_ENABLED` confirmed absent (re-read 12 Oct 13:40 UK: absent), then redeploy the same SHA. The class-instances cron then keeps 56 days ahead every night; retention stays off on its own gate; the monthly-reports cron answers 500 "AI service not configured" because `ANTHROPIC_API_KEY` is absent, so no club data goes to an AI service.
  3. Never set `CRON_SECRET` while `e8afb6a` (which has no retention gate) or any older build is serving or could be rebuilt. If the release ever has to fall back to older code, delete `CRON_SECRET` first.

**F.3 Credential revocation, tied to the specific exposed credentials.** What leaked on 7 May (commit `fa3c460`, `docs/SECURITY-AUDIT-2026-05-07.md` line 52, read with the value redacted) is a Neon password of the `npg_` form **without** a role name or host, and a full 36-character Resend key of the `re_` form. Date-based statements ("the role was updated today", "one key created today") show that something changed. They do not show that the exposed values stopped working, and they are withdrawn as revocation evidence.

| Check | What it proves | What it does not prove | Status |
|---|---|---|---|
| N1. The password production uses now does not match the leaked password's fingerprint (`ops-credential-fingerprint.mjs`, local, value never printed; re-run 12 Oct 13:35 UK), **and** that password authenticates as `neondb_owner` on `ep-bold-wave-abt39t7x` (`db-role-inspect`, 11 Oct 16:12 UK) | A Postgres role holds exactly one password, and production's only application login role is `neondb_owner` (roles on production, read 11 Oct: `cloud_admin`, `neon_service`, `neon_superuser`, `neondb_owner`). So the leaked string is not `neondb_owner`'s current password on production and cannot authenticate as it there | That Vercel holds the same string as the local `.env`. Both came from the same reset; the serving deployment connects, so Vercel's value is a valid password, and a role has only one, so it equals the tested value | **PASS (documented inference)** |
| N2. The test branch's credentials (`TEST_DATABASE_URL`, `RESTRICTED_DATABASE_URL`) do not match the leaked fingerprint (local, 12 Oct 13:35 UK) | The leaked password does not open the TEST branch either. A branch created from production before a reset would inherit the old password; this one does not hold it | Other branches. The project has two (production, test) per the owner's dashboard read; any branch created later inherits the current password | **PASS** |
| N3. One connection attempt with the leaked password against `ep-bold-wave-abt39t7x` as `neondb_owner`, expecting `password authentication failed` | Direct proof, at that moment, that the exposed value no longer authenticates | — | **NOT RUN.** Requires Noe's specific approval (old-credential authentication). Recommended only if N1's inference is not accepted |
| R1. Resend API-keys page: the owner reports one key, created 11 Oct | No key created on or before 7 May remains in the account | That the specific leaked key is the one deleted. Resend does not display the secret, so the key list is not tied to the value | REPORTED, date-based: not revocation evidence |
| R2. One read-only Resend API call with the leaked key (for example `GET /domains`), expecting `401` with an invalid-key error name (not `restricted_api_key`, which a still-valid sending-only key would also return) | Direct proof that the exposed key no longer authenticates at Resend | — | **RUN 12 Oct 14:32 UK under Noe's specific approval: PASS.** The one `re_` key in `fa3c460` (36 characters, sha256 prefix 7879e886) was sent once to `GET https://api.resend.com/domains`; Resend answered `HTTP 400 validation_error "API key is invalid"` at 13:32:52Z. That is Resend's answer for a key that does not exist; a still-valid sending-only key answers `401 restricted_api_key` and a valid full key `200`. The key was read from git and passed to the request in-process, never printed. Script: scratchpad `hub/r2-check.mjs` |

Recommendation: accept N1 and N2 for Neon, a sound inference from one password per role with both facts it rests on verified. Run R2 for Resend under your explicit approval, because no other evidence ties revocation to the leaked Resend key.

**Outcome (12 Oct 14:33 UK).** R2 PASS: the leaked Resend key no longer authenticates. Noe approved the plan ("approved all plan", 14:33 UK), which accepts N1 and N2 for Neon; N3 is not run. The leaked `CRON_SECRET` is deployed nowhere and stays so; the Stripe prefix match is outside this release (no live Stripe).

**F.4 The `EMAIL_DELIVERY` commands.** From the repository folder, in this order:

```
npx vercel env rm EMAIL_DELIVERY production
npx vercel env add EMAIL_DELIVERY production
```

- The first **writes** configuration. It deletes the stored Production value of `EMAIL_DELIVERY` in the Vercel project `noetopalians-projects/matflow`, after asking you to confirm (`y`). Expected output: `Removed Environment Variable`. It has no effect on the serving deployment, which ignores this variable entirely (the switch was added on 7 Oct, after `e8afb6a`), and none on Preview.
- The second **writes** configuration. It creates `EMAIL_DELIVERY` for Production. At `Value?` type `off`. Leave it non-sensitive (no `--sensitive` flag) so its value can be listed later; `off` is not a secret. Expected output: `Added Environment Variable EMAIL_DELIVERY to Project matflow` (Production).
- To **read** without writing: `npx vercel env ls production` lists names, type and age only, never values. Expected afterwards: `EMAIL_DELIVERY | Encrypted | Production | a few seconds ago`. The effective value is read after the release from the public `GET https://matflow.studio/api/tenant/totalbjj` field `"emailDelivery": "off"` (release-verify `tenant.email_delivery_off`).
- Consequence to note: until `512d5e8` serves, production mail is live with the new Resend key. Any invitation or password reset an owner triggers today is sent.

**F.5 Production configuration names re-read** (12 Oct 13:40 UK; names, types and ages only): `OPERATOR_ALLOWED_IDS` present (Sensitive, set 01:35 UK); `EMAIL_DELIVERY` present (Sensitive, 4 days); `MATFLOW_ADMIN_SECRET` present on Production and Preview (53 days); `LOGIN_THROTTLE_ENABLED` present (Sensitive, 19 days, value unknown); `TESTING_MODE` present on Production and Preview (ignored in production by the code at `512d5e8`, `lib/testing-mode.ts`); `CRON_SECRET`, `RETENTION_CRON_ENABLED`, `ENABLE_GOOGLE_OAUTH` and `MATFLOW_CSP_ENFORCE` absent.


---

# Part 1 — Questions 1–13 (lane AQ1)

## Q1. What exactly am I accepting?

**Status: BLOCKED.** All seventeen decision boxes in packet §6 (eleven original plus six added 12 Oct 11:25 UK) are empty. Six further residuals (a–d at the end of this section, plus SF-90 member TOTP reuse and old Vercel deployments, entries 12 and 13) were missing from §6 and are now added to it (section D). One more owner decision, the absent `CRON_SECRET` (e), is not in §6. Nothing can be called accepted yet.

### §6 decision table, verbatim (the decision column stays empty)

Two notes on the packet text. The packet pre-labels row 10's decision box "☐ noted"; it is shown here as an empty box, and the label is the packet's, not a decision. Row 9's recommendation, "ACCEPT as unchanged existing exposure", does not comply with requirement 17 (existence is not a basis for acceptance); see residual 9 for the reconciled recommendation.

| Risk | Recommendation | Decision |
|---|---|---|
| SF-137 bare `/login` on an unknown revocation verdict (did not recur in run 3; code unchanged; cookie intact) | ACCEPT for this release as Low–Medium UX under database pressure, fix in the next candidate — or FIX FIRST (small change in `lib/authz.ts`) | ☐ |
| SF-138 operator address in tenant audit metadata | ACCEPT (Low); fix next candidate | ☐ |
| SF-139 budget cut classified as busy (purge reporting) | ACCEPT (Low) | ☐ |
| SF-140 misleading guard log | ACCEPT (Info) | ☐ |
| Stripe webhook in-transaction P2002 catches now answer 500 (duplicates never acknowledged; endpoint could be flagged) | ACCEPT on the condition that no live Stripe endpoint is created before the payments branch lands | ☐ |
| Owner recovery-code redemption not browser-rehearsed (no driver; integration tests only) | ACCEPT with the integration-test evidence; add a driver step later | ☐ |
| SF-30 partial CSP (`unsafe-inline` still enforced) | ACCEPT (unchanged from production) | ☐ |
| SF-05 legacy untagged links valid until expiry (≤ 7 days) | ACCEPT (the workflow retires tokens for both addresses in the club) | ☐ |
| Runtime role `neondb_owner`, RLS as backstop only, audit rows editable (SF-62/73/74, SF-57) | ACCEPT as unchanged existing exposure; separate projects | ☐ |
| Environmental revocation-check `unknown` verdicts under load on TEST (P2028 earlier; connection timeouts now) | not a candidate defect; production has a different pool/latency profile; monitored via Sentry after release | ☐ |
| `main` PR + status-check protection not yet applied (D-14) | apply at approval time (manual mode) | ☐ |

**Rows added 12 Oct 11:25 UK (were missing from this table; found by the assurance lanes):**

| Risk | Recommendation | Decision |
|---|---|---|
| Owner login-email route does not refuse the synthetic `@no-login.matflow.local` / `@deleted.invalid` domains as a new owner login, and has no in-route support-session check (the proxy refuses support sessions on `/api/admin/*`, `proxy.ts:307-321`); version bound at code entry (SF-09) | ACCEPT with an operator checklist rule ("never a synthetic domain"; Sean asked not to change his own address during the window); fix in the next candidate. **Touches Sean's correction**: a typing error the code will not catch | ☐ |
| SF-118 / SF-119 / SF-59 burst availability: a burst at one address can refuse the real owner as "Incorrect email or password" after ~13 s; a saturated pool refuses other security buckets on that instance | ACCEPT (fails closed; nobody admitted); fix in a later candidate (stop holding a connection while waiting; correct the message) | ☐ |
| SF-90 member second-factor codes are not single-use | ACCEPT (existing; members only; needs interception); schedule the fix | ☐ |
| Old Vercel deployments with old secrets (SF-10, C5) still accept the legacy operator secret behind Vercel SSO | ACCEPT until release verification, then delete them through the separately authorised procedure | ☐ |
| SF-131..134 readiness-script hardening (lane denied, D-8) | ACCEPT (tooling only) | ☐ |
| Hub journeys proven by scratchpad drivers, not repository specs | ACCEPT for this release; promote the drivers to repository specs later | ☐ |

### Each residual in detail

**1. SF-137: bare `/login` after a successful sign-in**

- **Failure and who is affected.** The proxy admits a signed-in request. The page's own `auth()` call then gets an `unknown` revocation verdict because the database did not answer in time. `requireSession` / `requireStaff` respond with `redirect("/login")` and drop `?club=` (`lib/authz.ts:35`, `auth.ts:1524-1527`, `app/dashboard/layout.tsx:26`). The signed-in user (staff, owner, or a member on a page gated this way) sees the club-code box with no message.
  - The cookie is kept, and nothing is granted or exposed. In run 2 §5.1 the same tab made an authenticated 200 POST afterwards, and the fault test saw 0 clearing cookies.
  - The SF-44 contract (a retrying 503 page, "still signed in") is broken on this path.
- **Trigger.** The revocation lookup fails during the page render but not during the proxy check. That happens on a pool-acquisition or connection timeout under database pressure.
- **Observed frequency:**
  - Twice in real journeys: the first attempt, flow 4 (Node 25); and run 2, restricted pass, flow 7.
  - Run 3: 0 of 100 journey rows. There were 3 `unknown` verdicts; none produced a driver-visible `/login` landing, and whether any reached a page gate is not established (Run 3 §4.2).
  - The production frequency is unknown, and there is no baseline.
- **Recommendation: ACCEPT for this release, with the fix in the next candidate.**
  - It fails closed, keeps the session, and recovers on reload.
  - FIX FIRST changes the executable. That means a new review, gates and a browser rehearsal (an R10 + RH cycle) for a navigation defect that grants nothing.
- **Mitigation (procedural, no code):**
  - In the account-change procedure, tell Sean that if he lands on the club-code page after entering a correct password and code, he should open the dashboard again. Nobody should act on it as a failed sign-in.
  - The operator diagnoses from records before any mutation (Q12).
  - Revocation-check failures are logged and sent to Sentry (CR §1, `lib/session-revocation.ts:134-147`).
- **Affects Sean's correction?** Yes, potentially at Sean's first sign-in and in daily use. It does not affect the operator's steps, which use the operator plane.
- **What supports the severity:** see Q4.

**2. SF-138: operator address in tenant audit metadata**

- **Failure.** `admin.impersonate.start` stores the operator's own address in `operatorEmail` inside a club's audit metadata (`app/api/admin/impersonate/route.ts:223`). So do the application approve and create-tenant routes. A club's audit export or a DSAR could then show the operator's address. The reject route stores it in a tenantless platform audit row (not in any club's audit) and also writes it to the server log via `console.warn` (`reject/route.ts:72-75`; unchanged from `e8afb6a`).
- **Trigger.** An operator starts a support session into a club, approves an application, or creates a club; for the log line, rejects an application.
- **Recommendation: ACCEPT (Low).** The exposed data is the operator's own address, not member data. Attribution is already carried by `operatorId`.
- **Mitigation.** Do not start a support session into Total BJJ during this release; the correction needs none.
- **Evidence.** Run 3 §3 rows 9 and 17: the SQL check flags it in both roles.
- **Affects Sean's correction?** No, unless a support session is used.

**3. SF-139: budget cut classified as "busy"**

- **Failure.** A persistently slow (not locked) statement inside a tenant transaction hits the 15 s / 60 s budget. It is then classified as busy:
  - a club restore answers 503 "a deletion step is running";
  - the purge cron logs "skipped busy" instead of a failure.
  - Nothing is written either way.
- **Trigger.** Restoring or purging a soft-deleted club while one of its statements runs slowly. The retention cron cannot run in production today only because `CRON_SECRET` is absent (coordinator, 00:30 UK): the serving build `e8afb6a` has no `RETENTION_CRON_ENABLED` gate (its retention route checks only `CRON_SECRET`, `git show e8afb6a:app/api/cron/retention/route.ts:137-139`; the gate commit `ed567c4` is not an ancestor of `e8afb6a`). The gate exists only from `512d5e8`, where the live sweep runs only when `RETENTION_CRON_ENABLED` is exactly `"true"` (unset; `512d5e8:app/api/cron/retention/route.ts:131-144`).
- **Recommendation: ACCEPT (Low).** It affects reporting only, and it is the same classification as at `704ab57`.
- **Mitigation.** Nothing is written in either case (the refusal is fail-safe); once `512d5e8` serves, the purge cron is off on its own gate (until then, only by the absent `CRON_SECRET`); a club restore is an operator action, so a 503 "a deletion step is running" is retried by the operator and read against the audit rows, not taken as a failure.
- **Evidence.** R10 DELTA-HANDBACK line 10 (probes B4a/B4b, both roles).
- **Affects Sean's correction?** No.

**4. SF-140: misleading guard log**

- **Failure.** `guardPoolRelease` logs "released inside a transaction (status=T)" for a client whose connection had already died. Ending that client is harmless; the log line misleads anyone diagnosing an incident.
- **Trigger.** A pooled connection dies mid-transaction (server termination or network loss) and the client is then released; seen in R10's sec-a4 S2 owner run.
- **Recommendation: ACCEPT (Info).**
- **Mitigation.** Q10 incident handling treats that log line as "connection dead or in a transaction", not as proof of a transaction leak.
- **Evidence.** DELTA-HANDBACK line 11.
- **Affects Sean's correction?** No.

**5. Stripe webhook P2002 → 500**

- **Failure.** In `app/api/stripe/webhook/route.ts` at `512d5e8`, a duplicate-key error caught inside the transaction (`:529`, `:588`) now answers 500 "Processing failed".
  - Stripe then retries for about 3 days. A genuine duplicate is never acknowledged, and sustained failures can make Stripe disable the endpoint, which stops every webhook.
  - Before L2, the same case could commit nothing yet answer 200, losing the event without trace. The new behaviour is louder but not lossy.
- **Trigger.** A live Stripe webhook endpoint pointed at production, plus an event whose processing hits a unique violation (for example a redelivered or concurrent duplicate).
- **Recommendation: ACCEPT, on the stated condition** that the owner confirms no live endpoint exists now, and none is created before the payments branch lands.
- **Mitigation and evidence:**
  - DELTA-HANDBACK line 12.
  - Decision §3a says no live Stripe exists in production, with no connected account and no live endpoint. This lane did not re-read that. The condition needs one owner check: Stripe dashboard → Developers → Webhooks shows no live endpoint for the production domain.
- **Affects Sean's correction?** No.

**6. Owner recovery-code redemption not browser-rehearsed**

- **Failure.** The recovery route is database-tested, but its screen path has never been driven in a browser.
- **Trigger.** An owner (Sean, for example) loses the authenticator and uses a recovery code.
- **Recommendation: ACCEPT with the `512d5e8` database evidence.** The condition originally set here (re-run the recovery database files once at `512d5e8` under both roles) is MET (section D).
- **Mitigation and evidence.** Re-run on the exact candidate, both roles, 12 Oct 10:15–10:18 UTC, all exit 0: `owner-recovery-revocation-db` 5/5, `sec-a-recovery-code-race-db` 4/4, `sec-a2-member-recovery-race-db` 4/4, `totp-login-paths` 14/14 (`evidence/recovery-db-tests-512d5e8.txt`). Remaining gaps as in Q4 (no chained test; no redemption after an address change; no browser driver).
- **Affects Sean's correction?** Only as Sean's fallback. The correction leaves his recovery codes untouched, and the checker verifies their fingerprint and count (CR §6).

**7. SF-30: CSP partial**

- **Failure.** The enforced policy still allows inline scripts: `script-src 'self' 'unsafe-inline'` (`next.config.ts:11`, applied at `:100`). The nonce policy without `unsafe-inline` is report-only unless `MATFLOW_CSP_ENFORCE` is set (`lib/csp.ts:74-81`; CR §1). If any injection point existed, inline script would run in the victim's session, including an operator's.
- **Trigger.** An XSS vector. None is known; this is an amplifier, not a vector.
- **Recommendation: ACCEPT.** It is unchanged from production today. Enforcement follows a preview check.
- **Mitigation.** The Ledger SF-30 row records R5 evidence: 0 inline handlers, injection blocked when enforced. Request bodies on the hub routes are strict (CR §1, SF-33/98/99).
- **Affects Sean's correction?** Yes, as an environment risk: the hub runs in the operator's browser. There is no known vector.

**8. SF-05: legacy untagged links**

- **Failure.** Links issued before the release (every link production has minted so far) carry no subject tag. They stay valid on the old address-only rule until they expire: about 30 minutes for login links, up to 7 days for invitations (CR §1). If an address passes to a different person in that window, an old link can act for the new holder.
- **Trigger.** An untagged link is still outstanding when the release deploys, and its address is reassigned within the link's life.
- **Recommendation: ACCEPT.** The window is at most 7 days. The ledger fix is to remove the legacy branch 7 days after deploy.
- **Mitigation.** The hub workflow retires reset, login and first-time-signup tokens for **both** the old and the new address in this club (CR §5; `lib/login-email.ts:293,:302-329`).
- **Affects Sean's correction?** Covered for Sean's two addresses in Total BJJ. Other clubs and addresses are not covered.

**9. Runtime role `neondb_owner`, RLS as backstop only, editable audit rows**

- **Failure.** Production connects as `neondb_owner`. That role has BYPASSRLS, is a member of `neon_superuser`, and uses the direct host. Anyone holding that credential, or exploiting a SQL injection, can:
  - read and write every club;
  - rewrite, back-date or delete audit rows (SF-57);
  - alter the migrations ledger and operator rows (SF-73/74).

  RLS policies trust session settings that any role can set (SF-62). Isolation is enforced by the application only.
- **Trigger.** Runtime credential compromise, or SQL injection. The previously leaked password's revocation is REPORTED but not evidenced (Q6).
- **Recommendation: explicit owner decision required.** Proposed: accept for this release only, as an explicit time-boxed decision on the stated impact (a credential holder controls all data and the audit trail) and likelihood (one leak already occurred on 7 May; revocation unevidenced), with review date release + 30 days and remediation SF-62 phases 1–3 (estimated 13–19 agent-days, Ledger SF-62 row) then SF-57 v2. The fact that the exposure already exists is not the basis.
  - The packet §6 row wording "ACCEPT as unchanged existing exposure" does not comply with requirement 17 and should be reworded to match (§27.3). Section B and §26.3 carry the same reconciled wording (section E).
- **Mitigation evidence.** Run 3 passed every journey under the restricted `matflow_app` role on TEST. So the candidate code does not depend on the owner role, but production has no such role.
- **Affects Sean's correction?** Yes. The correction's own audit rows are editable by the runtime role, so the record is not tamper-evident.

**10. Revocation-check `unknown` verdicts under load**

- **Failure.** Under pool or connection pressure the revocation check cannot answer. The proxy then serves the retrying 503 page, which is correct. On the page path SF-137 applies instead. Nothing is ever admitted.
- **Trigger.** Database latency or pool saturation. The pool is `max` 5 per instance (`lib/prisma.ts`), on the direct host.
- **Recommendation: NOTED.** This is a monitoring item, not an acceptance. There is no production baseline, and AQ2 §24 covers thresholds.
- **Evidence.** Run 2 §5 (P2028 ×2 per role pass); run 3 §4.1 (0 P2028, 3 connection timeouts).
- **Affects Sean's correction?** Possibly during Sean's sign-in, as a 503 retry page or SF-137.

**11. `main` not protected by a required PR and CI check (D-14)**

- **Failure.** A direct push to `main` deploys **and** migrates production with no CI gate (Ledger SF-15). Affected: every club's data and the production schema.
- **Trigger.** Any push to `main` (accidental or by anyone with write access) before the ruleset is tightened.
- **Recommendation: FIX FIRST.** Apply it before the merge, with no bypass actor (Q3). It costs nothing.
- **Mitigation and evidence.** Until it is applied: no push to `main` other than the release merge; ruleset 24901063 today holds only no-deletion and no-force-push (coordinator read, 12 Oct 01:36 UK). The evidence after the change is the ruleset JSON read back (Q13).
- **Affects Sean's correction?** Indirectly: it controls what code reaches production.

**12. SF-90: member second-factor codes not single-use**

- **Failure and who is affected.** `Member` has no `totpLastUsedStep`, so a captured member authenticator code works again within its time window. Members with TOTP enabled are affected; staff, owners and operators are not.
- **Trigger.** An attacker intercepts a member's password and current code (phishing proxy or shoulder-surfing) and replays the code within its window.
- **Recommendation: ACCEPT, schedule the fix.** Existing behaviour, members only, and it needs interception.
- **Mitigation and evidence.** The password is still required; member routes refuse support sessions (SF-24). Evidence: FINDINGS SF-90 (OPEN; migration proposed); §16 table.
- **Affects Sean's correction?** No. Sean's owner sign-in uses the staff/owner path with single-use time-steps.

**13. Old Vercel deployments with old secrets (SF-10, C5)**

- **Failure and who is affected.** 62 of 64 older builds (9 Oct inventory) accept the legacy operator secret and hold pre-rotation configuration; anyone who reaches one with the old secret has operator access to every club through that build.
- **Trigger.** Vercel team access (the old URLs sit behind Vercel SSO, `all_except_custom_domains`) plus the old `MATFLOW_ADMIN_SECRET`.
- **Recommendation: ACCEPT until release verification, then delete** through the separately authorised procedure (D-3; packet §7.7).
- **Mitigation and evidence.** Vercel SSO on `*.vercel.app` (CONTAINMENT O6); deletion after release verification; the pre-rotation Neon and Resend credentials those builds hold are dead only if revocation is proven (Q6). Deletion is not credential revocation.
- **Affects Sean's correction?** No.

### Residuals that were missing from §6 (a–d, plus entries 12 and 13 above, added to packet §6 at 11:25 UK) and one not in §6 (e)

**a. Owner login-email route: no synthetic-domain refusal, no in-route support-session check, version bound at code entry (SF-09)** (Decision §3 row; CR §1 note, §4).
- **Failure.** The route does not refuse `@no-login.matflow.local` or `@deleted.invalid` as a new owner login, and has no support-session check of its own. The route is unchanged from `704ab57` to `512d5e8` (verified by `git diff --stat`). SF-09 (OPEN, Low): the route binds the subject version at code entry, not at the check the operator saw, so if Sean changes his own address inside the 5-minute window before the grant, the operator's change overwrites it. Affected: the club owner whose login is being changed.
- **Trigger.** An operator typing error (synthetic domain); a support session reaching the route (refused by the proxy first); concurrent owner self-service during the window (SF-09).
- **Recommendation:** ACCEPT, with the operator checklist rule "never a synthetic domain"; fix in the next candidate (in-route checks; compare the check-time version).
- **Mitigation and evidence.** The proxy refuses `/api/admin/*` to support sessions (`proxy.ts:307-321`); the operator checklist rule; Sean is told not to change his own address during the window. Evidence: §15 "Email correction" gap; packet §6 added row 1.
- **Affects Sean's correction: yes.** A typing error the code will not catch, and SF-09 if he changes his address during the window.

**b. SF-118 / SF-119: burst availability** (Ledger rows 137–138, OPEN, Low).
- **Failure.** Under a burst against one address, a correct password can be refused as "Incorrect email or password" after about 13 s. A saturated pool refuses every other security bucket on that instance (Retry-After ≤ 30 s). Affected: the targeted owner and other users on that instance.
- **Trigger.** A deliberate burst of sign-in attempts against one address.
- **Recommendation:** ACCEPT (fails closed; nobody is admitted).
- **Mitigation and evidence.** Fail-closed refusal; a retry after the window succeeds; Q12 case 5 tells the operator to read "Incorrect email or password" under load as possibly SF-118. Evidence: SF-118 40 concurrent sign-ins at pools 5 and 20; SF-119 TOTP bucket 5 of 60 through, apply bucket 0 of 60 (§18).
- **Affects Sean's correction:** only if his address is under attack during his sign-in.

**c. SF-131..134: readiness-script hardening** (Decision §3 row).
- **Failure.** Residual hardening gaps in the readiness scripts (the checker, release-verify, stage 0); affected: the operator running them, not production users.
- **Trigger.** Misuse or an unexpected input to a readiness script on the operator's machine.
- **Recommendation:** ACCEPT (tooling only; the lane was refused under D-8).
- **Mitigation and evidence.** The scripts are read-only against production, host-guarded and print no values (CR §6); every run's JSON is read by the operator.
- **Affects Sean's correction:** indirectly — the checker verifies it; its known omissions are covered by the Q12 queries.

**d. Rehearsal instrument**
- **Failure.** The hub journeys were proven by scratchpad drivers, not by repository specs (Decision §3; CR gap 9), so they cannot be re-run by CI or by a reviewer from the repository.
- **Trigger.** Any later change to the hub paths; a regression would not be caught by a committed browser test.
- **Recommendation:** ACCEPT for this release; promote the drivers to repository specs in a later candidate.
- **Mitigation and evidence.** The run records (runs 2 and 3, both roles) and the committed hub integration tests; the hub files are unchanged since the rehearsed SHA.
- **Affects Sean's correction:** no; the evidence for his path is run 3 flows 4, 6, 6b and 7.

**e. `CRON_SECRET` absent: class-instance and monthly-report crons not running** (not in §6; section B).
- **Failure.** `vercel.json` at `512d5e8` schedules three crons. Without `CRON_SECRET`, the class-instances cron (daily 02:40) and the monthly-reports cron answer 503 "CRON_SECRET not configured" and do nothing (`class-instances/route.ts:76-78`, `monthly-reports/route.ts:21-23`). ClassInstance rows then stop being generated, and members cannot check in once the current window lapses (`class-instances/route.ts:4-14`). Retention is a different case. At `512d5e8` it stays off on its own gate (`RETENTION_CRON_ENABLED` unset); the serving build `e8afb6a` has no such gate (its route checks only `CRON_SECRET`, `e8afb6a:app/api/cron/retention/route.ts:137-139`), so in production today the absent `CRON_SECRET` is the only thing stopping the 03:30 UTC sweep, which hard-deletes clubs past the 30-day soft-delete grace (SF-127). Affected: the real club's members and staff once members are imported. The same is true in production today (`e8afb6a`).
- **Trigger.** The generated window lapses (about four weeks after the last manual "Generate").
- **Recommendation:** owner decision: either name who presses the manual "Generate" and when, or set a new `CRON_SECRET` (never the leaked value). A new `CRON_SECRET` may be set only after `512d5e8` is serving and verified (Q10 checks passed) and `RETENTION_CRON_ENABLED` is confirmed unset; it must never be set while `e8afb6a` or any older build serves (`docs/security/RELEASE-SEQUENCE.md` 3.5 and 4.3 keep it unset until Stage 4, recovery tested).
- **Mitigation and evidence.** The manual "Generate" action; code citations above.
- **Affects Sean's correction:** no.

---

## Q2. What is the exact release candidate?

**Status: PASS, with limitations stated below.**

| Item | Value | Evidence |
|---|---|---|
| Full SHA | `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` | `git rev-parse 512d5e8` |
| Source tree hash | `182be72fb7a623d0cd1c12b6e14b3eb987e88f48` | `git rev-parse 512d5e8^{tree}`. This is the identity the merge commit must reproduce (Q3) |
| Branch | `security/assurance-2026-10` (local only; there is no remote-tracking ref for it, so the 187 commits since `e8afb6a` are not yet on GitHub) | `git branch -r`; `git rev-list --count e8afb6a..512d5e8` = 187 |
| Node (local evidence) | v24.21.0, binary checked against `SHASUMS256.txt`; npm 11.19.0 | Run 3 §1; `evidence/lead/gates-node24-512d5e8.log` line 1 |
| Node (production build) | Vercel project setting Node 24.x / `nodejs24.x` (observed on the serving build, 9 Oct); `package.json` engines `>=24.18.1 <25`. The exact minor version Vercel uses is printed in the build log and must be recorded at deployment | `CONTAINMENT-CHECKLIST.md` O3 |
| Build IDs | gates (isolated, TEST env): `XEFPlYyNsQ5F-CB6DKMKc`. Rehearsal run 3: `-VI8m-f5fjlPib2_etBjA`. `next.config.ts` has no `generateBuildId`, so each build gets a new random ID. **The production build will have a third ID.** Candidate identity is the git tree, not a build ID | gates log; Run 3 §1 |
| Independent review | R10 review of the L2 delta **at `512d5e8`**: APPROVED WITH RESIDUALS, R10-1..R10-5 CLOSED under both roles, 58 runs, gates on a clean worktree (`docs/security/evidence/R10/DELTA-HANDBACK.md`, saved 07:48 UK). Earlier R10 phases were at `1ca92c0` (PHASE1/PHASE2-HANDBACK). Ledger SF-135/136 rows read "FIXED — APPROVED WITH RESIDUALS by R10 at 512d5e8" | R10 files; Ledger rows 154–155 |
| Gates at `512d5e8` | lint 0 · `npm audit --omit=dev` 0 · unit 481 files, 6599 passed / 1 skipped · tsc 0 · build exit 0 · tree secret scan 8 candidates | gates log |

**Does `512d5e8` contain the reviewed SF-135/136 fixes?** Yes. `512d5e8` = `704ab57` + `1ca92c0` (L1) + `3e6dd26`, `0bbf0a1`, `2c6bd4c`, `38f8295` (L2 fixes) + `512d5e8` (test). R10 reviewed that delta at exactly `512d5e8`.

**Does it contain every source change the final browser rehearsal exercised?** Yes, by construction. Run 3 was built from a detached worktree whose HEAD was `512d5e8`, with an empty `git status --porcelain` after the build (Run 3 §1).

**Anything changed after those checks?**
- `git diff --name-only 512d5e8 HEAD` lists only files under `docs/` (five documentation commits: `665bc68`, `fc42f96`, `8768afb`, `e5636dc`, `cf17d78`).
- No code, configuration, migration or test changed after the review, the gates or the rehearsal.

**Limitations:**
1. The last full both-role sweep of every database test file was at `03ef584` (`evidence/lead/sweep-03ef584.txt`, 10 Oct), 77 commits before `512d5e8`. Since then five shared libraries changed: `lib/prisma.ts`, `lib/prisma-tenant.ts`, `lib/rate-limit.ts`, `lib/auth-lockout.ts` (sign-in lockout reservation, used by `auth.ts` authorize) and `lib/tenant-lifecycle.ts` (+367/−34, `git diff --numstat 03ef584 512d5e8 -- lib/`). At `512d5e8`, the database evidence is:
   - R10's transaction-focused suites and probes;
   - the recovery-code database tests re-run at `512d5e8`, both roles (section D);
   - the rehearsal journeys;
   - the PR's CI job, which runs the full suite, integration tests included, against a fresh Postgres 16 (Q3) and becomes the full run on the final tree.
2. The R10 hand-backs were saved by the coordinator because the reviewer's Write was refused. R10 is a separate agent lane, not a human; AQ2 §25 covers independence.
3. Vercel installs with its own install command, not the `npm ci` used locally (Ledger SF-15). The pinned `pg` 8.20.0 / `pg-pool` 3.13.0 should be confirmed in the Vercel build log.

---

## Q3. How will the pull-request release preserve the verified source?

**Status: NOT RUN.** The procedure is defined. The ruleset tightening is pending (D-14 in auto mode; it needs Noe's manual-mode approval or the GitHub UI).

| Item | Value |
|---|---|
| Current production SHA | `e8afb6a` (`e8afb6adf782…`), deployment `lxxo23g4i` READY (coordinator, Vercel API `meta.githubCommitSha`, 12 Oct 00:15 UK). Local `origin/main` = `e8afb6adf782b7b613899250dbe9164d9c71343c` (refresh with `git ls-remote` immediately before) |
| Release branch | `release/hub-512d5e8`, created at `512d5e8` from a clean checkout (packet §7.4) |
| Target | `main` |
| Merge method | GitHub "Create a merge commit". The repository allows merge, squash and rebase (Decision §7b). Squash and rebase would rewrite commits, so they are not used |
| Required CI | the job `Typecheck + Lint + Vitest` (`.github/workflows/ci.yml` at `512d5e8`, `on: pull_request`) |

**What that CI job runs:**
1. `npm ci` on Node 24 (pinned action SHAs);
2. `prisma migrate deploy` and the seed on a Postgres 16 service;
3. tsc;
4. lint;
5. Semgrep ratchet;
6. the full Vitest suite;
7. an RLS proof under a NOBYPASSRLS role.

No production secret is in its environment; it uses test-only values.

**Will merging create a new commit?** Yes. GitHub's merge-commit button always creates a merge commit, even when a fast-forward is possible. Call it `M`; its parents will be `e8afb6a` and `512d5e8`. Because `main` has nothing that `512d5e8` lacks (`e8afb6a` is an ancestor), `M`'s tree equals `512d5e8`'s tree.

**Establishing that `M` is the reviewed executable (all read-only, after the merge):**
1. `git fetch`, then `git rev-list --parents -n 1 M` → exactly `e8afb6a` and `512d5e8`.
2. `git rev-parse M^{tree}` must equal `182be72fb7a623d0cd1c12b6e14b3eb987e88f48`. One hash comparison proves the source is byte-identical. `git diff M 512d5e8` empty (packet §7.4) is equivalent.
3. Vercel deployment `meta.githubCommitSha` = `M`, READY (release-verify `vercel.production_sha`).

**Checks that must run on the final result:**
- **PR CI.** It runs on the PR's merge ref, which has the same tree as `M`.
- **CI on the push to `main` at `M`.** `ci.yml` has `on: push: branches: [main]`. It runs after the merge in parallel with Vercel. It is informative and does not gate the deploy.
- **The Vercel build log.** It must show the six migration names before `next build`.
- **Packet §7.6:** `release-verify --sha M` and `release-stage0-readonly`.

Vercel deploys `main` on push whatever the CI result says (Ledger SF-15), so the gate has to sit at the merge. That is what the ruleset change provides.

**Ruleset change:**
- Ruleset 24901063 today: active, deletion + non-fast-forward only, no bypass actor (coordinator, 01:36 UK).
- Proposed change (D-14):
  - require a pull request (0 approvals; a solo maintainer cannot approve his own PR);
  - require the status check `Typecheck + Lint + Vitest`;
  - keep no-deletion and no-force-push;
  - **no** linear-history rule, which would forbid the merge commit;
  - **no bypass actor**. No bypass is requested.

**Recommended order (one change to the packet).** The containment checklist §6 warns that if CI is red after the ruleset is applied, nothing can merge. So:
1. Settle the preview setting (Q5 step 4).
2. Push the branch and open the PR.
3. Wait for CI to go green.
4. Tighten the ruleset.
5. Merge.

If CI is red, stop. Any fix is a new candidate with its own review.

**Limitations:**
- CI has never run on this branch. `ci.yml` triggers only on PRs and on `main`, and production `e8afb6a` once shipped with CI failing (Ledger SF-15). A red result for environmental reasons (Semgrep registry fetch, Postgres 16 versus production 17) is possible and must be classified, not bypassed.
- Pushing the branch publishes 187 commits, including the security ledger and evidence, to a **public** repository (`CONTAINMENT-CHECKLIST.md` O7). §19 "Publication on push" assesses what that discloses. The owner should take that decision knowingly.

---

## Q4. What remains unverified in authentication?

**Status:**
- Owner recovery-code redemption in a browser: **NOT RUN**.
- Integration tests: **PASS at `03ef584`** (both roles).
- Integration tests at `512d5e8`: **PASS** (both roles; `evidence/recovery-db-tests-512d5e8.txt`; section D).
- SF-137: **OPEN**. The severity is evidenced; the cause is not resolved.

### Tests that cover recovery-code redemption

Found with `git grep -l recover 512d5e8 -- tests/`. The relevant ones:

| Test (at `512d5e8`) | What it covers | Last run, SHA, roles |
|---|---|---|
| `tests/integration/owner-recovery-revocation-db.test.ts` (5 cells; real route `app/api/auth/totp/recover`, real revocation check; `role: "owner"` row with 8 codes, `sessionVersion` 4) | a valid code clears the factor and secret, consumes exactly one code (8 → 7) and bumps `sessionVersion` 4 → 5, so a token at version 4 is `revoked` (**session effect**). Password hash and `mustChangePassword` survive. **Single use:** the same code again answers the opaque 200 and changes nothing (7 codes, version 5). Also covers the operator 2FA reset | `03ef584`, **both** roles (owner = `neondb_owner`, restricted = `matflow_app` with `RLS_ENFORCED=1`): 5/5 each (`evidence/lead/sweep-03ef584.txt` lines 20–21). Also 9 Oct both roles (`evidence/F/db-runs-final-2026-10-09.txt` lines 25–26). **`512d5e8`, both roles, 5/5 each** (12 Oct, `recovery-db-tests-512d5e8.txt`) |
| `tests/integration/sec-a-recovery-code-race-db.test.ts` (4 cells; same staff route; the test row is a `coach`, and the route has no role branch, so owners take the same path) | **Concurrent redemption:** two different codes at once → exactly one recovery, version +1 once, no consumed code comes back. The same code twice at once → one recovery. With no second factor nothing is spent. Positive control | `03ef584` both roles 4/4 (lines 22–23). **`512d5e8` both roles 4/4** (12 Oct). Red-then-green history in `evidence/A/LOG.md:136` |
| `tests/integration/sec-a2-member-recovery-race-db.test.ts` (member route, same four cells) | Member concurrency and single use | `03ef584` restricted 4/4. The owner role exited 1 with 4 skipped (`sweep-03ef584.txt:34`), then re-ran 4/4 (`sweep-03ef584-reruns.txt` line 3). **`512d5e8` both roles 4/4** (12 Oct) |
| `tests/unit/totp-recovery-codes.test.ts`, `staff-totp-setup-recovery-single-use.test.ts`, `reset-password-session-invalidation.test.ts` and others (mocked Prisma) | Helper single use, opaque responses (no enumeration), `sessionVersion: { increment: 1 }` on success, regeneration's step-up code spent once | `512d5e8` unit gate, 6599 passed (gates log) |
| `tests/integration/totp-login-paths.test.ts` (14 cells) | **Subsequent login:** after recovery `totpEnabled` is false, so an owner's next sign-in carries `requireTotpSetup` and is forced to `/login/totp/setup`. API routes get a JSON 403; the enrolment page and `/set-password` are reachable | `03ef584` both roles 14/14 (`sweep-03ef584.txt:112-113`). **`512d5e8` both roles 14/14** (12 Oct) |

**Gaps:**
1. **No test chains** redemption → a fresh sign-in at the account → forced enrolment. Each half is pinned separately.
2. **No test redeems a recovery code after a login-address change** (the lookup is by club + current address).
3. **No browser driver exists** for the recovery screen (Run 3 §5; Decision §7 had asked for "one added step for staff recovery-code redemption").
4. **CLOSED (section D): the database tests now have run at `512d5e8`.** The route files are byte-identical from `03ef584` to `512d5e8`; the libraries underneath (`withRlsBypass`/`withTenantContext` in `lib/prisma-tenant.ts`, `checkRateLimit` in `lib/rate-limit.ts`, the pool guard in `lib/prisma.ts`, plus `lib/auth-lockout.ts` and `lib/tenant-lifecycle.ts`) changed by +367/−34 across five files, including `lib/auth-lockout.ts`. R10's runs contain no recovery file, so the gap was closed by the 12 Oct re-run of the four files, both roles, all PASS.

**Does the missing browser journey leave a release requirement unmet?**
- Yes, one requirement the Decision set itself: §7, the "added step for staff recovery-code redemption". The packet turned it into an owner risk row (§6 row 6) instead of satisfying it.
- It is not on Sean's correction path. The correction redeems no code, and the checker verifies his recovery codes are unchanged.

**Recommendation.**
- The targeted run this lane recommended is done: the recovery database files plus `totp-login-paths` ran at `512d5e8` under both roles on TEST, all PASS (section D).
- With that evidence, ACCEPT the missing browser step for this release (an owner decision, section B), and add the driver step to the repository specs later.
- Reason: the route's logic is proven against a real database under both roles on the exact candidate. A browser driver costs a rehearsal cycle and covers a screen Sean's correction does not use.

### What supports SF-137's severity ("did not recur" is not resolution)

- **Defect reproduced twice in real journeys:**
  - first attempt, flow 4, Node 25 (Decision §7a);
  - run 2 restricted pass flow 7 at 02:59Z: sign-in accepted, ended on `/login`, followed by two P2028 "kept for revalidation" log lines (Run 2 §5.1).
- **Mechanism read in code.** `auth()` returns null for a session awaiting revalidation, and `lib/authz.ts:35` redirects (Run 2 §5.3).
- **Code unchanged at `512d5e8`.** `auth.ts`, `proxy.ts`, `lib/authz.ts`, `app/dashboard/layout.tsx` and `lib/session-revocation.ts` are byte-identical to `704ab57` (Run 3 opening). The trigger, an `unknown` verdict, still occurred in run 3: 3 connection timeouts (Run 3 §4.1). So the behaviour is present and was simply not hit.
- **Bounded at Low–Medium by evidence that it grants nothing and loses nothing:**
  - the cookie was kept and the same tab made an authenticated 200 POST;
  - 0 clearing Set-Cookie headers among 858 (fault test);
  - no data or authority is involved (Run 2 §5.4).
- **Not established:**
  - its production frequency (no baseline; production pool `max` 5 on the direct host);
  - whether every `unknown` on a page path produces it (Run 3 §4.2: "This lane cannot tell … which `auth()` call received the refusal").
- **Closure condition.** The ledger fix: a typed unavailable path mapped to a 503 that preserves `?club=`, a unit test on `lib/authz.ts`, and a browser cell. Retries passing do not close it.

---

## Q5. What exactly must I do in Vercel?

**Status: BLOCKED.** These are owner dashboard actions, not yet done.

Facts the steps rest on, all read at `512d5e8`:
- Vercel applies a variable change only to deployments created **after** it (`OPERATOR-ACCESS-RECOVERY.md`; `RELEASE-PACKAGE.md` §2.4). The serving `e8afb6a` deployment keeps what it was built with.
- `e8afb6a` has **no `EMAIL_DELIVERY` switch at all** (`lib/email-delivery.ts` is absent there and was added in `aff6682` on 7 Oct). **Production can send mail today** through the fresh Resend key. `EMAIL_DELIVERY=off` takes effect only with the `512d5e8` deployment.
- Set it to `off` (case and surrounding spaces are ignored). Unset, empty or `on` means **on**; any other value is treated as off, with a boot warning (`lib/email-delivery.ts:4-7,:40-51`; `lib/env-guards.ts:90`).
- At `512d5e8`, `MATFLOW_ADMIN_SECRET` authenticates nothing on any process with `NODE_ENV=production`, `VERCEL_ENV=production` or the production database (`lib/admin-auth.ts` `sharedAdminSecretPermitted`; `app/api/admin/auth/login/route.ts:24-29` refuses with 403 before reading the body; the `proxy.ts:343` edge copy).
- `e8afb6a` accepts the secret by header and by cookie (`lib/admin-auth.ts` at `e8afb6a`, `adminSecretHeaderAllowed` defaults to allowed).
- `OPERATOR_ALLOWED_IDS` on a production process: unset or empty admits **nobody** (`lib/operator-auth.ts` `isOperatorAllowed`). `e8afb6a` ignores it.

### Minimal ordered steps

**0. Preserve working operator access first** (`OPERATOR-ACCESS-RECOVERY.md` "Rollout", items 1–2).
- On the **current** site, sign in at `/admin/login` with your operator password **and** authenticator code, and confirm the console loads.
- This is the "fresh challenged login" the Decision §5 still lists as pending. Stage 0 showed the authenticator secret is present on Operator `cmoudu55l0000qktgw0r0ve2t` (coordinator, 01:33 UK), but presence is not proof.
- Keep your operator recovery material where you can reach it, without sharing it. If this sign-in fails, stop: enrol on the current build before going further.

**1. `EMAIL_DELIVERY`**
- Vercel → project → Settings → Environment Variables → filter **Production** → `EMAIL_DELIVERY`.
- CORRECTED 12 Oct 13:45 UK: it is stored **Sensitive** (`vercel env ls production`, read by the coordinator at 13:40 UK: `EMAIL_DELIVERY | Hidden | Sensitive | Production | 4d ago`), so its value cannot be read back in the dashboard or the CLI. The 9 Oct statement "non-sensitive, read back as off" is superseded.
- Re-set it deliberately to `off` (section F.4 gives the two commands). The only read-back of the effective value is after the release, from the public `GET /api/tenant/totalbjj` field `emailDelivery` (release-verify `tenant.email_delivery_off`).
- Record the "updated" time.
- Effective at the `512d5e8` deployment; it has no effect on `e8afb6a`.

**2. `MATFLOW_ADMIN_SECRET`**
- Production → Edit → paste a value generated on your machine with `openssl rand -hex 32`. Do not keep it anywhere; nobody needs it. Mark it Sensitive. Save.
- Delete the **Preview** copy (it is Production + Preview, containment step 8).
- Do **not** delete the Production entry before the release: `e8afb6a`'s boot guard still requires it, so a rebuild of that commit would fail without it.
- Why rotate when `512d5e8` ignores it? So that any fresh build or rollback of old code cannot be opened with a value anyone knows (`OPERATOR-ACCESS-RECOVERY.md` rollback note; `RELEASE-PACKAGE.md` §2.4).
- **Impact on current access: none.** The serving build keeps its old value until it is replaced, and after the deploy the secret is dead in production code.

**3. `OPERATOR_ALLOWED_IDS`**
- Production → confirm the variable exists. It was set 12 Oct 01:35 UK and is Sensitive, so the value cannot be read back.
- If you have any doubt about what was typed, Edit and re-enter exactly `cmoudu55l0000qktgw0r0ve2t`: one id, no spaces, no quotes.
- Do not add it to Preview.
- Effective at the `512d5e8` deployment; `e8afb6a` ignores it.

**4. Preview deployments**
- The decision is yours. **Recommendation:** Settings → Git (on some dashboard versions, Build and Deployment) → **Ignored Build Step** → custom command `[ "$VERCEL_ENV" != "production" ]`. It exits 0, meaning "skip", for every non-production build, and 1, meaning "build", for `main`. [NEEDS VERIFICATION of the control's location and label on the day.]
- Keep it in place until Preview has its own secrets (containment step 8), not just for this push.
- Effective for the next Git-triggered build: the release-branch push.

### When each takes effect, and the impact on operator access

Steps 1–3 take effect only at the `512d5e8` deployment. At that moment:
- every existing operator session is invalidated, because the session signature changed;
- you sign in again with password + code;
- the shared-secret door closes on the production domain;
- only the allow-listed id is admitted.

If you are refused after the deploy, the allowlist value is wrong or was not picked up. Fix it and redeploy (runbook "Rollout" D). There is no other door, and the shared secret must not be re-opened.

Legacy access on **old deployment URLs** stays open with the **old** secret until those deployments are deleted. They sit behind Vercel Authentication (`all_except_custom_domains`; CONTAINMENT O6). Rotating does not close them; retiring them does (packet §7.7, after verification).

### How the release verifies effective values without exposing secrets

| Setting | What proves the effective value | Evidence |
|---|---|---|
| `EMAIL_DELIVERY` | `release-verify` `tenant.email_delivery_off`: public `GET /api/tenant/<slug>` must report `emailDelivery: "off"` from the running deployment | `release-verify.mjs:116-123` |
| `MATFLOW_ADMIN_SECRET` | `legacy.header`, `legacy.cookie`, `legacy.login_post`: a **random** well-formed value must get the application's own 401/403 JSON; a redirect, 5xx or 429 counts as a failure. Together with the code, the real value is irrelevant in production. Rotation itself is shown only by the Vercel "updated" time (names and ages only) | `release-verify.mjs:17-31,:393-394` |
| `OPERATOR_ALLOWED_IDS` | `operator.access` (required on production): an authenticated operator request with your private session file → 200 JSON; then your challenged sign-in. That a **non-listed** operator is refused was proven on TEST (Run 3 flow 1), not on production. `release-stage0-readonly` lists the operator ids; if any row other than yours exists, it must be absent from the list | `release-verify.mjs:147-151,:396`; Run 3 §5 |
| Stored versus effective, in general | A variable whose "updated" time is earlier than the deployment's creation time is in that deployment (the method used 11 Oct) | `ITERATION-2-REPORT.md` row "Revocation of the 7 May leaked credentials" |

---

## Q6. What credential-containment evidence already exists?

**Status: BLOCKED.** Provider-side revocation is not evidenced for either credential. Replacement and deployment are evidenced.

Note the conflict with two cited sources: `ITERATION-2-REPORT.md` §9 records the Neon password and Resend key as "EVIDENCED (Stage 1.1 closed 11 Oct 17:07 UK)", and FINDINGS SF-14 records them as "MITIGATED". Both rest on owner-reported dashboard reads only, not a negative test. This report treats provider-side revocation as NOT EVIDENCED; the two documents should be corrected to match (§27.3).

| Stage | Neon (password of `neondb_owner` in `DATABASE_URL`) | Resend (`RESEND_API_KEY`) |
|---|---|---|
| Replacement created | **REPORTED** by Noe, 11 Oct 17:07 UK: Roles page shows `neondb_owner` "last updated minutes ago". The coordinator has not read it | **REPORTED** by Noe, 11 Oct 17:07 UK: exactly one API key, "created today". The coordinator has not read it |
| Stored configuration updated | **VERIFIED:** removed and re-added Production-only, Sensitive, 11 Oct 16:58 UK; age 7 h at 12 Oct 00:30 UK (coordinator). Still the **direct** host (pooled required by CLAUDE.md; a later change) | **VERIFIED:** removed from Production + Preview 16:37 Italy, re-added Production-only, Sensitive, 15:40 UK; age 9 h at 00:30 UK (coordinator) |
| Serving deployment updated | **VERIFIED:** `lxxo23g4i` (commit `e8afb6a`) READY 17:00 UK, after 16:58; health 200, db ok, 17:02 (`ITERATION-2-REPORT.md` revocation row) | **VERIFIED:** redeploy `ibeca0u39` (16:33 UK), then `lxxo23g4i` (17:00 UK), both after 15:40 |
| Exposed credential revoked | **NOT EVIDENCED** | **NOT EVIDENCED** |

**What does not count as revocation:**
- A new key's creation date.
- A local fingerprint non-match. `ops-credential-fingerprint.mjs` exit 0 only shows the laptop copy differs from the leaked value (`ITERATION-2-REPORT.md` row: "no match" for both).
- A Roles page saying "updated". That cannot tell a reset from a re-copied password, as the ledger itself notes.

**Exact missing evidence you must provide (values never shown):**

1. **Neon, negative test.** Use the leaked password from your own old copy. The leaked string is in public history (commit `fa3c460`); do not paste it anywhere. Connect once to `ep-bold-wave-abt39t7x` → expect `password authentication failed`. Record the date, time and outcome only. This is containment step 4's required evidence.
2. **Neon, role identity.** Confirm that the role named in the **leaked** string is `neondb_owner`: read the role name only. If it names a different role, that role's password must be reset and tested too.
   - Also note the Roles page's absolute "last updated" timestamp for every role (a screenshot with no values).
3. **Resend.** API Keys page screenshot showing name, permission, created date and last used, for every key. No key may be created on or before 2026-05-07 14:17 UTC (containment step 3). Record the new key's permission level ("sending access" restricted to the domain is the target).
4. **Resend logs (optional; strengthens 3).** For the available window, no request authenticated by a deleted key.

**Same leak, outside this release:**
- The Stripe restricted live key: its prefix matched the leak, and it has been deployed since 7 May.
- `CRON_SECRET`: it matches the leak in full, but exists only in the local `.env`.

Both remain open (`ITERATION-2-REPORT.md`; containment steps 5 and 7).

---

## Q7. What is the precise recovery procedure?

**Status: NOT RUN.** The restore runbook has never been executed against production data (Decision §4; `RESTORE-REHEARSAL-ISOLATED.md` §0).

**One correction to packet §5 first.** Packet §5 as first written created `pre-hub-release` and then ran the migrations **on the same branch**. Once migrated, it is no longer a pre-release restore point. `cf17d78` added the two-branch paragraph below to the packet, but its step 1 still names `pre-hub-release` (steps 2–4 say "the branch") and relies on the overlay note "read `rehearsal-hub-512`" (§27.3). Use two branches:

- **`rehearsal-hub-512`: the rehearsal branch.** Created now from production, migrated, booted, then **deleted within 24 hours**, because it carries about 922 members' personal data and the production password (runbook §1, §7).
- **`pre-hub-release`: the restore point.** Created from production **immediately before the merge** (after CI is green and the ruleset is tightened; the packet's "immediately before the release push" is superseded, §27.3) and left untouched until the post-release observation ends. A branch outlives the 6-hour history window only if the project's branch-expiry settings allow, so read and record them. Delete it only by a separate decision.

### Creating the rehearsal branch and checking its source point

**Approval first.** Record the four [AUTH] items of runbook §1 in the run record:
- one branch with a 24-hour deletion deadline;
- who runs it, on which machine;
- that person holding the branch connection string, which is a production secret because Neon branches inherit the parent's roles and passwords;
- confirmation that no production configuration changes.

**Pre-checks** (runbook §2): plan; history window (`history_retention_seconds`; recorded as 6 hours on Free, 11 Oct 16:55 UK, REPORTED); earliest restorable time; root branch id (`br-ancient-bird-ab1fz41d`, commit `105079a`); branch quota; Postgres version.

**Create it** (runbook §3): Neon → Branches → Create branch → parent = the production root branch → current data (or a point in time inside the window) → name → create with a compute. Record T0 and T1.
- **Source point:** the branch page's parent and "created from" time.
- **Expiry:** any expiry or auto-delete setting offered [NEEDS VERIFICATION of the label].
- **Cross-check the source point with data.** Production real-tenant totals (runbook §4.2, read-only on production) must equal the branch totals at the snapshot. `prisma migrate status` against the branch URL from a `512d5e8` checkout must show 94 applied plus the historic extra row, and 6 pending (Q8).

**Protect it from side effects** (runbook §5):
- a fresh worktree with **no** `.env*` file;
- every provider dark at its boundary (the table in runbook §5.2): invalid Stripe and Resend keys, no Blob token, no Sentry DSN, no `CRON_SECRET`, `TESTING_MODE=false`;
- fresh `AUTH_SECRET`/`NEXTAUTH_SECRET`, so no production token is valid;
- `MAINTENANCE_MODE=true` for the first boot;
- bound to `127.0.0.1`;
- a host guard: not `ep-bold-wave`, not `ep-hidden-salad`;
- the branch URL kept outside the repository, never in `.env`.

### What the rehearsal proves, and what it does not

**It proves:**
- **Data integrity of a branch copy:** per-table counts for a synthetic tenant and real-tenant totals equal production at the snapshot (§4.1, §4.2).
- **The six migrations apply to production-shaped data,** with timings, and locks observed if any step exceeds a second (packet §5.3).
- **Old code tolerates the new schema:** `e8afb6a`'s build boots and serves sign-in, a member page and the operator console on the migrated branch (packet §5.4).
- **The new code boots.** `512d5e8`'s build passes health, maintenance holds, and the synthetic Iron Path owner can sign in (runbook §5.3–§5.4). Never a Total BJJ account, never Sean's.
- **RTO excluding cut-over**, and data age (§6).

**It does not prove:**
- cutting production over to a restored branch (runbook "Not covered": that needs a `DATABASE_URL` change and a redeploy);
- Blob recovery (there is no Blob backup);
- recoverability beyond the history window unless `pre-hub-release`'s expiry is confirmed.

### Data-loss window, and writes after the branch

- **RPO** = the branch's creation moment, or any point within the 6-hour window by point-in-time restore.
- A restore discards every write after that point: attendance, sign-ins and audit rows, Sean's correction, imports.
- **Rule:**
  1. Declare a 30-minute change window from `pre-hub-release` to the end of post-release checks: no imports, no account changes except approval B, no club configuration.
  2. If a restore were ever needed, export the post-snapshot rows that matter (audit rows, attendance) from production before switching, as counts and ids in private files.
  3. Re-apply Sean's correction through the hub workflow, never by SQL.
  4. Reconcile attendance from its source.
- **The preferred response to any post-deploy fault is fix-forward** (Q8). A restore is for data damage, not for a failed build.

**Who executes, and what approval is needed:**
- Noe executes the Neon console steps and holds the branch URL. The agent's production reads stay refused in auto mode (DENIALS D-1).
- The coordinator may run individual commands only in manual mode with each call approved.
- Each [AUTH] gate needs Noe's recorded approval.
- Branch deletion is mandatory within 24 hours, and the name is checked twice.

---

## Q8. What happens during the six migrations?

**Status: NOT RUN** for the production-derived rehearsal. **PASS** for content review (CR §7). **NOT RUN** for the tested fix-forward path.

**The migrations,** in order: `20261006010000_operator_auth_hardening` · `20261006020000_tenant_lifecycle_safety` · `20261006040000_support_session_binding` · `20261006050000_operator_enrolment_ticket` · `20261007010000_login_email_provisional` · `20261009010000_audit_operator_request`.

- `git ls-tree -d` counts 94 migration directories at `e8afb6a` and 100 at `512d5e8`. The difference is exactly these six (CR §6).
- No payments migration and no proposal migration (SF-57, SF-62) is included: the proposals are files under `docs/security/evidence/` and not under `prisma/migrations/`. The payments branch's seven migrations are not ancestors of `512d5e8`.

**Rehearsal results.** None yet; packet §5 steps 2–4 are outstanding. On TEST, release-verify reported 100 applied under both roles (Run 3 §1). That is a test branch, not production-shaped data.

**Locking, data transformation and compatibility (CR §7 table):**
- Every change is `ADD COLUMN`, nullable, with no default, each migration in its own `BEGIN … COMMIT`.
- No NOT NULL, rename, drop or backfill; no new table.
- Each `ADD COLUMN` takes a brief ACCESS EXCLUSIVE lock on User / Operator / Tenant / AuditLog.
- `20261009010000` builds `AuditLog_tenantId_requestId_idx` without `CONCURRENTLY`, and validates a foreign key to `Operator` (SHARE / SHARE ROW EXCLUSIVE locks). With 120 `AuditLog` rows (coordinator, 01:33 UK) this is expected to be instant.
- No `lock_timeout` is set, so a long-running transaction on those tables at deploy time would make the migration, and the queries behind it, wait.
  - The production server reports `statement_timeout` 15 s (`b82ca48`, db-role-inspect). If that applies to the migration session, a lock wait over 15 s fails the migration cleanly rather than hanging. That is not established.
  - Run in a quiet period, inside the change window.
- `e8afb6a` ignores the new columns. It does not honour `loginEmailProvisionalSince` and writes no operator or request ids (CR §7).

**The extra historical migration row.**
- `release-stage0-readonly.mjs` counts `applied` from `_prisma_migrations` rows and reports "extra" rows (`:59-65`). Production showed 95 applied against the 94 of `e8afb6a`'s tree, and the extra is `.20260503200000_activate_rls_enforcement.skip`.
- So it is **a row in `_prisma_migrations`**, not a file. The packet's wording "a marker file, not a migration row" was corrected in `cf17d78`. The 18 Sep plan archive calls the same name "the orphan … row" on the test branch (`docs/superpowers/plans/2026-09-18-matflow-plan-archive.md:3517`).
- **Disposition: leave it untouched in this release.**
  - Every production build since May has run `prisma migrate deploy` successfully with it present (the serving deployment is READY).
  - `release-verify --expect-migrations local` does not look for extra rows (CR §6).
  - After deployment, stage 0 from the `512d5e8` checkout will still show `extra_on_db=1`. That is expected and is not a stop condition.
  - The branch rehearsal (Q7) should record whether `migrate deploy` prints any warning about it.

**If the migrations succeed but the build or deployment fails** (packet §5; CR §7):
- `package.json:7` runs `maybe-migrate.mjs && next build`, so a build failure happens after the schema changed.
- Production keeps serving `e8afb6a` on the migrated schema, which it tolerates (to be proven in Q7's compatibility boot).
- **Response: fix forward.**
  1. Do not re-push blindly.
  2. Read `migrate status`.
  3. Build the same commit `M` again. Noe does this from Vercel, because the coordinator's production redeploy is refused (D-12).
  4. **Never** Instant Rollback or Promote: they restore retired secrets and old configuration.

**If a migration fails partway** (CR §7):
- That migration rolls itself back; earlier ones stay applied.
- Prisma records the failure, the build stops, and later deploys refuse until the row is resolved with `prisma migrate resolve --rolled-back <name>`, which is a production write by Noe.

**Tested recovery or fix-forward path:** none yet.
- The fix-forward redeploy of the same SHA has not been rehearsed.
- The old-code-on-new-schema boot (packet §5.4) is the test that makes it safe, and it is outstanding.
- `migrate resolve` has never been exercised.

---

## Q9. What does disabling preview deployment change?

**Status: BLOCKED.** The owner decision is pending.

**Packet §7 step 2, verbatim:**
> 2. Vercel Git settings decision (**NOE**): pushing a release branch creates a **preview deployment** by default (no `DATABASE_URL` in Preview, so no migration; but a live URL of `512d5e8` with the Preview environment). Recommended: disable automatic preview deployments for this push (Vercel → Project → Git → Preview deployments off, or an "Ignored Build Step" for non-main), re-enable afterwards; alternative: accept the preview and delete it after the merge.

**Recommendation.** Use the Ignored Build Step (Q5 step 4), and keep it until Preview has separate secrets (containment step 8), rather than re-enabling it right after the release. A preview build of `512d5e8` would receive every Preview-scoped copy of production secrets for no release benefit.

| Does it affect… | Answer |
|---|---|
| CI | No. CI is GitHub Actions (`ci.yml` on `pull_request`), independent of Vercel |
| Browser verification | No. The browser evidence is the local production-mode rehearsal on TEST (Run 3). No preview was used, and the post-release checks run against production |
| Production secrets | It prevents a new preview runtime from holding the Preview copies. It does not remove the copies themselves |
| Automatic production deployment | No, if the command lets `VERCEL_ENV=production` build. If it were mistyped and skipped production, `release-verify` `vercel.production_sha` would FAIL: a stop condition, with no partial state beyond the migrations not having run |

**Preview access to production credentials that remains.** These are Preview-scoped copies, found in variable metadata from 9 and 12 Oct; equality of values is UNKNOWN unless stated:
- `BLOB_READ_WRITE_TOKEN`: Production, Preview **and Development**, non-sensitive; the production private store (coordinator, 00:30 UK; CONTAINMENT C5).
- `STRIPE_SECRET_KEY`: Production + Preview; the live restricted key, deployed since 7 May (CONTAINMENT C4).
- `STRIPE_WEBHOOK_SECRET`: Production (+ Preview) (C8).
- `NEXTAUTH_SECRET`: Production + Preview; whether the values are equal is unknown (C6). If they are equal, a preview runtime could sign sessions the production domain accepts.
- `MATFLOW_ADMIN_SECRET`: Production + Preview until Q5 step 2 deletes the Preview copy.
- `TESTING_MODE`: Production + Preview (161 days). At `512d5e8` it is ignored when `VERCEL_ENV=production` (`lib/testing-mode.ts`); on Preview it is honoured if `"true"`.
- No `DATABASE_URL` and no `RESEND_API_KEY` on Preview (coordinator).

**Existing deployments are not retired by this setting:**
- As of 9 Oct: 64 production deployments (0 previews) and 10 dangling branch aliases (CONTAINMENT O1/O2).
- Since then: `ibeca0u39`, one failed 16:46 build, and `lxxo23g4i`.
- Older builds hold the old Neon password and Resend key (dead only if Q6 revocation is proven) and the old `MATFLOW_ADMIN_SECRET`, with the legacy door open.
- All of them predate the `EMAIL_DELIVERY` switch.
- They sit behind Vercel Authentication on `*.vercel.app` and expire under the 30-day retention.
- Retirement is the separately authorised step: packet §7.7, containment step 9, D-3. Deletion is not credential revocation.

---

## Q10. What will prove deployment succeeded?

**Status: NOT RUN.** The checks are defined and run only after deployment. `release-verify` has passed against TEST in both roles (Run 3 §3 rows 8 and 16) but has never run with `--target production`.

All of these run **from the `512d5e8` checkout**, so `--expect-migrations local` derives exactly its 100 names (CR §6). Each must pass, in this order:

| # | Check | Expected | Stop if |
|---|---|---|---|
| 1 | Vercel build log of `M` | the six migration names, then `next build` exit 0; Node 24.x; `pg` 8.20.0 | a migration error, or a build failure → Q8 failure state |
| 2 | `release-verify --target production --sha M --base-url https://matflow.studio --tenant totalbjj --env-file-for-migrations .env --expect-host ep-bold-wave-abt39t7x --expect-migrations local --expect-operator-login --operator-session-file <private>` | exit 0 and every row PASS: `vercel.production_sha` (= `M`, READY) · `health` (200, `status ok`, `db ok`) · `migrations.applied` (all 100 finished, none failed or rolled back) · `tenant.email_delivery_off` · `legacy.header` / `legacy.cookie` / `legacy.login_post` (the app's own 401/403 JSON) · `operator.access` (200 JSON) | any FAIL or INCONCLUSIVE, or exit 1 or 2 |
| 3 | Tree identity | `git rev-parse M^{tree}` = `182be72fb7a6…` (Q3) | mismatch |
| 4 | `release-stage0-readonly.mjs .env ep-bold-wave-abt39t7x` | `missing_on_db=0`, `failed_or_in_progress=0`; `extra_on_db=1` (the historic `.skip` row; expected); the operator list shows only the allow-listed id | anything missing or failed; an unexpected operator row |
| 5 | You sign in at `/admin/login` with password + authenticator and open Total BJJ | the console loads, no "Bootstrap" tab, no new `admin.operator.refused` row for you | refused or no challenge |
| 6 | Sentry, first 30 minutes | no new unhandled-rejection class; no burst of revocation-check failures | a new error class on the auth or admin paths. **There is no baseline** (AQ2 §24), so any new class stops approval B |

**Notes:**
- The operator session file is a live bearer credential. Keep it outside the repository and delete it after check 2.
- The `.env` file used for migrations holds the production URL and is read only inside a read-only transaction with a host guard (CR §6).
- Agent reads of production need manual-mode approval (D-1); otherwise Noe runs them.

**Which failures prohibit Sean's account change:** every row above. Approval B is not requested until all six pass. In particular:
- a SHA, tree or migration mismatch means the running code is not the reviewed code;
- email delivery not reported `off` means the correction could be accompanied by mail;
- a legacy credential not refused means the old door is open;
- an operator access failure means the hub cannot be used, or the allowlist is wrong.

**What happens next if one fails:**
1. Stop all account mutations.
2. Preserve the JSON outputs and the build log (no secrets).
3. Classify the failure: configuration, build or code.
   - **Configuration** (allowlist, `EMAIL_DELIVERY`): fix the variable and redeploy the same `M` (Noe).
   - **Transient build or infrastructure:** rebuild `M`.
   - **Code defect:** a new candidate with its own review and rehearsal. `e8afb6a`-era behaviour must not come back through Instant Rollback or Promote.
4. If the console locks you out, follow `OPERATOR-ACCESS-RECOVERY.md` (allowlist fix and redeploy; `operator-access.mjs recover` against production only after the migrations ran).

---

## Q11. What will I actually click to change Sean's email?

**Status: NOT RUN** on production. The same sequence PASSED on TEST in both roles: Run 3 flows 4, 6, 6b and 7; checker 38/38.

**Inputs.** Use the existing private details recorded on 9 Oct: Sean's intended login address, and the previously agreed replacement address for the conflicting member record. They are not repeated here, and you are not asked for them again unless the fresh hub check below shows a different holder or state from the one recorded then.
- Under the code, the agreed replacement is permitted if it is a valid ASCII address, at most 120 characters, not used by any `User` or `Member` in Total BJJ, different from the member's current address, and not refused as a managed shape: the route refuses a `@no-login.matflow.local` address and the erasure sentinel `deleted-…@deleted.invalid` (also refused when it is the member's current address); other `@deleted.invalid` addresses are not refused (`contact-email/route.ts:78-79,:164`).
- **Plus-aliases and dots are not folded** (CR §4), so the replacement address agreed on 9 Oct (private record) is accepted by the code: no plus-alias folding; unique in the club; not a synthetic domain. Whether it satisfies the human rules (Sean accepts it, he or the club can read it, it is not his login) is your decision.

### Sequence

Labels are from `app/admin/tenants/[id]/LoginEmailCard.tsx` and `components/admin/ConflictPanel.tsx` at `512d5e8`; the order is from `OWNER-LOGIN-EMAIL-CHANGE.md` "Resolving a conflict" and Decision §6.

**A. Fresh facts, read-only, before the console:**
1. Club slug and immutable club id.
2. Sean's immutable `User.id` (`owner-account-state.mjs`, authorised for this step).
3. Sean confirms the intended login address by voice, on the number already held.

**B. Operator sign-in.**
4. Private browser window → `https://matflow.studio/admin/login` → operator e-mail and password → authenticator code → the console loads.

**C. Check.**
5. Open the Total BJJ tenant page. Confirm the club id matches A.1.
6. **Login email** card → **Change login email** → **New login email** = the intended address → **Check address**.
   - "Free in this club": no member step; go to step 12.
   - **Resolve conflict** panel: Club, Owner, **Held by** (kind, name, status, "Can sign in" / "Can activate (live invite or reset)" / "Cannot sign in", **Open record**, id).
   - **Stop** if the holder is a "Staff account", if only a count is shown (a legacy duplicate), if the holder is not the member recorded on 9 Oct, or if the club is wrong.

**D. Identity.**
7. Confirm independently that the member row is Sean, by call-back on the number held (`SUPPORT-IDENTITY-VERIFICATION.md`). Tick **"I verified the relationship independently"** and write how, with no unnecessary personal data.

**E. Baseline and approval B.**
8. Re-check the replacement with **Check address**: it must be free.
9. From the `512d5e8` checkout: `owner-login-change-check.mjs baseline --tenant totalbjj --owner-id <User.id> --member-id <Member.id> --expect-email-file <private file outside the repository> --expect-host ep-bold-wave-abt39t7x --env <env file> --baseline-dir <private dir>` → exit 0. Exit 1 means an identity mismatch: stop.
10. The coordinator shows you the preview: which record loses the address, which gains it, the sign-outs and token retirements, what is preserved.
    - **Approval B is given here, for these exact ids.**
    - **Declare the change window** (Q7).

**F. Member step.**
11. **Change this member's contact address** → **The member's new contact address** = the replacement → reason (10–500 characters) → **A new authenticator code** → **Change contact address**.
    - Read the result line: "They were signed out everywhere and sign in with the new address." or "They had no password: outstanding invite, sign-in and reset links were retired."
    - The panel then re-checks automatically. "Address re-checked — free in this club." means continue; anything else means stop.

**G. Owner step.**
12. "Your authenticator code works once. Wait for the next code before the second step." Once the next code appears: **Change the owner's login address** → code → **Change login address** → **Conflict resolved**.
    - If the network drops after you press a button, use **Re-send the same confirmation** only (Q12).

**H. Verify.** Run the checks in Q12, then tell Sean by voice to sign in with the new address, his own password and authenticator.

### Confirmations

- **How fresh identities and address ownership are checked:**
  - Club and owner: immutable ids read fresh (A.1–A.2); the baseline FAILS (exit 1) if the current addresses are not the expected originals (CR §6).
  - Member holder: kind, name, status, id and club from the check route under the per-club advisory lock (`lib/login-email.ts:176-242`), confirmed by a human call-back.
  - Address ownership: the code verifies nothing about who reads an address. The voice confirmation and the reason text are the only record (CR §4).
- **Member-record eligibility (code-enforced refusals, CR §3):**
  - cross-origin → 403;
  - not an allow-listed MFA operator → 403;
  - support-session cookie → 403;
  - more than 20 requests per operator+IP per hour → 429;
  - a body other than exactly `{newEmail, reason, version}`, or a bad address, reason or version → 400;
  - club or member not found, or member in another club → 404;
  - the member's current address synthesised or an erasure sentinel → 409 `managed`;
  - the new address synthesised → 400;
  - the new address equal to the current one → 400;
  - the new address held by anyone in the club (including a legacy duplicate) → 409 `taken`;
  - the member changed since the check (a version digest over id, `sessionVersion`, email, `externalRef`, password-present) → 409 `stale`;
  - a grant missing, invalid, expired, or bound to another session, action, target or change → 403;
  - the conditional write matching nothing → 409;
  - a unique violation → 409;
  - anything else → 500, with nothing changed.

  **Not refused:** a member with a password, live tokens, any status, TeamUp billing, a child with a real address, or `unverifiedEmail` set.
- **Effects of each mutation (CR §3, §5):**
  - **Member step.** One transaction: `Member.email` only changes.
    - Reset, login and first-time-signup tokens are retired for the **old and new** address in Total BJJ; waiver links are kept.
    - `Member.sessionVersion` +1 **only if** the member has a password at that moment (they are signed out everywhere).
    - Audit `admin.member.contact_email.changed` with keyed digests, `canSignIn`, `unverified`, `sessionsRevoked`, `sessionVersionAfter`, operator id and request id.
    - The `unverified` flag in audit metadata equals `canSignIn` (as does `sessionsRevoked`); for a passwordless holder it is false. `Member.unverifiedEmail` is not written.
  - **Owner step.** One transaction:
    - `User.email` changed; `loginEmailProvisionalSince` = now; `User.sessionVersion` exactly +1, so every owner session is signed out.
    - Reset, login and first-time-signup tokens for the old **and** new address are retired.
    - Audit `admin.owner.login_email.changed`.
    - Provisional means password + authenticator sign-in works. Forgot-password, magic links and Google sign-in are refused, and outbound mail to the address is refused (fail-closed). It does not prove mailbox control.
    - Sean's member session, if any, is unaffected by the owner step.
- **Is any e-mail sent?** No.
  - `EMAIL_DELIVERY=off` at `512d5e8`, confirmed by the post-release check.
  - Neither route sends mail.
  - Mail to a provisional address is refused even with delivery on (`lib/email.ts:410-426`).
  - The rehearsal recorded zero sends (Run 3 §5, flow 4).
- **Fields and relationships that must stay unchanged** (checker `verify`, CR §6):
  - **Owner:** id, club, role, password hash, authenticator secret and state, recovery codes (fingerprint and count), `mustChangePassword`, password-history ids, lockout.
  - **Member:** id, club, status, `externalRef` (import identity), credentials, memberships, attendance, guardian links (parent, confirmation, children).
  - **Two items the checker does not compare** are covered in Q12.

---

## Q12. How do we verify and recover from partial completion?

**Status: NOT RUN.** The procedure is defined, and the two queries are drafted here.

**The two checks the readiness script omits** (CR §6; Decision §6 step 10):
- **(a)** the `admin.login_email.checked` audit row. The checker's audit query reads only rows whose entity is the owner or the member; this row's entity is the Tenant.
- **(b)** the member's `sessionVersion` change. The checker's member comparison has no version check, although the baseline records it.

**How the final procedure covers them.** After `owner-login-change-check.mjs verify --path operator --operator-id cmoudu55l0000qktgw0r0ve2t` exits 0, run these two read-only queries:
- **Who runs them:** Noe, in the Neon SQL Editor on the production branch. That is the existing practice for read-only production queries (containment step 2), and agent production reads are refused (D-1).
- **Inputs:** ids only. The baseline's `takenAt` and member values are read from the private baseline file.

```sql
BEGIN READ ONLY;
-- (a) the hub's own audit trail for this change, ids and flags only
SELECT action, "entityType", "entityId",
       ("operatorId" = '<operator id>') AS operator_matches,
       ("requestId" IS NOT NULL)        AS has_request_id,
       "createdAt"
FROM "AuditLog"
WHERE "tenantId" = '<club id>'
  AND action IN ('admin.login_email.checked',
                 'admin.member.contact_email.changed',
                 'admin.owner.login_email.changed')
  AND "createdAt" >= '<baseline takenAt>'
ORDER BY "createdAt";
-- (b) the member's session version against the audit row's own record
SELECT m."sessionVersion",
       (a.metadata->>'sessionsRevoked')     AS sessions_revoked,
       (a.metadata->>'sessionVersionAfter') AS version_after
FROM "Member" m
JOIN "AuditLog" a ON a."entityId" = m.id AND a.action = 'admin.member.contact_email.changed'
WHERE m.id = '<member id>' AND m."tenantId" = '<club id>'
  AND a."createdAt" >= '<baseline takenAt>';
ROLLBACK;
```

**Expected results:**
- **(a):** at least one `admin.login_email.checked` row (every Check address, including the automatic re-check, writes one), with entity `Tenant` / the club id. Exactly one `admin.member.contact_email.changed` (entity = member id) and exactly one `admin.owner.login_email.changed`. Every row has `operator_matches = true` and `has_request_id = true`. The check route writes `operatorId` and a durable request id (`check/route.ts:142-157`; `lib/audit-log.ts:169-171`).
- **(b):** `sessionVersion` = `version_after`. It equals the baseline member `sessionVersion` + 1 if `sessions_revoked` is true, and is unchanged otherwise.
- **Expected audit values for Sean's correction** (the member holder recorded on 9 Oct is a cancelled imported member with no password): the `admin.member.contact_email.changed` row carries `canSignIn=false`, `unverified=false` and `sessionsRevoked=false`, and `version_after` equals the baseline member `sessionVersion` (unchanged). `Member.unverifiedEmail` is not written. If the fresh check shows the holder has a password, all three flags are true and the version is +1.
- Any deviation means "changed but unverified". Read it; do not fix it.

**Untested.** The query text has not been run anywhere. Its column and action names come from `prisma/schema.prisma` (model `AuditLog`) and the route code at `512d5e8`. A dry run against TEST, using a rehearsal fixture's ids, is a coordinator task that can be done now, and it gates approval B (Q13 checklist step 10a).

### Each partial-completion case

There are no blind retries, no automatic reversal, no direct SQL writes, and no password or MFA resets in any of these.

**1. The member change succeeds but the owner change fails.**
- The panel says "Step 1 done, step 2 not done" and offers to resume. A page reload resumes at the owner step after a fresh check (runbook "Half-done").
- Read the refusal:
  - `stale`, or a refused grant: wait for a fresh code and resume once (Run 3 flow 7 PASS, "stale-then-usable").
  - `taken`: case 3.
  - 500: nothing changed in that step. Stop and read the server-side cause before any further attempt.
- The member step is **not** reversed automatically. A reversal is a new, separately preflighted operation, and is possible only while the old address is free.

**2. A response is lost.**
- Press **Re-send the same confirmation**. The route recognises its own spent grant and answers `alreadyApplied` from the record. Nothing is applied twice, and a spent grant is never accepted for a new change.
- Owner route: `:123-131,:150-157`. Member route: `:174-179,:198-199`. Lost-response handling passed on TEST: member side flow 6 and owner side flow 6b, both roles (Run 3 §5).
- Never start a new mutation to "try again".

**3. Another record acquires the address between steps.**
- The owner change refuses with 409 under the advisory lock (`lib/login-email.ts`; owner route `:206-207,:253-263`), and nothing changes.
- **Stop.** Run Check address to see the holder, review it with the club, and get a fresh approval B for whatever follows.

**4. Verification fails after the mutation.**
- State is "changed but unverified". Read the exact failing check rows from the checker's JSON, which carry names, statuses and counts only, and the Q12 queries.
- Make no corrective mutation until the discrepancy is understood and a new preflight and approval exist.
- Freeze further account changes for the club.

**5. Sean cannot sign in.**
- Diagnose through authorised support (`SUPPORT-IDENTITY-VERIFICATION.md`) in this order:
  1. Is he using the **new** address exactly as recorded? The baseline's keyed digest is compared by the checker.
  2. Did he land on the club-code page after a correct password and code? That is SF-137 (Q1): open the dashboard again.
  3. A 503 "retrying" page means the database is unavailable. Wait.
  4. "Too many attempts" means the address lockout (10 failures per hour from unknown networks). Wait out the window.
  5. "Incorrect email or password" under load can be SF-118. Retry after a pause.
- **Never** disable MFA, reset his password or edit rows as a "fix". The operator recovery actions (force password reset, reset owner 2FA) are separate, audited, step-up mutations that need their own approval and identity verification.
- Rolling the address back is the same workflow in reverse, with a new approval (runbook "Rollback").

---

## Q13. What is still blocked, and what is the shortest remaining path?

**Status: BLOCKED.** Deployment approval (A) must not be requested yet.

### Work the coordinator can complete now (no production, no owner permission beyond normal TEST use)

| Task | Dependency | Evidence produced |
|---|---|---|
| Dry-run the two Q12 queries on TEST against a disposable fixture | TEST free | query output shape (ids and flags) |
| Correct the packet wording residues (§27.3): §5 step 1 to name `rehearsal-hub-512` inline; §5 (ii) "before the release push" → "before the merge (after CI is green and the ruleset is tightened)"; §7 steps 3–4 swapped (PR and green CI before the ruleset, Q3); §6 row 9 reworded to the reconciled owner-role wording (section E) | none; must be committed before anyone follows packet §5 or §7 (in any case before C step 7), because packet §5 (ii) as it stands would open the restore point and change window before CI | packet commit |
| Correct the DENIALS status note on D-11: the campaign e2e suite on `1ca92c0` was not re-requested and its outcome remains unobtained; the hub journeys were separately rehearsed with scratchpad drivers (RH runs 2–3) | none | DENIALS commit |
| Correct `evidence/review-handoff/README.md` item 8 time: "16:12 UK" → "15:12 UK (16:12 Italy)" | none | commit |
| Correct ITERATION-2 §9 and FINDINGS SF-14 so the Neon/Resend revocation status matches Q6 (owner-reported, not evidenced) | none | commit |
| Record or perform the cleanup of the first attempt's private files (`REHEARSAL-704ab57-RUN-2026-10-12.md`, cleanup not recorded) | the other session's scratchpad reachable | cleanup record |
| Verify and record the masking of lane RD's screenshots (`rd/*.png`) | RD scratchpad reachable | mask check recorded |
| Re-read the production variable names and ages immediately before approval | Noe's approval of the read (manual mode) | names and ages, no values |
| Draft the private expectations file template for the baseline (fields only, no addresses) | none | private file outside the repository |

Done since the lanes reported (section D, `cf17d78`): the recovery database tests at `512d5e8`, both roles; packet §3 and §5 corrections; the six missing residuals folded into packet §6; the DEPLOY runbook superseded; the decision document §5/§8 superseded; the review hand-off timeout; the DENIALS status note (which still needs the D-11 correction above).

### Dashboard actions only Noe can perform

| Action | Dependency | Permission | Evidence needed |
|---|---|---|---|
| Fresh challenged operator sign-in on the current site (Q5 step 0) | none | Noe | yes/no, time |
| Neon: negative test of the leaked password, role identity, Roles timestamps (Q6) | none | Noe | outcome text, timestamps, no values |
| Resend: API Keys screenshot, permissions (Q6) | none | Noe | dates and permissions only |
| Stripe: Webhooks page shows no live endpoint for production (Q1 row 5) | none | Noe | yes/no |
| SF-109: how the production demo club was created; rotate if it used the committed demo password (§26.2) | none | Noe | yes/no; rotation time |
| Sentry: one test event sent from production and received (§24) | none | Noe | event id and time |
| Vercel: re-read Production names `ENABLE_GOOGLE_OAUTH`, `MATFLOW_CSP_ENFORCE`, `LOGIN_THROTTLE_ENABLED`; Preview `NEXTAUTH_SECRET` equality (or rotate Preview's copy); Neon: compute size and connection limit (§26.2) | none | Noe | names, updated times, settings; no values |
| Decide `CRON_SECRET`: name who presses "Generate" and when, or set a new value — setting it only after `512d5e8` is serving and verified, with `RETENTION_CRON_ENABLED` confirmed unset; never while `e8afb6a` or an older build serves (Q1 e) | after Q10 checks pass | Noe | decision recorded; if set, the time it was set and `RETENTION_CRON_ENABLED` read back as absent |
| Vercel: `EMAIL_DELIVERY` read back as `off`; rotate `MATFLOW_ADMIN_SECRET` and delete its Preview copy; confirm `OPERATOR_ALLOWED_IDS`; Ignored Build Step (Q5) | operator sign-in proven first | Noe | variable names, "updated" times |
| Neon: rehearsal branch, restore rehearsal §2/§4/§5, migration rehearsal with timings, `e8afb6a` and `512d5e8` boots, RTO/RPO, branch deleted within 24 h (Q7, Q8) | [AUTH] approvals recorded | Noe (holds the branch URL); coordinator commands only in manual mode, per call | counts, timings, boot results, deletion time |
| GitHub: approve the ruleset tightening (D-14), after CI is green on the PR (Q3) | PR open, CI green | Noe (manual-mode prompt or GitHub UI) | ruleset JSON read back |
| Neon: create `pre-hub-release` immediately before the merge; record expiry | everything above done | Noe | creation time, expiry setting |

### Explicit risk decisions (Noe)

- The seventeen §6 rows (Q1): the eleven original rows and the six added rows (Q1 a–d, 12 and 13).
- The `CRON_SECRET` decision (Q1 e; section B).
- The publication of the branch's history to the public repository (Q3; §19 "Publication on push").

### Deployment approval (A)

Requested only after every row above has evidence. Approval A sits at checklist step 9: after the coordinator has pushed `release/hub-512d5e8` and opened the pull request with CI green (step 6, under per-call manual-mode approval and the preview setting chosen in C step 6), after the ruleset tightening (step 7) and after the restore point (step 8). The push and pull request do not deploy production. Noe's explicit "deploy 512d5e8" then authorises the merge as a merge commit and the tree-identity check (the remainder of packet §7 step 4), the build watch (§7 step 5) and the post-deployment checks (§7 step 6). Packet §7's heading, which puts every step after "deploy 512d5e8", is superseded on this point (section E).

### Sean's account-change confirmation (B)

After all Q10 checks pass:
- Sean confirms the intended login address by voice.
- The replacement address as agreed on 9 Oct (re-confirm only if the hub Check address shows a different holder or state).
- Independent identity confirmation.
- The coordinator has confirmed the Q12 queries were dry-run on TEST.
- The preview, then approval B for exact ids (Q11 steps 1–10).

### Tool denials

- **Still active in this auto-mode session:**
  - D-1: agent production database reads.
  - D-3: bulk deployment deletion.
  - D-12: agent production redeploy. Not re-requested; Noe deploys by merging and redeploys himself.
  - D-14: ruleset tightening. To be put to Noe.
- **Proposals only, not part of this release:** D-2 (SF-57 migration), D-4 to D-8.
- **Outcome later obtained under manual mode (register status note added in `cf17d78`):** D-9 (independent review of L1: R10 at `1ca92c0` and `512d5e8`).
- **Not re-requested, outcome unobtained:** D-11 (the campaign e2e suite `tests/e2e/campaign/**` on `1ca92c0`). The hub journeys were separately rehearsed with scratchpad drivers under manual mode (RH runs 2–3 on `704ab57`/`512d5e8`). The register's status note says otherwise and needs correcting (coordinator table above).
- Under manual mode each sensitive call is approved individually. **Manual mode is not blanket approval** (DENIALS, Noe's standing instruction of 10 Oct and the 12 Oct resolution note).

### Your actions, in dependency order

1. **First action:** sign in to the current operator console with password + authenticator, and confirm it works (Q5 step 0). Nothing else is safe to change if this fails, and it takes two minutes.
2. Return the decisions on the seventeen §6 rows (Q1), the `CRON_SECRET` decision (Q1 e; the choice only — if it is a new secret, it is set after step 10, never while `e8afb6a` serves), and the public-history publication decision (Q3; §19). If SF-137 is "fix first", the candidate changes, and steps 6 and 8 onwards wait for a new reviewed candidate.
3. Provide the Neon and Resend revocation evidence (Q6) and the Stripe webhook check (Q1 row 5).
   - 3a. SF-109: tell the coordinator how the production demo club was created; rotate if it used the committed password.
   - 3b. Send one Sentry test event from production and confirm receipt.
   - 3c. Re-read the Production variable names (`ENABLE_GOOGLE_OAUTH`, `MATFLOW_CSP_ENFORCE`, `LOGIN_THROTTLE_ENABLED`), settle Preview `NEXTAUTH_SECRET` equality (or rotate Preview's copy), and record the compute size and connection limit.
4. In Vercel: `EMAIL_DELIVERY` read back (it must be exactly `off`; edit only if not); rotate `MATFLOW_ADMIN_SECRET` and delete its Preview copy; confirm `OPERATOR_ALLOWED_IDS`; set the Ignored Build Step (Q5 steps 1–4).
5. Approve the [AUTH] items and run the Neon rehearsal branch: restore checks, the migration rehearsal, both boots, RTO/RPO, then delete it within 24 h (Q7, Q8).
6. Let the coordinator push `release/hub-512d5e8` and open the PR. Wait for CI to go green (Q3).
7. Approve the ruleset tightening (D-14) with no bypass actor.
8. Create the `pre-hub-release` restore-point branch and declare the 30-minute change window.
9. Give deployment approval A: "deploy 512d5e8" (merge as a merge commit).
10. Post-release checks (Q10), including your own challenged sign-in. Stop on any failure.
    - 10a. The coordinator confirms the Q12 queries were dry-run on TEST.
11. Sean: voice confirmation, the replacement address as agreed on 9 Oct (re-confirm only if the hub Check address shows a different holder or state), identity confirmed, preview, approval B, then the two-step change, verification and Sean's own sign-in (Q11, Q12).
12. Afterwards: retire old deployments (packet §7.7), and remove the SF-05 legacy branch 7 days after the deploy.

---

# Part 2 — Requirements 14–27 (lane AQ2)

## Summary

| # | Requirement | Status (by part) |
|---|---|---|
| 14 | Threat model and trust boundaries | PASS (model and application-layer controls) · FAIL (database-enforced isolation and runtime-credential compromise, existing exposure) |
| 15 | Privileged-access review | PASS with one exception (email-correction path, code + TEST browser, both roles; the owner route binds the subject version at code entry, not at the operator's check — SF-09, OPEN Low) · PASS (guard presence on all 49 changed privileged endpoints, static) · NOT RUN (fresh per-route independent re-review of the other endpoints in this lane) |
| 16 | Authentication and account-takeover paths | PASS (subject binding, single use, concurrency, retirement on address change — TEST both roles) · NOT RUN (owner/staff recovery-code redemption in the browser) · FAIL (member second-factor replay SF-90; legacy untagged links SF-05, both existing) |
| 17 | Database integrity and failure handling | PASS (transactional consistency, failure classes, reuse safety — TEST both roles, R10) · FAIL (editable audit and owner-role runtime, existing, unchanged) |
| 18 | Availability and resource limits | FAIL (one bucket/address can exhaust an instance pool; SF-118/119 open) · NOT RUN (production capacity) |
| 19 | Sensitive-data protection | PASS (changed code, rehearsal artefacts of runs 2–3) · FAIL (public-history credentials not proven revoked; SF-138) · NOT RUN (build output inspection; logged error-object contents) |
| 20 | Browser and request security | PASS (CSRF, validation, mass assignment, cache, headers on affected routes; payments COEP change excluded) · FAIL (enforced CSP keeps `unsafe-inline`, SF-30, existing) |
| 21 | Build, dependencies and provenance | PASS (gates, runtime, lockfile, CI permissions and pins) · FAIL (only-approved-source control not yet in force: D-14 pending; build/install with production secrets SF-20) · NOT RUN (the production build at the merge commit; PR CI) |
| 22 | Environment and configuration isolation | PASS (test bypasses and dev modes refused in production code) · BLOCKED (preview/historic deployments and stored-vs-effective values pending owner actions) |
| 23 | Migration and recovery safety | BLOCKED (production-derived rehearsal and restore not done — packet §5, owner) · PASS (`DEPLOY-2026-10.md` §5 superseded with the fix-forward rule, `cf17d78`) |
| 24 | Monitoring and operational response | FAIL (no baseline, no alert rules in evidence) · NOT RUN (Sentry delivery from production not evidenced) |
| 25 | Independent-review scope | PASS (final executable covered by independent review, gates and browser rehearsal) · NOT RUN (any human or organisationally independent review) |
| 26 | Security acceptance and release decision | Classification complete; owner decisions EMPTY |
| 27 | Evidence integrity and completeness | PASS (diff, routes, migrations, journeys reconciled) · FAIL (stale/contradictory documents listed in §27.3) · BLOCKED (configuration and operational prerequisites) |

---

## 14. Threat model and trust boundaries

**Status:** PASS — assets, attackers and application-layer controls are identified with evidence. FAIL — database-enforced isolation does not exist in production, and nothing protects against a leaked runtime credential. This is existing exposure, unchanged by this release and not accepted here.
**Executable:** `512d5e8`. **Environment:** CODE; TEST (both roles); PROD (db-role-inspect, run at Noe's instruction, 11 Oct 15:12 UK / 16:12 Italy; read-only).

**Assets in scope for this release.** Club owner login identities (`User.email`, password hash, TOTP secret, recovery codes, `sessionVersion`); member records and their addresses; the operator plane (`Operator` rows, MFA, step-up grants, allowlist); `AuditLog` as the record of privileged changes; sign-in tokens (invitations, login links, reset codes); runtime secrets (database credential, session signing key, mail key, Blob token, Stripe key, legacy admin secret); production data of the real club and the demo club.

| Attacker | What they can reach | Controls that apply (evidence) | What does NOT protect |
|---|---|---|---|
| Unauthenticated caller | login, reset, magic link, invitation acceptance, recovery-code door, health, operator login door | Same-origin check on mutating routes; per-address and per-network lockout with atomic reservation (SF-111, R7); rate limits fail closed on security buckets (SF-113, R7; `lib/rate-limit.ts`); subject-bound tokens (SF-05, `lib/auth-token-binding.ts:75-118`); no existence oracle on sign-in (SF-35, R6); shared admin secret grants nothing in production (`lib/admin-auth.ts:70-72`) | Burst availability: a right password can be refused as "Incorrect email or password" under saturation (SF-118); legacy untagged links until expiry (SF-05 residual) |
| Member | member portal, own profile/TOTP | `requireSession` + member `sessionVersion` (`lib/session-revocation.ts:109-111`); revocation fail-closed (SF-01/44); member routes refuse support sessions (SF-24) | Member TOTP codes replayable within their window (SF-90, OPEN) |
| Staff (coach/manager) | dashboard, registers, imports (manager) | Role guards (`requireApiOwner`, `requireApiRole`); tenant filter on every query; strict bodies on changed routes | RLS is not a backstop in production (below) |
| Club owner | everything in the club, account self-service | `requireApiStaff`/`requireApiOwner`; step-up not required for DSAR erase (SF-61, OPEN Low) | — |
| Compromised operator session | `/api/admin/*` | MFA session cookie bound to `sessionVersion` and expiry, allowlist checked on every resolution (`lib/operator-auth.ts:27-29`; in production an empty list admits nobody, `docs/runbooks/OPERATOR-ACCESS-RECOVERY.md` table), step-up grant per action/target/change/version, 5 min, single use (`lib/operator-step-up.ts:12-55,:73`); sign-out bumps `sessionVersion`; durable audit row before any grant | A stolen live session cookie plus a current authenticator code can perform any single step-up action until sign-out or expiry (8 h); no phishing-resistant MFA (runbook "Phishing-resistant MFA (recorded, not built)") |
| Leaked runtime credentials | the database directly; mail; Blob; Stripe; session signing | Rotation of the Neon password and Resend key (REPORTED by owner 11 Oct 17:07 UK; revocation not evidenced, SF-14) | **Nothing in the application.** Production runs as `neondb_owner` (BYPASSRLS, member of `neon_superuser`, direct host; db-role-inspect, run at Noe's instruction, 11 Oct 15:12 UK / 16:12 Italy; read-only). With that credential an attacker reads and writes every club, rewrites or deletes audit rows (SF-57 not applied), writes `Operator.passwordHash` (SF-73) and forges import provenance (SF-74). With a leaked session signing key, sessions can be forged |
| Malicious imported content | TeamUp CSV/XLSX, uploads | Identity binding rules (SF-06/51/54/67, approved by R through 788d29a); CSV formula guard (SF-38/52); upload pixel cap and per-principal limits (SF-40/86); SVG served as attachment (SF-42) | Raw-SQL takeovers and back-dated audit rows remain open by design until SF-57 and P2 land (SF-67 residual) |

**Application authorisation versus database-enforced isolation.**
- Application authorisation is the control in production. Every tenant query carries `where: { tenantId }` and runs through `withTenantContext` or `withRlsBypass`; operator routes resolve the club from the path.
- Database isolation (RLS) is enforced only when the app connects as `matflow_app`. That role exists on TEST but not on production. The TEST restricted passes in rehearsal run 3 prove the application works under RLS. They do not show production is isolated.
- Even under `matflow_app`, the policies trust two unregistered session settings (`app.bypass_rls`, `app.current_tenant_id`) that the role can set itself (SF-62, root cause by B2). RLS is therefore a backstop against application filter mistakes, not against SQL injection or a compromised runtime.
- 27 bare Prisma calls outside `withTenantContext` (SF-87) are latent under the pooled host. Production currently uses the direct host.

**Evidence.** `docs/security/THREAT-MODEL.md` (actors, boundaries 1–7, chains C1–C9); FINDINGS.md SF-02, SF-57, SF-62, SF-73, SF-74, SF-87; HUB-RELEASE-DECISION §1 row "Production runtime role"; run 3 §1 "Roles".

**Limitations / follow-up.**
- `THREAT-MODEL.md` was written for `2a6487e`. It has no row for the L1/L2 transaction layer or for the release path (PR, merge commit, preview deployment). The content is still accurate, but the document should be dated forward.
- The SF-62 boundary (13–19 agent-days per SF-62-APPLICATION-INTEGRATION.md) and SF-57 remain separate projects. Neither is claimed for this release.

---

## 15. Complete privileged-access review

**Status:** PASS with one exception — email-correction path (CODE + TEST browser, both roles); the owner route binds the subject version at code entry, not at the operator's check (SF-09, OPEN Low; below). PASS — a server-side guard is present on all 49 changed privileged endpoints (CODE, static). NOT RUN — a fresh independent per-route re-review of the other endpoints in this lane. Every one of them is byte-identical to the reviewed `03ef584`, so earlier reviews cover the code (see below).
**Executable:** `512d5e8`. **Environment:** CODE; TEST.

**Method.** `git diff --name-status e8afb6a 512d5e8 -- app/api/admin app/api/staff app/api/account app/api/auth` gives 49 files. Each was read at `512d5e8` for its exported methods and the guard calls it makes. `git diff --name-only 03ef584 512d5e8 -- app` lists only `app/api/cron/retention/route.ts` and `app/api/members/[id]/rank/route.ts`. So none of the 49 changed after the integrated iteration-2 candidate `03ef584`, which reviewers R6 and R7 reviewed and on which the both-role database sweep ran (112 runs).

**Common guards.**
- **Operator plane (`/api/admin/customers/*`, `impersonate`, `create-tenant`, `applications`):**
  - `assertSameOrigin`;
  - `isAdminAuthed`/`getOperatorContext` (an MFA session cookie, HMAC + expiry + `sessionVersion` equal to the database + TOTP enabled + allowlisted; `lib/operator-auth.ts:27-29,:80-101`; the shared secret is refused in production, `lib/admin-auth.ts:70-72`; every route refuses `!authed`);
  - a per-operator+IP rate limit;
  - a step-up grant for destructive actions (`requireStepUp` + `consumeStepUpGrant` inside the mutation transaction);
  - `withRlsBypass` with explicit `tenantId` filters;
  - `logAudit` in the same transaction.

  The proxy also refuses `/api/admin/*` for a support session (`proxy.ts:298-321`).
- **Club plane:** `requireApiOwner` / `requireApiRole(["owner"])` / `requireApiStaff` / role checks, plus `refuseSupportSession`, `assertSameOrigin` and `withTenantContext`.
- **Anonymous credential doors:** rate limit + token or subject binding.

| Endpoint (A = added, M = modified) | Methods | Server-side guard at `512d5e8` |
|---|---|---|
| A account/login-email | GET, POST | requireApiStaff (own account), same-origin, refuseSupportSession, rate limit, withTenantContext, audit |
| A account/password | POST | same as above |
| A account/profile | GET, PATCH | same as above |
| M admin/applications/[id]/approve | POST | operator gate, same-origin, rate limit, audit |
| M admin/auth/login | POST | legacy shared-secret door: same-origin, rate limit; grants nothing in production (`lib/admin-auth.ts:70-72`); refusal verified in TEST browser flow 2 |
| M admin/auth/logout | POST | same-origin; resolves the session without the allowlist, so a de-listed operator can still sign out; bumps `sessionVersion` |
| M admin/auth/operator-login | POST | same-origin, rate limit; password yields only a challenge or enrolment cookie |
| M admin/auth/operator-totp | POST | same-origin, rate limit, `isOperatorAllowed`, single-use time-step (`consumeOperatorTotp`), audit |
| M admin/auth/operator-totp/setup | GET, POST | same-origin, rate limit, `isOperatorAllowed`, enrolment ticket, audit |
| A admin/auth/step-up | POST | same-origin, full MFA session via `resolveOperatorFromCookie` (allowlist included), rate limit 5/10 min per operator, authenticator code, durable audit before the grant |
| M admin/create-tenant | POST | operator gate, same-origin, rate limit, audit |
| M admin/impersonate | POST, DELETE | operator gate (`getOperatorContext`; DELETE also accepts the current support session or `isAdminAuthed`), same-origin, rate limit 30/h per IP, step-up (POST), audit; operator address written to tenant audit metadata (SF-138, `:223`) |
| M customers/[id]/force-password-reset | POST | operator gate + step-up, rate limit, audit |
| A customers/[id]/login-email/check | POST | operator gate, same-origin, in-route support refusal (`:76`), rate limit, audit `admin.login_email.checked` |
| A customers/[id]/login-email | POST | operator gate (`:86-90`), rate limit, strict body, step-up bound to `<club>/<owner>/<action>` (`:141-144`), mutation + audit in one transaction; **no in-route support-session check** (proxy only; CR gap 3) |
| M customers/[id]/member-totp-reset | POST | operator gate + step-up, rate limit, audit |
| A customers/[id]/members/[memberId]/contact-email | POST | 16 ordered refusals (CR §3 table), incl. same-origin, operator gate, support refusal (`:138`), strict body, club/member scoping 404, managed-record 409, holder 409, stale version 409, step-up; one transaction |
| A customers/[id]/owner-profile | POST | operator gate + step-up, rate limit, audit |
| M customers/[id]/review-lock | POST, DELETE | operator gate, rate limit, audit |
| A customers/[id]/revoke-access | POST | operator gate + step-up `access.revoke_all`, rate limit, audit (SF-08, R approved) |
| M customers/[id]/soft-delete | POST, DELETE | operator gate + step-up, rate limit, audit |
| M customers/[id]/suspend | POST, DELETE | operator gate + step-up, rate limit, audit |
| M customers/[id]/totp-reset | POST | operator gate + step-up, rate limit, audit |
| M customers/[id]/transfer-ownership | GET, POST | operator gate + step-up, conditional role swap (SF-23), audit |
| M admin/dsar/erase | POST | requireApiRole(["owner"]), same-origin, refuseSupportSession, rate limit, audit; **no step-up** (SF-61 OPEN Low) |
| M admin/dsar/export | GET | requireApiOwner, refuseSupportSession, rate limit, audit |
| M admin/email/test | POST | requireApiOwner, same-origin, rate limit, audit |
| M admin/import/[id]/commit | POST | requireApiOwner, same-origin, refuseSupportSession, withTenantContext, audit |
| M admin/import/[id]/rollback | POST | same as above |
| M admin/import/attendance/export | GET | requireApiOwner, refuseSupportSession |
| M admin/import/attendance | GET, POST, DELETE | requireApiOwner, same-origin, rate limit |
| M admin/import/upload | POST | requireApiOwner, same-origin |
| M admin/import/uploads | POST | requireApiOwner, same-origin, rate limit |
| M auth/[...nextauth] | GET (handlers) | NextAuth; `authorize` with the lockout reservation; revocation in the JWT callback (`auth.ts:1361-1406`) |
| M auth/disown-login/[token] | GET, POST | GET renders a confirmation only; POST same-origin + conditional claim (SF-37) |
| M auth/forgot-password | POST | rate limit; subject-bound reset code; mints nothing for a provisional address |
| M auth/logout-all | POST | `auth()`, same-origin, refuseSupportSession, audit |
| M auth/reset-password | POST | rate limit; legacy hash then subject-bound hash; refused and burned for a provisional address |
| M auth/set-password | POST | `auth()`, same-origin, refuseSupportSession, audit |
| M auth/staff-unlock/[id] | POST | requireApiOwner, same-origin, refuseSupportSession, audit |
| M auth/totp/disable | POST | `auth()` + refuseSupportSession; self-service disable is refused by design (only operator routes clear TOTP) |
| M auth/totp/recover | POST | anonymous door: per-IP 20/h and per-address 5/h; conditional claim `updateMany({totpEnabled:true})` single winner (`:95-101`); `sessionVersion +1`; audit. Clears the factor **without a password** — the password is still required at the next sign-in |
| M auth/totp/recovery-codes | POST | `auth()`, same-origin, refuseSupportSession, audit |
| M auth/totp/setup | GET, POST | `auth()`, same-origin, refuseSupportSession, rate limit, audit |
| M auth/totp/verify | POST | pending-TOTP token only; revocation gate before anything is spent (`refuseRevokedPendingToken`, SF-37); strict body; rate limit |
| M staff/[id] | PATCH, DELETE | `auth()` + requireApiOwner, owner-row protections, same-origin, refuseSupportSession, audit |
| M staff/[id]/totp-reset | POST | requireApiOwner, same-origin, refuseSupportSession, audit |
| M staff/[id]/transfer-ownership | POST | `auth()` + role must be owner, same-origin, refuseSupportSession, rate limit, conditional swap (SF-23) |
| M staff | GET, POST | `auth()` + roles owner/manager (owner-only for owner-level actions), same-origin, refuseSupportSession, audit |

**Specific concerns.**
- **Cross-tenant identifiers.** The club comes from the path and the member lookup is `where {id, tenantId}` (contact-email 404 #6/#7). Flow 8 cross-tenant 404 PASS in both roles (run 3 §5).
- **Role escalation.** Strict bodies on every hub route (`login-email/route.ts:72-76`, `contact-email/route.ts:82-88`, `check/route.ts:45`). The owner route selects `role: "owner"` itself. SF-03 forged-key test (23 cases, R approved). Flow 8 mass assignment 400 PASS.
- **Impersonation / support sessions.** Proxy refusal `proxy.ts:298-321`; in-route refusals on check and contact-email; SF-24 backstop on member writes. Flow 1 "support-session refusal" PASS both roles.
- **De-listed operators.** The allowlist is checked at every cookie resolution; flow 1 allow-list refusal PASS. `OPERATOR_ALLOWED_IDS` is SET in Production (12 Oct 01:35 UK) and takes effect only at the next deployment.
- **Revoked sessions.**
  - Operator: `sessionVersion` equality on every request.
  - Club: revocation check on every Node pass, fail-closed (`auth.ts:1361-1406`, `lib/session-revocation.ts:103-126`).
  - Flows 9/9m PASS both roles.

**Email correction — one club, one subject, one change, one version.**
- **Lookup / preflight:** the check route reads holders in the path club only and writes `admin.login_email.checked`.
- **Step-up:** the grant binds operator, operator `sessionVersion`, action, target `<club>/<subject>/<sub-action>`, a digest of the canonical intended change, and a keyed digest of the subject's record version (`lib/operator-step-up.ts:12-55,:122,:172,:186-248`):
  - owner version = `owner:<id>:sv<n>:email=…:provisional=…` (`:214`);
  - member version = id, `sessionVersion`, address, `externalRef`, password-present (`:236-239`).
- **Mutation:** the grant is spent inside the same transaction as the write (`consumeStepUpGrant`), with a conditional `updateMany` on the address just read.
- **Audit:** `operatorId` and `requestId` (= digest of the grant nonce) in the same transaction.
- **Gap (SF-09 / AH-C2, OPEN Low):** the owner route binds the version **at code entry**, not at the check the operator saw. If Sean changed his own address inside the 5-minute window before the grant, the operator's change would overwrite it. The member route compares the version the operator saw (409, grant unspent; `sec-b-version-at-check-db` 4/4).

**Evidence.** CR-REPORT §1, §3–§5 (code at 704ab57; the hub files are unchanged since `c837e38` and since `03ef584`); run 3 §5 flows 1, 3, 4, 5, 5x, 6, 6b, 7, 8, 9, 9m PASS under both roles; FINDINGS SF-03, SF-08, SF-09, SF-23, SF-24, SF-61.

**Limitations / follow-up.**
- The table above is a static presence check. It is not a fresh line-by-line authorisation review of the 46 endpoints outside the hub; for those this lane relies on the R/R2–R9 approvals at earlier SHAs, with the code unchanged since `03ef584`.
- The owner login-email route lacks an in-route support-session check (proxy only) and does not refuse synthetic domains (CR gap 3).
- The remediation for SF-09 is described in `evidence/B/04`.

---

## 16. Authentication and account-takeover paths

**Status:** PASS — subject binding, expiry, single use, concurrent redemption, retirement on address change, no transfer of tokens and no implied mailbox verification (TEST both roles; code). NOT RUN — owner/staff recovery-code redemption in the browser. FAIL — existing gaps: member second-factor replay (SF-90) and legacy untagged links until expiry (SF-05 residual).
**Executable:** `512d5e8`. The auth routes, `lib/auth-token-binding.ts`, `lib/login-email.ts` and the recovery routes are unchanged between `03ef584` and `512d5e8`. **Environment:** TEST (sweep `03ef584`, both roles; browser run 3 on `512d5e8`); CODE.

| Path | Binding / expiry / single use / concurrency | Evidence |
|---|---|---|
| Password | Atomic per-address and per-network reservation before bcrypt; refund on success; no existence oracle | SF-111 (R7), SF-35 (R6); `auth.ts:493-506,:629-631` |
| Staff/owner TOTP | Single-use time-step across instances (`totpLastUsedStep`, conditional update); revocation gate on verify | SF-37 (R3), `app/api/auth/totp/verify/route.ts:32-33` |
| Operator TOTP | Single use (`consumeOperatorTotp`, `lib/operator-auth.ts:226-243`); step-up grant 5 min, single use | flows 1, 5, 5x PASS both roles |
| Member TOTP | **Not single use** — no `totpLastUsedStep` on `Member` | SF-90 OPEN (migration proposed) |
| Recovery codes (staff/owner and member) | Conditional claim → single winner; consumed code removed; `sessionVersion +1`; the factor is cleared without a password, so the next sign-in still needs the password | `sec-a-recovery-code-race-db` 4/4 both roles (two different codes at once; same code twice), `owner-recovery-revocation-db` 5/5 both roles (single use; sessions evicted), `sec-a2-member-recovery-race-db` 4/4 both roles, `totp-login-paths` 14/14 both roles — at `512d5e8` (12 Oct, `evidence/recovery-db-tests-512d5e8.txt`); earlier at `03ef584` (`evidence/lead/sweep-03ef584.txt` and `-reruns.txt`); browser redemption NOT RUN (run 3 §5) |
| Invitations | Subject tag (HMAC naming the person); 7-day expiry; two concurrent redemptions → one winner | `sec-a-token-subject-binding-db` 7/7 both roles (incl. "two concurrent redemptions … exactly one wins") |
| Reset codes | Hashed with the person; 2-minute codes; expired bound code refused | same test |
| Magic links | Subject tag; 30-minute expiry; a mismatch is audited and refused; passwordless members refused | `magic-link/verify/route.ts:109-111,:145-161` |
| Legacy untagged links | **Accepted on the old address-only rule until expiry** (≤ 7 days for invitations) — every link production has issued so far | SF-05 residual; `lib/auth-token-binding.ts:40-45,:100` |
| Google OAuth | Interim refusal unless an explicit link exists (none can exist yet); production enablement NOT ENABLED per the 9 Oct variable listing, not re-observed | SF-36 (R3/R6) |
| Disown-login | GET renders a confirmation; POST same-origin conditional claim | SF-37 |

**Address change does not transfer tokens or confer verification.**
- Both hub steps retire `reset`, `login` and `first_time_signup` tokens for the **old and the new** address in the club; waiver links are kept (`lib/login-email.ts:290-329`).
- The owner step sets `loginEmailProvisionalSince` and `sessionVersion +1`.
- While the address is provisional: forgot-password mints nothing, reset is refused and the code burned, magic links mint nothing, Google is refused, and outbound mail to the address is refused (CR §5, `lib/email.ts:410-426`).
- Provisional clears only by an operator attestation with its own step-up.
- No verification mail is sent (`EMAIL_DELIVERY=off`). On the member step the audit flag `unverified` equals `canSignIn` (false for a passwordless holder); `Member.unverifiedEmail` is not written.
- Run 3 flow 4: the old address is refused, the new address reaches `/dashboard`, checker 38/38, zero sends, both roles.
- Retirement matches the stored token address exactly after lower-casing. A legacy token row stored with other case or whitespace would survive; current issuers write lower-case (CR §5).

**Remaining differences between populations.**
- **Member:** TOTP replayable within its window (SF-90). Revoke-all of a staff user does not end that person's own member session (SF-50).
- **Owner:** DSAR erase needs no step-up (SF-61). The owner login-email route does not check support sessions in-route (proxy covers it).
- **Operator:** the only population with allowlist, step-up and durable sign-in audit. No phishing-resistant MFA.
- **Staff/owner and member:** recovery codes clear the factor without the password (by design).
- **All:** the per-address cap can be filled by an attacker from unknown networks, so a victim on a new device is refused while mail is off (SF-59 residual).

**Limitations / follow-up.**
- Integration results for the recovery paths were re-run at `512d5e8` itself, both roles, 12 Oct: `owner-recovery-revocation-db` 5/5, `sec-a-recovery-code-race-db` 4/4, `sec-a2-member-recovery-race-db` 4/4, `totp-login-paths` 14/14 (section D). The other rows rest on the 10 Oct sweep at `03ef584`; they hold for `512d5e8` because those files are byte-identical, while the shared libraries underneath changed (five files, including `lib/auth-lockout.ts`) and were reviewed separately by R10.
- The browser driver for recovery-code redemption is still owed (run 3 §5; decision §7). AQ1 Q4 carries the recommendation.

---

## 17. Database integrity and failure handling

**Status:** PASS — mutations and audit writes commit together; rolled-back writes are not reported as success; failed transactions do not contaminate reused connections; failure classes bounded (TEST both roles, R10 reviewer's own probes and mutants). FAIL — audit rows are editable and the runtime is the owner role (existing, unchanged; not accepted by this document).
**Executable:** `512d5e8`. **Environment:** TEST (R10 phase 2 on `1ca92c0` and delta review on `512d5e8`, 52 + 58 runs, both roles); CODE.

| Concern | Evidence at `512d5e8` |
|---|---|
| Mutation + audit atomic | Hub routes do grant spend → re-read → checks → conditional write → token retirement → audit in **one** transaction. Any failure, including the audit write, gives 500 with nothing changed (contact-email `:196-276`; owner route `:149-265`). Run 3 §8 SQL checks found the expected audit rows with operator id and request id |
| Success not reported for rolled-back writes | R10-3 CLOSED: a liveness `SELECT 1` before COMMIT (`lib/prisma-tenant.ts:140`). Swallowed errors (B5a, B5c) and a caught P2002 inside `withRlsBypass` (B5d) all end in `TenantTransactionAbortedError`, no COMMIT, 0 rows. Mutant ML-live → red (DELTA-HANDBACK) |
| Reused-connection contamination | SF-136 CLOSED: the release guard ends a client released inside a transaction (`lib/prisma.ts:84,:145`). MR2 with the guard → write persisted; without → lost. The guard never ended a healthy client in 7 burst runs. `withTenantContext` resets the bypass in the same statement that sets the tenant (B2, `sec-b2-stale-bypass-db` 6/6) |
| Transaction-start timeout | Pool acquisition 10 s (`lib/prisma.ts:33,:62`); B6: pool held 12 s → tenant call fails ~10.0 s, rate limit refuses ~10.06 s, 0 rows, no client left in BEGIN |
| Statement / lock timeout | Transaction-local `statement_timeout` 15 s (60 s extended) and `lock_timeout` 10 s (45 s), set in the first statement (`lib/prisma-tenant.ts:105-111,:224`). B4a/B4b/B4d/B4e: exactly one ROLLBACK each, acquires = releases, next client clean |
| Callback overrun | R10-1 CLOSED: the budget races the callback (`withinBudget`, `:170-196`); the slot is freed at ~15.4 s; the Blob `del()` moved after commit (`rank/route.ts`) |
| Connection loss / cancellation | B2 (server ends session at 3 s) → cut at 15.1 s, dead client dropped, next call works; `sec-l1-connection-drop` 11 + 1 skipped; 57014/57P01 fault cells for revocation (SF-01/44) |
| Rollback failure | Rollback once + release once on every path (R10 phase 1 checklist). The Prisma 1 h timer and the abandon-the-start path remain in the library; the guard neutralises the latter (R10 "unchanged residuals") |
| Retry behaviour | No blind retry in the hub. A lost response is answered from the record (`alreadyApplied`, flow 6b PASS both roles); a spent grant is never accepted twice. Stripe retries a 500 for ~3 days (webhook behaviour change; §26) |
| Uniqueness under concurrency | Advisory lock on (club, canonical address) across `User` and `Member` (`lib/login-email.ts:149-242`); P2002 → 409. **Cross-table and case-folded uniqueness is an application rule, not a database constraint**: the DB unique keys are per table and on the raw value (CR §4). The DB trigger proposal (SF-07) is not applied |
| Version checks under concurrency | Member route version-at-check 409 (`sec-b-version-at-check-db` 4/4); flow 7 stale 409 with grant unspent, resume with a fresh code, PASS both roles; ownership-transfer race fixed (SF-23, 9/9 both roles) |

**Editable audit and owner-role runtime — consequences, stated plainly.**
- Production connects as `neondb_owner`.
- Anyone who holds that credential can do all of the following: change, back-date or delete any audit row; truncate the table; rewrite `Operator` password hashes and the migrations ledger; read and write every club; and forge the release/acquisition rows the importer trusts.
- That includes every historical deployment still holding a valid credential, and anyone holding a leaked value that was not revoked.
- So the audit trail of Sean's correction is evidence against honest mistakes, not against a credential holder.
- SF-57 v2 (append-only trigger) protects nothing while the runtime is the owner role (the owner can disable triggers; R3). It requires the restricted runtime (SF-62 phase 2) first.
- The fact that this exposure already exists in production is not a reason to classify it as accepted. It is listed for an explicit decision in §26.

**Limitations / follow-up.**
- Every result is from TEST at ~45 ms round-trip time. Production's `idle_in_transaction_session_timeout` was read as 300 s, 11 Oct (db-role-inspect, read-only; FINDINGS SF-135); the review hand-off was corrected to match in `cf17d78`.
- SF-139: a persistently slow statement is classified as "busy" (restore answers 503; the purge cron skips silently). Reporting only, Low.

---

## 18. Availability and resource limits

**Status:** FAIL — one login address or one security bucket can saturate an instance's database pool and deny other security buckets on that instance (SF-118/SF-119 OPEN, ledgered Low because they fail closed). NOT RUN — production capacity was never measured.
**Executable:** `512d5e8`. **Environment:** TEST only.

**Mechanism.**
- Production pool `max` 5 per instance with a 10 s acquisition deadline (`lib/prisma.ts:33,:56`).
- A burst at one address holds a pooled connection per waiting reservation while it queues on the per-address advisory lock (lock bound 5 s / 10 s; SF-118).
- When the pool saturates, every other security bucket on that instance (TOTP verify, apply, recovery) is refused with `Retry-After` ≤ 30 s (SF-119; a TOTP bucket got 5 of 60 through, an apply bucket 0 of 60).
- The real owner with the right password can be refused with the misleading "Incorrect email or password" during the burst (SF-118 wording residual).
- A known address can be re-capped roughly every 75 minutes with ~10 requests (SF-59 residual). A victim on a new device stays refused while mail is off.
- Nothing is admitted in any of these cases — security-preserving refusal — but it is an outage for that instance and, for the targeted address, for its owner.

**Reconciling earlier burst failures with the final candidate.**
- **L1 cycle 2:** 15 failed runs of 24 of `sec-c3`: 14 warm-up connection-acquisition timeouts (no test executed) and 1 lock-deadline under-allow; 0 unhandled (ITERATION-2-REPORT §11). Kept as failures.
- **R10 phase 2 at `1ca92c0`:** 0 product-caused unhandled rejections in 52 runs. The R10-1 regression (slot held until the callback returns) was found and later closed.
- **R10 delta at `512d5e8`:** 0 product-caused unhandled rejections in 58 runs. The remaining failures, classified per DELTA-HANDBACK "Failures kept": the `sec-l1` S1-owner/S2-restricted and `sec-c3` S1 suite runs had every cell skipped on setup connection timeout (TEST connectivity); B12 39/40 once (TEST connectivity); probe A reviewer harness; B4a = SF-139; D-plant intended control; `sec-a4` S2 owner 1 cell refused by a 10 s lock timeout after a mid-transaction connection death (fail-closed, SF-118 family; R10-8/SF-140).
- **Rehearsals:**
  - first attempt (`704ab57`, Node 25): P2028 in the revocation check;
  - run 2 (`704ab57`, Node 24): P2028 ×2 per role pass and one bare `/login` (SF-137);
  - run 3 (`512d5e8`): 0 P2028 and 3 pg connection-timeout `unknown` verdicts (restricted main 1, fault server 2), none user-visible.
- The cause of these timeouts on TEST is not established (run 2 §5a; run 3 §4.1).

**Tested concurrency and duration (all TEST, short bursts).**
- R10 B12: 40 concurrent at pool 5 → 40/40, 4.0–4.5 s (3.9 s before the liveness statement).
- R7: 120 concurrent sign-ins; SF-118: 40 concurrent with pools 5 and 20.
- Run 3 fault test: 12/24/40 concurrent `GET /dashboard` and 6/12 tabs (1,189 responses); every response 200.
- Durations are seconds to minutes. No sustained test, no multi-instance test.

**Limits that are known.**
- 5 connections per instance; 10 s acquisition; 15 s tenant budget (60 s extended); lockout lock 10 s; the security-bucket refusal window ≤ 30 s.
- **Unknown:**
  - the number of Vercel function instances under load;
  - the production Neon compute size and its `max_connections`. Production uses the **direct host** (packet §4), so instances × 5 connections land on the compute directly. This conflicts with the project instruction that production use the pooled host — see §27.3.
- No production capacity is claimed from any of the above.

**Limitations / follow-up.** SF-119 fix is outlined in the ledger: stop holding a pooled connection while waiting on the bucket lock. Also correct the SF-118 refusal wording. Read the production compute size and connection limit read-only. Monitoring of the 503 rate and of the "revocation unknown" log line is proposed in §24.

---

## 19. Sensitive-data protection

**Status:** PASS — changed code and the run 2 / run 3 artefacts. FAIL — credentials disclosed in public git history are not proven revoked (SF-14); the operator address is stored in tenant audit metadata (SF-138). NOT RUN — inspection of the production build output; proof that logged error objects never carry an address.
**Executable:** `512d5e8`. **Environment:** CODE; TEST artefacts; PROD (variable metadata only).

**Changed code.**
- **Logs:**
  - the hub and account routes log a fixed message plus the error object on failure (`login-email/route.ts:265`, `contact-email/route.ts:272`, `check/route.ts:160`, `account/login-email/route.ts:185`);
  - `auth.ts:581` logs subject kind, ids and `err.message` only;
  - the rate-limit over-limit warning logs the family and counts only (SF-120 FIXED, R8);
  - the readiness checker stores every address, hash, TOTP secret and recovery-code list as HMAC under a run secret and prints none (CR §6).
- **Errors and caches:** every `/api` response is `private, no-store` (`next.config.ts:146-148`, added in this delta); exports are no-store (SF-29).
- **Tree secret scan on `512d5e8`:** 8 candidates (count only in the gates log, `evidence/lead/gates-node24-512d5e8.log`; the list is not recorded there; "pre-existing, outside the delta — documented test fixtures and the demo-seed password (SF-82, SF-109)" is asserted by commit `665bc68` and not independently verified here).
- **SF-138:** `admin.impersonate.start`, approve and create-tenant store the operator's own address in club-tenant audit metadata (`app/api/admin/impersonate/route.ts:223`). Reject stores it in a tenantless platform audit row and also writes it to the server log via `console.warn` (`reject/route.ts:72-75`; unchanged from `e8afb6a`, so outside the changed-code log claim above). Observed in run 3 under both roles. OPEN Low. It does not touch Sean's correction, which uses no impersonation.

**Release artefacts.**

| Artefact | Location | Masking / cleanup (per run record) |
|---|---|---|
| Run 3 screenshots (41) | lane scratchpad `SP/hub/rh512-e2e/` | all masked (mask check viewed); none committed |
| Run 3 private files | `SP/hub/rh512-private/` | baselines, private expectation files, `state.json`, mail trigger deleted; nothing written under `%LOCALAPPDATA%\matflow-readiness`; worktree removed (run 3 §6) |
| Run 2 screenshots (41) | `SP/hub/rh24-e2e/` | all masked; none committed; private files deleted (run 2 cleanup) |
| First attempt (Node 25) screenshots | other session's `SP/hub/rh-e2e/` | **9 Oct mask defect:** an address was readable in one capture (`REHEARSAL-704ab57.md:57`; synthetic TEST fixture). Run record left unfinished, so its private-file cleanup is **not recorded** |
| Lane RD screenshots `rd/*.png` | RD scratchpad | masking status not recorded |
| Server logs, checker stderr | scratchpads | stated to contain no addresses (run 2) |
| Browser traces | none recorded in runs 2–3; `e2e.yml` uploads a Playwright HTML report on schedule/dispatch only (TEST data) | — |
| Committed run records | `docs/readiness/hub-release-2026-10-12/` | no address, password, code, token or secret (stated in each record; consistent with this lane's reading) |

**Preventing future disclosure versus revoking past disclosure.**
- **Prevention in this release:** masking, no-store, the log-family rule, HMAC-only checker output, mail off, and the operator shared secret refused in production.
- **Revocation — a separate matter:**
  - *Neon password and Resend key:* replacements created and deployed. Replacement and deletion of older keys are REPORTED by the owner (11 Oct 17:07 UK); revocation is not evidenced (Q6). The fingerprint check proves only that the local values differ from the leaked ones (SF-14). ITERATION-2 §9 and FINDINGS SF-14 record this more strongly (27.3).
  - *Stripe key:* fingerprint MATCH. Only a 25-character prefix leaked (CONTAINMENT C4); roll as hygiene.
  - *CRON secret:* matched the leak and is now absent. It must never be re-set to the old value.
  - *Blob token:* possibly exposed through SF-28 in every older build. Unrotated; rotation only after this release is live (SF-69).
  - *Legacy admin secret:* 53 days old; held by old builds that still accept it (§22).
  - *Public git history* keeps the 7 May values permanently. Only provider-side revocation neutralises them.

**Publication on push (public repository history).** Pushing `release/hub-512d5e8` publishes the 187 commits since `e8afb6a` to a public repository (Q3). What becomes public:
- `docs/security/FINDINGS.md` with open findings and their mechanisms: SF-62 (RLS trusts self-settable session settings; owner-role runtime), SF-57/73/74 (editable audit, operator and provenance rows), SF-118/119 (burst availability), SF-90 (member TOTP replay), SF-137 (bare `/login` under database pressure), SF-138 and others;
- the evidence logs, run records, review hand-backs, runbooks (restore, operator access recovery, deploy) and the DENIALS register;
- infrastructure identifiers: the production database endpoint host prefix, the GitHub ruleset id, the operator id and the Neon root branch id;
- the form of the member record's agreed replacement address, which is already described in committed docs at `512d5e8` (`docs/readiness/admin-hub-2026-10-09/FINAL-REPORT.md:95`, `CR-REPORT.md`, `ITERATION-2-REPORT.md`, among others), so pushing publishes it unless those lines are handled.

What is sensitive: the open-finding mechanisms are a roadmap for an attacker until they are fixed (SF-62 and SF-118/119 most of all); the identifiers narrow targeting but grant nothing without credentials. Whether any further secret value is in these files is not established: the tree secret scan's 8 candidates are not listed in the evidence, and their classification as pre-existing fixtures and the demo-seed password (SF-82, SF-109) is asserted by commit `665bc68`, not independently verified (above). The 7 May leak is already in public history. Options for the owner (decided in the Q13 risk-decision list and checklist step 2): accept publication as is, or move the security documents out of the release history before pushing. The second rewrites commits and changes the tree, so the reviewed identity (tree `182be72…`, Q3) would have to be re-established with fresh gates and review. This assessment does not choose between them.

**Limitations / follow-up.**
- **Cleanup not recorded:** the first attempt's private-file cleanup and lane RD's screenshot masking (table above) are not recorded. Coordinator follow-ups (Q13): record or perform the first attempt's cleanup; verify and record the masking of the RD screenshots.
- **Error objects:** whether a logged Prisma/pg error object can carry the pg `detail` text (which can include a conflicting address on a unique violation) was not verified. Neither was what `lib/sentry-scrub.ts` removes before Sentry. A one-off check on TEST would settle both.
- **Build output:** the production build output (client bundles) was not inspected for embedded values. By design only `NEXT_PUBLIC_*` reaches the client.
- **Sean's baseline:**
  - the private baseline file for Sean's real correction must be created outside the repository with a deletion time (decision §6 step 5);
  - the checker refuses in-repository paths only relative to the checkout it runs from (CR §6);
  - mode 0600 is not enforced on Windows.

---

## 20. Browser and request security

**Status:** PASS — CSRF/origin, input validation, mass assignment, cache behaviour and security headers on the affected routes; payments-only COEP change excluded. FAIL — enforced CSP still allows inline scripts (SF-30 PARTIAL). This is existing exposure, unchanged from production.
**Executable:** `512d5e8`. **Environment:** CODE; TEST browser (run 3).

- **CSRF / origin.** `assertSameOrigin` is present on every mutating privileged route (§15 table). Flow 8 Origin/CSRF 403 PASS both roles. The SameSite cookie is the second layer (SF-32 note).
- **Input validation / mass assignment.**
  - `z.strictObject` on the three hub routes and on both TOTP verify routes (SF-98).
  - A forged-key matrix of 23 cases (SF-03) and the canary sweep (SF-33).
  - Flow 8 mass assignment 400 PASS.
  - About 100 other routes still use strip-mode schemas (SF-101, hardening).
- **Redirects.**
  - SF-137: the page gate redirects to bare `/login` on an `unknown` revocation verdict, which drops `?club=`. That is a navigation defect, not an open redirect.
  - Callback/redirect parameters of NextAuth were not re-assessed in this lane.
- **Cache.**
  - `private, no-store, max-age=0, must-revalidate` on `/api/:path*`, `/api/admin/:path*`, `/admin/:path*`, `/api/auth/:path*` and others (`next.config.ts:112-170`; new in this delta: `/api/*` from commit `035e27e`, `/api/admin/*` and `/admin/*` from commit `48a9182`).
  - Flow 3 no-store PASS.
- **Security headers (static, all paths):**
  - HSTS 2 years with `preload`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`;
  - COOP `same-origin`, COEP `credentialless`, CORP `same-origin`;
  - `frame-ancestors 'none'` (`next.config.ts:49-100`).

**The CSP that is actually enforced at `512d5e8`.**
- The static policy is sent as `Content-Security-Policy` on every response (`next.config.ts:7-37,:100`). Production values:
  - `default-src 'self'`;
  - `script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com https://js.stripe.com` (no `unsafe-eval` in production);
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`;
  - `img-src 'self' data: blob: https:`;
  - `connect-src` self + Vercel storage/insights + three Sentry ingest regions + Stripe API + Google accounts;
  - `frame-src 'self'` + Stripe;
  - `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`, `upgrade-insecure-requests`.
- **Inline script is therefore permitted by the enforced policy.**
- The per-request nonce policy without `unsafe-inline` (`lib/csp.ts:96-125`, with `strict-dynamic`) is sent as `Content-Security-Policy-Report-Only` unless `MATFLOW_CSP_ENFORCE` is exactly `1`/`true` (`lib/csp.ts:74-81`). That variable is not set in production and was unset in run 3.
- Report-only is monitoring, not protection.
- `style-src 'unsafe-inline'` remains in both policies.

**Payments header change.**
- The COEP removal (commit `4a3968c`) is on `payments/stripe-defects-2026-10` and is **not** an ancestor of `512d5e8` (`git merge-base --is-ancestor` false).
- The latest `next.config.ts` commit in the candidate's history is `035e27e` (cache rule).
- `512d5e8` therefore still sends COEP `credentialless`, as production `e8afb6a` does today. The only change to `next.config.ts` in the delta is the 26 added cache lines.
- The payments change is excluded. It needs its own review with the payments milestone; card frames remain blocked by COEP in both builds, which is irrelevant while Stripe is not live.

**Limitations / follow-up.**
- XSS testing of the hub pages was not run in this lane. R5's 19-page CSP pass (`ebd761d`) concerned the nonce policy.
- `report-to` delivery over https is UNKNOWN (SF-30 residual).
- Enforcing the nonce policy is an owner decision after a preview check. Setting the variable does not change the static header on `/api` paths (SF-107).

---

## 21. Build, dependencies and release provenance

**Status:** PASS — runtime, lockfile, gates and CI hygiene for the candidate. FAIL — "only approved source reaches production" is not yet enforced: the PR + status-check ruleset is pending (D-14). Install and build steps run with production secrets (SF-20, existing). NOT RUN — the production build at the merge commit and the PR CI run do not exist yet.
**Executable:** `512d5e8`. **Environment:** local Node 24.21.0 (gates, rehearsal); CODE (workflows); PROD (ruleset, coordinator 12 Oct).

**Runtime, lockfile, audit.**
- **Gates (`evidence/lead/gates-node24-512d5e8.log`, 12 Oct 05:37Z, Node v24.21.0):**
  - lint 0;
  - `npm audit --omit=dev` 0 vulnerabilities;
  - unit 481 files, 6,599 passed / 1 skipped;
  - isolated build `XEFPlYyNsQ5F-CB6DKMKc`;
  - tsc 0;
  - tree secret scan 8 candidates (count only in the log; "pre-existing" is asserted by commit `665bc68`, not independently verified here; §19).
- **Run 3:** fresh `npm ci` under the SHASUMS-verified Node 24.21.0 binary: 1,039 packages, no EBADENGINE, `pg` 8.20.0 and `pg-pool` 3.13.0 confirmed.
- **`package.json` at `512d5e8`:**
  - `engines` `>=24.18.1 <25`;
  - overrides `deepmerge-ts ^8.0.0`, `mysql2 ^3.24.5` (SF-11), `pg-pool 3.13.0`.
- **Audit scope:** production dependency tree only. Dev dependencies are covered by the OSV step in `security-supply-chain.yml`, which is not a required check.
- **Unresolved:**
  - generated Prisma client 7.10.0 versus runtime `@prisma/client` 7.4.2 (R10 note);
  - npm reports 4 install scripts "not yet covered by allowScripts" (`@prisma/engines`, `@sentry/cli`, `prisma`, `unrs-resolver`; run 2 §1);
  - the Vercel Node patch level is UNKNOWN (SF-71).

**Build and install scripts with production secrets.**
- On Vercel the install and the build run with the Production environment.
- The root `postinstall` (`prisma generate`) runs.
- The build script `node scripts/maybe-migrate.mjs && next build` runs `prisma migrate deploy` with the production `DATABASE_URL`. That is the same owner identity as the runtime (SF-75); the guard refuses the production endpoint unless `VERCEL_ENV=production` (CR §7).
- Dependency install scripts were skipped by npm's allowScripts in the serving build (SF-71), but a dependency with an allowed script, or Tailwind/Next plugins evaluated at build, executes with those secrets in scope.
- Vercel installs with `npm install`, not `npm ci` (SF-15). The deployed tree is resolved by Vercel, not by the gate's `npm ci`.
- Postinstall-downloaded engine binaries sit outside lockfile integrity (SF-20 OPEN).

**CI and third-party actions (read at `512d5e8`).**
- `ci.yml`, `e2e.yml` and `security-supply-chain.yml` declare `permissions: contents: read`; `db-backup.yml` sets the same at job level.
- Actions are pinned to commit SHAs: `actions/checkout@11bd719…` (v4.2.2), `actions/setup-node@49933ea…` (v4.4.0), `actions/upload-artifact@ea165f8…` (v4.6.2). Semgrep is pinned via `pipx install semgrep==1.180.0`.
- No `pull_request_target` or `workflow_run` exists in any workflow (`git grep` empty).
- `ci.yml` runs on `pull_request` with a throwaway Postgres service and fixed fake secrets. It references no repository secret, so a fork's pull request receives no secret (GitHub withholds secrets from fork PRs regardless).
- Repository secrets appear only in `db-backup.yml`, which runs on schedule/dispatch, never on a PR (and fails at "Validate secrets", SF-77).
- `security-supply-chain.yml` installs with `--ignore-scripts`. Its tree secret-scan step exits 1 on the documented fixtures (SF-82), so it is red as it stands and is not the required check.
- **Vercel:** fork protection is on (E2 O6). A pushed branch creates a preview deployment with the Preview environment (packet §7 step 2).

**How only the approved source reaches production (packet §7, in the Q3 order; the packet still lists the ruleset first, §27.3).**
1. The branch `release/hub-512d5e8` is created at `512d5e8`, pushed, and the PR is opened; CI must be green.
2. Then the ruleset is tightened to require a PR and the `Typecheck + Lint + Vitest` check, with no bypass actor. Today ruleset 24901063 holds only no-deletion and no-force-push; until it is tightened, a direct push to `main` deploys **and migrates** production (SF-15). The PR is then merged as a merge commit `M`.
3. `git diff M 512d5e8` must be empty (tree identity).
4. The Vercel deployment must show `meta.githubCommitSha = M`.
5. `release-verify --sha M` is run from the `512d5e8` checkout.

**Limitations / follow-up.**
- Source identity is git-tree identity only. The production build ID will differ from `XEFPlYyNsQ5F-CB6DKMKc` and `-VI8m-f5fjlPib2_etBjA`. There is no build provenance or attestation (SF-15).
- GitHub and Vercel account 2FA status is UNKNOWN (SF-15).
- CI on `e8afb6a` was failing when it shipped (SF-72). A green PR run on the merge base is required evidence and does not exist yet.

---

## 22. Environment and configuration isolation

**Status:** PASS — test bypasses and development modes cannot activate in production at `512d5e8` (code). BLOCKED — the treatment of preview and historical deployments, and the read-back of effective values, depend on owner actions not yet evidenced.
**Executable:** `512d5e8`. **Environment:** CODE; PROD (variable names and ages, coordinator 12 Oct 00:30 UK; E2 inventory 9 Oct).

**Which environments hold which credentials (names and targets only).**

| Credential | Production | Preview | Development | Historic deployments |
|---|---|---|---|---|
| Database (`DATABASE_URL`) | yes (rotated 11 Oct; direct host; owner role) | **no** | — | each build kept the value it was built with; old builds hold the pre-rotation value — harmless only if the old password is revoked (unevidenced) |
| Session signing (`NEXTAUTH_SECRET`) | yes | yes; equality with Production UNKNOWN (C6) | — | all builds |
| Mail (`RESEND_API_KEY`) | yes, Production only since 11 Oct | removed | — | old builds hold the old key until it is deleted at Resend |
| Blob (`BLOB_READ_WRITE_TOKEN`) | yes, non-sensitive | yes | yes | all builds; possibly exposed (SF-69) |
| Payments (`STRIPE_SECRET_KEY`, webhook secret) | yes (157 days) | yes (C4/C8) | — | all builds; no live Stripe in use |
| Legacy operator secret (`MATFLOW_ADMIN_SECRET`) | yes, 53 days, rotation pending | yes | — | 62 of 64 builds (9 Oct) hold an older value, **and builds before this release accept it in production** (OPERATOR-ACCESS-RECOVERY "Rollout"; chain C5) |
| `TESTING_MODE` | present (161 days) | present | — | inert in production in every build (CONTAINMENT line 140) |

**Bypasses and development modes at `512d5e8`.**
- `isTestingMode()` is false when `VERCEL_ENV=production` or when `DATABASE_URL` names the production endpoint (`lib/testing-mode.ts`).
- The E2E password bypass requires `E2E_AUTH_BYPASS=true` and is refused whenever `VERCEL` or `VERCEL_ENV` is set (`auth.ts:238-244`).
- `LOGIN_THROTTLE_ENABLED=false` is ignored on any Vercel deployment or against the production database (`auth.ts:225-230`, SF-68).
- The shared admin secret is refused on `NODE_ENV=production` or `VERCEL_ENV=production` (`lib/admin-auth.ts:70-72`).
- The production DB guard in `maybe-migrate.mjs` refuses migration from a non-production environment (CR §7).
- **Caveat:** on a Preview deployment (`VERCEL_ENV=preview`) with `TESTING_MODE=true`, mandatory 2FA is bypassed. Preview has no `DATABASE_URL`, so no real account is reachable there.

**Preview and historical deployments.**
- Disabling automatic previews (packet §7 step 2) stops a **new** preview of the release branch from being built with Preview secrets. It does not retire existing deployments.
- On 9 Oct there were 64 production deployments and 0 previews (E2 O1), protected only by Vercel SSO (`all_except_custom_domains`).
- They are retired only by deletion, under the separately authorised procedure (D-3). Deletion is not containment: a deleted build is restorable for 30 days. Only provider-side revocation contains a credential.

**Stored configuration versus effective running deployment.**

| Setting | Stored (dashboard) | Effective in the serving build | How the release verifies the effective value |
|---|---|---|---|
| `EMAIL_DELIVERY` | stored **Sensitive** (re-read 12 Oct 13:40 UK; value not readable); re-set to `off` before the release (F.4) | none — `e8afb6a` has no `EMAIL_DELIVERY` switch and can send mail today; `off` takes effect only with the `512d5e8` deployment | `release-verify` `tenant.email_delivery_off`: public `GET /api/tenant/<slug>` reports `emailDelivery: "off"` |
| `OPERATOR_ALLOWED_IDS` | set 12 Oct 01:35 UK | **not effective** until the next deployment | `release-verify --expect-operator-login` (authenticated operator request succeeds); owner's own `/admin/login` |
| `MATFLOW_ADMIN_SECRET` | 53 days; rotation pending | grants nothing in the new build's production paths; still honoured by older builds | `release-verify` "legacy transports refused" (401/403 JSON) |
| `DATABASE_URL` / `RESEND_API_KEY` | rotated 11 Oct | serving build reads the new values (deployment created after the change) | health ok; migration state read |
| `CRON_SECRET` | absent | absent | all three crons answer 503; class-instance generation and monthly reports are not running (Q1 e). In the serving build `e8afb6a` the absent `CRON_SECRET` is the only thing stopping retention: it has no `RETENTION_CRON_ENABLED` gate (`e8afb6a:app/api/cron/retention/route.ts:137-139`). The gate exists only from `512d5e8`. Do not set `CRON_SECRET` until `512d5e8` is serving and verified, with `RETENTION_CRON_ENABLED` confirmed unset |
| `MATFLOW_CSP_ENFORCE`, `ENABLE_GOOGLE_OAUTH` | absent per the 9 Oct listing; not re-read | report-only CSP; Google door refused | not covered by release-verify — re-read names before approval |

**Limitations / follow-up.** Containment step 8 is not done: Preview's own `NEXTAUTH_SECRET`; Preview copies of the admin secret, the Stripe secrets and the Blob token removed; `TESTING_MODE` removed from Production. Deletion of old deployments is the owner's. The names in the last row should be re-read before approval.

---

## 23. Migration and recovery safety

**Status:** BLOCKED — the exact six-migration sequence has not been rehearsed on a production-derived isolated copy, and no restore of production data has ever been executed (packet §5, owner; required before approval). PASS — `docs/runbooks/DEPLOY-2026-10.md` §5, which named "Instant Rollback" as the preferred recovery, is superseded with the fix-forward rule (`cf17d78`, runbook line 190); this closes the FAIL the lane recorded (section D).
**Executable:** `512d5e8` (migrations identical to `704ab57`; `git diff 704ab57 HEAD -- prisma/migrations` empty). **Environment:** TEST (migrations applied; release-verify 100 applied, both roles); PROD (Stage 0 read 12 Oct 01:33 UK: 95 applied, the six missing, 0 failed or in progress, `AuditLog` 120 rows).

**What exists.**
- **Six migrations:** `20261006010000_operator_auth_hardening`, `20261006020000_tenant_lifecycle_safety`, `20261006040000_support_session_binding`, `20261006050000_operator_enrolment_ticket`, `20261007010000_login_email_provisional`, `20261009010000_audit_operator_request`.
- Each is wrapped in BEGIN/COMMIT (pinned by `tests/unit/migrations-are-atomic.test.ts`).
- They make nullable columns only, plus one index (not CONCURRENTLY) and one validated FK on `AuditLog`. No backfill, NOT NULL, drop or rename (CR §7).
- No campaign or payments migration is included.
- **TEST is not production-derived.** It proves the application runs on the migrated schema, not that production data satisfies the FK or that the timings hold.

**Recovery per case.**

| Case | Defined response (evidence) | Rehearsed? |
|---|---|---|
| A migration fails partway | That migration rolls itself back; earlier ones stay; `migrate deploy` exits non-zero; the build stops; `e8afb6a` keeps serving; P3009 until `prisma migrate resolve --rolled-back <name>` (owner, production) | Mechanism drilled 30 Sep on a TEST throwaway schema (DEPLOY-2026-10 §5); not on a production copy |
| Schema succeeds, build fails | Additive nullable schema while `e8afb6a` serves; fix forward with a new build of the same SHA; never Instant Rollback/Promote (packet §5 "Failure state") | Old-code-on-new-schema boot **NOT RUN** (packet §5 step 4) |
| Deployment succeeds, authentication breaks | Stop before approval B; fix forward. Operator access is retained through `scripts/operator-access.mjs` run locally with the database credential (the only emergency path; audited in the same transaction). Club owners have no operator-independent path while mail is off | Not rehearsed in production; the script itself is exercised on TEST by the rehearsal setup |
| Production writes after the recovery point | Restore discards them; packet §5 step 5 defines a 30-minute change window (no imports, no account changes) and reconciliation of later writes; Neon history window is 6 hours (owner-reported) | NOT RUN |
| Rollback would restore a vulnerable path or retired secret | Forbidden: an older build restores the shared admin secret in production, the fail-open revocation (SF-01), untagged tokens only, and the pre-rotation credentials and configuration (CR §7 "Rollback consequence"; decision §4) | n/a (prohibition) |

**Who executes, and access during an authentication incident.**
- **Owner:** Neon console (branch, restore), Vercel (deployments, variables), GitHub (merge), and local scripts holding the database credential.
- **Coordinator:** read-only verification. Agents remain refused production reads except owner-approved manual-mode calls (D-1).
- **Access retained** through the owner's provider accounts (2FA status UNKNOWN, SF-15) and the local database credential. If the owner loses both his authenticator and his workstation, recovery depends on the Neon account alone.

**A backup is not recoverability.**
- No exported backup has ever succeeded (SF-19, SF-77; 22 failed runs).
- The weekly dump omits roles and grants.
- The `backup-2026-10-11` branch is UNVERIFIED.
- The restore runbook has run only on in-memory TEST copies (SF-19; ITERATION-2-REPORT §3).

**Limitations / follow-up.**
- The packet §5 steps 1–6 are the owed evidence. Required results: branch creation time and expiry setting; `migrate status` on the branch (95 + 6 pending, checksum warnings noted — SF-78); timed migration; both boots; RTO/RPO.
- `DEPLOY-2026-10.md` §5 is now explicitly superseded (`cf17d78`), so an incident will not follow its Instant Rollback advice; the historical text is kept below the notice.

---

## 24. Monitoring and operational response

**Status:** FAIL — no baseline, no alert rules and no thresholds exist in the evidence; the packet defines only "no new unhandled rejection class in Sentry in the first 30 minutes". NOT RUN — that Sentry actually receives production events has not been evidenced in this campaign.
**Executable:** `512d5e8`. **Environment:** CODE; PROD (variable names only).

**What exists.**
- `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` have been set in Production since 15 Sep (E2 metadata).
- `instrumentation.ts`, `instrumentation-client.ts` and `sentry.{server,edge,client}.config.ts` are present; the CSP allows all three ingest regions.
- Sentry captures:
  - revocation-check failures (`lib/session-revocation.ts:136-147`, log line "session-revocation check failed — request REFUSED as unavailable");
  - lockout counter failures (`auth.ts:581-588`);
  - Stripe webhook failures (R10 note).
- `lib/sentry-scrub.ts` exists. Its effect was not verified here.
- Vercel logs on Hobby are kept for about **1 hour** (CONTAINMENT C5), so evidence must be captured within that hour.
- No alerting configuration exists in the repository. **No baseline exists** for authentication failure rates, 5xx rates or database timeouts in production.

**Detection without logging secrets (proposed signals, no baseline behind them).**

| Signal | Source | Proposed stop / escalation (absolute, because no baseline exists) |
|---|---|---|
| Authentication failures | `AuditLog` sign-in and refusal rows; login-page reports; Sentry `area:auth` | any operator sign-in refusal for the allow-listed id; any owner report of being unable to sign in → stop account mutations |
| Elevated 5xx | Vercel logs filtered to `/api/admin/*`, `/api/auth/*`, `/api/account/*` | any 5xx on these prefixes during the window, other than the known cron 503s → stop and investigate |
| Database timeouts | "session-revocation check failed" log line; Sentry P2028 / `TenantTransactionBudgetError` | any occurrence in the first 30 minutes → hold approval B until explained |
| Failed privileged changes | route error lines ("change or audit write failed; nothing changed"); 409/500 in the hub panel; audit rows | any 500 from the hub routes → stop; read state before any retry |
| Unexpected e-mail delivery | `release-verify` `emailDelivery: off`; `EmailLog` row count; Resend dashboard send log | any new `EmailLog` row or Resend send → stop; delivery must be off |

**Window and responsibility.**
- Proposed window: from READY until 30 minutes after Sean's own successful sign-in.
- The owner (Noe) is the only human responder. The coordinator performs read-only checks.

**Incident procedure (short).**
1. **Stop.** No further account mutation, no retry of a hub action, no imports.
2. **Preserve.** Copy Vercel log lines (1-hour retention), Sentry issue ids, the hub panel state and the request ids. Record times in UK.
3. **Assess.** Read actual state, read-only: `owner-login-change-check.mjs verify`, `release-stage0-readonly.mjs`, and the two SQL checks of decision §6 step 10.
4. **Contain.** Revoke the affected sessions (operator sign-out; `revoke-access`), keep mail off, and leave the deployment in place unless it is the cause.
5. **Recover** by the approved path only: fix forward; a branch restore only under packet §5's reconciliation rule; never Instant Rollback; no direct SQL changes, no password or MFA resets as a fix.

**Limitations / follow-up.** A test event from production should confirm Sentry delivery. This is the GO-LIVE-2026-09 Part 1 check, and it was not found executed in the evidence. Thresholds should be revised once a week of production data exists.

---

## 25. Independent-review scope

**Status:** PASS — the final executable `512d5e8` is covered by an independent review of its last code delta, by gates, and by a browser rehearsal on the same SHA. No code changed after those checks. NOT RUN — any human or organisationally independent review: every reviewer is an AI agent lane under briefs written by the same coordinator.
**Executable:** `512d5e8`. **Environment:** as per row.

| Reviewer / lane | Kind | What it inspected / tested | SHA |
|---|---|---|---|
| R (iteration 1) | unit + DB review | lanes A/B/C (13/13 approved), D (five passes, two claims refuted), F; both roles; mutants | ab5f928 … 788d29a |
| R2–R9 | unit + DB review, mutants, own probes | E/E2/B2, A2/F2/E3, D2, C2, A3/D3/F3/C3 and the integrated candidate (R6), A4/C4 (R7), M1 v2 (R8), M2 (R9); five lanes refused on first review; R6 found two Medium defects in the fixes (SF-111/112) | through 704ab57 |
| Lead sweep | DB verification | 112 integration runs, both roles: 105 ok, 3 non-zero (2 setup skips and 1 restricted `tenant-restore-purge-race` run with 2 failed cells; all passed on rerun), 4 no-tests-ran by design | 03ef584 |
| R10 phase 1 | static architecture/code review | transaction layer of L1; found R10-1…R10-4 | 1ca92c0 |
| R10 phase 2 | DB verification, both roles, fault injection, mutants | 52 runs; confirmed R10-1 (Medium regression), R10-2/3/4, new R10-5 | 1ca92c0 |
| R10 delta | DB verification, both roles | L2 delta: R10-1…5 CLOSED; new R10-7 (SF-139), R10-8 (SF-140); Stripe webhook behaviour change; 58 runs | 512d5e8 |
| Lead gates | unit / static | lint, audit, unit, tsc, isolated build, tree secret scan | 512d5e8 |
| CR | code reconciliation (static; no tests) | eleven path fixes, hub routes, checker, migrations; five corrections to the v1 decision | 704ab57 (hub files identical at 512d5e8) |
| First attempt (other session) | browser rehearsal | Node 25, aborted: 28 PASS / 5 FAIL | 704ab57 |
| RD | failure classification | first attempt's five FAILs and the abort | 704ab57 |
| RH run 2 | browser rehearsal, both roles | all hub journeys PASS; P2028 ×2 per role; one bare `/login` (became SF-137); SF-138 found | 704ab57 |
| RH run 3 | browser rehearsal, both roles | every journey PASS; 0 P2028; SF-137 not recurred (code unchanged) | 512d5e8 |
| Coordinator | operational readiness (read-only) | production SHA, variable names and ages, Stage 0 migration state, ruleset; nothing executed | PROD |

**Coverage of the final integration.**
- `512d5e8` = `704ab57` + L1 + L2 + one test commit.
- The L1+L2 library delta was reviewed by R10 (phase 1, phase 2, delta).
- The hub routes, `auth.ts` and `proxy.ts` are byte-identical to `704ab57` and `03ef584`; `lib/auth-lockout.ts` and the transaction libraries changed (L1+L2) and were reviewed by R10.
- The recovery-code database tests were re-run at `512d5e8`, both roles, all PASS (section D).
- Run 3 and the gates ran on `512d5e8` itself.
- After `512d5e8`, only documentation changed.
- **Not covered:** the production build at the merge commit; operational readiness, which was assessed but not executed (recovery, migration rehearsal, configuration); owner recovery-code redemption in the browser.

**Disagreements and corrections (preserved).**
1. **CR versus decision v1:**
   - SF-30 was counted as fixed, but `unsafe-inline` is still enforced;
   - `ab5f928`'s change to the login-email route is body strictness, not subject binding;
   - SF-54/91 feed the attendance import, not address freedom;
   - the checker omits `admin.login_email.checked` and the member `sessionVersion` check;
   - `--expect-migrations local` expects all 100 migrations, not six;
   - the production migration tree ends at `20261003180000`, not `20260930100000`.
2. **R10 versus L1:**
   - L1's `1ca92c0` introduced an unbounded slot hold (R10-1, Medium), so it was not releasable alone;
   - R10-5 showed lock waits reaching the caller as 57014 and producing a 500 on restore;
   - after L2, R10 **refuted** the claim that a slow query "still 500s": it now reaches the caller as P2028, is read as *busy* and answers 503 — a misclassification, ledgered as SF-139.
3. **RD versus the first attempt:**
   - RD classified the five FAILs and the abort as driver/hand-off errors plus one environmental P2028;
   - run 2 then showed the flow-4 symptom is an **application** contract deviation (bare `/login` instead of the SF-44 503), triggered by the environmental timeout;
   - it became SF-137, so "environmental" alone was incomplete.
4. **Run 2 versus run 3:** SF-137 did not recur in run 3, but the code is unchanged, so it stays OPEN. "Did not recur" is not a fix.
5. **Ledger notes:**
   - SF-27's member half was labelled "awaiting review" while code and tests were present (CR §1);
   - `idle_in_transaction_session_timeout` in production: read as 300 s, 11 Oct (FINDINGS SF-135; db-role-inspect, read-only); the review hand-off, which said UNVERIFIED, was corrected in `cf17d78` — resolved.

**Independence limits.**
- All reviewers are agent lanes of the same model family, reading briefs and ledgers written by the coordinator. Shared assumptions are therefore possible: for example, every lane accepted the TEST branch as a stand-in for production.
- The E lanes and the coordinator's cross-owner edits were not independently reviewed (SECURITY-ACCEPTANCE §4).
- The hand-off for a human reviewer exists (`evidence/review-handoff/README.md`) but was not used.

**Unresolved findings at `512d5e8`:** SF-137, SF-138, SF-139, SF-140, the Stripe webhook behaviour change, and the full open list in §26.

---

## 26. Security acceptance and release decision

**Status:** classification complete; **every owner decision column is empty**. Nothing below is accepted by this document. Accountable owner for every row: Noe (sole operator and owner). Review/expiry dates are proposals.
**Executable:** `512d5e8`.

### 26.1 Must fix (or complete) before this release

| Item | Why it blocks, in plain language | Evidence needed | Owner decision |
|---|---|---|---|
| Recovery and migration rehearsal on a production-derived branch (SF-19/77; packet §5) | Without it, nobody has shown that production can be restored, or that the six migrations and the old code behave on real data | branch time and expiry; `migrate status`; timings; two boots; RTO/RPO | |
| `main` protection: PR + required CI check, no bypass (SF-15, D-14) | Today a direct push deploys and migrates production with no check | ruleset read-back after the change | |
| Rotate `MATFLOW_ADMIN_SECRET`; re-read `EMAIL_DELIVERY` = off | The legacy secret is 53 days old and held by old builds; mail must be provably off before any account change | variable age after rotation; `EMAIL_DELIVERY` read back as `off` (edit only if not); release-verify `tenant.email_delivery_off` | |
| Preview-deployment decision for the release push (packet §7 step 2) | A preview of the release branch would run with Preview secrets (admin secret, Stripe, Blob, `TESTING_MODE`); `TESTING_MODE` on Preview bypasses mandatory 2FA there | the setting chosen and recorded | |
| ~~Correct or supersede `DEPLOY-2026-10.md` §5 ("Instant Rollback preferred")~~ — DONE (`cf17d78`; section D) | In an incident it would have restored old code, retired secrets and the shared-secret door | runbook line 190, SUPERSEDED notice | |
| Residual decisions recorded (26.3) | The release proceeds on explicit decisions, not defaults | ticked packet §6 | |

### 26.2 Requires additional evidence before deciding

| Item | Question to settle | Evidence | Owner decision |
|---|---|---|---|
| Neon password and Resend key revocation (SF-14) | Are the leaked credentials dead, or only replaced? This decides whether old deployments can still reach data or send mail | provider dashboards: identifiers and timestamps of the deleted or reset credential (no values) | |
| `ENABLE_GOOGLE_OAUTH`, `MATFLOW_CSP_ENFORCE`, `LOGIN_THROTTLE_ENABLED` names in Production (SF-36, SF-30, SF-68) | Unknown since 9 Oct | variable names re-read | |
| Demo club accounts and the committed demo-seed password (SF-109) | Was the production demo club seeded with the public password? If so, it is a live credential in public history | owner's read of how the demo club was created; rotation if yes | |
| Production compute size and connection limit (the idle-in-transaction timeout is settled: 300 s, read-only, 11 Oct; section D) | Unknown; affects the §18 limits | read-only settings read (owner-approved) | |
| Sentry delivery from production | Is the only monitoring channel live? | a test event received | |
| Preview `NEXTAUTH_SECRET` equal to Production? (C6) | If equal, any Preview runtime or Preview-env reader can mint production sessions | owner compares names and updated times, or rotates Preview's copy | |
| Stripe live webhook endpoint (condition of the Stripe row, 26.3) | Does a live endpoint point at production today? Decision §3a says none; not re-read | Stripe → Developers → Webhooks read by the owner | |

### 26.3 Proposed explicit owner acceptance

| Residual | Impact | Likelihood assumptions | Exposure | Mitigation | Review / expiry | Planned remediation | Owner decision |
|---|---|---|---|---|---|---|---|
| SF-137 bare `/login` on an `unknown` revocation verdict | A signed-in owner sees the club-code page with no message; the cookie stays intact; a retry works | needs a DB timeout during a page render; seen twice (first attempt flow 4 on Node 25; run 2 restricted flow 7), 0 in run 3 | every staff page under database pressure, including Sean's first sign-in after the change | the owner tells Sean to retry; monitor the revocation log line | 14 days after release | map `unavailable` to a 503 in `requireSession` with a unit test and a browser cell (or FIX FIRST — small, but it changes the candidate and needs gates, review and a rehearsal) | |
| SF-138 operator address in tenant audit metadata | the operator's own address is readable by that club's audit view | every impersonation, approval or tenant creation (separately, every application rejection writes the operator's address to the server log via `console.warn`, `reject/route.ts:72-75`, and to a tenantless platform audit row) | operator privacy only; not on Sean's path | none | next candidate | operator id or keyed digest; drop the address from the reject log line | |
| SF-139 budget cut classified as busy | a persistently slow purge step is skipped silently; restore answers 503 | only under slow statements | reporting only | none | next candidate | distinguish budget from lock wait | |
| SF-140 misleading guard log | a log line says "released inside a transaction" for a dead connection | rare | log noise | none | next candidate | check `_queryable` | |
| Stripe webhook P2002 → 500 | a duplicate event is never acknowledged; Stripe retries for ~3 days and may flag the endpoint | only with a live endpoint | none reported in Decision §3a; not re-read — owner to confirm on Stripe → Developers → Webhooks (26.2) | **condition:** owner confirms no live endpoint now, and none is created before the payments branch lands | at the payments milestone | the payments branch removes those catches | |
| Owner/staff recovery-code redemption not browser-rehearsed | a defect in the page flow would surface only when someone needs recovery | rare event | owner and staff recovery | integration tests at `512d5e8`, both roles (12 Oct): 5/5, 4/4, 4/4 and 14/14 (section D) | 30 days | add a driver step | |
| SF-30 enforced CSP keeps `unsafe-inline` | any injected inline script runs; amplifies an XSS bug | needs a separate injection bug | all pages; unchanged from production | report-only nonce policy collects violations | 30 days | enforce `MATFLOW_CSP_ENFORCE` after a preview check | |
| SF-05 legacy untagged links | a pre-release invitation or login link for an address still works on the old rule until expiry | needs an outstanding link plus an address change or deletion | ≤ 7 days after deploy | the workflow retires tokens for both addresses in Sean's club | release + 7 days | remove the legacy branch | |
| Owner route: synthetic domains not refused; support check only in proxy; version bound at code entry (CR gap 3; SF-09) | operator error could set an unusable login; an owner self-change inside the 5-minute window could be overwritten | operator mistake or concurrent self-service | the operator plane only | operator checklist "never a synthetic domain"; Sean is told not to change his own address during the window | next candidate | in-route checks; compare the check-time version | |
| Runtime role `neondb_owner`, RLS backstop only, editable audit, Operator rows writable (SF-62/57/73/74/87) | anyone with the runtime credential controls all data and the audit trail; no database-enforced isolation | requires a credential leak or SQL injection; one leak already occurred (7 May); revocation unevidenced (Q6) | all clubs, all audit; unchanged by this release, which is **not** the basis for acceptance (requirement 17) | credential rotation; application filters; mail off | **explicit time-boxed decision** — proposed release + 30 days | SF-62 phase 1–3 (13–19 agent-days) then SF-57 v2 | |
| SF-118/119/59 availability under burst | one address or bucket can refuse others on an instance; the real owner may be told the wrong reason | needs a deliberate burst | sign-in availability | fails closed; nobody admitted | 30 days | stop holding a connection while waiting; fix the message | |
| SF-90 member TOTP replay | a captured member code works again within its window | needs interception | members with TOTP | none | 30 days | migration plus conditional spend | |
| Old deployments with old secrets (SF-10, C5) | old builds behind Vercel SSO still accept the legacy operator secret and hold pre-rotation credentials | needs Vercel team access plus the old secret | operator plane via an old URL | Vercel SSO; rotation of the Neon/Resend credentials if revoked | delete after release verification | separately authorised deletion | |
| SF-20 / SF-15 build and install with production secrets, no provenance | install and build scripts (root `postinstall`, allowed dependency scripts, build-time plugins) run with the Production environment in scope; Vercel installs with `npm install`, not `npm ci`; postinstall-downloaded engine binaries sit outside lockfile integrity; no build attestation | needs a compromised or malicious dependency or build plugin | every production secret available to the build, including the database credential that runs `migrate deploy` | allowScripts skipped dependency install scripts in the serving build (SF-71); pinned `pg`/`pg-pool`; lockfile; `npm audit` 0 (§21) | 30 days | `ignore-scripts` with an explicit allowlist and engine checksums; build provenance; `npm ci` on Vercel | |
| SF-50 review minors (includes: revoke-all of a staff user does not end that person's own member session; waiver links not subject-bound) | a revoked staff user who is also a member keeps a member session; a waiver link is not tied to its person | needs a staff user who is also a member, or a forwarded waiver link | member portal of the affected person | the staff session itself is revoked; member routes refuse support sessions | 30 days | per FINDINGS SF-50 | |

### 26.4 Outside this release (justified)

| Item | Justification |
|---|---|
| SF-17 `CRON_SECRET` absent | At `512d5e8`, retention stays off on its own gate: `RETENTION_CRON_ENABLED` is unset, and only the exact string `"true"` enables it (one-way door, SF-127; `512d5e8:app/api/cron/retention/route.ts:131-144`). The serving build `e8afb6a` has no such gate (its route checks only `CRON_SECRET`, `:137-139`), so in production today the absent `CRON_SECRET` alone stops the sweep. Without `CRON_SECRET`, though, the class-instances cron (daily 02:40) and the monthly-reports cron also answer 503 and do nothing. ClassInstance rows then stop being generated, and members cannot check in once the current window lapses (`class-instances/route.ts:4-14`). This is the same in production today (`e8afb6a`). **Owner residual (section B; Q1 e):** either name who presses the manual "Generate" and when, or set a new `CRON_SECRET` — only after `512d5e8` is serving and verified (Q10) with `RETENTION_CRON_ENABLED` confirmed unset, and never while `e8afb6a` or any older build serves |
| Stripe restricted live key (prefix leaked 7 May; Production and Preview) | Only a 25-character prefix leaked (CONTAINMENT C4); no live Stripe is in use (no connected account; endpoint check in 26.2); roll as hygiene, prepared separately from this release (SF-14 Stripe part) |
| SF-18 DMARC/SPF | Mail is off only once `512d5e8` serves with `EMAIL_DELIVERY=off`; the serving build `e8afb6a` has no mail switch and sends mail today with the new Resend key. DMARC and SPF are required before mail is deliberately enabled |
| SF-69 Blob token rotation | Must follow this release (old builds would leak a new token) |
| SF-131..134 tooling hardening | Readiness-script residuals blocked by D-8; not runtime |
| SF-101, SF-105/108, SF-55, SF-60, SF-61, SF-115 | Hardening or Low residuals not on the changed paths; unchanged exposure; next candidate |
| Payments branch (COEP removal, its seven migrations) | Separate milestone; excluded from `512d5e8` (§20) |

---

## 27. Evidence integrity and final completeness check

**Status:** PASS — the diff, changed routes and libraries, the migration set, the ledger and the required journeys are reconciled below. FAIL — stale or contradictory documents remain (27.3 items 3 and 5–8; items 9, 10 and 11 resolved 12 Oct 13:10–13:15 UK; items 1, 2 and 4 were resolved by `cf17d78`); none changes the code verdict, but the packet wording residues (item 10) could misdirect an operator unless this report's order is followed. BLOCKED — configuration and operational prerequisites (§22, §23, §26.1).
**Executable:** `512d5e8`.

### 27.1 Reconciliation

| Axis | Reconciled against | Result |
|---|---|---|
| Complete diff from serving | `git diff e8afb6a 512d5e8`: 187 commits, 1,330 files | runtime delta = hub + campaign + L1/L2 + pg pin; no code after `512d5e8` |
| Changed routes | 98 files under `app/api`; 49 privileged | §15 table; all 49 byte-identical to `03ef584` |
| Shared libraries | `auth.ts`, `proxy.ts`, `next.config.ts`, `package.json`/lock, 4 workflows, and lib files incl. `prisma.ts`, `prisma-tenant.ts`, `rate-limit.ts`, `auth-lockout.ts`, `session-revocation.ts`, `auth-token-binding.ts`, `login-email.ts`, `operator-step-up.ts`, `operator-auth.ts`, `csp.ts`, `tenant-lifecycle.ts`, `support-session.ts` | the five transaction-layer files changed after `03ef584` and were reviewed by R10; the rest are covered by R2–R9 |
| Migrations | `prisma/migrations` versus `e8afb6a` and production | exactly six new; production missing exactly these six (Stage 0) |
| Findings ledger | FINDINGS.md SF-01..SF-140 | every material open row classified in §26 (including, after reconciliation, SF-17's cron effect, SF-20/SF-15, SF-50, the Stripe restricted key and Preview `NEXTAUTH_SECRET` equality); SF-137..140 present |
| Required journeys | run 3 §5 | all PASS both roles except owner recovery-code redemption (NOT RUN) |
| Configuration and operations | packet §4–§7 | BLOCKED on the owner items in §26.1 |

### 27.2 Failures preserved, and what resolved them

| Original failure | Cause established | Resolving evidence |
|---|---|---|
| L1 cycle 2: 15 failed `sec-c3` runs of 24 | TEST warm-up connectivity (14) + fail-safe lock-deadline under-allow (1); 0 unhandled (ITERATION-2-REPORT §11) | R10 phase 2 and delta: 0 product-caused unhandled; failures kept |
| First attempt: 5 FAIL + abort (`704ab57`, Node 25) | driver/hand-off errors plus environmental P2028; flow 4 = SF-137 | runs 2 and 3; SF-137 still OPEN |
| Run 2: bare `/login` (restricted flow 7), P2028 ×2 per role | SF-137 contract deviation; P2028 cause not established | run 3: not recurred; code unchanged |
| Run 3: restricted server-log standard FAIL (revocation refused 1) | pg connection timeout on TEST | none — recorded, not resolved |
| Run 3: SQL-check FAILs (SF-138 flag; holder-helper artefact) | expected: one ledgered finding, one helper artefact (run 2 §4.4) | classified |
| R10: probe A, B4a, B12 39/40, D-plant exit 1, `sec-a4` S2 owner 1 cell, `sec-l1`/`sec-c3` skipped suite runs | reviewer capture window; SF-139; TEST connectivity; intended control; fail-closed refusal (SF-118 family; R10-8/SF-140); TEST connectivity (every cell skipped on setup connection timeout) | DELTA-HANDBACK "Failures kept" |
| Sweep `03ef584`: 3 non-zero, 4 no-tests-ran | 2 setup skips (reran OK) and 1 restricted `tenant-restore-purge-race` run with 2 failed cells (re-run 5/5); SF-57 suite skipped by design; fixture sweep | `sweep-03ef584-reruns.txt` |
| Unit: 1 skipped | known Windows-only skip | gates log |
| Tree secret scan: 8 candidates | count only in the gates log; the list is not recorded there; "pre-existing fixtures and the demo-seed password" is asserted by commit `665bc68` and not independently verified here | SF-82, SF-109 (SF-109 needs owner evidence, §26.2) |

### 27.3 Stale, contradictory or incomplete evidence

1. **`docs/runbooks/DEPLOY-2026-10.md` §5** preferred Instant Rollback. **RESOLVED by `cf17d78`**: marked SUPERSEDED with the fix-forward rule (runbook line 190).
2. **`HUB-RELEASE-DECISION-2026-10-12.md` §5** described a fast-forward push of `704ab57` and a deferred PR ruleset; its §8 verdicts read "704ab57". **RESOLVED by `cf17d78`**: both sections marked superseded (by §3a/§7b and packet §7: PR + merge commit at `512d5e8`).
3. **`ledger-vs-candidates.tsv`** is indexed against `2a6487e`. It ends at SF-136 with pre-review statuses and has no rows for SF-137..140. Kept as a historical index; superseded by the ledger's current rows SF-135..140 (section E).
4. **`idle_in_transaction_session_timeout` in production:** "300 s" in FINDINGS SF-135 versus "UNVERIFIED in production" in `evidence/review-handoff/README.md` item 8. **RESOLVED by `cf17d78`**: the README now records 300 s (read as 300 s, 11 Oct; hand-off corrected). One residue: the README's time stamp "16:12 UK" should read "15:12 UK (16:12 Italy)" (ITERATION-2-REPORT §9 says 16:12 Italy; commit `b82ca48` recording it is dated 15:13 UK).
5. **Production `DATABASE_URL` uses the direct host** (packet §4; decision §1). The project's CLAUDE.md requires the pooled host for production. This decision is unrecorded; it affects SF-87 and §18.
6. **First attempt record** (`REHEARSAL-704ab57-RUN-2026-10-12.md`) was never completed: steps 10–20 are pending and its cleanup is not recorded. It is also **untracked in git** (owned by the other session), so it is not committed evidence. Lane RD's screenshot masking is not recorded. Coordinator follow-ups in Q13 (record or perform the cleanup; verify the RD masking).
7. **`THREAT-MODEL.md`** is dated to `2a6487e` (§14).
8. **Production facts are point-in-time:**
   - variable ages (12 Oct 00:30 UK) and Stage 0 (01:33 UK);
   - the owner-reported provider state (11 Oct 17:07 UK);
   - the deployment inventory (9 Oct; 64 builds).

   All need refreshing immediately before approval.
9. **Provider revocation status (SF-14) — RESOLVED 12 Oct 13:15 UK.** `ITERATION-2-REPORT.md` §9 and FINDINGS SF-14 had recorded the Neon password and Resend key as evidenced or mitigated on the owner's dashboard read alone; both now say provider-side revocation is NOT EVIDENCED, consistent with Q6.
10. **Packet wording residues after `cf17d78` — RESOLVED 12 Oct 13:10 UK.** Packet §5 step 1 now names `rehearsal-hub-512`; §5 (ii) creates `pre-hub-release` immediately before the merge; §7 step 3 now runs after CI is green and before the merge, followed by the restore point and the change window; §6 row 9 no longer recommends acceptance (existing exposure with a dated remediation plan); §6 row 10's box is a plain empty box.
11. **DENIALS status note on D-11 — RESOLVED 12 Oct 13:15 UK.** The note now says D-11 (the campaign e2e suite on `1ca92c0`) was not re-requested and remains unobtained; the hub journeys were rehearsed separately with the scratchpad drivers.

### 27.4 Concluding points (lane AQ2 recommendation — the overall deployment-readiness conclusion is the coordinator's to sign after reconciling with AQ1)

1. **Is the exact candidate ready for deployment?**
   - **Recommendation: not yet.**
   - The code evidence for `512d5e8` is sufficient for this release's purpose:
     - independent review of the final library delta;
     - gates on the SHA;
     - every hub journey in the rehearsal plan passed under both database roles on a fresh production-mode build of the same SHA, except the recovery-code redemption browser step (not run; database tests at `512d5e8` only);
     - no code changed since.
   - The prerequisites in §26.1 are not complete: the production-derived recovery and migration rehearsal, `main` protection, admin-secret rotation and mail read-back, the preview decision, and the recorded residual decisions (the runbook correction is done, `cf17d78`). Provider-side revocation evidence for the leaked Neon password and Resend key (§26.2; section A item 1) is also outstanding.
   - Green test counts do not substitute for these.
2. **What remains exposed after deployment.**
   - The runtime still connects as the owner role: no database-enforced isolation, and the audit trail is editable.
   - Inline script is allowed by the enforced CSP.
   - Legacy untagged links stay valid for up to 7 days.
   - Old deployments still hold old secrets until they are deleted, and leaked credentials are not proven revoked.
   - The Blob token is unrotated.
   - Member TOTP codes can be replayed.
   - Sign-in availability under a deliberate burst is weak (fails closed).
   - SF-137 navigation under database pressure.
   - There is no tested restore of production data, and no monitoring baseline.
3. **Can Sean's correction proceed after the post-release checks?**
   - Yes, provided every packet §7 step 6 check passes and approval B is given on fresh facts (decision §6).
   - The workflow passed end to end under both roles at `512d5e8`: holder check, step-up binding, the two-step change, lost-response replay, stale refusal, token retirement, and checker 38/38.
   - It must not proceed if any row of the Q10 table fails (Vercel build log, release-verify, tree identity, stage 0, the operator sign-in, Sentry).
4. **Remaining blockers and owners.**
   - **Noe:**
     - packet §5 rehearsal;
     - admin-secret rotation;
     - `EMAIL_DELIVERY` read-back;
     - preview setting;
     - ruleset tightening (manual-mode prompt);
     - provider revocation evidence;
     - residual decisions;
     - SF-109 answer;
     - deployment approval A;
     - later, approval B with Sean's voice confirmation.
   - **Coordinator:**
     - ~~correct `DEPLOY-2026-10.md` §5 and the stale decision §5/§8 wording~~ — done (`cf17d78`);
     - the packet, DENIALS, README, ITERATION-2 and FINDINGS wording residues (27.3 items 4, 9–11);
     - the `ledger-vs-candidates.tsv` disposition (kept as a historical index, section E);
     - re-read the production variable names and ages immediately before approval;
     - ~~reconcile this file with AQ1~~ — done (sections D and E).
   - **Sean:** voice confirmation of his intended login address; the replacement address as agreed on 9 Oct (re-confirm only if the hub Check address shows a different holder or state); his own sign-in after the change.
5. **Next concrete action.** Superseded by section A item 5 and section C: first, sign in to the current operator console with password and authenticator. The rehearsal then runs on `rehearsal-hub-512` (C step 7). `pre-hub-release` is the untouched restore point, created only at C step 8, immediately before the merge, and is never migrated or booted against.
