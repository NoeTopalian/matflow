# Deep Interview Spec: Email Hub — residual ambiguity resolution

## Metadata
- Rounds: 4 (Round 0 topology + 3 targeted)
- Final Ambiguity Score: 8.8%
- Type: brownfield
- Generated: 2026-08-21 (Bali)
- Threshold: 0.2 / Source: default
- Status: PASSED — **specification only; implementation separately gated (Noe: "we are still planning, we aren't implementing")**
- Base document: `docs/EMAIL-HUB-SPEC.md` (D1–D10 + A1–A4, locked earlier 2026-08-21)

## Topology (Round 0, confirmed "Looks right — all six")
| Component | Status | Coverage |
|---|---|---|
| Sender identity (per-gym Resend domains) | active | D1, D2 + **D12** (failure behaviour) |
| Templates (editable copy, fixed layout) | active | D3, A2 |
| Automations (birthday, welcome, receipt) | active | D8, A1, A3 + **D11** (welcome edge) |
| Manual send (profile → blast → segments) | active | D4, phased |
| Consent & unsubscribe | active | D5, D6 + **D13** (granularity) |
| Settings UI (Email tab) | active | Spec §UI |

## New decisions from this interview (extend D1–D10, A1–A4)

**D11 — Welcome fires only for genuinely new members.** Trigger condition: member record created ≤30 days before activation. A veteran accepting a bulk-invite during club migration gets nothing; the owner can send manually from the profile. Closes the migration trap where ~200 long-standing members would each receive "Welcome to the gym!" as they accepted app invites.

**D12 — Verified domain that later fails ⇒ pause + alert.** Hub automations stop for that club; owner gets an in-app banner and a transactional alert (sent via matflow.studio, which still works) with re-check/records actions. Nothing ever sends from a failed domain — bounces would poison deliverability. Receipts/invites/resets unaffected. Consistent with D1: their domain, their responsibility.

**D13 — Unsubscribe is all-or-nothing in v1, stored category-shaped.** One click stops all automated email (receipts always exempt), but the schema stores a category list (e.g. `Member.emailOptOuts String[]` with a sentinel `all`, replacing the earlier `autoEmailOptOut Boolean`), so per-category preferences ship later without a migration. Schema shape is the stickiest thing to change; the boolean was the trap.

**Scale constraint (Noe, mid-interview): must work for 10–20+ clubs.** Volume is trivial at that scale (well inside Resend Pro's 50k/mo). The real constraint: **Resend caps verified domains per account by plan tier — 20 clubs = 20 domains on MatFlow's account. [[NEEDS VERIFICATION]] which tier permits ≥20 domains before Phase 1 build starts.** Fallback if capped: higher Resend tier — not shared subdomains, which would reverse D1.

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|---|---|---|
| "Welcome on activation" is always right | Migration bulk-invite: veterans get welcomed months late | D11: ≤30-day recency gate |
| Verification is one-way | DNS breaks after verify at 20-club scale — someone's will | D12: pause + alert, never silent fallback |
| Opt-out is a boolean | Phase-2 blasts make one-click kill birthdays too | D13: category-shaped storage, all-or-nothing UI |
| Any Resend plan fits | Per-club domains × 20 may exceed plan's domain cap | Flagged for verification pre-build |

## Ontology (stable all rounds — 100% stability from Round 1)
| Entity | Type | Key fields | Relationships |
|---|---|---|---|
| Tenant | core | senderDomain, senderDomainStatus, resendDomainId, senderFrom | has many EmailAutomation, Member |
| Member | core | email, dateOfBirth, preferNoDob, emailOptOuts[] | belongs to Tenant; kid → parent redirection (D9/A4) |
| EmailAutomation | core | trigger, enabled, subject, body | per Tenant per trigger |
| EmailAutomationSend | supporting | memberId, trigger, year, sentAt | idempotency ledger |
| EmailLog | existing | status, resendId, bounce states | delivery truth; reused, not duplicated |
| Domain (Resend-side) | external | records, status | mirrored onto Tenant |

## Acceptance criteria added by this interview
- [ ] Bulk-invited member whose record is >30 days old activates → no welcome email; ledger records nothing.
- [ ] Member created 5 days ago activates → welcome sends once; second activation event sends nothing.
- [ ] Simulated Resend `failed` webhook on a verified domain → automations for that tenant stop before the next cron tick, owner banner + alert email present, receipts still send.
- [ ] Unsubscribe click writes the `all` sentinel; birthday cron skips; receipt still sends; schema accepts a future per-category write with no migration.
- [ ] Documented confirmation of the Resend tier supporting ≥20 verified domains, before Phase 1 starts.

## Interview Transcript
<details><summary>4 rounds</summary>

**R0 (topology):** six components confirmed — "Looks right — all six".
**R1 (Automations/constraints, ambiguity 15%→12.5%):** welcome for migrated veterans? → "No — welcome only for genuinely new members".
**R2 (Sender/constraints, →11.25%):** verified domain later fails? → "Pause automations + alert the owner". Mid-round: "should work in a scalable for 10-20+ clubs" → scale constraint + domain-cap verification flag.
**R3 (Consent/constraints, →8.8%):** unsubscribe granularity? → "All-or-nothing for v1, schema ready for categories".
</details>
