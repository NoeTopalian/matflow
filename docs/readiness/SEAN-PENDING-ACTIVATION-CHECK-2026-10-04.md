# Total BJJ — pending-activation check (4 Oct 2026)

Secret-free. No names, emails or personal data; counts only. (`tenant-state.mjs` gained an enforced
`SET TRANSACTION READ ONLY` during this run; its earlier production reads were read-only in effect, with no write path.) Row-level working files stayed in the session scratchpad
(`private-*`). Production was **read only** in this run: every production read ran inside `BEGIN READ ONLY … ROLLBACK`
(or `SET TRANSACTION READ ONLY`) through `.env`, host `ep-bold-wave`. Two subagent read queries were refused by the
permission classifier and were not retried; the criteria they served are marked UNVERIFIED.

## Operator summary

- **Sean cannot proceed with the credentials already sent. Blocker: the owner account still carries the operator's
  authenticator.** Production, read 21:10 and 21:31 Italy: `mustChangePassword` true, `totpEnabled` true, TOTP secret
  stored, 8 recovery codes, `sessionVersion` 4, `updatedAt` 2026-10-04 03:08Z, 0 LoginEvents, 0 failed sign-ins. A
  sign-in with the temporary password lands on the authenticator challenge before `/set-password` (A1), so Sean is asked
  for a code only the operator's device produces. Whoever holds one of the 8 codes can also clear the factor through
  the public recovery route.
- **The fix is one operator action — prepared, not executed — but its timing matters.** `/admin` → Total BJJ →
  Danger Zone → **Reset owner 2FA** sets `totpEnabled` false, nulls the secret and the recovery codes, and bumps
  `sessionVersion` (4 → 5). It leaves the temporary password and `mustChangePassword` in place, so Sean's details then
  work in the order password → own password → enrol authenticator.

  **The trade-off:** after the reset, the temporary password is the *only* credential. It has no expiry (A3) and its
  provenance is unconfirmed (A9). Whoever signs in with it first chooses the password and enrols their own
  authenticator. Today the operator's authenticator happens to block that.

  **Safe order:**
  1. Resolve A9. Confirm the value Sean received is the one set at 03:08Z and exists nowhere else. If unsure, also click
     **Reset password** and send the new value to Sean by a second channel.
  2. Agree a time when Sean will sign in, in one sitting.
  3. Just before that, click **Reset owner 2FA**.
  4. Re-run `node scripts/readiness/owner-account-state.mjs --tenant totalbjj`. Expect `VERDICT: PASS`.
  5. Delete the operator's authenticator entry and the 8 codes.
  6. Confirm in Vercel that `ENABLE_GOOGLE_OAUTH` is unset (A2).
  7. Check the runtime database role (§1).
- **The production import is complete and independently reconciled 7/7** (§3).
- **Backups: today's import has no working backup except Neon point-in-time history, whose window is unknown** (§6).
  This is the next risk after the reset.
- **What still depends on Sean's first sign-in:**
  - his own password and authenticator;
  - disabling the demo-era display token (owner-only control);
  - confirming or rejecting the 307 suggested guardian links;
  - resolving the 14 pending attendance identities.

## 1. Production candidate

| Item | Evidence | Status |
|---|---|---|
| Domain | `https://matflow.studio` — `/api/health` 200 `{"status":"ok","db":"ok"}`; `/login?club=totalbjj` 200; unauthenticated `/api/admin/import/attendance?latest=1` → **401 JSON** (21:12 Italy) | VERIFIED |
| Deployed SHA | GitHub deployment 6835932179: `e8afb6a`, environment Production, state success, 2026-10-04 02:34Z | VERIFIED |
| Migrations | `npx prisma migrate status` against production (operator, ~04:37 Italy): 94 migrations, "up to date". This includes `20261003180000_attendance_history_ledger`. The import used its tables (§3). | VERIFIED |
| Code/schema compatibility | The attendance job ran on the deployed code (mapping `attendance@2026-10-03`, started 02:50Z after the 02:34Z deploy) and wrote the new tables; reconciliation reads them | VERIFIED |
| Runtime DB role | App uses `DATABASE_URL` only (`lib/prisma.ts:21`). The maintenance connection is `neondb_owner` with BYPASSRLS. Docs *presume* the runtime is the same (ADR-001 D8). There is no direct evidence: no deployed route exposes `current_user`. | **UNVERIFIED** |

