# Deep Interview Spec: UX on both sides (owner dashboard + member portal), families, maturation

## Metadata
- Interview ID: dd-2026-09-25-ux-both-sides
- Rounds: 7 (+ Round 0 topology)
- Final Ambiguity Score: 19.5% (22% after round 7; Context lifted by the trace)
- Type: brownfield
- Generated: 2026-09-25T17:52:00Z
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED
- Source: deep-dive (trace: .omc/specs/deep-dive-trace-improve-the-user-experience-owner.md)

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal Clarity | 0.85 | 0.35 | 0.30 |
| Constraint Clarity | 0.75 | 0.25 | 0.19 |
| Success Criteria | 0.80 | 0.25 | 0.20 |
| Context Clarity | 0.80 | 0.15 | 0.12 |
| **Total Clarity** | | | **0.805** |
| **Ambiguity** | | | **0.195** |

## Topology
| Component | Status | Description | Coverage |
|---|---|---|---|
| Owner dashboard experience | active | nothing hidden, nothing lies, at any width | Package A |
| Member portal experience | active | the same rule on a phone | Package A |
| Parent and child accounts | active | parent runs the whole family; adult takeover with parent paying until changed | Packages B, C |
| Shell consistency | active | tokens and browser styling identical on both shells | Package A (sheets + ink tokens) |
| Measurement | active | contact sheet at 375/1440 after each UI change, inspected before commit; geometry gate; Noe assesses | Package A |

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|---|---|---|---|
| Member | core | id, accountType, dateOfBirth, parentMemberId, payerMemberId (new), stripeCustomerId, stripeSubscriptionId | belongs to Club; may have a Guardian (Parent) and a Payer |
| Parent | role of Member | — | guardian of Children; payer of Children and of adult children until changed |
| Child | role of Member | age band from DOB | has Guardian; has Payer; matures into an adult Member (same row) |
| Payer | relationship | payerMemberId | funds a Member subscription via its Stripe customer |
| Payment | core | amount, status, method | belongs to Member; charged to Payer |
| Screen/table | surface | route, dialog, viewport | measured by the Contact sheet |
| Shell | surface | staff (light), member (dark, branded) | tokens |
| State | surface | loading, empty, error, success | honest per UI-RULES §7 |
| Waiver, Photo, Attendance, Rank | supporting | — | belong to Member; signed/uploaded by Guardian for a Child |
| Contact sheet | artefact | date, screens, notes | inspected before commit |

## Ontology Convergence
| Round | Entities | New | Changed | Stable | Stability |
|---|---|---|---|---|---|
| 1 | 9 | 9 | - | - | - |
| 2 | 10 | 1 | 0 | 9 | 90% |
| 3 | 14 | 4 | 0 | 10 | 71% |
| 4 | 16 | 2 | 0 | 14 | 88% |
| 5–7 | 16 | 0 | 0 | 16 | 100% |

## Interview Transcript
<details><summary>7 rounds</summary>

1. Owner goal → nothing hidden, nothing lies (61%)
2. Member goal → the same honesty rule on a phone (52%)
3. Family scope → run the whole family (42%)
4. Proof (contrarian) → screenshots a person looks at, every screen, both widths (35%)
5. Maturation → research TeamUp and others; kids take control with data pre-filled, parent payments continue until changed (30%)
6. Scope now (simplifier) → fix what is seen, prove the rest, then families (24%)
7. Done means → Claude decides and inspects; Noe assesses at the end (22%)
</details>

# ▶ UX ON BOTH SIDES — deep-dive spec (trace + 7-round interview, Noe, 2026-09-25 18:04–19:50 Italy; ambiguity 22% → 19.5% once the trace landed)

## Context
Noe photographed the member Payments tab (blank band above the table header, one of two payment rows hidden, a pink sliver above "Status"), asked for a test-and-assess pass on parent and child accounts (a "+" capture, done: `01-Daily/2026-09-25.md`), then reframed: "improve the plan and help me improve the user experience for both owner side and member side", and added: parents can have multiple children, and children maturing to adult accounts with parents continuing to pay. Deep-dive ran three trace lanes (agents could only read under plan mode; two wrote via heredoc, lane 2 produced nothing) and a research lane on maturation; the interview settled the goals below.

