# Independent review (R) of lane D second pass at 35e031a, 9 Oct 2026 (saved by the coordinator from the hand-back)

Fold rule and CSV guard APPROVED; released-address rule NOT APPROVED — a false match still commits through the real route on both roles whenever the old address was released without a keyed audit row; C3 not closed. Reviewed 35e031a2e8c802fd449e5db2315d626332b91265 (diff vs 6bfb86c); reviewer wrote none of the code; scratch worktree (lane F excluded; removed); guarded runners, TEST branch, roles logged (neondb_owner RLS_ENFORCED=0; matflow_app RLS_ENFORCED=1); secr- fixtures, count-checked teardown incl. audit rows; no repo edits.
Lane tests at 35e031a: sec-d-attendance-misbinding-db 14/14 both roles; red check (planner files reverted to 6bfb86c) 3/14 fail both roles; unit 6 files 103/103.

## R's variants re-run through the real route (both roles), original moved with the real owner PATCH (audit row present)
Accent (Béa) pending; rename (Beatrice) pending; zero-width space pending; Cyrillic е in the name pending (saved only by the released rule — the fold does not unify it).

## Rule 1 foldName — APPROVED (residual)
Full-width letters and ligatures fold together (ｆｉ… and ﬁona → fiona). NOT unified: Cyrillic а/е, Greek ο, dotless ı, ß vs ss — each alone lets a name escape the same-name check. A fold collision between genuinely different people (Zoe / Zoë Ng) makes the row pending — the safe direction.

## Rule 2 released-address — NOT APPROVED
Only releases recorded with the keyed digest are known. All three commit a false match through the real route on both roles (1 row to the other Bea Lane, attendance_created): address changed by raw SQL (no audit row); move recorded before AH-E2 with the unkeyed SHA-256 form; original deleted and a different Bea Lane created at the address. In-app writers releasing an address with no digest (only 6 writers write one): member delete, staff DELETE, DSAR erase (sentinel), import rollback. Key rotation (digest key = auth secret) makes every recorded release unmatchable. Case/whitespace handled (emailDigest normalises); plus-tagged source never matches → pending. Suggested: also match the unkeyed form; make delete/DSAR/rollback write the digest; or invert — allow the fallback only when the member has held the address since before the booking dates.

## Rule 3 CSV — APPROVED (residual unverified in a real spreadsheet)
Red (lib/csv.ts reverted) 8/25; green 25/25. Prefixed now: leading space, NBSP, BOM, zero-width space, U+FE66, ideographic space, pipe, leading tab; cells containing ; quoted. Still unprefixed: U+FE62/U+FE63, U+FF5C, U+2028, VT, FF (spreadsheet behaviour unknown). An unquoted mid-cell tab only matters when pasted or imported as TSV — Low.

## Chain C3
Not closed, narrowed to unaudited releases: closed for same name, accent, zero-width, look-alikes and renames when the move went through an audited keyed-digest writer; remaining: releases by delete, DSAR erase, import rollback, staff deletion, raw SQL, pre-AH-E2 change, or before a key rotation.
Not done: real spreadsheet; lane mutants; production. Logs <scratchpad>/security/R/logs/D2-*, d2-summary.txt; scratch tests zz-r-d1b-route-db.test.ts, zz-r-d2-probe.test.ts (not committed).
