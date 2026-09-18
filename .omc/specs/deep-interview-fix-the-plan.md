# Deep Interview Spec: Fix the plan — the MatFlow break-the-system loop, reshaped

## Metadata
- Interview ID: x12-fix-the-plan-20260918
- Rounds: 5 (plus the Round 0 topology gate)
- Final Ambiguity Score: 19%
- Type: brownfield
- Generated: 2026-09-18 17:45 UK
- Threshold: 0.2
- Threshold Source: default (no `omc.deepInterview.ambiguityThreshold` in `~/.claude/settings.json`; no project `.claude/settings.json`)
- Initial Context Summarized: yes (the plan file, ~3,500 lines, was summarised to one paragraph before scoring)
- Status: PASSED
- Plan of record: `~/.claude/plans/so-im-seeing-issues-abundant-naur.md`, PART X-12. This file is its mirror; the plan file wins on any disagreement.
- Note: interview state was kept in the plan file because plan mode permits no other write; this mirror was written at stage one, step 1.

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.35 | 0.30 |
| Constraint Clarity | 0.75 | 0.25 | 0.19 |
| Success Criteria | 0.80 | 0.25 | 0.20 |
| Context Clarity | 0.85 | 0.15 | 0.13 |
| **Total Clarity** | | | **0.81** |
| **Ambiguity** | | | **0.19** |