## What the trace found (evidence, not assumption)
- **The hidden payment row — HIGH confidence, controlled reproduction (lane 1).** Between 640 and 1023 px the `DataTable` wrapper `hidden overflow-x-auto sm:block lg:overflow-x-visible` (`components/ui/data-table.tsx:229`) computes to `overflow: auto/auto` and becomes the sticky header's scrollport; a sticky box in a non-scrolling scrollport is NOT inert, it is displaced by its full `top`. With `stickyOffset="var(--staff-member-tabs-h)"` = 45 px (the two member-profile call sites, `MemberProfile.tsx:1631` and `:1791`) the `<th>` row sits 45 px below its in-flow place at rest, leaving the blank band, and its `z-10` paints over row 1 (36 px), leaving an 8.5 px sliver of the row's "Paid" pill above the header — every element of the screenshot from one number. At ≥1024 px displacement is 0 and the header parks correctly on scroll; <640 px the table is cards. Forcing `top: 0` OR `overflow: visible` each removes it; the members list (no offset) is unaffected. The primitive's own header comment (`:37-42`) states the false belief; `warnOnClippingAncestor` starts its walk above the wrapper so cannot catch it. The 45 px token itself is correct (rail measured 45.0 at every width) but is one of eight hand-solved geometry constants (`--staff-tabbar-h`, `--staff-topbar-h`, the phone-preview ladder, `--member-nav-clearance`/`--member-header-clearance` consumed by ~12 member sites, the Toast offset) — a latent class. Note: the test branch has zero payment rows on the seeded club (Payments renders the empty state there; the screenshot is from the live demo club); the Attendance tab is the identical code path and reproduces it.
- **Coverage (lane 3).** 54 route segments: 8 walked in a browser (15 %), 29 smoke-only, 17 never; ~45 dialogs/tabs/sheets, essentially none walked; 0 staff dialogs ever rendered at phone width; 6 `boundingBox` assertions in the whole repo plus a 44 px nav check; the overlap/dual-viewport sweeps exist but are OFF unless `UI_OVERLAP_AUDIT=1`. Predicted friction, unverified: the six-tab profile rail on a phone, `/member/billing` unreachable from the nav, `/member/actions` orphaned, the pack purchase screen untested, announcement modal on first paint. Confidence 0.85 on the gap, 0.5 on the predictions — the walk decides.
- **Tokens/shells (lane 2)** — inconclusive (agent produced no output). Known facts stand: hex ratchet 737 (was 743 today), `text-gray-*` 249, raw buttons 342; the login autofill class of fault fixed today; intent-as-text must use `-ink` tokens.
- **Maturation research** (TeamUp, Glofox, Mindbody, Gymdesk, Zen Planner, Kicksite, Martialytics, ClubReady; URLs in `scratchpad/trace/research-maturation.md`): no platform documents a self-service child→adult transition; TeamUp's is a support ticket. Two models recur: proxy-only child records (Glofox, Martialytics) where maturation means a new account, and separate-profile-with-shared-payer (TeamUp, Kicksite, Gymdesk, ClubReady) where the child already has its own profile and the parent is attached as payer — the only model where "take control with the data already filled in" is possible without migration. Where a payer pays for another adult it is framed as membership/agreement sharing, not delegated card-on-file. Pitfalls: UK GDPR Article 8 / ICO Children's Code (under-13 consent by the guardian; re-derive at 13 and 18); the cardholder's mandate was given for a dependent, so the adult must own the relationship (see charges, end the arrangement) while the parent's card stays; the Stripe Customer should map to the payer and the member row should reference which customer funds it — takeover repoints, never recreates.

## Interview outcome (7 rounds; topology of five, all active)
Owner side: **nothing hidden, nothing lies, at any width** — the look stays. Member side: **the same rule on a phone**. Families: **a parent runs the whole family from the phone** (add, edit, photo, waiver, pay, check in, remove) and **a maturing child takes over their own account with the data already filled in, the parent's payments continuing until either side changes it** (Noe's lean, confirmed by the research as the defensible model). Shell consistency: tokens and browser styling identical on both shells. Measurement: **a contact sheet of every screen and dialog at 375 and 1440 after each UI change, which I inspect before committing; geometry assertions are the gate; Noe assesses the finished result.** Sequence (simplifier round): **fix what is seen and prove the rest → parents run the whole family → adult takeover.** Ontology converged three rounds: Owner, Coach/desk, Member, Parent, Child, Payer, Payment, Screen/table, Shell, Club, State, Waiver, Photo, Attendance, Rank, Contact sheet.

