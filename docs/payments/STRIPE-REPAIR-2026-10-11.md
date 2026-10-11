# Stripe payment-defect repair — final report, 11 Oct 2026 (UK)

Follows `STRIPE-CONNECT-AUDIT-2026-10-11.md` (audit at `a0ff39c`). Branch **`payments/stripe-defects-2026-10`**, created from `a0ff39c`; the security candidate `1ca92c0` on `security/assurance-2026-10` is untouched. Bounded loop of five iterations: implementation (PA, PC, PD), confirmation UI and sandbox (PB, TS, PC round 2, PD round 2), PC round 3, independent review (REJECTED at `1da1e5a`) and fixes (PB, PC, PD, PA, PC), re-review (APPROVED WITH RESIDUALS at `d3f5762`). Nothing was pushed, merged, deployed or run against production; no live charge, refund or billing change was made. Lane reports, briefs, gate logs and the unapplied header patch are under `evidence/repair-2026-10-11/`.

## Exact tested source and build

| Item | Value |
|---|---|
| Final executable SHA | `d3f5762` |
| Gates (coordinator, Node 24.21.0, `evidence/repair-2026-10-11/gates-node24-d3f5762.log`) | lint 0 · tsc 0 · `npm audit --omit=dev` 0 · unit 492 files, 6970 passed, 1 skipped (pre-existing symlink skip), 0 failed · isolated production build `l2jgqK02xpKGFMgOyfC2X` (177/177 pages) · tree secret scan: 8 candidates, all pre-existing in files the branch does not touch |
| Reviewer's own gates in a fresh worktree at `d3f5762` | identical counts; build `HCF95ALFm_porys0jSmo5`; `prisma validate` OK; TEST branch `migrate status` 107 up to date |
| Migrations added (all additive, BEGIN/COMMIT, applied to the TEST branch only) | `20261011180000_pay_pd_stripe_event_store`, `20261011190000_pay_pc_member_subscription_mapping` (with backfill), `20261011200000_pay_pc_stripe_event_ignored_mode`, `20261011210000_pay_pc_mapping_last_failed`, `20261011220000_pay_pc_entitlement_follows_payment`, `20261011220100_pay_pc_backfill_cleanup`, `20261011223000_pay_pd_stripe_event_created_bigint` |
| Production | serving `e8afb6a` with the rotated Neon password and Resend key; the Stripe key roll (hygiene) is still prepared, not executed |

## Independent review outcome

Pass 1 at `1da1e5a`: **REJECTED** — RP-1 (COEP header blocks every Stripe frame; owner action, denial D-13), RP-2 (unpaid sign-up granted check-in; desk payer lost "paid"), RP-3 (backfill adopted TeamUp-billed pointers), plus RP-4…RP-11.
Pass 2 at `d3f5762`: **APPROVED WITH RESIDUALS**, "not shippable until RP-1 is resolved by Noe". RP-2, RP-3, RP-4, RP-5, RP-7, RP-8, RP-9, RP-10 CLOSED by the reviewer's own probes under both database roles. OPEN: RP-1 (owner), RP-6 (low, theoretical cross-club upsert on globally unique ids), RP-11 (low: migration path and a read-only route without the full guard). New, low: RP2-1 the "no access until the first payment" sentence is wrong for a member who already holds a desk tier; RP2-2 a permanently failing Stripe lookup answers 409 for up to three days and needs a runbook line or a distinct code. Full text: `evidence/repair-2026-10-11/RP-review-pass1.md`, `RP-review-pass2.md`.

## Updated capability table

