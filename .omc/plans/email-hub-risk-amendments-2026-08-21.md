> **STATUS: saved for later implementation (Noe, 2026-08-22). Nothing applied.**
> When the Email Hub work starts, apply these amendments to `docs/EMAIL-HUB-SPEC.md` and
> `.omc/specs/deep-interview-email-hub.md` FIRST, then build. Companion lane reports are in
> `C:/Users/NoeTo/.claude/plans/so-im-seeing-issues-abundant-naur-agent-*.md`.
> One item is NOT deferred: the launch-runbook extraction near the bottom (Resend tier vs
> ~200-member onboarding invite; Vercel plan check) belongs to THIS WEEK's launch, not the hub.

# Email Hub — risk trace synthesis and spec amendments (2026-08-21)

## Context

Three parallel trace lanes (timeline/priority, solo-operation, technical/compliance) ran against the locked Email Hub spec with the brief "everything that could go wrong, judged against Noe's actual plan". Full lane reports: `so-im-seeing-issues-abundant-naur-agent-{a2723252d5ccbdc8e, a0a57e5fd14603746, ae22f27c8fa036b45}.md` in this plans directory. Lanes 2 and 3 converged independently on the same catastrophic risk. Approving this plan applies the amendments below to `docs/EMAIL-HUB-SPEC.md` + `.omc/specs/deep-interview-email-hub.md` — **documentation only; the hub remains unbuilt** per Noe's standing instruction.

## Ranked risk register (synthesised)

| # | Risk | Verdict |
|---|---|---|
| 1 | **Shared-account blast radius** — Resend's AUP (fetched 21 Aug): complaint rate <0.08%, bounce <4%, "account may be shutdown without warning", account-scoped. At ~3k emails/mo, **2.4 complaints anywhere across all clubs breaches the threshold**. Suspension kills magic-link login, receipts and invites for **every** club (passwordless members exist; all templates ride one `RESEND_API_KEY`). D2's "transactional unaffected" is true for domain failure, **false for account suspension** — the spec never distinguished them. | Confirmed by both lanes; worst flaw in the design |
| 2 | **D6 violates Resend's own terms** — the AUP demands *explicit* opt-in; UK-PECR-lawful soft opt-in is still standing grounds for termination. Converts risk 1 from accident to policy breach. | Confirmed, quote in lane 3 |
| 3 | **Kid/parent consent identity bug** — spec's send path checks consent on the *kid* then swaps the address to the parent: a parent who unsubscribed keeps receiving kid-triggered mail (PECR breach with an audit trail proving it), and the unsubscribe token minted could be the kid's. Kids' emails can be synthetic (`lib/synthesise-kid-email.ts`) → bounce-budget burn. | Certain to be built wrong as written |
| 4 | **Operator blindness** — zero alerting code exists (verified by grep); the Resend webhook **discards `domain.*` events** today, so D12's signal is thrown away; `/admin` has no email surface. First sign of a 2am failure is an angry club days later. | Verified |
| 5 | **Ledger unique constraint is void for welcome** — Postgres treats NULLs as distinct, so `(member,"welcome",NULL)` inserts unlimited times; the acceptance criterion isn't enforced by the schema as specced. Plus write-vs-send order unpinned. | Verified |
| 6 | **Erasure/hard-delete wiring** — new `EmailAutomationSend.memberId` FK would 500 member deletion (repo is explicit-cascade by design); owner-edited subjects embed `{firstName}`, destroying the DSAR erase route's recorded "subject residual risk is bounded" rationale; `unsubscribeToken` is a live no-login capability the erase route must null. | Verified against `lib/member-delete.ts`, erase route |
| 7 | **DNS support is the real cost** — ~25–40 founder-hours to 20 clubs, 60–70% of owners can't do SPF/DKIM unaided, some clubs have **no domain at all** (Facebook-only — unaddressed by D1), and D12 alerts the owner who can't fix it — via an email that may itself be on the dead domain. Infra cost is a non-issue (~4–6% of MRR at 20 clubs). | Quantified |
| 8 | **Launch-critical fact buried in the hub spec** — Resend free tier = 100 emails/day; Total BJJ onboarding-day bulk invite ≈ 200. On the wrong tier, **invites silently die on demo day**. This belongs on the launch runbook now, hub or no hub. | Extracted |
| 9 | Deliverability: no RFC 8058 `List-Unsubscribe` headers specced (Gmail/Yahoo bulk rules) — `lib/email.ts:339` already anticipates them. Subject lines need their own rule (CR/LF strip, never HTML-escape); body escape order must be pinned or member names become stored XSS in the preview. | Verified |
| 10 | Spec integrity: A1–A4 cited but **defined nowhere in the repo copies**; three load-bearing `autoEmailOptOut` references survive D13's supersession; `preferNoDob` is UI state, not a schema field; "Hobby caps at 2 (already at 3)" is self-contradictory; RLS policies for the two new tables unmentioned; spec uncommitted. | Verified |

Lane-1 verdict stands unopposed: **defer-until-first-invoice is correct**; the failure mode is the unguarded "unless re-prioritised" clause during a 4-working-day launch window. Sean was told about email "loosely, not as a commitment" (Noe, 21 Aug) → honest-pitch guard, no scope pull-forward.

## Amendments to apply (on approval — spec text only)

