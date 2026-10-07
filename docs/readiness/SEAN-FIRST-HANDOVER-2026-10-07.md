# Sean's first Total BJJ handover — record (7 Oct 2026)

Secret-free. No password, code, recovery code or member personal data appears here. Earlier evidence reused and cited:
`SEAN-HANDOVER-VERIFICATION-2026-10-03.md` (source controls, owner activation order, exports, import rehearsal),
`SEAN-PENDING-ACTIVATION-CHECK-2026-10-04.md` (production import + reconciliation, family authority, billing),
`OPERATOR-ADMIN-SECURITY-2026-10-05.md` + `OPERATOR-REMEDIATION-DEPLOY-PACKAGE.md` (operator remediation).

## 1. Verdict

**READY FOR SEAN once Noe completes the deploy steps in §10 — BLOCKED until then on the mail-dark and provisional-email
requirements.** The account and the reconciled data are already in production and Sean could sign in today, but on the
deployed build (`e8afb6a`) email is still on, his login address cannot be marked provisional, and the operator console
still has the 5 Oct audit findings. Everything those steps need is built, tested and committed locally.

**Not ACTIVATED.** Read-only check `node scripts/readiness/owner-account-state.mjs --tenant totalbjj` against production, 7 Oct, before 13:00 UK (output recorded in the session that wrote this record; the address is masked in it): owner account `READY FOR HANDOVER` — must change password, no
authenticator, no recovery codes, 0 sign-in records, not locked, 0 credential changes under support access.

## 2. Where

| | |
|---|---|
| Club URL | `https://matflow.studio/login?club=totalbjj` |
| Tenant | Total BJJ, slug `totalbjj` — the existing real tenant (one owner, no second tenant or owner created) |
| Deployed today | `e8afb6adf782b7b613899250dbe9164d9c71343c` (Vercel Production, 4 Oct) |
| Candidate | local `main` — see §11 for the exact commits; NOT pushed |

## 3. Sean's account

| | |
|---|---|
| Role | Club owner (named, not an operator, not a shared desk account) |
| Login email | `se***@totalbjj.co.uk` — the address Noe supplied (Noe holds it in full). **Provisional, unverified**: MatFlow has never proven Sean controls that mailbox. After the deploy the operator marks it provisional (§10 step 8); from then no reset code, sign-in link, invitation or alert is ever sent to it, and Google/sign-in links cannot be used with it. |
| Password | A temporary password was set by the operator on 5 Oct. It cannot be proven who holds a copy of it (4 Oct record, A9), so §10 replaces it with a fresh one after the provisional mark; only that one goes to Sean. Forced change before anything else; operator-issued temporary passwords expire after 72 h (legacy ones on 20 Oct 2026 23:59 UTC after the deploy). |
| Authenticator | Not enrolled. Sean enrols his own; MatFlow never generated or kept his seed or codes. Mandatory at page and API level. |
| Real email later | Settings → Account → Login email (current password + a fresh authenticator code) or operator-assisted (Danger Zone card, step-up + reason). Same account id, role, club, authenticator and history; old address stops working; every device signed out; the new address stays provisional until mailbox verification exists. Runbook: `docs/runbooks/OWNER-LOGIN-EMAIL-CHANGE.md`. Transition and rollback tested (§8). |

How his activation will read: because the operator created and reset the account, the readiness script reports
**"ACTIVATED AFTER OPERATOR RESET — confirm with the owner"** even after Sean does it himself. Close it by asking Sean on
a phone call (not by email): did you choose your own password and scan the QR code on your own phone? Record who
confirmed, how and when.

## 4. Data (production, imported 3–4 Oct; reconciled)

- Source: `report-download-hdJocCUxn3aEXNGBdg22Dc.csv`, SHA-256 `90693f95228db57f39b9fd596e694fa62b57107fd63b6aa546a9275bf0aaed22`
  (checksum re-verified 7 Oct). Controls reproduced exactly by an independent parser: 1,082 membership rows; 708 name/email
  groups; 302 active rows across 298 groups (4 groups with two actives); 78 shared emails across 172 groups; 15 missing-email
  rows across 5 groups; 3 exact duplicate excess rows (cancelled); 20 plan labels; statuses active 302 · hold 22 ·
  cancelled 505 · completed 163 · upgraded 60 · downgraded 30; 2 starts after the export (5 and 19 Oct).
