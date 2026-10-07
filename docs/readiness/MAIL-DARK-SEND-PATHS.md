# Mail-dark: every email send path (7 Oct 2026, handover story US-003)

Noe's decision for Sean's first Total BJJ handover: **no email delivery**. Production carries `RESEND_API_KEY`
and `RESEND_FROM`, so before this change it was *not* mail-dark, and unsetting the key would stop the app booting
(`lib/env-guards.ts` required it at severity error).

> **Production sends email until `EMAIL_DELIVERY=off` is set** in Vercel → Production and the app is redeployed.
> Deploying this code does not, by itself, stop a single email. Everything below headed "with `EMAIL_DELIVERY=off`"
> applies only after that step. Set it, and mark the first owner's login email provisional, BEFORE his first sign-in
> (a new-device alert, `lib/login-event.ts`, would otherwise go to the address on file).

## The switch

`EMAIL_DELIVERY` (read by `lib/email-delivery.ts`):

| Value | Behaviour |
|---|---|
| unset, empty or `on` | Current behaviour — sends go to Resend. |
| `off` | Nothing is sent. `sendEmail` never constructs or calls the Resend client, writes **one** `EmailLog` row at `status = "suppressed"`, `errorMessage = "suppressed_delivery_off: …"`, and returns `{ ok: false, logId, suppressed: "delivery_off" }`. |
| anything else (`false`, `0`, a typo) | Treated as **off** (fail closed) and named in the boot log. |

**Default `on`** so every existing environment (local dev, the unit suite, preview deploys) keeps today's behaviour
and mail-dark is one explicit, reviewable variable rather than a side effect of a code deploy. The consequence:
**production is mail-dark only once `EMAIL_DELIVERY=off` is set in Vercel → Production and redeployed.** That is an
operator step for Noe; nothing in this change turns production mail off by itself.