Operator check for the runtime role, read-only and without printing a secret: in Vercel, open Project → Settings →
Environment Variables → `DATABASE_URL` (Production) and read only the text between `//` and `:` (the role). Or, in the
Neon SQL editor:
`SELECT usename, application_name, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1,2;`
and
`SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname NOT LIKE 'pg\_%';`.
If it is `neondb_owner`, RLS is not a backstop in production, and the application `where: { tenantId }` filters
(tested) are the only tenant isolation.

## 2. Account lifecycle and access controls

| Id | Criterion | Status | Evidence | Next action |
|---|---|---|---|---|
| A0 | One tenant `totalbjj`, one user, the owner; no duplicate owner or tenant | VERIFIED | `owner-account-state.mjs` and `tenant-state.mjs`, read-only | — |
| A1 | Pending-activation state is the intended bootstrap (forced password change, no factor, no codes) | **ISSUE (High)** | Production row above. Code: `auth.ts:509` sets `totpPending` from `totpEnabled`; `proxy.ts:249-251` routes to `/login/totp` before the password gate (`:287`); `set-password` refuses while a code is owed (`app/api/auth/set-password/route.ts:63`); `/login/totp` offers no recovery entry. Reproduced by `tests/unit/pending-activation-enrolled-owner.test.ts` (new). | Operator: **Reset owner 2FA** (prepared above). Effects proven by `tests/unit/operator-owner-totp-reset-effects.test.ts` and `tests/integration/owner-recovery-revocation-db.test.ts` (new, test branch) |
| A2 | Mailbox and Google doors shut during bootstrap | VERIFIED | Magic-link request/verify, forgot/reset password and Google all refuse while `mustChangePassword` is true (`magic-link/request:76`, `verify:139`, `forgot-password:86`, `reset-password:115`, `auth.ts:695`). Unit tests pass. | Confirm in Vercel that `ENABLE_GOOGLE_OAUTH` is unset (UNVERIFIED) |
| A2b | Window between his own password and enrolment | Known residual | Mailbox doors reopen once `mustChangePassword` clears. Safe today only because mail is not configured. | Tell Sean to set the password and authenticator in one sitting. When Resend is configured later, keep the same user and verify the address first. |
| A3 | Temporary password expiry and throttling | ISSUE (Medium) — from code; throttling not exercised in isolation | No expiry exists (`schema.prisma:131` is a flag only). Throttling: 5 per slug+email per 15 min, 30 per IP per 30 min, 10 failures → 1 h lockout, TOTP 5/10 min, recovery 5/h (`auth.ts:137-167`, `totp/verify:26`, `recover:32-34`). | Product decision: add a TTL to temporary passwords |
| A4 | Password-first order, MFA before tenant data on pages and JSON APIs, re-login challenge, recovery-code single use, `sessionVersion` revocation | VERIFIED (unit + test-branch DB) | 19 targeted files (`proxy-activation-gates`, `owner-activation-order`, `api-authz-*`, `totp-*`, `session-revocation`, door tests). New DB test 5/5: a code is consumed once, a replay changes nothing, an operator reset nulls the codes and revokes the old version. **Browser E2E not run** (no server in that lane). | — |
| A5 | An API call owing its code gets JSON | ISSUE (Low) | `proxy.ts:249-251` answers `/api/*` with a 307 to `/login/totp` while `totpPending`; no data leaks | Return JSON 403 for `/api/` in that branch (not changed in this run) |
| A6 | `/set-password` in the reserved slugs | ISSUE (Low) | Missing from `lib/reserved-slugs.ts:20-34`, so the proxy passes it as a club short URL. The page and API still authenticate (not exploitable). `public-club-slug-reserved.test.ts:22` uses a hard-coded list. | Add it, and make the test read `app/` |
| A7 | Demo-era display token | ISSUE (Medium, latent) | Issued 2026-09-22, no expiry. `/leaderboard/<token>` is public and shows first name + last initial and check-in counts for this month and last (`lib/leaderboard.ts:37-182`). Imported visits are excluded since `8eaec8e`, and there are 0 live check-ins, so it shows an empty board today. It publishes names from the first live check-in. Only the owner can disable it (`/api/settings/display`). | After activation: Sean → Settings → Integrations → Leaderboard → **Disable**. Interim: none without a production write. |
| A8 | Kiosk | VERIFIED | No kiosk token issued | — |
| A9 | Credential provenance | UNVERIFIED | No record in this repository or this session of the current temporary password's value. The operator signed in with it on 4 Oct to run the imports, then set a new temporary password at 03:08Z (PasswordHistory 3). Whether the value Sean received is that 03:08Z password is not provable without the operator. Any holder of the temporary password can claim the account before Sean; the password and MFA gates do not establish who the recipient is. | Operator confirms the value sent was generated at 03:08Z and was never pasted anywhere else. If unsure, Reset password as well and send the new one by a second channel. |
| A10 | First login | Pending | 0 LoginEvents, 0 failed sign-ins (21:31 Italy). Zero rows do not prove the login UI works for him. `owner-account-state.mjs` prints "ALREADY ACTIVATED" from database state alone; that word is not the verdict. | Re-run `owner-account-state.mjs` after he reports in. ACTIVATED only when `totpEnabled` is true *by his enrolment*, `mustChangePassword` is false and he confirms access. |