| Capability | Audit (a0ff39c) | Now (d3f5762) | Evidence |
|---|---|---|---|
| Money never reaches the platform account | fail-open on permission error; conditional `stripeAccount` in shop checkout | one guard (`lib/stripe/club-account.ts`) before every Stripe call on 16 routes; missing, stale, disconnected, deauthorised or unreadable → refused (409/503); every refusal leaves no order and makes no Stripe call | PA race test 9/9 both roles; reviewer's checkout-vs-deauthorisation race (24 rounds, every session on the club account); sandbox 2a–2f on a real Standard account |
| First membership payment in the product | impossible (client secret discarded, no Stripe.js) | Payment Element on the club's account; 3-D Secure; decline retries the same intent; pay later and resume; staff, guardian and adult self flows | PB unit 70/70, DB 6/6 both roles; six browser journeys on the Standard test account, **passing only on a build without the COEP header** |
| Entitlement follows payment | tier written at sign-up; unpaid sign-up gave check-in | tier written on the first paid invoice of the active mapping; an abandoned sign-up restores the prior payment status; `Member.status` is never written by Stripe events | `pay-pc-rp-signup-db` 3/3 both roles; reviewer RP-2a…2e 10/10 both roles |
| Subscription and invoice mapping | customer-only; any event re-pointed the member | `MemberSubscription` mapping with metadata on every MatFlow create; foreign objects `ignored_foreign`; older events `ignored_stale`; wrong mode `ignored_mode` (acknowledged, recorded); failed first-invoice at sign-up never dunns; voided unpaid invoice never a refund | PC 15/15 both roles; reviewer M1–M7; sandbox runs 3–7 with real events |
| Durable events, replay, reconciliation | claim inside the handler; no failed row; no replay; reconcile never ran | row recorded before any lookup; failed rows with masked error; operator replay fetches fresh from Stripe and runs the real processor; forced replay compare-only; reconcile on its own gated cron (`STRIPE_RECONCILE_ENABLED`, default off), per-club error codes, dry run, state comparison through the mappings; `/admin/stripe` page | PD 15/15, 7/7, 5/5, 3/3 both roles; reviewer D1–D3 and RP-8; sandbox runs 8–9 |
| Business model | no fee in code | unchanged: no `application_fee`, `transfer_data`, `on_behalf_of`; TeamUp guard call sites identical; nothing cancels or replaces an existing subscription | reviewer §5 both passes |
| Live-mode behaviour | none | none | — |

## Remaining owner questions and actions

- [ ] **RP-1, decides everything about collection:** apply `evidence/repair-2026-10-11/coep-removal-NOT-APPLIED.patch` (delete the COEP header, correct the comment, make the test assert absence), commit it, then re-run PB's six journeys on the committed build. The coordinator was refused permission to commit it (D-13).
- [ ] Stripe key hygiene roll per `STRIPE-CREDENTIAL-CONTAINMENT-2026-10-11.md`; the rolled key must hold the accounts read scope, otherwise every club refuses 24 hours after its last status check.
- [ ] Sean: was his Stripe account opened directly at stripe.com or inside other software; are his members' subscriptions on his account or TeamUp's; what does ending a TeamUp membership do to its subscription and when. No migration is proposed until answered; nothing on the branch replaces or cancels existing subscriptions.
- [ ] Product decisions: a subscription ending at Stripe no longer ends the person's membership (confirm); a chargeback moves the member to overdue (confirm) and who clears a lost dispute; refunds, cancellations, holds and the portal keep working while a club's charges are disabled (confirm); a declined first card at sign-up emails nobody (confirm); staff type the member's card at the desk versus sending a link; one club per Stripe account; replace while subscriptions are live; the staff route now refuses prices not attached to an active tier.
- [ ] Vercel: the plan must allow four cron entries; `CRON_SECRET` (new value) and `STRIPE_RECONCILE_ENABLED=true` only when you switch reconciliation on.
- [ ] TEST branch hygiene: the club connected with a fake account id now reports `account_invalid` on every reconcile run; the `20260930100000` migration checksum mismatch and seven old soft-deleted tenants remain.
- [ ] Security docs: the SF-62 RLS proposal must name `MemberSubscription`, `StripeEvent` and `StripeReconcileRun`.

## Sandbox acceptance plan (before any live pilot)

1. Apply RP-1; rebuild; re-run the six browser journeys on the committed build, both database roles.
2. Register the test OAuth redirect (`http://localhost:3961/api/stripe/connect/callback`, test client id already in `.env.test`), run a real OAuth connection as a test club owner on the Standard test account `acct_1UPRQ1JpZMl35yzx`, complete hosted onboarding with test data so the account is chargeable without the cache override, then revoke the platform from its dashboard to produce a real `account.application.deauthorized` — the one event class never produced yet.
3. Expose a test endpoint so Stripe delivers events itself (today every event is fetched and posted locally, signed with a local secret) and check signing, livemode and the `account` field on real deliveries.
4. Run the lane and reviewer DB suites on both roles against that build; run reconcile against the connected test club and replay a dropped event with a real operator TOTP step-up.
5. Two isolated clubs, guardian payments, failed payments, refunds, retries, a disconnected club, recovery — the audit's §20 list — each with the persisted-state check.
6. Only then, with your explicit authorisation and after the production migration counts are read: the live pilot with Sean's account as the first connection.

## Verdicts, separately

| Question | Verdict |
|---|---|
| Connection readiness | NOT YET — the flow and guard are proven in sandbox; live platform setup is unverified; no real OAuth connection has ever completed; an account created inside another platform cannot attach |
| Collection readiness | NO on the committed build (RP-1); YES in sandbox on a build without the header, for staff, guardian and self flows, with real test-mode charges |
| Synchronisation reliability | APPROVED WITH RESIDUALS by the reviewer: scoped, ordered, durable, replayable, reconciled; real Stripe delivery and a real revoke remain unproven |
| Live-pilot readiness | NO |
