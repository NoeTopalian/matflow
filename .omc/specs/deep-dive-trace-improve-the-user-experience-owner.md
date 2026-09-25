# Deep Dive Trace: improve-the-user-experience-owner

Run 2026-09-25 18:09–19:50 Italy. Three tracer lanes (general-purpose agents, read-only; plan mode blocked their file writes until they used Bash heredocs — lane 2 never wrote) plus a research lane. Full lane outputs: `C:/Users/NoeTo/AppData/Local/Temp/claude/c--Users-NoeTo-Desktop-matflow/6bf2b346-2362-4810-9964-5aa730c9ba31/scratchpad/trace/{lane1-findings.md, lane3-findings.md, research-maturation.md}`.

## Observed Result
On a staff member profile → Payments tab (owner screenshot, ≈915 px wide, live demo club): a blank band above the transactions table header, only one of two payment rows visible before "Total recorded", a pink sliver above the "Status" heading. Wider question from Noe: improve the UX on both the owner and the member side; parents with several children; children maturing into adults while the parent keeps paying.

## Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|---|---|---|---|---|
| 1 | Layout primitives lie about geometry: the DataTable sticky header is offset against a rail but, in the 640–1023 px band, resolves against the table's own `overflow-x-auto` wrapper, so it is displaced by the full offset and covers row 1 | High | Strong — controlled reproduction with two single-variable interventions (force `top: 0` → fixed; force `overflow: visible` → fixed; members list without offset → unaffected) | Explains every pixel of the screenshot from one number (45 px); confined to the two call sites that pass `stickyOffset` |
| 2 | What is measured is not what a user meets: 54 route segments, 8 walked in a browser, ~45 dialogs essentially never, 0 staff dialogs at phone width, 6 geometry assertions in the repo, overlap sweep opt-in | High on the gap, Medium on the friction it predicts | Strong (counted from source) / Weak (walk not run) | Why the fault reached a screenshot instead of a test |
| 3 | The two shells apply tokens and tenant colours inconsistently | Low (lane produced no output) | Code-level facts only: hex ratchet 737, `text-gray-*` 249, raw buttons 342, the login autofill fault fixed today | Not disproven; not the cause of the observed result |

## Evidence Summary by Hypothesis
- **H1:** `components/ui/data-table.tsx:229` wrapper `hidden overflow-x-auto sm:block lg:overflow-x-visible` computes to `overflow: auto/auto` between `sm` and `lg`; a sticky `<th>` with `top: var(--dt-sticky-top)` = 45 px inside a non-scrolling scrollport is pushed down 45 px at rest; `z-10` paints it over the 36 px first row; an 8.5 px sliver of row 1 (the Paid pill) shows above the header. Measured at 1440/1280/1024 (displacement 0), 1023/915/768/700/640 (45 px, row 1 covered), 375 (cards). The 45 px token is correct at every width (rail 45.0). The primitive's header comment (`:37-42`) states the false belief that the header "cannot stick" there; `warnOnClippingAncestor` starts above the wrapper.
- **H2:** coverage matrix per shell (staff 19 routes: 3 walked; member 10: 4; public/auth/kiosk 18: 1; operator 7: 0); dialogs/tabs/sheets ≈45, walked ≈0; geometry assertions 6 + one 44 px nav check; `UI_OVERLAP_AUDIT=1` and `AUDIT_HARVEST=1` gate the sweeps off by default; 3 `loading.tsx`, 13 `error.tsx`.
- **H3:** none collected by the lane.

## Evidence Against / Missing Evidence
- **H1:** none against; the Payments tab itself could not be reproduced on the test branch (zero payment rows on the seeded club) — the Attendance tab, identical code path, was used.
- **H2:** the walk that would turn predictions (six-tab rail on a phone, `/member/billing` unreachable from the nav, `/member/actions` orphaned, pack purchase untested, announcement modal on first paint) into observations was not run.
- **H3:** no lane output; the worst-case accent probe (`#ffffff`, `#ffe14d`, `#111111`) is still owed.

## Per-Lane Critical Unknowns
- **Lane 1:** whether the second, more durable step (not manufacturing a scrollport in the tablet band, or measuring rail heights at runtime) is needed for the other seven hand-solved constants, or whether scoping the offset to `lg:` is enough for now.
- **Lane 2:** what breaks under the three worst-case accents on the member shell and the login.
- **Lane 3:** does the unmeasured space contain user-visible friction at a rate that matters, or is it unverified-but-fine — a ten-minute 375 px walk of the member profile decides.

## Rebuttal Round
- Best rebuttal to H1: "the constant is wrong / the rail wraps". Held? No — the rail measured exactly 45.0 px at every width and cannot wrap (flex nowrap with horizontal scroll); the offset is correct and its scrollport is wrong.
- Best rebuttal to H2: "the suite is API-first by charter and that is fine". Held partly — it explains the design, not the outcome; the owner found the fault, the suite did not.

## Convergence / Separation Notes
- H1 and H2 are separate mechanisms with one consequence: a geometry fault that nothing measured. H1 is the cause of the screenshot; H2 is why it was not caught. H3 is a different class (colour), left open.

## Most Likely Explanation
A correct sticky offset applied inside the wrong scrollport in the tablet band, unguarded by any geometry assertion at that width.

## Critical Unknown
Whether the unmeasured surfaces (≈45 dialogs and tabs, staff shell on a phone) carry more faults of the same class — answered only by the contact-sheet walk.

## Recommended Discriminating Probe
Sign in as the seeded owner at 375 × 812 and at 915 × 700, open a member, photograph the tab rail and the first fold of each tab, then Record payment and Put on hold; compare against the same at 1440.

## Research (maturation)
Eight platforms; none document a self-service child→adult transition; the viable model is separate-profile-with-shared-payer (TeamUp, Kicksite); pitfalls: UK GDPR Art. 8 / ICO Children's Code consent at <13, 13, 18; the cardholder's mandate was given for a dependent; the Stripe Customer maps to the payer and the member row references its funding customer — takeover repoints, never recreates.