## 3. Production import reconciliation

Independent script `scripts/readiness/attendance-reconcile.mjs --production` (its own CSV parser and identity rule, no
app code, READ ONLY): **RECONCILED 7/7** (21:13 Italy).

| Check | Result |
|---|---|
| C1 source | sha256 `115373716468…`; 15,273 rows; Attended 13,795 · Registered 1,331 · Late Cancelled 82 · No show 65; 486 identities; 1,684 provisional sessions |
| C2 one booking per row | ledger 15,273 = CSV 15,273; 0 missing; 0 phantom |
| C3 statuses | identical |
| C4 people | 472 matched · 14 pending · 0 disagreements |
| C5 visits | 13,592 distinct (member, instant) = 13,592 linked records |
| C6 no phantom attendance | 13,592 imported records; 0 on non-visits; 0 unreferenced; 0 live check-ins |
| C7 sessions | 1,684 → 1,613 created + 71 with no resolvable attendance; 0 with an end time |

**Jobs:**
- Members `htfc19`: complete; 926 rows; 922 imported; 4 refused; hash `90693f95…`.
- Attendance `dxekg9`: complete; 15,273 rows; 13,592 visits; 0 errors; mapping `attendance@2026-10-03`; 02:50Z–03:03Z.
- Upload rows and chunks are already deleted (0 left).

**The preview prediction was 13,592 + 1,471 + 165 + 45 = 15,273. Verified exactly.**

**Time:** 14,904 bookings with a session; 0 date and 0 time mismatches against Europe/London. Around 26 Oct 2025 there
are 508 bookings and 0 mismatches; around 29 Mar 2026, 501 and 0. Raw `startsAtRaw` re-parses to the stored instant
15,273/15,273. Instructors and Checkin Timestamp are null for all rows. Visits are dated by the session start and
labelled "Not recorded" (profile) and "Class at HH:MM" (family page). The 14 historical classes have no duration,
capacity, instructor or schedule; all 1,613 sessions have no end time.

**Pending (VERIFIED: 14 identities / 165 rows / 158 attended):**
- 9 attendance-only identities: 20 rows, 18 attended.
- 4 children the members import refused (`kid_without_parent`): 140 rows, 136 attended.
- 1 deleted customer, kept pending by decision: 5 rows, 4 attended.

