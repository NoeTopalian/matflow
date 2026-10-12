# Independent review (R) of lane D at 1e68155, 9 Oct 2026 (saved by the coordinator from the hand-back)

All lane D fixes APPROVED; the AH-D1 claim "never commits a false match" is REFUTED — through the real route, on both database roles, a false match still commits when the true person differs by an accent or a rename (and, at planner level, a zero-width space). Chain C3 NOT closed.

Reviewed 1e681552ffe62bf5dc34e75d4695bb71a97aec3c (diff vs 9c9cf22); reviewer wrote none of the code. Scratch worktree of 1e68155 (lane F edits excluded; removed afterwards); guarded runner copies, TEST branch, both roles logged (neondb_owner RLS_ENFORCED=0; matflow_app RLS_ENFORCED=1); each red run reverted one fix to its pre-fix version then restored (git diff clean). No repo edits/server/mail/production. Unit at 1e68155: 11 files, 354/354.

## Verdicts
- AH-D1 / SEC-053 importer — APPROVED as a fix; "never commits" REFUTED. Red (planner + route at 9c9cf22): 3/10 both roles; green 10/10 both; attendance-import-engine 19/19, contact-email-change-imports-db 7/7 both roles. Roster drift closed (steps take decisions only from the frozen commit snapshot; a decide call during a running job writes the ledger, not the frozen set). __proto__ person key → pending. Concurrent/replayed commits covered, green both roles.
- SEC-052 CSV guard — APPROVED for what it covers (red 6/16 at 3deb7c7; green 16/16; every text/csv producer goes through csvCell/csvRow/csvDocument). Residual (unverified in a real spreadsheet): leading space, NBSP, BOM, zero-width space, U+FE66 ﹦, ideographic space, `|cmd`, `a<TAB>=…` pass unprefixed; `Ann;=1+1` is left unquoted so a semicolon-locale Excel splits and evaluates — Low; check in Excel and LibreOffice.
- SF-C2 own-property lookups — APPROVED (red 5/19; green 19/19). Body-shape 400 on admin/import/attendance — APPROVED (red 1/7; green 7/7; canary sweep green at this SHA → R-2 cleared).
- SEC-089 webhook signature tests — APPROVED (constructEvent → JSON.parse fails 4/9; replay within tolerance claimed once; stale 600 s → 400; re-serialised bytes → 400; tampered account → 400; a future-dated timestamp passes the age check but needs the secret).
- SEC-091 mail holds — APPROVED (8/8; restoring scripts/test-resend.mjs fails 1/8; lib/email.ts is the only Resend transport in app, lib, scripts).
- Deletion of scripts/test-resend.mjs — APPROVED (held no secret; the uniqueness test keeps it gone).
- /api/upload limitInputPixels 50 MP — APPROVED; NOT pinned to the route: over the limit sharp refuses in 6–8 ms (50.01 MP PNG, 160 KB); just under, a 49.98 MP PNG of 160 KB costs ~0.6 s and ~190 MB RSS peak (~125 MB above baseline); sharp failure → 400, nothing stored; reverting the route leaves sec-d-image-bounds 5/5 green (it tests sharp directly). Per-principal rate limit (SF-40) still owed: N concurrent uploads ≈ N × 125 MB.

## AH-D1 variants that still commit (real route, both roles, secr- fixtures, count-checked teardown)
Accent: original hand-added "Béa Lane" moved to a new address; a different "Bea Lane" holds the released old address → attendance commits to the other person (1 row), original 0. Rename: original renamed "Beatrice Lane" and moved → same. Planner probe: zero-width space inside the name → same. Cause: norm() only trims, lower-cases and collapses whitespace, so the same-name check (sameName.length === 1) never sees the original. Options: fold names with NFKD, strip combining marks and zero-width characters; refuse the name+email fallback when the member address changed after the booking dates (audit history). The rename case cannot be detected from the data alone.

## Chain C3
NOT closed: same-name and roster-drift variants closed (red/green both roles); accent and rename variants still bind history to the wrong person through the real route on both roles. Binding a link to the record does not help because the record itself is the wrong one.

## Not done
Lane planner mutants not re-run; real-spreadsheet CSV check; route-level timing test of the upload limit; SEC-090 Stripe test-mode; production. Evidence: <scratchpad>/security/R/logs/D-*, d-summary.txt, d-red-unit.txt, three scratch tests (not committed).
