# Review R3 (lanes A2, F2, E3, S; iteration 2), 9 Oct 2026, ~19:00–21:05 UK

I reviewed SHA af803d5 (committed tree only) in a scratch worktree. HEAD moved to 15bd0c8 during the review and that commit was not reviewed. Every run used Node v24.21.0. Database work ran on the TEST branch (ep-hidden-salad) only, through R3 copies of the guarded runners, under both roles. Nothing touched production, and nothing was applied, pushed or deployed. The SF-57 SQL ran only in a disposable PGlite restore. Fixtures used the prefix secR3-: 0 tenants and 0 members were left on TEST. The row-data exports were deleted and the worktree was removed. The evidence is in this directory (probe scripts carry a .txt suffix).

## Verdicts
| # | Item | Verdict |
|---|---|---|
| 1 | A2 test runs | DB tests passed under both roles. The unit suite has 1 environment-dependent failing file (finding R3-1) |
| 2 | SF-44 | APPROVED |
| 3 | SF-35 / SF-59 | SF-35 NOT APPROVED (oracle remains); SF-59 APPROVED WITH RESIDUALS |
| 4 | SF-37 | APPROVED |
| 5 | SF-36 interim | APPROVED; the proposal has residuals |
| 6 | Login copy | Residual (see 6) |
| 7 | SF-57 v2 SQL | APPROVED as a proposal (unapplied) |
| 8 | Restore drill and fingerprint | APPROVED WITH RESIDUALS (R3-4 and R3-5) |
| 9 | coverage-reconcile | APPROVED WITH RESIDUALS (R3-6) |
| 10 | E3 | APPROVED WITH RESIDUALS |
| 11 | S | APPROVED WITH RESIDUALS |

## 1. A2 runs
- **DB tests (5 files):** owner 29/29 and restricted 29/29, both exit 0.
- **Full unit suite (repository config):** 450 files and 6133 tests; 6131 passed and 2 failed, exit 1.
- **The failing file:** both failures are tests/unit/readiness-scripts-release-verify.test.ts. The script reads the untracked .vercel/project.json, so the test fails in a clean checkout (and therefore in CI). With that file copied in, it passes 59/59. This is finding R3-1 (Low: non-hermetic test).
- **The 15 files A2 reported failing all pass now:** the 13 companion files, sec-a2-proxy-outage-cookie (13/13) and sec-c-csrf-sweep (424/424).

## 2. SF-44
**Mutants (file restored from git after each; all killed):**
- No revalidateSince stamp → 6/13 red.
- No 24 h bound → 1/13 red.
- Proxy clears the cookie on unknown → 6/13 red.
- An Edge pass deletes the marker → 1/13 red.
- Support resolver failure kept as "unknown" instead of ending the session → support-carrier-jwt "any binding failure ends a carrier session" red. The support path still returns null.

**Can the 503 path bypass authentication? No.** `auth()` returns null for an unusable session. Every route that reads the cookie with getToken calls `auth()`/requireApiStaff first, or runs the pending-gate revocation check. Those routes are account/profile, auth/set-password, auth/totp/setup, member/totp/setup, auth/totp/verify, member/totp/verify and admin/impersonate (operator gate). No jwt trigger "update" path exists. POST /api/auth/session returns `{authUnavailable}` with no user. The routes outside the matcher authenticate themselves. Public-prefix routes reach `auth()` and get null.

## 3. SF-35 / SF-59 (evidence: oracle-*.json and zz-r3-lockout-oracle-db.test.ts.txt; real bcrypt cost 12; identical request shapes)
**Response codes are identical at 0, 9, 10 and 11 prior failures under both roles:** refused at 0 and 9, rate_limited at 10 and 11.

**R3-2 (Medium, reproduced under both roles): a lock-state and existence oracle remains.** An account row-locked by "Wasn't me?" or by an operator answers 12×refused. A non-existent address answers 10×refused and then rate_limited. The cause is in auth.ts: a rowLocked attempt returns null before recordFailure, so a locked address never reaches the cap. This contradicts A2's claim that a locked row "answers exactly like a wrong password".

**R3-3 (Low–Medium): a timing difference on wrong passwords.** A wrong password for an existing account runs an extra withTenantContext transaction to increment failedLoginCount.
- On this link the measured differences were +262 ms (0 failures) and +251 ms (9 failures) as owner, and +205 ms and +263 ms restricted. That is about 5 round trips at a 45–55 ms round-trip time.
- At 10 and 11 failures (blocked) the differences were +6 / +62 ms (owner) and −11 / −9 ms (restricted).
- In production the round trip is about 1–2 ms in-region, so the gap is a few milliseconds. It is still averageable.

**Mutants:**
- Count failures against the row instead of the address: DB 2/5 red.
- Let "false" turn the throttle off on Vercel: 2/31 red.
- **Skip the known-device lookup for non-existent addresses: SURVIVES.** Unit tests 30/30 and DB tests 5/5 stay green. My timing probe on this mutant was inconclusive because the machine was loaded (+36 ms at 10 failures, +141 ms at 11). No test pins the equal-cost path.

