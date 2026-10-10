# Lane E5 — saved by the coordinator as REPORT.md (identical to E5-option-b-assembly.md, the lane-written copy)

# Lane E5 — option B (minimal containment patch) assembled in isolation, plus option B+

Date 2026-10-10 (UTC 08:15–09:35). Runtime: Node v24.21.0 (campaign binary) for every step. Base: admin-hub candidate `2a6487e`.
Scratch worktree `<scratchpad>/security/E5/wt` on local branch `option-b-assembly` (never committed, never pushed); real copy of node_modules
from the main tree (`npm ls --depth=0` exit 0, six optional wasm packages extraneous as in the main tree); `.env.test` copied for the guarded runners.
Main working tree not touched except this evidence folder. No production access, no secrets in any file here.

## 1. Option B — final file set (whole files via `git checkout <commit> -- <path>`; every one is byte-identical to `23af42b`)
Requested: `lib/prisma-tenant.ts` (d4ea9fc) · `app/api/members/[id]/route.ts`, `app/api/staff/[id]/route.ts`, `app/api/member/children/[id]/route.ts`,
`app/api/admin/dsar/erase/route.ts`, `lib/attendance-import.ts` (1c4d242) · `app/api/blob-image/route.ts`, `app/api/auth/totp/verify/route.ts`,
`app/api/member/totp/verify/route.ts`, `app/api/members/[id]/hold/route.ts` (ebd761d) · `lib/auth-secret.ts`, `lib/token-hash.ts`, `lib/key-contexts.ts`,
`lib/pending-tenant-cookie.ts` (03ef584) · `app/globals.css`, `.vercelignore` (9f573ff) · `package.json`, `package-lock.json`, `.nvmrc`,
`.github/workflows/ci.yml`, `scripts/readiness/**` (17 files) (23af42b).
Forced source additions (compile errors, tsc-1/tsc-2 logs):
- `lib/auth-pending-gate.ts` (75da8b5) — both TOTP verify routes import `refuseRevokedPendingToken` (TS2307).
- `lib/session-revocation.ts` (75da8b5, the A2 version) — auth-pending-gate passes `tenantId` to `checkSessionVersion` (TS2353).
- `lib/importers/attendance.ts` (1c4d242 = 0964571 = HEAD) — attendance-import needs `cuidCreatedAt`, `RosterMember.addressChangedAt`, `releasedBy` (TS2305/2339/2353).
  Decision: included (one file, no further imports); the deletion-route set was kept.
Forced test additions (whole files, HEAD versions): `tests/setup-test-db.ts` (03ef584; three pins import its exports), `tests/unit/sec-c4-allow-rate-limit.ts`
(9f573ff; helper), `tests/unit/import-attendance-route-fake.ts` (b3e6f38; fake lacked `$queryRaw` used by the new attendance-import), and the HEAD versions of
11 pre-existing tests the same commits had updated (dsar-erase-audit-durability, dsar-erase-completeness, import-attendance-route, import-attendance,
import-matching-after-contact-change, member-delete-photo-blobs, member-delete-stripe-cancel, readiness-scripts-release-verify, session-revocation,
staff-last-owner-guard, totp-verify-single-use). Pins: the 20 listed sec-* files. Full manifest: `optionB-files.txt` (74 paths). No code edited.

## 2. Option B — gates (Node v24.21.0)
- tsc: exit 2 (9 errors) → exit 2 (1) → exit 0 after the three forced files; final tree exit 0. Lint: exit 0 (final tree).
- Unit, full suite: first run 15 files / 105 tests failed (stale base tests); final tree **exit 1: 21 failed | 5139 passed (5160), 419/423 files**. All 21 are outside B:
  sec-c2-request-validation 15 (only `/api/auth/totp/setup`, `/api/member/totp/setup`, `/api/admin/import/uploads` — not in B); sec-e3-upload-limit-input-pixels 3
  (`/api/upload` not in B); sec-f2-coverage-reconcile 1 (needs `docs/security/COVERAGE-MATRIX.md`); sec-r-skip-gate-expected-files 2 (needs
  `tests/integration/sec-f-pool-exhaustion-db.test.ts` on disk). The four B routes' request-validation cells: 29 passed | 29 skipped, exit 0; blob-image 15/15.