Residual, named: constraint clarity on the loop's shape sits at 0.75 because the matrix's size (61 journeys × 10 roles) sets the hours, and the role set is a ruling (Lane A0's ten roles) that Noe can veto.

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| stale-facts | active | The plan text contradicted the world: branch `feat/attendance-hub`, a merge still to come, production frozen at `ea1d10e`, five lanes not six, no brief-A0 | Covered by the rewrite: `main`, production `883e934`, eight lanes, brief-A0 at S1.5 |
| prompt-critique | active | The A0 end-user prompt was never critiqued by subagents (plan mode returned stubs and no files); v2 was the controller's own pass | S1.2–S1.4: four file-writing critics (security/tenancy; integrity/evidence; functionality/coverage; different users/roles), every MATERIAL finding folded into v3; Noe reads v3 before approval two |
| loop-shape | active | Six domain lanes, 2.5–3.5 h rounds, no cap, against "break down every process and ensure working" | §4 of the plan: a process is a user journey; 61 journeys × 10 roles; A0 drives column one, seven partition lanes the rest; the attack list is the floor; exit only when nothing goes wrong, then a confirmation round |
| plan-document | active | Fifteen parts, ~3,500 lines, superseded parts retained | S1.1: operative part on top; everything older archived verbatim to `docs/superpowers/plans/2026-09-18-matflow-plan-archive.md`; plan file under 500 lines |

## Goal
Every journey a club or a member can take on MatFlow is driven for real, as every role that can reach it, and attacked at every seam as aggressively as the harness allows; every failure is root-caused and fixed on `main` with a test that fails on revert; the loop closes only when nothing goes wrong — zero ERROR across the whole journey-by-role matrix and every attack HELD — twice on the same commit. Before that loop starts, the A0 prompt that drives column one is critiqued by four subagents and shown to Noe as v3, and the plan file is reduced to its operative part with its history archived in the repo.

## Constraints
- Two approvals: approval one starts stage one (archive, critique, v3); approval two, after Noe has read v3, starts the loop.
- Production Neon is never targeted; `.env.test` only; one Playwright run at a time on the detached dev server; lanes never run Playwright; three subagents at once; `general-purpose` agents (they write files), plain dispatch prompts.
- No fix without Phase 1; every fix ships with a revert-red test; timeouts never raised; files staged by name; British English; no secret ever printed.
- Noe's rules, verbatim: "do most comprehensive"; "be extremely aggressive"; "only close this ralph loop when no errors occur when you're trying to break the system"; no cap on rounds; a checkpoint every two hours.
- The plan file stays under 500 lines; the archive is verbatim and `cmp`-identical to the removed span.

## Non-Goals
- No new product features; the loop fixes what the matrix proves broken and nothing else.
- No production data, no production migrations, no live Stripe, no real inbox delivery (those are the only UNCOVERED allowed at exit, by name).
- Noe's Vercel environment items (`CRON_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TESTING_MODE`) stay his and outside the loop.
- No rounding of a red count to green; no round cap.

## Acceptance Criteria
- [ ] `docs/superpowers/plans/2026-09-18-matflow-plan-archive.md` exists and its body is byte-identical to the span removed from the plan file; the plan file is under 500 lines.
- [ ] Four critic reports exist at `x10/critic-{1..4}.md` with graded tables; v3 of the prompt is in §5 of the plan with a "Changes from v2" list naming each finding; `x10/brief-A0.md` exists.
- [ ] Approval two is granted through the plan gate before any lane is dispatched.
- [ ] `tests/e2e/campaign/assess/journeys.ts` lists the 61 journeys with primary role, allowed roles, refused roles and routes; every cell is ALLOWED, REFUSED or N/A by name.
- [ ] Every round's ledger line carries per-lane PASS / ERROR / UNCOVERED / FRICTION and EXPLOIT / BUG / HELD counts and the matrix total (cells driven / cells in the manifest).
- [ ] The loop exits only after a CLEAN round (zero ERROR in every cell table, every attack HELD, every cell driven, serial run green) followed by a confirmation round on the same commit with the same result.
- [ ] Every fix has a test that fails on revert, named in its commit; production smoke is OK after every push.

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| A "process" is a domain (settings, members, money…) | Round 1: the plan already held three different units — surfaces, routes, journeys | A process is a user journey with one verdict; lanes only decide who drives which journeys |
| History in the plan file can simply be deleted | Round 2: the ledgers are evidence the memory files point at; plan mode writes only this file | Operative plan on top; everything older archived verbatim to the repo at execution step 1 |
| The prompt critique can run while planning | Round 3: three plan-mode critics returned stubs and wrote nothing; critic 3's output file was empty | Execution only, four file-writing critics, and two approvals so Noe reads v3 first |
| Six parallel domain lanes give more coverage | Round 4 (contrarian): every lane's specs queue on one Playwright server; A0 already walks every journey | "Do most comprehensive": the journey × role matrix, A0 column one, seven partition lanes for the other columns |
| An undriven cell may stand at exit | Round 5: the old exit test never mentioned UNCOVERED | "Do when nothing goes wrong then pass; be extremely aggressive": every cell driven, UNCOVERED only for a named live service, the attack list is the floor |

## Technical Context
- Production is `883e934` on `main`; there is no feature branch. Fixes land on `main` behind `tsc`, lint, the unit suite with the test database, and the affected Playwright specs; each push deploys and is smoke-checked.
- Harness hazards recorded in the plan: the Bash tool refuses apostrophes; one Playwright run at a time on the detached launcher server; subagent final messages are discarded and `Plan` agents cannot write files; three agents at once; prompts that mention hooks or "do not commit" are refused by the classifier.
- The campaign helpers (`tests/e2e/campaign/helpers/*`), the `sessionFor` pattern (`authorisation.spec.ts:84-106`), the camera stub (`card-scan.spec.ts`), and the signed-webhook pattern (`stripe-webhooks.spec.ts`) are the reusable pieces every lane copies.
- Known-open items the lanes inherit with Phase 1 done are listed in §4.6 of the plan (pack-refund double revocation, kiosk `roster_not_listed` 500, class cancellation unreachable, comp-class roster dropped on create, the two member spec defects, `cancelledAt` never nulled, the seed's `onboardingCompleted`, the owner-session-killing spec, the kiosk spec rotating the seeded token, impersonation without `actingAs`, `GET /api/members` 200-on-error).

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Plan | core | operative part, archive, ledger | Plan has one operative Part and many archived Parts |
| Part | supporting | number, date, status (operative / archived) | Part belongs to Plan |
| Loop | core | round, exit rule, cap (none) | Loop runs Rounds; Loop is closed by the Exit rule |
| Round | supporting | number, CLEAN or not, counts | Round belongs to Loop; Round produces Reports |
| Lane | core | id (A0, L-A..L-G), journeys owned, files owned | Lane drives Cells; Lane writes a Report per Round |
| Journey | core | id (J01–J61), name, primary role, allowed roles, refused roles, routes | Journey has Cells; Journey is owned by one Lane per column |
| Role | core | ten named roles | Role × Journey = Cell |
| Cell | core | ALLOWED / REFUSED / N/A, verdict, spec:line | Cell belongs to Journey and Role; Cell carries Attacks |
| Verdict | supporting | PASS / ERROR / UNCOVERED / FRICTION | Verdict is on a Cell |
| Attack | supporting | class, status, body, rows written/read, grade | Attack targets a Cell's route; graded EXPLOIT / BUG / HELD |
| Prompt | core | version (v2 → v3), sections, report path | Prompt drives Lane A0; Prompt is reviewed by Critics |
| Critic | supporting | lens (security/tenancy; integrity/evidence; functionality/coverage; users/roles), report | Critic reviews Prompt; Critic writes a report file |
| Report | supporting | cell table, errors, attacks, routes, friction, counts | Report is written by a Lane or a Critic |
| Ledger | supporting | round lines, checkpoints | Ledger belongs to Plan |
| Archive | supporting | repo path, header, verbatim body | Archive holds every archived Part |
| Approval | supporting | one (stage one), two (the loop) | Approval gates Stage |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 12 | 12 | - | - | - |
| 2 | 13 | 1 (Archive) | 0 | 12 | 92% |
| 3 | 14 | 1 (Approval) | 0 | 13 | 93% |
| 4 | 16 | 2 (Role, Cell) | 0 | 14 | 88% |
| 5 | 16 | 0 | 0 | 16 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds + topology)</summary>

### Round 0 — topology
**Q:** Four components read from "fix the plan": stale facts; the A0 prompt critique never run; the loop's shape and cost; the plan document itself. Which should the fix cover?
**A:** All four active.

### Round 1 — loop-shape / goal
**Q:** What IS a process here (a surface, a route, or a journey), and should the loop's verdict be indexed by it?
**A:** A user journey, one verdict per journey; lanes only decide who drives which journeys.
**Ambiguity:** 52% (goal .45, constraints .40, criteria .40, context .80)

### Round 2 — plan-document / constraints
**Q:** Plan mode writes only this file; the ledgers are evidence. What may be done with the history?
**A:** Operative plan on top; archive the rest to the repo on approval.
**Ambiguity:** 39% (goal .70, constraints .50, criteria .50, context .80)

### Round 3 — prompt-critique / constraints
**Q:** The critique can only run in execution mode. One approval or two?
**A:** Two approvals: critique now, show v3, then approve the loop.
**Ambiguity:** 35% (goal .75, constraints .50, criteria .55, context .85)

### Round 4 — loop-shape / constraints (contrarian)
**Q:** What if five of the six lanes need not exist, now the verdict is per journey?
**A:** "do most comprehensive" — every journey as every role, a verdict per cell.
**Ambiguity:** 26% (goal .80, constraints .75, criteria .60, context .85)

### Round 5 — loop-shape / success criteria
**Q:** What closes the loop — what does an undriven cell mean at exit?
**A:** "do when nothing goes wrong then pass. be extremely aggressive."
**Ambiguity:** 19% (goal .85, constraints .75, criteria .80, context .85) — PASSED

</details>
