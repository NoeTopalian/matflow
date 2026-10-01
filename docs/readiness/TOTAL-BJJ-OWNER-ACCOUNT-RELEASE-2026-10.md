# Total BJJ owner account — release package & engineering verification

**Milestone: ENGINEERING VERIFIED (1 Oct 2026, candidate `1276e24`) + deployment package.** Not deployed, not provisioned, Sean not contacted. Prepared 1 Oct 2026 (Italy). Final engineering candidate **`1276e24`** on `main`, local only.

> Milestone ladder (report each separately, never conflate): **ENGINEERING VERIFIED** = the frozen candidate passes the agreed checks, not deployed · **READY FOR ACTIVATION** = after an authorised deploy + production checks + the real named account exists · **ACTIVATED** = after Sean himself enrols an authenticator and signs in. This document delivers the first, plus the exact package to reach the second.

## 1. Candidate & changes since production
- **Final SHA:** `74682a9` (`main`, local). **130 commits ahead of `origin/main`**; production runs an **older build** — the deployed SHA is **not exposed by any route**, last known `90868eb` → treat the live version as **UNKNOWN until read from Vercel's deployment metadata** at deploy time.
- **Headline launch changes in this candidate:** mandatory owner TOTP (`64263ba`) + the activation-order/API-shape fixes (`74682a9`); payments CSV export audit (`a841520`); the independent security gate (SAST+DAST+isolation review, `e06b7b0`/`ea43b47`/`b2af378`); the TeamUp bridge (billed-by-TeamUp, status refresh, holds that never touch external collection, `426f595`/`3ccc20d`/`d97a3c4`); import provenance/rollback/atomicity; waiver shown-text integrity; member-action auditing; hold/resume correctness.

## 2. Pending migrations (10, all additive, wrapped BEGIN…COMMIT, atomicity-tested)
`20260923220000_billing_cycle_weekly` · `20260924120000_member_hold_until` · `20260925000000_locations` · `20260925090000_tier_location` · `20260926130000_user_must_change_password` · `20260930100000_import_provenance_review_lock` · `20260930120000_request_ids` · `20260930140000_member_billing_source` · `20260930160000_class_is_kids` · `20261001100000_member_hold_prior_status`.
- **Applicability:** all are nullable column adds, new tables (`Location`), a widened CHECK, and unique indexes on nullable keys — the **old build keeps serving on the new schema** (forward-compatible). Applied to the Neon **test** branch only; **not** timed on production-sized data.
- **Known limitation:** migration history does **not** replay from an empty database (fails at `20260513000002`) — a *new* environment can't be built from migrations alone; **deploying onto the existing production database is unaffected**. Squash/repair before a second environment is needed.
- `scripts/maybe-migrate.mjs` runs `prisma migrate deploy` during the Vercel build, so the deploy applies these automatically. **Representative-schema rehearsal on a ≥300-member throwaway is recorded in `TOTAL-BJJ-LAUNCH-REGISTER-2026-10.md` §3 (PASS on the test branch); a production-sized timing run is still owed.**