Boot (`lib/env-guards.ts`): with `EMAIL_DELIVERY=off`, `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are not required,
and a loud warning lists what is suppressed. With delivery on, the key is still required exactly as before.

**Provisional recipients** (independent of the switch, holds with delivery ON): before any send, `sendEmail` looks up
a `User` in **any** club (through `withRlsBypass`, so system mail sent as `_system` and another club's mail are
covered too) whose `email` matches the recipient (case-insensitive) and whose `loginEmailProvisionalSince` is set
(lane P, `lib/login-email.ts`; widened from per-club by the review of lanes P + M, defect 8). If found: no Resend call, `EmailLog` row at
`status = "suppressed"`, `errorMessage = "suppressed_provisional: …"`, result `suppressed: "provisional_recipient"`.
If the lookup itself fails, nothing is sent (fail closed, `status = "failed"`).

**Reply-To** (review defect 9): a club-voiced email never carries a provisional login email as its Reply-To. The club's
contact address is skipped if it is provisional (same any-club lookup), then the billing contact; if neither is usable,
or the check fails, the email goes without a Reply-To.

Reading the log: `EmailLog where status = 'suppressed'` lists everything that would have gone out.

## Inventory

Recipient: M = member, O = club owner/staff, A = applicant, T = MatFlow team (`MATFLOW_APPLICATIONS_TO`).
"Before" is what the screen/API said when nothing could be sent. Tests: `tests/unit/…`.

| # | Path (call site) | Template | Trigger | To | Before (mail-dark) | Now with `EMAIL_DELIVERY=off` | Tested by |
|---|---|---|---|---|---|---|---|
| 1 | `app/api/members/route.ts` POST | invite_member | Staff add an adult with an email | M | Dialog: "an invite email was **queued**" — false | Response carries `inviteEmailSent:false` + `inviteEmailNote`; dialog says "Email is turned off for this club, so nothing was sent. Hand them this link instead…" Invite link still minted and shown (the non-email route) | members-no-email-adult |
| 2 | `app/api/members/bulk-invite/route.ts` | invite_member | Profile "Send login invite"; Import panel "Send login invites" | M | Minted + retired tokens, then "Email send failed" per member | **409 before any token is minted or retired**: "Email is turned off for this club, so nothing was sent. Use "Show invite link" on a member's profile…" (shown by both UIs) | mail-dark-send-paths |
| 3 | `app/api/members/[id]/invite-link/route.ts` | — (no email) | Profile "Show invite link" | — | Works | **Unchanged — the supported alternative** (owner/manager, one-time, 7 days, audited) | existing |
| 4 | `app/api/waiver/kiosk-request/route.ts` | kiosk_waiver | Member at kiosk asks for waiver link | M | Minted token, generic 503 "check the email address" | **503 before token mint/retire**: "Email is turned off for this club, so no waiver link was sent. Ask a coach to open your waiver on a staff device." ("Open waiver on this device" on the profile is the alternative) | mail-dark-send-paths |
| 5 | `app/api/payments/chase/route.ts` | payment_failed | Outstanding panel "Chase" | M | 502 "Couldn't send the reminder email" (reads as retryable) | 409 "Email is turned off for this club, so nothing was sent. Chase this member in person or by phone."; audit `emailSent:false, suppressed` | mail-dark-send-paths |
| 6 | `app/api/admin/email/test/route.ts` | test | Owner test email (no UI caller found) | O | 500 | 409 with the email-off sentence; no `email.test_sent` audit | mail-dark-send-paths |
| 7 | `app/api/admin/applications/[id]/approve/route.ts` | owner_activation | Operator approves an application | A→O | Toast "Approved…" (confirm said link "will be emailed"); key check bypassed the switch | **No activation token is minted and sendEmail is not called** (review defect 5: a live sign-in link nobody can receive is only a liability). Club and owner are created; response `activationEmailSent:false, activationLinkCreated:false, emailDelivery:"off"`; operator toast says email is off and no activation link was created — give the owner access another way; confirm copy says "if email is turned on". No link is ever logged | mail-dark-send-paths, approve-link-not-logged-in-production |
| 8 | `app/api/onboarding/csv-handoff/route.ts` | csv_handoff_internal | Owner hands a CSV to MatFlow | T | "…email you when they're ready" whatever happened | Message: file is safe, email is off, team was **not** notified, tell your MatFlow contact; `teamNotified:false`; wizard shows the server's sentence | onboarding-csv-handoff |
| 9 | `app/api/apply/route.ts` | application_received, application_internal | Public application form | A, T | 502 with "notification didn't go through… email hello@matflow.studio" | Unchanged — already honest (application saved, no human notified) | apply-notification-failure (existing) |
| 10 | `app/api/admin/import/[id]/commit/route.ts` | import_complete | Import finishes | O | Logged only; screen shows result | Unchanged — suppressed + logged; no screen claims an email | email-delivery-off (template loop) |
| 11 | `app/api/auth/forgot-password/route.ts` (lane P) | password_reset | "Forgot password?" | O/M | Opaque 200 by design (anti-enumeration) | Route stays opaque; sendEmail suppresses. **Login screen no longer offers "Forgot password?"** — it says email is off and to ask the club / MatFlow. See "For lane P" below | email-delivery-off |
| 12 | `app/api/magic-link/request/route.ts` (lane P) | magic_link | "Email me a sign-in link" | O/M | Opaque 200; screen "A sign-in link has been sent" — false | Route opaque; sendEmail suppresses. **Login screen hides the sign-in-link button** when `/api/tenant/[slug]` reports `emailDelivery:"off"` (deployment-wide, no per-account signal) | mail-dark-send-paths (lookup flag) |
| 13 | `lib/login-event.ts` | login_new_device | Sign-in from a new device (flag-gated) | O/M | Audit "New-device sign-in alert sent" written even when not sent | Audit written only when `ok`; LoginEvent row still recorded | login-event-always-recorded |
| 14 | `app/api/stripe/webhook/route.ts` | payment_failed, payment_failed_owner, receipt ×2, dispute_opened_owner, stripe_disconnected_owner | Stripe events | M, O | Fire-and-forget, no UI | Suppressed + logged. **Owner alerts (chargeback, Stripe disconnected, payment failed) do not arrive** — the dashboard flags (overdue, disputed, Stripe status) are the only signal | email-delivery-off (template loop) |
| 15 | `app/api/members/[id]/charge/route.ts` | receipt | Staff card charge succeeds | M | Fire-and-forget | Suppressed + logged; charge unaffected; no receipt claim on screen | email-delivery-off |
| 16 | `app/api/payments/[id]/refund/route.ts` | refund_processed | Staff refund | M | Fire-and-forget | Suppressed + logged; no claim on screen | email-delivery-off |
| 17 | `app/api/members/[id]/rank/demote/route.ts` | rank_demoted | Demotion with "notify" | M | Fire-and-forget | Suppressed + logged; response makes no email claim | email-delivery-off |
| 18 | `lib/notify-member-action.ts` (via `app/api/tasks/route.ts`) | member_action_assigned | Staff send an action | M | Push + email best-effort | Email suppressed; action still appears in the member app | email-delivery-off |
| 19 | `scripts/test-resend.mjs` | — (direct Resend) | Operator runs it by hand | any | n/a | **Not covered by the switch** — a manual diagnostic outside the app; do not run it while mail-dark | — |

Not email: staff creation (`app/api/staff/route.ts`, temporary password, no mail); import, refresh and rollback
("Nobody is emailed"). Templates `welcome`, `rank_promoted`, `dispute_created` have no caller today.

## For lane P (their files — not edited here)

- `forgot-password` and `magic-link/request` still **mint a token and retire earlier ones** before `sendEmail`
  suppresses. Proposed: after the existing lookups, `if (!isEmailDeliveryOn()) return NextResponse.json({ ok: true });`
  (from `@/lib/email-delivery`) — same opaque answer, no orphan token. Their `!process.env.RESEND_API_KEY` branches
  can stay (dev convenience).
- Login-screen wording used for the forgot-password door: "Forgot your password? Email is turned off for this club,
  so we can't send a reset code or sign-in link. Ask your club to reset your access — club owners, contact MatFlow."
  Replace "contact MatFlow" with the named recovery route once P's runbook is final.

## Residual risk

- (Closed 7 Oct 2026, review defect 8) The provisional check used to be per club; it now spans every club.
- `MembersList`, `MemberProfile` and `ImportPanel` still show "Send login invite(s)" buttons; with email off they
  answer with the email-off sentence instead of acting. Hiding them would need the flag threaded into each page.
- Owner alerts listed in row 14 are silent while mail-dark; that is the decision, not a defect, but Sean should be
  told the dashboard is the only place they appear.

## Known gaps

- **Ticket — member create does not refuse a staff login address (review defect 11, INFO).** `POST /api/members`
  can create a member whose email equals a staff user's login email in the same club (import and member email edit
  not checked). Sign-in resolves the staff `User` first, so the member row is shadowed for sign-in, and magic-link
  verify resolves staff before member on the same address. The staff row's own password and authenticator still
  guard it, but the member cannot sign in as themselves. Proposed: reuse `loginEmailTaken` (`lib/login-email.ts`) in
  member create (and in import / email edit if they have the same gap), answering with the same opaque 409 the
  login-email change uses. Not built.

## Future Resend activation (separate work — do not enable as a side effect)

1. **Sender domain**: verify the sending domain in Resend; SPF, DKIM and DMARC (start `p=none`, move to
   `quarantine`), `RESEND_FROM` on that domain; Resend webhook + `RESEND_WEBHOOK_SECRET` for bounces/complaints.
2. **Delivery test**: send each template to seeded test inboxes on a non-production deploy; check inbox placement,
   rendering, Reply-To (club contact), bounce suppression and the EmailLog status trail.
3. **Token security**: review every emailed credential (invite 7 days, magic link 30 min, reset code 2 min, waiver
   24 h, disown 7 days) for single use, hash-at-rest, retirement on re-issue and on login-email change.
4. **MFA-safe alternative login/recovery**: email recovery must never bypass required owner MFA; keep the operator
   recovery route as the documented path and decide whether email reset is allowed for MFA-enrolled staff at all.
5. **Explicit per-club enablement of customer communications**: today the switch is deployment-wide. Before
   switching on, add a per-club setting (default off for clubs migrated from TeamUp, which still sends its own
   reminders) so turning Resend on does not start mailing Total BJJ's members unannounced.
6. **Mailbox verification for provisional login emails**: an authenticated, MFA-confirmed email-change flow that
   sends a code to the new address, proves ownership, then clears `loginEmailProvisionalSince` — replacing today's
   operator attestation.
7. Only then set `EMAIL_DELIVERY=on` in production, as its own reviewed change.