**New decisions:**
- **D14 — per-tenant send guardrails** (must exist before any blast ships): per-tenant daily cap `max(2×memberCount, 500)`; one blast/24h/tenant; first-blast cap ≤100 recipients; auto-pause a tenant's hub at ≥3 complaints or ≥0.5% complaint rate in 7 days (same query shape as the existing bounce check); no-purchased-lists + content-responsibility clause in gym ToS; blasts exclude members created <14 days ago absent owner attestation.
- **D15 — operator visibility**: webhook handles `domain.updated` + `email.suppressed`; "Email health" card on `/admin` (per-tenant bounce/complaint 7d, domain statuses); `OPERATOR_ALERT_EMAIL` gets immediate alerts (domain failure, tenant auto-pause, complaint spike) + daily digest.
- **D16 — offboarding**: tenant churn/delete calls Resend delete-domain and nulls `Tenant.senderDomain*`; acceptance: no domain on the account without a live paying tenant.
- **D17 — account split (amends D7/D2)**: transactional (matflow.studio) and hub/marketing ride **separate Resend accounts** so no club's complaint rate can ever lock members out of login. D2's "transactional unaffected" becomes true *by construction*. `[[NEEDS VERIFICATION]]` (written question to Resend before Phase 2): whether a second account by the same operator is permitted/sufficient, else a second ESP (e.g. Postmark streams) for the marketing side.
- **D18 — consent belongs to the resolved recipient (amends D9/send path)**: resolve kid→parent **first**; check the *parent's* `emailOptOuts`; mint the *parent's* token; skip+log when no parent or synthetic email. Acceptance: parent opted out + kid birthday → nothing sends.

**Amended decisions:** D6 — blasts require **explicit opt-in** (Resend AUP); soft opt-in survives only for Phase-1 lifecycle mail on the warm base; marketing-refusal checkbox added to member onboarding now; opt-out events written to the existing AuditLog (Art 5(2) trail). D8 — receipt editor carries a promo-content warning: the consent exemption is a property of the content, not the template slot. D12 — fallback alert address when the owner's login email is on the failing domain; auto-resume on re-verification; paused state surfaces on Noe's admin (D15). D1 — clubs 1–4 get concierge domain setup (Noe, via dashboard/API; assistance ≠ holding registrar credentials); **owner-facing wizard moves to Phase 1b**, gated on first non-concierge signup; domain-less (Facebook-only) clubs stay on the locked-hub/transactional path and are named as such.

**Engineering pins:** ledger `year Int` non-null with sentinel `0` (unique constraint then bites for welcome); claim-first at-most-once (create claim → catch P2002 skip → send → delete claim on clean `ok:false`); optional Resend `Idempotency-Key`. `EmailAutomationSend.memberId` gets `onDelete: Cascade` **and** explicit `deleteMany` in `lib/member-delete.ts` (LoginEvent precedent); erase route nulls `unsubscribeToken`; EmailLog stores the **uninterpolated** subject; DSAR export includes `emailOptOuts` + ledger rows; privacy-policy retention table gains both tables; RLS policies extended to both new tables in the same migration. Subjects: CR/LF-stripped, length-capped, never HTML-escaped; bodies: escape → `\n`→`<br>` → interpolate pre-escaped values; preview iframe sandboxed without `allow-scripts`/`allow-same-origin`; click/open tracking off. RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers on every branded send via the existing `headers` passthrough; unsubscribe POST accepts the mail-client form post. A1 restated: **08:00 UTC** (Vercel cron is UTC-only; 8/9am London seasonally). Feb 29 → greeted 1 Mar in non-leap years, documented. `preferNoDob` refs replaced with "null `dateOfBirth`". Birthday acceptance test seeds a DOB at `23:00:00Z` to catch UTC day-shift.

**Spec hygiene:** define A1–A4 inline in both repo copies; replace all `autoEmailOptOut` references with `emailOptOuts`/`all`; record SC1 as **resolved** — Pro $20 = 10 domains (wall at club 9), +$20 add-on = +100 domains, Scale $90 = 1,000; *lane discrepancy: free tier = 1 vs 3 domains between lanes — re-check at build, immaterial to conclusions*; re-base the Vercel-plan line on the dashboard's actual plan (3 crons deploy today); commit the spec to git.

**Status-line hardening (lane 1):** replace "unless re-prioritised" with: *"re-prioritised only if the first paying gym makes member email a signing condition; otherwise no phase starts before the first invoice is paid."* Pitch guard: "automated member email included" is not used in any pitch or landing copy until Phase 1 is live (landing currently makes no such promise — keep it that way; Sean heard it "loosely, not as a commitment").

**Launch-runbook extraction (do this week, independent of the hub):** check the Resend plan tier before Total BJJ onboarding day — free tier's 100/day cap silently kills a ~200-member bulk invite; confirm the Vercel plan (doubles as the are-all-3-crons-running check); the DMARC record already owed covers the hub's deliverability prerequisite.

## Verification

- Both spec files updated consistently: no surviving `autoEmailOptOut`/`preferNoDob` reference, A1–A4 defined inline, D14–D18 present, SC1 marked resolved with dated numbers, status line hardened.
- The two `[[NEEDS VERIFICATION]]` items each name their resolution method and deadline: Resend suspension scope (written support question, before Phase 2) and post-verification DNS re-checking (live experiment — verify a test domain, delete DKIM, watch for `domain.updated` — before Phase 1).
- Spec committed to git so it has history.
- Nothing outside the two spec documents (and this plan) is touched; no schema, no code, no migrations.