**HMAC keys and the RateLimitHit table:**
- The HMAC uses the server secret (AUTH_SECRET). lib/auth-secret throws at import in production if the secret is absent.
- RateLimitHit has no tenant column, and its buckets hold `authfail:<kind>:<40-hex HMAC>`, so neither the address nor the club leaks.

**What removing the per-address limit changed:**
- **Guessing budget:** an attacker rotating /24s now gets at most 10 failures per hour per address in total (address cap; blocked attempts are not counted). A single IP is held to 30 attempts per 30 minutes across all addresses. The old budget was a row lock after 10 failures plus 20 attempts per hour, so guessing is not worse.
- **New residual:** blocked attempts still run bcrypt at cost 12, so a distributed source can force unbounded hashing against one address. This is bounded only per IP; the old per-address limit capped it.
- **Lockout lever:** with 10 requests an hour an attacker caps every new-device sign-in for an address. Known devices are unaffected.

## 4. SF-37 (all mutants killed)
- GET performs the disown → 3/8 red.
- POST without the same-origin check → sec-c-csrf-sweep 2/424 red.
- Bypass allowed when E2E_AUTH_BYPASS=true and VERCEL=1 → 1/29 red.
- Bypass enabled by a header with no flag → 4/29 red.
- The positive control passes.

## 5. SF-36
**Interim refusal.** Removing the link check sends 3/6 tests red: member, staff, and "club cookie not consumed". With the check in place the sign-in lands on google_link_required with no token and no login event.

**Proposal residuals:**
- ExternalIdentity.tenantId is not bound to the account's tenant. It needs composite foreign keys (userId, tenantId) / (memberId, tenantId), or a trigger.
- Unlinking on password reset or revoke-access is only "recommended". It should be required.
- The seam sits after the email lookup, so a filled-in link store would still need an email match. That contradicts the proposal's "same sub, different email admitted"; the lookup must be by sub.
- The Google door still separates NoAccountForGym from google_link_required. Only the mailbox owner can see this (Low).
- The Google-path login event takes its IP from the first x-forwarded-for entry, which the client controls.

## 6. Login page
- account_locked has no producer any more, but `urlErrorMessage` still renders a crafted /login?error=account_locked as "This account is temporarily locked…".
- rate_limited still says "a few minutes" for a window of up to an hour.
- google_link_required shows nothing.

## 7. SF-57 v2 (PGlite restore of a fresh TEST export with the SQL applied; every case rolled back)
**As matflow_app, all refused:**
- UPDATE of any column (including userId to NULL): 42501.
- DELETE, TRUNCATE and upsert (ON CONFLICT DO UPDATE).
- DISABLE TRIGGER ("must be owner").
- CREATE OR REPLACE of the function (no CREATE on public).
- `session_replication_role = replica`.
- Purge with batch 0 or 1,000,000 (22023).
- GRANT to itself: notice "no privileges were granted", and the ACL is unchanged.

**Back-dating fails for matflow_app.** A back-dated INSERT is stamped now(). A temporary audit_log_is_table_owner() combined with a pg_temp-first search_path is still stamped now().

**Purge minimums are correct with planted ages.** Deleted: ordinary at 366 d, admin.* at 2191 d, actingAs at 2191 d, and memberXdsar_erase (so there is no LIKE wildcard). Kept: ordinary at 364 d, admin.* at 366 d, dsar_erase and dsar_erase* at 366 d, actingAs (including JSON null) at 366 d.

**As the owner:**
- Refused: content UPDATE and TRUNCATE (by the trigger), and `session_replication_role`.
- Succeeded: userId → NULL, DELETE, back-dated INSERT, DISABLE TRIGGER, function replacement and CREATE in public.
- **Plainly, the owner can do anything.**

## 8. Restore drill
**Export.** backup-export on TEST (REPEATABLE READ, read-only) exported 53 tables and 116,136 rows in 33 s, including 6 JSON nulls in User.totpRecoveryCodes.

**Restore.** The restore reached RESTORED-AND-VERIFIED with compare PASS before and after revocation (591 users, 3,988 members, 1 operator). The JSON-null fix is confirmed. It passed **only** with the main tree's migration bytes; two other checkouts failed:

| Checkout | Result |
|---|---|
| Fresh checkout, core.autocrlf=true | FAIL: "function changed: matflow_lowercase_email()" |
| LF checkout | Dies: "checksum of 20260531000001_member_lifecycle_indexes differs" |

This is **R3-4** (Low; the result fails closed). backup-restore accepts the checksum of the LF-normalised text but replays the raw bytes, and it never tries the CRLF variant. The fix is to replay whichever variant matched the checksum.

**Refusals all exit 2:** a production URL (with either expectHost), an in-repo output directory (including an upper-cased path), PGOPTIONS, and ?options=.

**Tampering.** Every class F2 lists FAILS the compare, 22 cases in all. Extensions were checked by a pure compare because PGlite has no installable extension.