## Package A — fix what is seen, prove the rest (first)
1. **`DataTable` sticky offset scoped to the scrollport it resolves against:** the `--dt-sticky-top` offset applies only at `lg:` and up (where `<main>` is the scroller); below `lg` the `<th>` `top` is 0. Rewrite the primitive's header comment with the true rule (a sticky box in a non-scrolling `overflow:auto` scrollport is displaced by its full offset). Make `warnOnClippingAncestor` start at the wrapper. Second step, same commit: stop the tablet band manufacturing a scrollport when the table is not wider than its card (`overflow-x: auto` only when `scrollWidth > clientWidth`, via a class toggled by a ResizeObserver, or `overflow-x: clip` + a scroll shim); if that proves fiddly, the offset scoping alone closes the fault and is shipped.
2. **Regression, red on revert:** a unit test for the primitive (offset class present only at `lg`), and a cell in `ui-audit-overlap.spec.ts` at 915 px on the member profile Attendance tab (the seeded club has attendance rows): the first data row's centre resolves to its own row, not the `<thead>`; the `<thead>` top equals the table top at rest. Promote the overlap sweep from opt-in to the default project matrix.
3. **The contact sheet (measurement):** a Playwright script (`tests/e2e/campaign/sheets/contact-sheet.spec.ts` + `scripts/contact-sheet.mjs` runner) that signs in as owner and as member, visits every one of the 54 route segments and opens every dialog/tab/sheet it can reach without submitting (the lane-3 inventory is the list), at 375 and 1440, and writes one PNG per screen plus an HTML index per run into `.omc/sheets/<date>/` (git-ignored) and copies the index to the Desktop. Each capture also records the geometry floor: no element wider than its container, no sticky header covering a row, every button/link ≥ 44 px on 375, no horizontal page scroll, and a "state" probe (with `/api/*` stubbed to 500 the page shows an error state, not an empty one). I inspect every sheet before committing and write what I saw into the run's notes file.
4. **Fix what the sheet shows**, in the same package, each with its geometry assertion: the six-tab profile rail at 375 (visible scroll affordance or a two-row rail), `/member/billing` and `/member/actions` reachable from the member nav, the announcement modal not on first paint before content, the pack purchase screen states, the hand-solved constants replaced by measured ones where a sheet shows drift (ResizeObserver writing the real rail height into the variable), any intent-as-text hex on either shell moved to `-ink` tokens, and whatever else the sheets reveal — recorded PRODUCT / UX / GAP in a findings table, HIGH fixed, the rest ranked.
Done when: lf-3, lc-1 (members), lf-1 (portal) green on the serial runner; the overlap sweep green at 375/915/1440; contact sheet run clean on both shells with my notes; tsc, lint ratchets (hex ≤ 737), unit suite green. Commits: `fix(ui): sticky table header…`, `feat(qa): contact sheet…`, `fix(ui): …` per finding.

## Package B — a parent runs the whole family (second)
Scope from the prior spec `.omc/specs/deep-dive-audit-the-entire-kids-account.md` (its acceptance checklist is reused, not rewritten) plus the lh-2 lane: from `/member/family` the parent can add a child (name, DOB, photo, emergency contact), edit, upload/replace a photo, sign the child's waiver, pay for the child (kids tier via `start-for-kid`, Stripe test mode on a Custom account; the card-fails leg answers C6.08: which rows flip when the payer's renewal fails), check the child in (C6.03 on the screen), see attendance and rank, and remove a child (with the honest consequences named); siblings share one payer; the staff Family card's Link existing / Add child dialogs are walked and sheet-inspected. Lane `lh-5-clublife-families-quality.spec.ts` drives every cell on the wire at 375 and 1440; the contact sheet covers the screens; findings fixed as in A. Done when lh-5 green, `parent-pays-for-kid` and `member-self-pay` still green, catalogue L6 rows C6.10+ filled, register row R2-8.

## Package C — adult takeover with the parent still paying (third, after A and B)
Model (from the research's pattern b): the child is already its own `Member` row; add a **payer link** distinct from the guardian link — `Member.payerMemberId` (nullable, same club, FK SetNull) with the Stripe customer/payment method resolved from the payer for billing, while `parentMemberId` remains the guardian link. **Promote to adult** becomes a takeover: the row keeps its id, history, rank, attendance and waiver record; `parentMemberId` is cleared; `payerMemberId` is set to the former guardian if a subscription is live; the adult gets an invite to claim the existing profile (set their own password, 2FA offered); the parent keeps the payer view of that member (billing only: what is charged, when, the payment method) and loses attendance/rank/notes; either side can end the arrangement — the adult from Billing ("Pay for this myself"), the parent from Family ("Stop paying") — which repoints or cancels the Stripe subscription with the same replace-at-period-end discipline as the migration engine, never a new member row. Age triggers: the age band re-derives from DOB on read (13 → junior, 18 → eligible for takeover); an 18th birthday flags the row for the owner and the parent ("ready to take over"), it does not flip anything automatically. Consent capture: under-13 consent recorded against the guardian at creation; re-consent prompts at 13 (optional) and at takeover (required, the adult's own). Migration additive; RLS on the new column via the existing policy; the TeamUp import sets the payer to the parent for every kid it links. Acceptance: unit (payer resolution, takeover transaction, end-arrangement paths), integration (Stripe stub: subscription stays on the parent's customer through takeover; repoint on "pay for this myself"), lh-6 lane on the wire with a test-clock renewal after takeover charging the parent, and the contact sheet for the new screens. This package reopens `auth.ts` only for the claim-profile invite (existing `first_time_signup` token path, reused).

## Non-goals
No redesign of either shell's look; no switcher/Person identity (ADR-001 D4 stays NOT STARTED); no automatic flip at 18; no pooled family Stripe customer; no push notifications; no changes to what the desk can do.

## Verification / exit for the whole spec
Every package ends with: tsc 0 · lint ratchets at or below baseline · unit suite green · the named lanes green on the serial runner (test branch) · contact-sheet run inspected and noted · commit per concern · push only on "push". Final report to Noe with the sheets index on the Desktop and the findings table, then Noe assesses.

## Execution route (after approval)
Direct execution in this session in the order A → B → C, with the deep-dive artefacts written first: trace to `.omc/specs/deep-dive-trace-improve-the-user-experience-owner.md`, spec to `.omc/specs/deep-dive-improve-the-user-experience-owner.md` (this section, verbatim), state marked spec-complete. Each package is its own gate; C waits for B's lane to be green.
