# Timetable mats and the same-time split (PR 2 of 3) — evidence (5 Nov 2026)

A club has its own list of mats (training areas). A class can be on one; while it is, its place everywhere is that mat's current name. Owners and managers choose how same-time classes are split on the staff week, **By mat** (one column per mat, as on Total BJJ's printed MAT 1 / MAT 2 timetable) or **By time** (lanes); until somebody chooses, a club with classes on two or more mats is split by mat. Stacked on PR 1 (#66). Plan: `.omc/plans/timetable-side-by-side-plan-2026-11-05.md`.

Synthetic data only, Neon test branch, isolated worktree. No production query, no change to any real club.

## 1. What changed

| Behaviour | Files |
|---|---|
| `Mat` table (name, a case-free key unique per club, order), `Class.matId` (ON DELETE SET NULL), `Tenant.timetableLayout` (nullable, `mat` or `time`) | `prisma/schema.prisma`, two hand-written migrations (§2) |
| Names (24 characters, 12 mats, one per club whatever the capitals), the per-club advisory lock taken first by every mats write, and the place suggestions | `lib/mats.ts`, `lib/mats-store.ts`, `lib/timetable-layout.ts` |
| Routes: list and add mats, rename, remove, reorder, the typed places on offer, "Add these as mats", the split choice | `app/api/mats/**`, `app/api/timetable/layout/route.ts` |
| A class can be put on a mat on create and edit; the mat's name replaces the typed place; a foreign mat is refused | `app/api/classes/route.ts`, `app/api/classes/[id]/route.ts`, `lib/schemas/class.ts`, `lib/class-refs.ts` |
| Undo of a class edit takes the mat's name as it is now, is refused onto a mat that has gone, and takes the mats lock; the six mat actions cannot be undone from Activity (they are changed back on the Timetable page) | `lib/undo-registry.ts`, `lib/undo-batch.ts`, `lib/audit-labels.ts`, `docs/design/LOCK-ORDER-2026-10-24.md` |
| A club's mats go with the club when it is purged | `lib/tenant-purge.ts` |
| The Mats sheet (first run from typed places, the list, rename, move, remove, add), the split control, the Mat select in the class form, the staff week by mat | `components/dashboard/MatsSheet.tsx`, `components/dashboard/TimetableManager.tsx`, `app/dashboard/timetable/page.tsx`, `components/schedule/*` |
| Rules written down | `docs/RULES.md` §5b |

Not changed: the phone and the members' app (they follow the split from PR 3); the Activity feed's mapping of the six new mat actions lands with whichever of this PR and the Activity timeline PRs merges second.

## 2. The migrations, as applied

Both are expand-only (no DROP, no backfill), each in one transaction with `lock_timeout 5s` and `statement_timeout 15s`:

- `20261105160000_mats`: table `Mat` with row-level security enabled and forced and the same `tenant_isolation` policy as the other tenant tables, unique `(tenantId, nameKey)`, index `(tenantId, sortOrder)`, foreign key to `Tenant` ON DELETE RESTRICT; nullable `Class.matId` with its index and foreign key ON DELETE SET NULL.
- `20261105160100_tenant_timetable_layout`: nullable `Tenant.timetableLayout` with a CHECK of `mat` or `time`.

Applied to the Neon test branch with `migrate-test.mjs deploy` at 18:05 UK (`PRISMA DEPLOY EXIT 0`); `status` then: "Database schema is up to date". Not applied to production: a merge to `main` applies them in the Vercel production deploy.

## 3. Gates

| Gate | Result | Commit |
|---|---|---|
| `npm run lint` (eslint + UI-RULES ratchet) | pass, all ratchets at baseline | `ac2c6b2e` |
| `npx tsc --noEmit` | pass | `ac2c6b2e` |
| Full unit suite `npm test` | 618 files passed, 115 skipped (database files: no test database in a unit run); 8,713 tests passed, 853 skipped, 3 todo; 0 failed | `ac2c6b2e` (the commit after it, `d31dc565`, changes only a database test file) |
| Production build (`server.mjs build`, no database variable) | `BUILD EXIT 0`, tree clean | `bb69d14d` |
| Independent review (Opus) | APPROVE WITH CHANGES (§5) | `c6ba84e3` |

## 4. Database suites, as both roles (owner, and the restricted `matflow_app` role with row-level security enforced)

| Suite | Owner role | `matflow_app` role | Commit |
|---|---|---|---|
| `mats-db` (isolation between two clubs, the write-through rule on real rows, Undo onto a renamed and a removed mat, the per-club lock under real concurrency, the choice, one audit row per write) | 22 passed, 1 skipped (a restricted-role-only check) | 23 passed | `d31dc565` |
| `cross-tenant-authorisation-matrix` (Mat added) + `rls-coverage` (Mat is a tenant table with forced row-level security) | 61 passed | 61 passed | `3539a3aa` |
| `class-lifecycle-db`, `class-lost-update-db` | passed | passed | `3539a3aa` |
| `class-schedule-edit`, `class-roster-reply-db`, `roster-cross-tenant` | 12 passed | 12 passed | `3539a3aa` |
| `tenant-restore-purge-race` | 3 of 5 time out | 3 of 5 time out | `3539a3aa`, `0417be50`, and PR 1's `f5943ddf` alike: see §7 |

Between `3539a3aa` and `d31dc565` the product code changed only in how a tied spelling is chosen (`lib/mats.ts`, `lib/mats-store.ts`); `mats-db` covers that change and ran on `d31dc565`.

## 5. Independent review

Opus, on `c6ba84e3`: **APPROVE WITH CHANGES**, no blocker. Fixed in `3539a3aa`: mat rename and removal by id **and** club (was by bare id; not exploitable, the club-scoped read and row-level security came first); "The staff week is now split by …" wording; a refused "Add these as mats" shows the server's sentence after reading the list again; Mat 1, Mat 2, No mat no longer leaves "Mat 1" in the place box; a failed mats read no longer toasts a change of split; a doc path. Accepted and recorded, not changed: a class edit with no mat that lands while an adopt is mid-way can lose its new place to the mat's name (the place still equals the mat); when the mats cannot be read, a typed Location edit on a class that is on a mat is dropped by the server (the class keeps its mat's name); a chip's accessible name gives the coach where the spec says "no mat".

## 6. Browser journeys

| Journey | What it proves | PASS | FAIL | NOTE |
|---|---|---|---|---|
| timetable-mats | a mat added by hand changes nothing and says why; "Add these as mats" with a forced failure then one retry; the week by mat at 1440 with scrollbars (every chip under its own mat, Mat 1 then Mat 2 every day, 14 px to spare); pinned mat names at 1366; the choice by a manager and the owner with forced failed saves, a coach reading it; rename, move, remove and re-add a mat; the class form's Mat select with a forced failed save; classes sharing a mat side by side, then "+2 more" opening the Day view; the sheet by keyboard; phones at 375 and 390 | 13 | 0 | 3 |
| timetable-week-grid | PR 1's poster week, unchanged on a club with no mats | 16 | 0 | 2 |
| timetable-week-grid-stress | PR 1's busy week, unchanged | 11 | 0 | 1 |
| smoke | the harness itself | 11 | 0 | 1 |
| **Total** | | **51** | **0** | **7** |

All on one build of `bb69d14d`: the first three in run `rmw41smp075df9d` (21:18 to 21:42 UK), smoke in run `rmw42niyja1cba2` straight after on the same build. In the first run smoke failed its two forced-failure checks (F1, F2): its abort route missed the save request. Smoke passed on PR 2's two earlier builds tonight and again here; Settings is untouched by this PR; it is a timing flake of the reference check, recorded, not hidden. Every fixture club was torn down to zero rows (mats included).

The test branch was slow tonight (about 2.2 s a new connection, 4 to 6 s a request through the app), so the mats journey waits 20 s on an assertion instead of Playwright's 5 s, and polls the class form's mat list, which follows a refresh. Earlier runs on this branch failed on exactly those waits; no product change was needed for them.

## 7. Found on the way

| Finding | What was done |
|---|---|
| The full unit run found the retention test's fake database had no `mat` table, and no journey in the manifest named the six new routes | fake gains `mat`; manifest J85 (`c6ba84e3`) |
| Three classes typed "Mat 1", "mat 1" and "MAT 1" (one each): the tie went to "MAT 1", and the suggestion list and adopting each had their own copy of the rule | one `commonestSpelling()` for both, preferring mixed case, then lower, then capitals (`2df573a5`, `ac2c6b2e`) |
| A class edit's `class.updated` audit row is written after the response, best effort; the Undo database tests read it straight away | the tests wait for the rows they undo |
| `tenant-restore-purge-race` times out (three tests, as both roles) | **not caused by this PR**: it fails identically from PR 1's worktree, whose code does not touch the purge; whether it fails on `main` today was not established; it needs its own look |

## 8. Deviations from the plan, recorded

- "Add these as mats" skips classes that only exist as imported history (they are never on a timetable).
- Undo takes the mats lock whenever its batch touches a class, not only when a mat is involved.
- The hint under the split control has no second "Mats" button (Appendix B10).

## 9. Not verified

- The migrations on production; Sean's real typed places (Noe can check production for them before this merges).
- The six mat actions in the Activity feed (the Activity PRs are unmerged).
- Browsers other than Chromium.
- `tenant-restore-purge-race` (§7).
