# Lane F3 (close review R3's F2/E3/S residuals + SF-102 harness) — iteration 2, 9–10 Oct 2026 (saved by the coordinator from the hand-back)

All seven items done, red→green proven. Nothing staged/committed/pushed; no production. Node v24.21.0. HEAD 035f484 at start, 52e3036 at hand-back (no F3 file touched by those commits). Fresh-checkout worktree removed; TEST export and restore directories deleted. Evidence: this directory (14 files).

## Files
Modified: scripts/readiness/{restore-verify,backup-export,backup-restore,coverage-reconcile,secret-scan}.mjs; tests/setup-test-db.ts; tests/unit/readiness-scripts-release-verify.test.ts; tests/unit/sec-f2-coverage-reconcile.test.ts (appended); release-verify.mjs unchanged. New: tests/unit/sec-f3-restore-verify-catalogue, sec-f3-secret-scan-residuals, sec-f3-setup-test-db-secret; tests/integration/sec-f3-signing-secret-db; evidence/F3/tamper-classes-f3.mjs + logs. Out of scope (accepted by the coordinator): tests/unit/sec-e-secret-scan.test.ts — one SYNTHETIC row for the new rule (its "every declared rule has a synthetic case" cell fails without it) and three triaged fingerprints in KNOWN_FIXTURE_FINGERPRINTS with reasons.

## SF-96 restore-verify fingerprint
New sections: role and database settings for every role (values digested); database owner and ACL; every non-system schema; views, materialised views, sequences, foreign tables and non-public tables; rewrite rules; column grants (pg_attribute.attacl); pg_default_acl; functions in every non-system schema. Runs with search_path = public; compare fails on any difference and when a section exists on one side only. backup-export records the raw globals; backup-restore replays them (default privileges last). Unit catalogue cells 15 fail → 17/17; R3-5 tamper classes on the PGlite copy 1/7 (HEAD, the view only, incidentally) → 7/7; R3 follow-ups 2/3 → 3/3; F3 extras 0/13 → 13/13; F2 controls 10/10; sec-f2-restore-verify-compare green. The one R3-listed case that never runs is a circular role grant Postgres refuses (R3 got the same error).

## SF-95 line endings
backup-restore replays the line-ending variant (as checked out, LF or CRLF) whose sha256 matched the source checksum; the summary records the variant per migration. Fresh `git worktree add` (autocrlf): HEAD FAIL "function changed: matflow_lowercase_email()" → RESTORED-AND-VERIFIED, compare PASS before and after revocation (83 migrations replayed as LF, 17 as checked out). Same worktree with every migration converted to LF: HEAD dies on the 20260531000001 checksum → RESTORED-AND-VERIFIED (11 replayed as CRLF). Drill 53 tables / 115,619 rows; export 29.9 s; restore to verified 17.6 s; revocation 598 users, 3,937 members, 1 operator.

## SF-97 coverage-reconcile
Reviewer check negation-aware; the LAST approval word in the cell decides. N/A rows with an empty, dash or placeholder evidence cell fail (naWithoutEvidence). Unit 15 failed of 37 → 37/37. Real matrix --findings-strict --require-reviewed: exit 0 RECONCILED; all 96 classifications identical to HEAD; fixedCountedAsPass 13; naWithoutEvidence empty.

## SF-94 release-verify test
Passes --vercel-project explicitly; four new cells against a temporary repo root (file present, absent → fails closed, malformed id). Clean worktree without .vercel/: HEAD 2 failed of 59 → 63/63; main tree 63/63.

## SF-82 secret-scan residuals
Names case-insensitive; new rule generic-secret-assignment (any name ending _PASSWORD/_PASSWD/_SECRET/_TOKEN, any non-empty value, quoted anywhere, whole env/YAML line, or tight NAME=v); placeholder test on the captured value (references a.b, $X, %X% not findings); a marker inside a single token (R3's "example" plant) no longer downgrades. Unit 16 failed of 33 → 33/33; every E/E3 negative control green. Re-scan by rule only: --tree candidates 5 → 8; --history 15 → 24 (generic rule tree: 3 candidate / 40 literal / 54 placeholder; history: 9 candidate / 180 literal / 107 placeholder); the 9 new history candidates: seed-demo-rich 2 blobs, pending-activation-enrolled-owner test 3, readiness-scripts-owner-login-change test 2, older stripe-subscription-confirmation-secret test 2; other rules unchanged. The CLI --tree still exits 1 (no allowlist; counts the 5 documented fixtures) — already red at HEAD, so the CI step in security-supply-chain.yml fails as it stands.

## SF-102 empty signing key (harness part)
When TEST_DATABASE_URL is set and both secrets are unset or empty, setup-test-db sets a random 64-hex AUTH_SECRET and prints one SYNTHETIC line to stderr (vitest swallows setup-file stdout); a configured secret is never touched. Unit 3 failed of 6 → 6/6; sec-f3-signing-secret-db 2 failed both roles with HEAD's setup → 2/2 both roles; sec-d-attendance-misbinding-db 23/23 both roles before and after. D3's empty-key HMAC refusal cell still owed by D3.

## Decisions for the reviewer to challenge
1 `literal` classification: generic-rule values that look human-written in non-config source files are listed and counted but do not fail the run (random-looking values, and any value in env/YAML/TOML/Dockerfile, stay candidate) — without it the tree test fails on ~44 test fixtures. 2 Reviewer cells: last approval word wins ("R3: NOT APPROVED; R4: approved" → approved). 3 SF-102 applies only to database runs. 4 The restore creates a cloud_admin NOLOGIN placeholder role to replay Neon's platform default privileges (reported under placeholderRoles).

## New finding
scripts/seed-demo-rich.mjs hard-codes DEMO_PASSWORD (16 chars, random-looking, fingerprint b94e8093ff12); every account the seed creates gets it and the seed prints it each run. Any database the seed ran against has a committed login password; whether a production demo tenant was seeded is UNVERIFIED from here. Fix: take it from the environment or generate per run, then rotate the seeded accounts. Medium if a production tenant was seeded, Low otherwise. Fingerprint allowlisted in the sec-e tree test with "NOT a fixture… drop once fixed".

## Also observed (TEST, 9 Oct ~21:17 UTC)
TEST carries default privileges set outside any migration (neondb_owner→matflow_app arwd on tables, rU on sequences; cloud_admin→neon_superuser its own defaults) and database grants to neon_superuser; a --no-privileges dump loses all of these (adds to SF-77); the drill now replays them from the manifest.

## Gates (Node v24.21.0)
tsc 0; lint 0; 15 unit files (sec-f3-*, sec-f2-*, sec-e-*, sec-e3-*, sec-r-*, readiness-scripts-release-verify) 293/293, re-run after HEAD moved to 52e3036. Not run / BLOCKED: Neon-level restore (no credential); live extension tamper (PGlite has none); role settings scoped to other databases deliberately excluded.