**No side effects (VERIFIED, read-only):**
- 0 rows in each of: Payment, Notification, MemberClassPack, ClassPackRedemption, MemberRank, RankHistory,
  ClassWaitlist, Order, Dispute, PushSubscription.
- 0 Member or MembershipTier rows updated during the attendance job.
- EmailLog has 2 rows, both before the job: a 23 Sep demo-era row, and the members import's owner notice (3 Oct 12:39Z).
- Every imported AttendanceRecord has `checkInMethod` import and no actor.

### The 45 same-start overlaps — verdict: bookings preserved, visits counted once, class attribution partial (ISSUE, Medium)

**Pairs (45 in all):** Advanced Comp Gi / Advanced No-Gi 15; Advanced Comp Nogi / Advanced Gi 14; All Levels Free
Practice / Judo for BJJ 16.

**What is stored:**
- All 90 bookings are kept, each with its own offering and status `attended`.
- In every pair one booking is `attendance_created` and the other `attendance_existing`, and both point at the same
  AttendanceRecord.
- Each booking keeps its own class's session (90/90).

**Which class keeps the visit:**
- Comp Gi 9 vs No-Gi 6.
- Comp Nogi 10 vs Gi 4.
- Free Practice 9 vs Judo 7.
- The rule is the lower booking key, i.e. a hash: arbitrary, though deterministic.

**Shows the second class:**
- the ledger;
- the ledger CSV: the deployed CSV shows the source Offering column only. **After the local fix (not deployed)** it
  adds **MatFlow class** and **Visit counted in class**, tested row-level and tenant-scoped;
- the DSAR export.

**Does not show it:**
- class registers and per-class reports, which read AttendanceRecord;
- the member attendance list.

On those class-level surfaces, 45 bookings appear only under the other class. 2 Judo for BJJ sessions show nobody
although the source says this person attended. 31 member profiles show more attended bookings than visits, which the
profile line only partly explains.

**Decision for Noe** (not changed in this run, because it alters what every report counts):
- **(a)** Accept: one visit per instant, with the second class in the ledger.
- **(b)** Make registers and per-class reports also list `attendance_existing` bookings, labelled "same visit as
  <class>", keeping visit totals unchanged.

Recommendation: **(b)** before Sean relies on per-class history.

## 4. Roster, family, billing, exports

| Id | Finding | Status |
|---|---|---|
| R1 | 922 members = members job `htfc19` imported rows (703 people + 219 guardian records); 4 refused; 1,082 membership-ledger rows | VERIFIED |
| F1 | 307 parent links, all **suggested** (265 emergency contact, 42 shared email), 0 confirmed; the attendance import created none | VERIFIED |
| F2 | A member cannot claim a child or change family authority: self-PATCH refuses family fields (`member/me:298`, `lib/family-authority.ts:52-56`); child edit/delete and billing/waiver/photo/check-in routes require a confirmed guardian; link/confirm/unlink are owner/manager only | VERIFIED (code) |
| F3 | Kiosk listed children under a merely suggested parent (`kiosk/[token]/members` `children` include) | ISSUE (Low, latent: no kiosk token) — **fixed locally**: confirmed-guardian filter (tested). The `selfTrainable` change in the same file is policy-consistent but effectively a no-op: the client reads it only in the pick-attendees step, which a junior without children never enters. |
| B1 | All 922 billed by TeamUp; 0 `nextDueAt`, 0 Stripe ids, 0 packs, 0 payments, none overdue; debt cannot be derived for TeamUp-billed members (`lib/overdue.ts`) | VERIFIED |
| B2 | Tiers carry real prices entered by the operator (16, none linked to Stripe). No code multiplies price by members; MRR comes from Payment rows only (£0). | VERIFIED |
| B3 | Settings → Revenue showed a hard-coded "+12% vs last month", called real zeros "demo data", labelled all active members "paying members" (531 including TeamUp-billed and parents), and priced four-weekly tiers "/mo" | ISSUE (Medium, misleading) — **fixed locally** (honest banner and labels, cycle wording) |
| B4 | Dashboard week/month attendance tiles include imported TeamUp visits (281 this week, 136 this month on 4 Oct) | Low; truthful visits. Left as is; fades within a month. |
| E1 | Owner exports: attendance ledger parts (owner, audited), payments CSV (owner/manager, rate-limited, audited), import exceptions (owner, audited), DSAR JSON (owner, audited); all tenant-scoped; BOM, CRLF, quoting, formula guard | VERIFIED (code + 350 unit tests); no production download made (0 export audit rows) |
| E2 | Exceptions CSV had no BOM | Low — **fixed locally** |
| E3 | Leading-zero identifiers keep their bytes; Excel hides the zero on display | Documented |
| E4 | TeamUp re-import compatibility of MatFlow CSVs | Not claimed (no TeamUp import format tested) |
| S1 | Two stale generic previews from 3 Oct hold the memberships file (private Blob) and a dry-run summary. Not committable while `htfc19` stands. Retention purges them on 3 Nov. | Low. Option (not executed): discard them now. Retention cron health is UNVERIFIED. |

