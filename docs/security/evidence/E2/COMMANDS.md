# Lane E2 commands, exit codes and runtimes (9 Oct 2026, UTC)

Machine: developer Windows 11 laptop. Vercel CLI 59.1.4 ran on the local Node 25.9.0 (EOL, ADV-11) — CLI calls are
read-only observations, not gate evidence. Tests and scripts presented as evidence ran on **Node v24.21.0** (the
lead's binary in `<scratchpad>/security/node24/`). Raw outputs stay in `<scratchpad>/security/E2/`.
Git Bash rewrites a leading `/v9/...` argument into a Windows path; `MSYS_NO_PATHCONV=1` was set for `vercel api`.

| UTC | Command (read-only unless stated) | Exit | Note |
|---|---|---|---|
| 17:28:10–17:28:58 | `vercel ls matflow --prod --format json [--next <cursor>]` ×4 and the same without `--prod` ×4 | 0 ×8 | 64 / 64 rows |
| 17:29:18 | `node <scratch>/recon.cjs` (diff against the lead's inventory; `git merge-base --is-ancestor ed3e146 <sha>` per deployment) | 0 | 0 added, 0 removed, 0 SHA mismatches; 64/64 contain ed3e146 |
| 17:29:32 | `vercel alias ls --format json` | 0 | 14 aliases |
| 17:29:36 | `vercel inspect <serving url> --format json` | 0 | 581 functions, all `nodejs24.x` |
| 17:29:52–17:30:35 | `vercel inspect <dpl id>` for the 10 branch-alias targets | 1 ×10 | "Can't find the deployment" ×10 |
| 17:30:52 | `vercel inspect <serving url> --logs` (raw log kept in scratch; redacted extract in this folder) | 0 | 379 lines; no secret-shaped string (scan of route names only) |
| 17:31:56 | `vercel env ls --format json` piped through a filter that drops `value` before anything is written | 0 | 19 entries |
| 17:35:43 | `node <scratch>/dns.cjs` (Google DoH; no request to MatFlow hosts) | 0 | 15 queries |
| 17:36 | `vercel project inspect matflow` (secret-like lines filtered) | 0 | Node 24.x, default install command |
| 17:37:02 | `vercel api /v9/projects/matflow --raw` piped through a field picker (protection, retention, crons, link; env dropped) | 0 | — |
| ~17:37 | `vercel api /v2/teams --raw` (plan + role only) | 0 | hobby / OWNER |
| ~17:38–17:39 | `gh api` repo, `branches/main/protection`, `rulesets`, `secret-scanning/alerts` (open, resolved; value fields not selected), `actions/runs` | 0 / 404 for protection | see CONTAINMENT-CHECKLIST O7 |
| ~17:40 | `vercel api /v1/storage/stores --raw` (ids fingerprinted in the pipe). One earlier attempt with stderr merged printed the first ~300 characters raw: a store id and the team id (identifiers, not credentials); repeated correctly | 0 | 3 stores |
| ~17:41 | `git show fa3c460:<doc> \| node <extract> \| node scripts/readiness/ops-credential-fingerprint.mjs --stdin` (positive control; values piped, never printed) | 3 | 4 × MATCH (neon-password, resend-api-key, cron-secret, stripe-key-prefix) |
| ~17:41 | `printf '<synthetic>' \| node scripts/readiness/ops-credential-fingerprint.mjs --stdin` (negative control) | 0 | no match |
| ~17:43 | `node24 scripts/readiness/ops-blob-host-count.mjs .env.test ep-hidden-salad TEST_DATABASE_URL` | 0 | TEST pooler; 451 columns; 0 blob references; no RLS warning (owner role) |
| ~17:43 | same with `RESTRICTED_DATABASE_URL` | 0 | 451 columns; RLS warning names 47 tables — the undercount caveat works |
| ~17:43 | same with expected host `ep-bold-wave` against the TEST URL | 2 | `REFUSED: host does not contain ep-bold-wave` |
| ~17:44 | `node24 <scratch>/sqlre-control.mjs` (the script's SQL pattern on literal synthetic values, TEST, READ ONLY) | 0 | private ×2 (case-merged), public ×1, bare ×1, foreign-path URL not matched |
| 17:51:54 | `node24 node_modules/vitest/vitest.mjs run tests/unit/sec-e2-ops-scripts.test.ts tests/unit/sec-e2-mail-records.test.ts tests/unit/sec-e2-containment-redaction.test.ts` | 0 | 3 files, 27 tests (re-run after the final edits; REPORT.md write was refused by the harness, the hand-back message is the record) |
| ~17:53 | `python <scratch>/mutants.py` (8 mutants, each file restored; sha256 of every E2 file checked after) | — | 8/8 KILLED; restore check clean |
| ~17:55 | `node24 node_modules/eslint/bin/eslint.js` on the 2 scripts and 3 tests | 0 | — |
| ~17:55 | `node24 node_modules/typescript/bin/tsc --noEmit` filtered to E2 files | — | 0 errors in E2 files |
| ~17:56 | `node scripts/readiness/secret-scan.mjs --dir docs/security/evidence/E2` | 0 | 0 candidates |

Mutants: M1 synthetic Resend-shaped key planted in an evidence file; M2 `BEGIN READ ONLY` → `BEGIN`; M3 TLS guard
disabled; M4 URL-password form dropped; M5 DMARC stage 1 `p=reject`; M6 a second SPF on `send`; M7 CLI echoes the
value; M8 identifier quoting removed. All killed.