- DB, both roles (guarded copies of att/run-engine.sh and q78/run-restricted.sh, ep-hidden-salad only):
  sec-b2-stale-bypass-db 6/6 owner, 6/6 restricted · sec-d3-deletion-race-db 8/8, 8/8 ·
  **sec-d2-deletion-provenance-db 14/16 owner, 14/16 restricted, exit 1** — both failures are the members-import rollback release path
  (`app/api/admin/import/[id]/rollback/route.ts`, changed in 3be9490, not in B): no release digest recorded; a planted back-dated record inherits the released holder's history.
  Probe: adding that one file (3be9490) → tsc 0 and 16/16 under both roles; probe reverted, not part of the build below.
- `npm run build` from an empty `.next`: exit 0, Next.js 16.3.8, **BUILD_ID `cd98_g8m2mGUpcaoI7wr-`**.

## 3. What B carries beyond its stated scope (by the commits' own content)
TOTP verify routes carry A2's pending-token revocation gate (503 + Retry-After when revocation is unknown — part of the "503 outage mode" §6 says stays out);
`lib/session-revocation.ts` (75da8b5) now refuses non-integer token versions and tenant mismatches (base auth.ts still keeps the token on "unknown");
`lib/attendance-import.ts` carries lane D's seven commits including the D3 provenance MAC (§6 says the MAC stays out), so the
"pre-provenance decisions fall back to pending" behaviour ships with B.

## 4. Option B+ (B + AH-G7 at ab5f928: session-revocation.ts, auth.ts, proxy.ts, app/api/auth/[...nextauth]/route.ts)
- At ab5f928, proxy.ts and the nextauth route are identical to 2a6487e; only auth.ts (+38/−5) and session-revocation.ts (+61/−24) differ.
- Pure base + the four files: tsc exit 0, **no further files**. Unit sec-a-revocation-fail-closed passes; base `tests/unit/session-revocation.test.ts`
  fails 1 ("REPORTS the failure, because revocation is failing open") — ab5f928 updated it. DB sec-a-revocation-fail-closed-db 6/6 owner, 6/6 restricted.
- Full B+ (B patch, then the four files at ab5f928 replace B's 75da8b5 session-revocation; plus both revocation tests and session-revocation.test.ts at ab5f928):
  tsc 0, lint 0; unit exit 1: 21 failed | 5186 passed (5207) — the same 21 out-of-scope cells, nothing new; pinning files 15/15, 247 tests;
  DB both roles: revocation 6/6, 6/6 · b2 6/6, 6/6 · d3 8/8, 8/8 · d2 14/16, 14/16 (same rollback gap). Build exit 0, **BUILD_ID `8sVbrnp8yf_mp9Ia0W-SD`**.
  B+ does not need lane A's later auth.ts.

## 5. Verdict
Option B **builds and lints on its own after three forced source files**, but does **not** pass its own pinning tests as specified: the D2 deletion-provenance
test fails 2/16 under both roles because the members-import rollback route is missing. B + `app/api/admin/import/[id]/rollback/route.ts` (3be9490) is the
smallest set that went green on every listed pin and DB file. B+ adds AH-G7 cleanly (no further files) with the same single gap.

## 6. Clean-up
`git worktree remove --force` failed: "Filename too long". Git deregistered the worktree (no `.git`, not in `git worktree list`), `.env.test` and `.next` are gone,
but source files and node_modules remain at `<scratchpad>/security/E5/wt`. Stopped as instructed — not deleted another way. Branch `option-b-assembly` (at 2a6487e,
no commits) remains. Patches: `<scratchpad>/security/E5/optionB.patch` (sha256 6479…22ff9), `optionBplus.patch` (sha256 050d…72b6).
Evidence: `summary.txt`, `optionB-files.txt`, `optionBplus-files.txt`, `logs/` (sanitised).