## 5. Local fixes in this run (not deployed)

| Fix | Files | Tests |
|---|---|---|
| Revenue tab: no fabricated trend, honest banner and labels, billing-cycle wording via `lib/billing-cycle` `cyclePriceSuffix` | `components/dashboard/SettingsPage.tsx`, `app/api/revenue/summary/route.ts` | tsc, lint, unit |
| Kiosk: confirmed children only (`selfTrainable` aligned with the same rule; no visible effect today) | `app/api/kiosk/[token]/members/route.ts` | `kiosk-member-search-pii` +3 |
| Exceptions CSV starts with a BOM | `lib/importers/teamup-exceptions.ts` | `import-teamup-exceptions` updated |
| Ledger CSV: "MatFlow class" and "Visit counted in class" columns | `app/api/admin/import/attendance/export/route.ts` | `import-attendance-route`: header test + row-level values incl. another club's session resolving to blank |
| Reconcile script: `--production` and `--restore-branch` read-only modes | `scripts/readiness/attendance-reconcile.mjs` | run on production (7/7), test branch (7/7), refusal checks |
| `tenant-state.mjs`: `SET TRANSACTION READ ONLY` enforced; the invariant counts only non-import attendance, plus an import-provenance check | `scripts/readiness/tenant-state.mjs` | disposable test-branch tenant (PASS / FAIL as expected); re-run read-only on production 21:40 Italy |
| New security tests | `tests/unit/pending-activation-enrolled-owner.test.ts`, `tests/unit/operator-owner-totp-reset-effects.test.ts`, `tests/integration/owner-recovery-revocation-db.test.ts` | pass |
| Restore runbook | `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` | prepared, not executed |

Production actions, prepared and **not executed**:
- Reset owner 2FA (operator, now).
- Disable the display token (Sean, after activation).
- Discard the two stale previews (optional).
- Set the backup secrets and trigger a dump (§6).
- Confirm the Neon history window (§6).

## 6. Backup and recovery