- As-of: Noe confirms the export is recent; TeamUp writes no export time. Recorded as **provisional 2 Oct 2026 12:27
  BST** (the file's save time, labelled as an estimate everywhere it is shown). Import time recorded separately.
- Members import (job `htfc19`): 926 import rows → **922 members** (703 people + 219 guardian records), **4
  refused** (children with no parent on file — named in the owner's exceptions CSV), **1,082 membership-history rows** kept
  whole. 16 tiers named exactly as the plan labels. Their **prices were entered by the operator from the 24 Sep catalogue and Sean has not confirmed them**; none is linked to Stripe and they charge nobody (members are billed by TeamUp).
- Families: **307 suggested guardian links awaiting Sean's review** (shared email / emergency contact). Suggested links give
  the parent no access until a club admin confirms them.
- Attendance (separate TeamUp export, 15,273 rows): 13,592 visits imported; independent reconciliation **7/7** on
  production.
- Billing: all 922 billed by TeamUp; 0 payments, 0 Stripe ids, 0 due dates, nobody shown as owing. MatFlow charges no one.

## 5. Families — who can change them

Owner and manager (server-side: `requireApiOwnerOrManager` on link/unlink/confirm; promote-to-adult owner only). Coaches,
the admin role, members and parents cannot. Members' self-service refuses family fields (forged `parentMemberId` → 403,
browser-tested 7 Oct). A parent sees a child only after an admin link; unlink removes access immediately (browser-tested).
Import, refresh, rollback, undo and invitations cannot confer guardian authority (4 Oct, code-verified).

## 6. CSV exports — exact claims

| Export | Who | Format | Notes |
|---|---|---|---|
| Payments CSV | owner, manager; audited; rate-limited | UTF-8 BOM, CRLF, RFC-4180, formula-guarded | Header only for Total BJJ (0 payments). Cap of 5,000 disclosed in the file and UI. |
| Reports CSV | staff with reports access | same | Built from the reports data; not audited. |
| Import exceptions CSV | owner; audited | same | Every refused row, decision and suggestion by source row. |
| Attendance ledger export | owner | same, in parts of 5,000 | Every imported booking with its source status and the MatFlow class it was matched to. |

Pinned by unit tests (3 Oct): byte-for-byte round trip of commas, quotes, multiline cells, accents, emoji, leading-zero
phones and postcodes; blank vs 0; formula guard. Not yet checked on a file downloaded from production. Excel may still
hide a leading zero on display in an all-digit cell; the bytes keep it. **No member-roster export exists and none is claimed. Nothing is claimed importable
back into TeamUp.**

## 7. What Sean can use now — and what he must set up

Usable once he has activated: members and their imported history and standing, families and the guardian review queue,
tiers, classes (create/edit), registers and check-in, attendance history, reports and their CSV, Activity log with undo,
staff management, the import exceptions CSV, Settings.

Not in the source and therefore empty: **the class timetable** (the attendance import created inactive historical classes
only — Sean sets up the live timetable under Timetable), **signed waivers** (members re-sign in MatFlow), **confirming the 16 tier prices**
(entered by the operator from the 24 Sep catalogue; nothing is charged either way), **the 4 refused children** (Sean names the parents; staff add them).

While email is off: no invitations, password-reset emails, sign-in links, receipts or owner alerts (chargeback, Stripe
disconnected, payment failed) are sent — the dashboard is the only signal. Invite links can still be copied and handed
over. Inventory: `docs/readiness/MAIL-DARK-SEND-PATHS.md`.

## 8. Evidence for the new work (7 Oct)

- Provisional login email: the doors (forgot-password, sign-in link request and use, reset with an outstanding code,
  Google) refuse a provisional user; every outbound email to a provisional address is suppressed in any club; password +
  authenticator sign-in unchanged.
- Login-email change: self-service (password + single-use authenticator code) and operator-assisted (step-up bound to the
  exact sub-action, reason, attestation to clear). Atomic; collisions refused without saying whose; identity and
  authenticator kept; old tokens and sessions dead. Integration test on the test branch **11/11 under both database roles**
  (transition, rollback, collisions, cross-club, replay).
- Mail-dark switch `EMAIL_DELIVERY=off`: no provider call on any path; suppressed log rows; honest "nothing was sent" states;
  the app boots without a Resend key when off.
- Single-use authenticator codes for staff sign-in, enrolment and recovery codes.
- Production-mode browser runs on the test branch with email off, both database roles: H1 bootstrap activation with a
  provisional email, H2 self-service change + rollback, H3 operator change/mark/clear, H4 mail-dark UI (zero provider
  calls), H5 family link/unlink and forged parent requests — **all PASS** (see §11 for the build each ran on).
- Independent review of the new code (`sean-handover-2026-10-07/review-PM-result.md`) found: 1 HIGH (integration
  evidence red — a stale test), 3 MEDIUM (the operator card called an unmarked address "Verified mailbox"; email-off
  copy shown whether or not email was off; a rollback past this change would reopen mail to Sean) and LOW hardening
  (step-up grant not bound to its sub-action; authenticator-code replay at staff enrolment and recovery codes; and
  others). All fixed and re-tested; one LOW (member create versus a staff address) ticketed. Integration after the fixes:
  `integration-login-email-change-engine.log` and `-restricted.log` in the evidence folder, **11/11 each**. Final
  completion review: first REJECT on documentation (this record), re-reviewed after fixes.

## 9. Recovery (mail-dark, MFA kept)

Browser-tested 6 Oct on the production-mode build (`operator-remediation-2026-10-06/report-G-e2e.md`, flow 5: 72 h
temporary password, 2FA reset, re-enrolment); these reset routes send no email.

Who may authorise: Noe as a named MatFlow operator with his own authenticator. Identity check: call-back on the number on
file or in person — not email while the address is provisional (`docs/runbooks/SUPPORT-IDENTITY-VERIFICATION.md`).
Lost password: operator *Reset password* (fresh code + reason) → new temporary password (72 h) given privately → Sean
sets his own. Lost authenticator: operator *Reset owner 2FA* → recovery codes and factor cleared, all sessions signed out
→ Sean must enrol afresh before any club access. Every step audited in the same transaction as the change.

## 10. Noe's steps, in order (production)

**Do not contact Sean before step 9.**

1. Decide the package §2 items: keep the 20 Oct legacy deadline; suspension leaves member billing alone; update the
   privacy page for 6-year operator/erasure audit records and 12-month sign-in records.
2. Vercel → Deployment Protection: Standard Protection on; delete old production deployments.
3. Rotate `MATFLOW_ADMIN_SECRET` to a value nobody keeps.
4. Sign in at `/admin/login` on the current site; if it does not ask for an authenticator code, enrol at
   `/admin/security`; sign out and back in with the code to prove it. Without this the deploy locks you out.
5. Retention dry-run (package §3) and note any club it would purge; deploy before 03:30 UTC if one is listed.
6. Vercel → Production: add `EMAIL_DELIVERY=off`.
7. `git push origin main` (deploys and applies five additive migrations). Never use Instant Rollback. **If you ever run
   code older than this release, first revoke the Resend API key at Resend** — older code would mail Sean's provisional
   address again.
8. Operator console → Total BJJ → **Login email** → *Mark provisional* (reason + code). Then Danger Zone → *Reset
   password* (reason + code): this issues a fresh 72-hour temporary password and kills any earlier copy.
9. Smoke checks in the package §5 (incl. the email-off login page and the provisional badge). Then send Sean the message
   below, and the fresh temporary password by a different channel (phone or in person).

## 11. Commits, builds, coverage

| What | Identity |
|---|---|
| Deployed production | `e8afb6a` (4 Oct) |
| Candidate (local, unpushed) | `aff668283c63aadf07c8e3d8e49560238ee871df` — handover gaps — on top of the operator remediation `2203087`, `b5c3b6a`, `3da3fdf` and the earlier `64c2657`, `8fb151a`, `d92435a` |
| Unit (388 files / 4,273 tests), typecheck, lint | pass on the tree committed as `aff6682` |
| Integration (test branch, owner role and restricted `matflow_app`) | login-email change 11/11 both roles; earlier remediation suites as recorded in the operator package |
| Production build + browser E2E (H1–H3) | the same code, built 12:25 UTC as HEAD `3da3fdf` + uncommitted diff `145233e5…` (48 files) — every code change in `aff6682`; H4–H5 ran on the slightly earlier build `336b3209…` |
| Not run | multi-instance behaviour; real Google OAuth (not configured in production: absent and refused); anything against production except the read-only owner-account check |

## 12. Message Noe can send Sean (no password in it)

> Hi Sean — your MatFlow account for Total BJJ is ready.
> Go to https://matflow.studio/login?club=totalbjj and sign in with **se***@totalbjj.co.uk** (I'll send the full address
> and your temporary password separately).
> You'll be asked to choose your own password first, then to set up an authenticator app (Google Authenticator, Microsoft
> Authenticator or 1Password) by scanning a QR code with your phone. Please do both in one go.
> If it shows recovery codes, keep them somewhere private — they're your way back in if you lose your phone.
> Email from MatFlow is switched off for now, so you won't get reset or sign-in emails; if you get stuck, call me and I'll
> reset your access.
> Your members, their plans and history, and your attendance history are already in. The class timetable isn't — you can
> set it up under Timetable — and there are about 300 suggested parent–child links waiting for you under Members to
> confirm or reject. Please also check the prices on your 16 membership plans (Memberships, in the left-hand menu) — I entered them from
> your price list; nothing is charged through MatFlow either way.
