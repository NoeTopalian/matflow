# Per-step integration qualification (14 Oct 2026, rehearsal worktree, nothing pushed)

Each deploying state was rebuilt on top of the previous one from the real branch refs and qualified with `tsc --noEmit`, the unit suites of the PRs involved, and `secret-scan.mjs --tree`. Node 24.21.0. Refs: #30 `origin/fix/main-ci-green`, #32 `origin/fix/secrets-fixtures`, #31 `a1dfee9`, #33 `7e24f4e` (the Escape-to-close follow-up `f2f5138` is client-only; its unit file re-ran green), #28 `origin/fix/members-toolbar-table-banner`, #29 `origin/feat/hub-conflict-resolution`.

| State | Merge | tsc | Suites | Tree scan | Note |
|---|---|---|---|---|---|
| S0 main `9272a21` | — | 0 | #30 suites: 19 passed, 1 skipped (on main's own tests) | 8 candidates (exit 1) | baseline; red as known |
| S1 +#30 | clean | 0 | 19 passed, 1 skipped | 8 candidates (exit 1) | red until #32, as PR #30 states |
| S2 +#32 | clean | 0 | 78 passed, 1 skipped (#30 + sec-e) | **0 candidates (exit 0)** | first green tree |
| S3 +#31 | clean | 0 | 462 passed, **1 failed** in `support-session-routes` under heavy concurrent load (48 s for the file); **re-run alone at the exact S3 head: see below** | 0 | — |
| S4 +#33 | clean | 0 | 793 passed (support + blob + sec-e) — includes `support-session-routes` green | 0 | — |
| S5 +#28 | **conflict** `components/layout/ImpersonationBanner.tsx` (expected) → resolved: #31 structure + #28 `<LocalTime>` | 0 | 413 passed (support + #28 UI) | — | resolution script in the evidence pack |
| S6 +#29 | clean | 0 | 477 passed (support + hub-conflict + sec-e) | 0 | final combined tree |

S3 re-run alone at `1b99291`: **36/36 passed in 5.5 s** — the S3 failure was load contention (the same file took 48 s during the parallel browser runs), not an interaction between #30/#32 and #31.

Reading: every deploying state compiles and its relevant suites pass; the secrets tree scan is red for the two states before #32 (known, stated in #30) and green from S2 on. The only cross-PR conflict is the banner; the resolution is deterministic and rehearsed twice.

After each real merge: confirm on GitHub that the next PR's base is `main` (GitHub retargets a stacked PR when its base branch is deleted after merge — verify, do not assume), and that the head SHA matches this table.