## 3. Required environment configuration (names only — never values)
| Name | Why | State for this release |
|---|---|---|
| `DATABASE_URL` | app DB — must be Neon's **pooled** (`-pooler`) host | set (prod) |
| `AUTH_SECRET` / `NEXTAUTH_*` | session signing, TOTP HMAC, cookie integrity | set (prod) |
| `CRON_SECRET` | **required** or every cron 503s — incl. `class-instances` (the timetable) and `retention` | **set only AFTER reading the retention `?dryRun=1` preview** (destructive first run) — outstanding |
| `MATFLOW_ADMIN_SECRET` | operator plane (used to provision Sean's tenant) | set (prod) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_CLIENT_ID` | card rails — **not needed for the bridge** (TeamUp bills) | present; card paths stay refused for TeamUp-billed members |
| `RESEND_API_KEY` / `RESEND_FROM` | email delivery | **deferred** — activation is mail-free (§7); member invites wait on DMARC |
| `BLOB_READ_WRITE_TOKEN` | CSV import + photos | confirm set on Vercel |
| `TESTING_MODE` / `DEMO_MODE` | test bypasses | **MUST be unset/false in production** — a production-build smoke with bypasses off is part of §6 |

## 4. Backup, recovery & rollback
- **Rollback of code:** redeploy the previous Vercel build. **Code rollback does NOT reverse the migrations** — they are additive and the old build is compatible, so recovery is *forward* (redeploy-previous keeps serving; fix-forward for any schema issue).
- **Data recovery:** Neon point-in-time restore. **A restore rehearsal has NOT been run** — **owner: Noe** (Neon console). This is a release prerequisite for the Recovery gate; it does not block ENGINEERING VERIFIED.
- **Responsible person for recovery:** Noe (platform owner).

## 5. Post-deployment smoke plan (read-only / safe)
Health `db:ok`; `/login?club=<slug>` renders branded; `/apply` 200; operator login; a dashboard read as the demo owner; confirm **`TESTING_MODE`/`DEMO_MODE` are off** (a protected page must demand real auth + MFA); confirm the deployed SHA from Vercel metadata equals `74682a9`; `/leaderboard/<bad>` 404; no 5xx on the new auth routes.

## 6. Independent verification (final candidate `1276e24`, production build, bypasses off)
- **Static gates (lead, recorded on `1276e24`):** tsc 0 · lint clean · Semgrep ratchet 0/0/0 · **unit+integration 2,701 passed / 0 failed** (294 files) · migration-atomicity included · production build exit 0. (RLS 9/9 restricted re-confirm owed on the freeze.)
- **Isolation & billing safety (independent — agent a9ecdb57):** **CONFIRMED** on tenant isolation, roles, suspend/revoke, operator plane, money/billed-elsewhere (409 before any provider call). Found one **P1 (API MFA bypass)** — ~82 bare-`auth()` routes let a not-enrolled owner read tenant data — now **FIXED `1276e24`** (middleware gates every `/api` with a JSON 403). P2 (migrate) and P3 (hold/resume, 200-empty) dispositioned as by-design. NOT-RUN areas were CONFIRMED in the earlier Layer C review.
- **Auth lifecycle re-verification (independent — agent adce7a3c):** **WORKING** 12/12 — pre-MFA page gate, enrolment, logout→login-with-TOTP, negative codes, throttle (bypasses off), session revocation, no self-disable, single-use recovery, secure cookies. **FINDING-1 (password-before-TOTP order): FIXED & confirmed.** The API-gate half it flagged = the same P1, now fixed in `1276e24`. **FINDING-B** (wide TOTP verify tolerance, otplib 13.4.0, pre-existing medium) documented for a focused follow-up — not a bypass, not a release-blocker.
- **Owner-workflow acceptance matrix (independent — agent afcba7fb):** **8 of 9 areas WORKING** through the real UI with DB + reload (classes incl. TZ/DST, registers/check-in incl. refusal copy + capacity override + idempotent duplicate, members/families, memberships incl. correct resume, waivers incl. parent-for-child, manual payments incl. lost-response idempotency, reporting incl. the `payments.export` audit row, staff/settings). Phone 390px clean; honest empty/error states; `class-instances` cron scheduled + idempotent + 56-day missed-run tolerance. **Import/refresh/rollback BLOCKED environmentally** (no `BLOB_READ_WRITE_TOKEN` on this build) — logic + unit/integration + prior e2e stand. One **low defect D-MED** (medical-conditions not settable via the staff profile Edit form) — documented.
- **P1 fix re-confirmation on the rebuilt `1276e24` build (lead, on the prod build bypasses off):** **CONFIRMED** — a not-enrolled owner (`requireTotpSetup=true`) gets **403 JSON** on `/api/members`, `/api/reports`, `/api/settings`, `/api/payments/outstanding` and `POST /api/members` (all previously served 200/data), and `/dashboard` → 307 `/login/totp/setup`.
- **Full 29-file browser pass on `1276e24`: 645 passed / 0 failed / 0 did-not-run, every file on its first attempt, no server deaths** (serial runner `x12/serial/final-1276e24`, dev server `.env.test`, Neon test branch; 1 Oct 20:05 UK). The four serial-pressure flakes seen on `b2af378` did not recur. Auth enforcement is TESTING_MODE-suppressed in this run by design; the enforced-MFA behaviour is proven by the production-build checks above.

**Verdict: `1276e24` is ENGINEERING VERIFIED** — static gates, independent isolation/auth/workflow reviews, the P1 re-confirmation on the rebuilt production build, and the full browser pass are all green on the same commit. Not deployed; not provisioned; Sean not contacted.

## 7. Total BJJ provisioning plan (mail-free; execute only on Noe's go + Sean's details)
**No real Total BJJ production tenant exists** (production has demo tenants only). Create a **fresh** tenant via the operator plane — never duplicate silently.
1. Deploy `74682a9` (needs Noe's "push").
2. Operator (`/admin`) **create-tenant** for Total BJJ with owner = **Sean's real name + his PRIVATE email** (authoritative — Noe supplies; never guessed). **Not the club's shared `info@` inbox:** owner alerts (payment failed, dispute, Stripe disconnected, import complete, new-device sign-in) and password resets go to the owner's login address, and a desk person with access to a shared inbox would read them. The create-tenant API answers with a `warnings[]` entry when the owner email looks like a role mailbox (`lib/email-shape.ts`) — heed it. The club's public address goes in **Settings → Overview → Contact email** on Sean's first login (members see it; replies to receipts/reminders land there). Owner gets **no TOTP yet**, so MFA is enforced on first sign-in.
3. Operator **force-password-reset** on that tenant → a one-time temp password shown on screen (never emailed, never logged).
4. Noe privately gives Sean: the club URL, his email, and the temp password.
5. Sean signs in → **sets his own password** (an old one is refused) → **enrols his own authenticator** → dashboard. (This step is what makes it **ACTIVATED** — Sean's participation.)
Recovery for Sean: operator force-password-reset (new temp password) and operator TOTP reset (re-enrol); both audited.

## 8. MFA rollout implications for existing staff
Mandatory TOTP applies to **every elevated role — owner, manager and admin** (`lib/mfa-policy.ts`, 1 Oct 2026: "owner and admin accounts should have more security than normal accounts"), not just Sean (no convenience exemption). A **coach** (registers and check-ins only) keeps optional 2FA; once a coach enrols, the challenge applies. On deploy, the existing **demo** owners/managers/admins (`totalbjjdemo`, `ironpathbjj`) will be **required to enrol an authenticator on their next sign-in** before reaching their dashboard or any `/api` route — expected and acceptable (a security improvement). Nobody can self-disable 2FA once enrolled. **Recovery:** the owner resets a manager/admin/coach from Settings → Staff ("Reset authenticator", reason required, audited `staff.totp_reset`); the owner's own reset stays operator-only (`/admin` → tenant → TOTP reset).

## 9. Outstanding decisions / blockers (owner: Noe unless stated)
- **Push/deploy go** — nothing is deployed.
- **Sean's authoritative name + email** — the only missing input for real provisioning.
- **Confirm creating the real Total BJJ production tenant now.**
- **`CRON_SECRET`** after reading the retention dry-run; **confirm `BLOB_READ_WRITE_TOKEN`.**
- **Restore rehearsal** (Recovery gate) + **production DB runtime-role** query (D8; the app currently connects as a BYPASSRLS role in production — RLS is a backstop only until this changes; the app-layer tenant filter is the primary control, independently reviewed).
- **Manager payments-CSV export policy** (owner-vs-manager) — the audit is now written regardless; the access policy is unresolved.
- **Email/DMARC** for member invites (G3) — deferred; activation does not need it.

## 10. Secure activation-instructions template (NO credentials/seeds/tokens in any file)
> **Your MatFlow club is ready to activate.**
> 1. Go to: `https://<matflow-domain>/login?club=<total-bjj-slug>`
> 2. Sign in with your email `<your email>` and the temporary password I'm sending you separately.
> 3. You'll be asked to **choose your own password** (something you've not used before).
> 4. Then you'll **set up your authenticator app** (Google Authenticator, Authy, 1Password, etc.) by scanning a QR code — this is your required second factor. **Save the recovery codes it shows you.**
> 5. You'll land on your club dashboard. From then on, sign in is your email + password + a code from your authenticator.
> 6. In **Settings → Overview → Contact email**, enter the club's public address (e.g. `info@…`). That's what members see and where their replies land. Your login stays your own address — alerts and resets come to you, not to the shared inbox.
> If you lose your authenticator, contact me — I can reset it so you can re-enrol. Your managers can be reset by you from Settings → Staff. *(Noe fills the domain, slug, email; the temp password travels by a separate private channel.)*

---
_This document is completed when §6's three independent verdicts and the 29-file pass are filled, and the final owner-facing report is issued._