| Id | Finding | Status |
|---|---|---|
| K1 | Weekly dump `db-backup.yml`: **22/22 runs failed** (10 May – 4 Oct 09:14Z), every one at "Validate secrets" | ISSUE (High) |
| K2 | Secrets: **0 of 5** present (DATABASE_URL_DIRECT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BACKUP_S3_BUCKET, BACKUP_S3_REGION) | ISSUE (High) |
| K3 | Dump has no client-side encryption; the "30-day lifecycle" exists only in a step name; no bucket exists; the repository is public (logs are public, no secret is logged today) | ISSUE (Medium) |
| K4 | Neon plan, history window and restore points | **UNVERIFIED**: neonctl not installed or authenticated. Per Neon's docs: Free 6 h; paid plans default to 1 day, Launch up to 7 days, Scale up to 30. A restore point before the 3 Oct import has probably already expired. |
| K5 | Privacy policy says backups are kept "typically 7–30 days" (`app/legal/privacy/page.tsx:81-82`); runbooks say "Free: 7 days" | ISSUE (Medium, compliance) — correct after K4 |
| K6 | No approved RPO/RTO; restore never rehearsed | ISSUE (Medium) |
| K7 | Recovery of the imports depends only on Postgres: the import files are deleted after use, so the TeamUp CSVs exist only where the operator saved them. Keep them under restricted handling; reconciliation after any restore needs them. Vercel Blob (photos, waivers) has no backup; Total BJJ has 0 waivers. | VERIFIED (code); photo count UNVERIFIED |

**Is today's import covered by a backup?**
- Weekly dump: **no**.
- Neon point-in-time history: **probably**, but the window is unknown.
- Do not rely on next Sunday's dump: it cannot run without the secrets.

The isolated restore rehearsal is prepared in `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md`:
- a branch from a point in time;
- a production build of `e8afb6a` with every provider disabled and `MAINTENANCE_MODE` on;
- integrity counts and `attendance-reconcile.mjs --restore-branch`;
- RTO/RPO timing;
- cleanup.

It needs Noe's authorisation (§1 of the runbook), because the branch holds real personal data. It was not executed.

## 7. Tests, environment and review

- Targeted unit and proxy suites (19 files) and the new security tests: pass.
- New DB test on the test branch: 5/5.
- Import, export and CSV suites: 350/350.
- Route tests: 185/185.
- Kiosk: 11/11.

**Not run:**
- browser E2E of the activation path (no server was started in that lane);
- a production export download (it would write an audit row);
- the restore rehearsal (needs authorisation);
- two read-only production queries refused by the classifier (runtime role probe; member photo count).

**Gates on the final tree (21:50 Italy):**
- `tsc`: 0 errors.
- Lint: passed (eslint and the UI-rules ratchet).
- Unit: 348 files, **3,412 passed**, 0 failed.
- Production build: passed.
- `owner-recovery-revocation-db`: 5/5 on the test branch.

**Independent review:** a critic agent that implemented nothing gave **ACCEPT WITH FIXES**. Its three major points were
closed in this report:
- the gates and review section was unfinished;
- the commercial questions (§8) were missing;
- the reset's credential trade-off and safe order were not stated (operator summary).

Its minor points were all addressed:
- kiosk `selfTrainable` is a no-op, now worded as such;
- cycle wording now uses `cyclePriceSuffix`;
- `tenant-state.mjs` now enforces read-only;
- the ledger CSV columns are labelled as local and not deployed;
- the export has a row-level test;
- the A9 and A2 operator checks are in the summary;
- A3 is marked as from code;
- "ALREADY ACTIVATED" is noted as not being the verdict.

It confirmed against the code:
- A1 (`auth.ts:509`, `proxy.ts:249-251`, `set-password/route.ts:63`);
- the Reset owner 2FA effects (`totp-reset/route.ts:70-84`);
- the 45-overlap arithmetic;
- the backup findings;
- that nothing claims ACTIVATED or "no security issues".

## 8. Commercial questions for Noe (not decided here)

Nothing commercial was touched in this run: no tier selected, no invoice, no payment link, no `subscriptionStatus`
change.

1. **Price.** Which MatFlow plan (£99, £149 or £199 a month) Sean is on, and from when.
2. **Agreement.** Whether there is a written or verbal agreement, including any trial period or discount.
3. **Invoicing entity.** Noe as sole trader, or Arevix (incorporation status unconfirmed here). It decides whose Stripe
   account and legal pages apply.
4. **Membership prices.** The 16 tier prices in production were entered by the operator from the 24 Sep catalogue.
   Sean has not confirmed them. They create no charge, because members are billed by TeamUp.