**R3-5 (Medium): seven tamper classes are NOT caught.**
- `ALTER ROLE matflow_app SET app.bypass_rls='on'`. This turns off RLS for every runtime session, because the policies read that setting.
- The same setting via ALTER DATABASE.
- A rule on AuditLog: `ON INSERT DO INSTEAD NOTHING`.
- A column grant: `UPDATE(action)` on AuditLog.
- ALTER DEFAULT PRIVILEGES.
- An owner-created view over User granted to matflow_app.
- A function in another schema combined with a role search_path.

## 9. coverage-reconcile (R3-6, Low)
**Classified as F2 claims:**
- A raw pipe → malformed, and the run FAILs.
- "A / B" → BLOCKED.
- A FIXED row marked "reviewed" → FIXED AWAITING RETEST.
- N/A + PASS → inconsistent.

**Wrongly accepted:**
- An N/A row with empty evidence (the evidence cell is never read).
- A reviewer cell reading "not yet approved" or "approved? no", which counts as approved (a FIXED row then counts as PASS).

## 10. E3
**All R2 attacks are now refused:**
- **ops-blob URL forms:** duplicate or encoded sslmode, SSLMODE, prefer, host, h%6fst, hostaddr, options and endpoint.
- **Environment variables:** PGSSLMODE (any case), PGOPTIONS, PGHOST and PGPASSWORD.

**Fingerprint script:**
- Six argument shapes leaked neither the value nor any 8-character substring of it.
- Quoted, single-quoted, unquoted+comment, `export` and `#`-in-value env lines all MATCH.
- `--env-file`: with a missing file, Node itself exits 9 and prints the path (outside the script's control); with an existing file the script exits 2.

**secret-scan.** Every R2 miss is now caught, and the R2 negative controls are unchanged. New misses:
- A lower-case operator_password.
- SMTP_PASSWORD (or any other *_PASSWORD).
- A Neon password containing the word "example" is downgraded to placeholder.

**skip-gate.** It fails closed on every glob that matches nothing, on brace globs and on case mismatches.

**db-target.** It refuses the look-alike endpoint, foreign-domain suffixes, another region and a trailing dot. It accepts the real .env.test URLs (3).

**Deviation proven inert.** A URL with sslmode=require builds an explicit config (no connectionString) with rejectUnauthorized true and the servername set. Against a local self-signed server it fails with DEPTH_ZERO_SELF_SIGNED_CERT, including with NODE_TLS_REJECT_UNAUTHORIZED=0. The control, sslmode=no-verify through a connectionString, completed the handshake.

## 11. S
**The check passes.** `--require-all` PASSES. S's 7 negative controls and my 12 fail for the planted reasons. A non-existent CWE passes with the mapping check off, because there is no CWE source (documented by S).

**Sample of 20 rows (SEC-001 … SEC-096, every 5th):** 18 fit and 2 are stretched. Both stretched rows are already graded "partial" by S, with a note.
- SEC-016: V8.2.1 is generic function-level access cited for session puzzling.
- SEC-026: V1.1.1 is about decoding canonicalisation, not identifier normalisation.

**Matrix columns.** Between 3bb4fb5 and af803d5 there were 0 cell changes outside the last column. The header and all non-row lines are identical, and all 96 rows changed only in Standard refs.

## 12. Gates on af803d5 (Node v24.21.0)
| Gate | Result |
|---|---|
| `npm run lint` | exit 0 |
| `tsc --noEmit -p .` | exit 0 |
| `npm run build` | exit 0 (migrate skipped, no DB URL) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Unit suite | 450 files / 6133 tests, 2 failed (R3-1), exit 1 |

The build first failed only because Turbopack refuses a junctioned node_modules ("Symlink [project]/node_modules is invalid, it points out of the filesystem root"). I re-ran it with a real copy.

## 13. Refusals, items not run, and owed work
**Refusals:** no permission layer refused anything.

**Not run:**
- The browser pass.
- A Neon-level restore (no credential).
- A live extension tamper (PGlite has no installable extension).
- A conclusive timing probe for the surviving mutant (the machine was under load).

**Owed, in order:**
1. **SF-35 (A2):** count wrong passwords on row-locked accounts exactly as on any other address. Adopt zz-r3-lockout-oracle-db as the regression test.
2. **SF-35 (A2):** make the failure path cost the same (row counter in after(), or equal work for an address with no account). Pin the known-device lookup for non-existent addresses with a query-count test.
3. **Login copy:** remove the account_locked URL case, fix the rate_limited wording, and add copy for google_link_required.
4. **R3-4:** backup-restore must replay the checksum-matched variant. Re-run the drill from a fresh checkout.
5. **R3-5:** add the missing classes to the fingerprint: pg_db_role_setting, pg_rewrite, attacl, pg_default_acl, views, matviews and sequences, and non-public schemas.
6. **R3-6:** make the reconcile reviewer check negation-aware, and require evidence on N/A rows.
7. **SF-36 proposal:** tenant-bound composite foreign keys, mandatory unlink on reset or revoke, and lookup by sub.
8. **R3-1:** make the release-verify test hermetic.
9. **secret-scan:** case-insensitive names and a generic *_PASSWORD rule.
10. **SF-57:** applying it still needs Noe's approval.
