# Review R7 — saved by the coordinator as REPORT.md (identical to REVIEW-R7.md, the reviewer-written copy)

# Review R7 — closing review of lanes A4 and C4 and the final candidate (iteration 2), 10 Oct 2026

Reviewed SHA 03ef584 (committed tree; lane A4 at 03ef584, lane C4 at 9f573ff). HEAD moved to 1417b86 during the review — docs-only after 03ef584 (`git diff --name-only 03ef584 1417b86` lists only docs/). Two detached scratch worktrees (wt: gates, sweep, probes; wtm: mutants, vectors, planted build), each with a robocopy of the real node_modules and a copy of .env.test; both deregistered and deleted afterwards. Node v24.21.0 on every run. TEST branch (ep-hidden-salad) only, through R7 copies of the guarded runners, both roles (neondb_owner; matflow_app with RLS_ENFORCED=1, role asserted in every R7 probe). Fixtures secr7a-/secr7s-/secr7k- plus R6's secr6*- prefixes; every teardown count-checked to 0. No production, nothing applied, pushed or deployed, no lane file edited. Evidence: docs/security/evidence/R7/ (scratchpad paths replaced by <scratchpad>).

## Verdicts
| # | Item | Verdict |
|---|---|---|
| 1 | SF-111 lockout reservation (A4) | APPROVED WITH RESIDUALS |
| 2 | SF-112 key separation (A4) | APPROVED |
| 3 | SF-113 store-failure fallback (C4) | APPROVED WITH RESIDUALS |
| 4 | SF-114 Tailwind sources + .vercelignore (C4) | APPROVED |
| 5 | Gates + both-role sweep on 03ef584 | PASS (1 unit timeout under load, green when re-run alone) |

A4 is APPROVED WITH RESIDUALS. C4 is APPROVED WITH RESIDUALS.

## 1. SF-111
R6's burst probe, verbatim: owner exit 0. Restricted run 1 failed in beforeAll (connect ETIMEDOUT/ENETUNREACH to the TEST endpoint, so no test ran); re-run exit 0. A second run of each role also exit 0. sec-a4-lockout-burst-db: 4/4 both roles (sweep).
R7 attack probe zz-r7-a4-attack-db, both roles, with pool 20 and with pool 5 (NODE_ENV=production), every run exit 0:
- R7-1, right password FIRST in a 40-way burst: admitted, 10 wrong verdicts, counter 10 (= wrong verdicts, so the success's slot was refunded).
- R7-2, right password first + 9 wrong: counter 9. The person signs in again from a fresh network: admitted, counter still 9, so they are not locked out by their own success. One more wrong: counter 10. Right password from an unknown network: rate_limited.
- R7-3, known device among 40 (index 39 and index 20): admitted every time; ≤10 wrong verdicts; counter = wrong verdicts.
- R7-4 / R7-4b / R7-5, network cap: 40 from the victim's /24 with the victim's browser family gives ≤10 verdicts. This holds both from a fresh address and with the address already at its cap, where every request is exempt at the read (R7-4b: 10 verdicts, pair counter 10). The known device on a capped network is rate_limited. Clearing only the network counter → admitted (positive control).
- R7-6, fail closed: the address advisory lock is held 13 s by another connection. 6 attempts, including the right password: all refused, 0 verdicts, 6 fail-closed errors ("A query cannot be executed on an expired transaction" / "Unable to start a transaction"), counter 0. After release, the right password is admitted.
- R7-7, saturation: 120 concurrent, right password last. Pool 20: 10 wrong verdicts, 47–49 fail-closed refusals. Pool 5: 10 verdicts, 64–68 fail-closed refusals. Never an admission outside a verdict; only generic answers.

Mutants (sha256 byte restore, tracked tree clean after each):
- MR1 refund ALL address rows: R7 probe 4 red; sec-a4-lockout-burst-db 2 red (refund, known); unit 1 red.
- MR2 burst re-check of the exemption removed: R7-3 ×2 red; unit 2 red.
- MR3 exempt request skips the pair cap: SURVIVED R7 probe v1 (the unlocked fast read masks it). Killed by the new cell R7-4b: 39 wrong + right admitted, pair counter 9. Not run against A4's own suites (owed).
- MR4 advisory lock removed: R7 probe 6 red; R6 probe red; unit 5 red.

Equal cost:
- sec-a3-failure-path-cost green in the full unit run. sec-a3-lockout-oracle-db 2/2 both roles.
- R6's oracle probe verbatim, 20 samples, both roles, exit 0: every shape gives codes identical to no-account at 0/9/10/11. Locked + right password from zero = refused ×10 then rate_limited ×2, identical to no account.
- Timing: owner account shapes −88..+104 ms against a ghost-vs-ghost floor of −49..+56; restricted −88..+145 against −160..+34. No shape moves consistently in one direction; the machine was loaded (sweep and mutants running), with medians around 1.3 s.

Residuals:
- SF-118 is now measured. Under a burst the real person's right password is fail-closed refused, and the refusal reads like a wrong password (`null`), not rate_limited. A held lock makes every attempt wait about 13 s.
- R7-4b (exempt-at-read + network cap) is not in A4's suite. Adopt it.

## 2. SF-112
R6's d3 probe, verbatim, both roles: 8 passed, 1 failed. R6-K1 now PASSES: status 200, equalsProvenanceSubKey=false, the decision does not bind. The only failure is R6-4b (tail truncation, D3's declared OPEN cell, SF-57 v2). At 5259d3b R6 measured 7 passed, 2 failed.

R7-K1 for each of the 4 registered contexts (provenance, kiosk, card, pending-tenant), through the real route with ENABLE_GOOGLE_OAUTH=true, both roles, 4/4:
- The cookie signature equals no sub-key.
- hashToken(any context) equals no sub-key.
- A kiosk token and a card token forged with the leaked bytes are refused; the real signers verify (positive control).
- The cookie reads back as its own slug.
- Teardown left 0 tenants with a context slug.

Vectors (zz-r7-vectors), under 4 root configurations: NEXTAUTH only, AUTH only, NEXTAUTH with a trailing newline (kept, so a distinct root), and both set. Computed with 5259d3b's lib/auth-secret.ts and lib/token-hash.ts, then with 03ef584's. Kiosk, card and attendance-import are byte-identical between the SHAs (`git diff` empty). The JSON files are byte-identical (`cmp`). They hold sha256(sha256(x)) of the root, the provenance/kiosk/card sub-keys, the provenance proof, sourceKeyDigest, the kiosk and card tokens, and hashToken(token) and hashToken(email); no key or token is written.

Mutants:
- MK1 cookie signed with the raw root: R7-K1 4 red, R6-K1 red, unit 8 red.
- MK2b hashToken context prefix removed: R7-K1 4 red, unit 4 red.
- MK2a cookie message prefix removed: DB probes green — equivalent for the leak, because HMAC(K_pending, slug) can equal no root sub-key and K_pending is never output. Killed by the unit format cell.

Code read: every remaining raw HMAC(root, x) signer either carries ':', '|' or '.<number>', or has a domain prefix. That covers the Stripe and Drive state, the disown token, the device hash, the operator session and the operator-id digest.

## 3. SF-113
R6's saturation probe, verbatim (R6_PROD_POOL=1, pool 5): 3/3 both roles.
sec-c4-rate-limit-saturation-db, 5/5 both roles:
- Security bursts 60/120 → 5 allowed, 5 rows.
- tenant-lookup bursts 60/120 → 5 allowed, 5 rows.
- One line per family per window, e.g. `[rate-limit] store unavailable reason=pool-timeout class=security family=secc4s60 outcome=refused windowMs=60000 suppressedSinceLast=0`, with no key in it.
- The second tenant-lookup burst in the same window logs 0 lines.

R7 probe zz-r7-c4-sat-db, both roles:
- A: R6's shapes → 5/5/5. One line in total (family "-"), no key.
- B: forgot:<email> burst 120 → 5 allowed, 5 rows, one fallback line with no key.
- D: a failClosed caller → 5 allowed, 44 thrown, one outcome=thrown line.
- C: two families saturated at once — first run FAILED my fairness assertion (see R7-N1).

Mutants (restricted, unless noted):
- MC0 old file (5259d3b) restored: R6 probe 2 red (10 allowed, 5 rows); C4 DB 4 red.
- MC1a security buckets answered from (seeded) memory: C4 DB 2 red, R7-B red, unit 4 red. R6's probe survives — equivalent for the count, since seeded memory still caps it.
- MC2 seed removed: C4 DB 2 red (the non-security cells); unit 4 red. The R6 and R7 probes survive, because neither has a non-security bucket.
- MC3 log removed: C4 DB 4, R7 3, unit 4 red.
- MC4 key logged as the family: C4 DB 4, R7 3, unit 3 red.

Fallback inventory, by grep:
- 82 checkRateLimit call sites. Every bucket starts with a literal `family:` (the multi-line ones checked by hand).
- Non-security buckets are exactly `tenant-lookup:${ip}` (app/api/tenant/[slug]) and `kiosk:classes:`. Everything else is security, plus 5 failClosed sites.
- This matches C4's inventory and its static test.

Residuals:
- R7-N1 (Low, availability, NEW): a burst on ONE security bucket refuses OTHER security buckets on the same instance. Cell C: totp:A got 5/60 and apply:B got 0/60 with 0 rows, both roles. C4's gap (b) says "that bucket's legitimate callers"; it is instance-wide for as long as the pool is saturated (Retry-After ≤30 s). It fails safe (before C4 it failed open). The fix is to stop holding a pooled connection while waiting on the bucket lock.
- R7-N2 (Low, privacy, pre-existing, C4 gap (a) confirmed): the over-limit warning logs the whole bucket. 5 and 3 lines carried the email in a 120-burst on forgot:<email>.

## 4. SF-114
R6's plant check with R6's plant file: tests/, scripts/readiness/, repo root, components/ and docs/ all compile (117,708 bytes, identical to no plant). Control with 5259d3b's globals.css in the same tree: RangeError Invalid code point 1885808 in tests/, scripts/readiness/, root and components/.

Real production build (`npm run build`, no database URL, so maybe-migrate skips) with the plant in all four places at once: exit 0, BUILD_ID 82Gw_Ji7MU6U7LP2PYmDK.

Class inventory (both css files compiled in the 03ef584 tree):
- 1002 → 978 classes, 24 removed, 0 added (C4: 24).
- No removed class appears as a class token in app/, components/ or lib/. The "blur" hits are inline `blur(` filter values.
- The gates build's CSS (2 files) contains all 978.

.vercelignore lists docs/, tests/, scripts/* with !scripts/maybe-migrate.mjs, and .omc/. Nothing the build needs is excluded:
- The build runs `node scripts/maybe-migrate.mjs && next build`; maybe-migrate imports only node:child_process.
- postinstall only runs prisma generate (prisma/ is kept).
- No @/scripts, @/tests or @/docs import, and no runtime file read under them, in app/, lib/, components/, next.config.ts, proxy.ts or auth.ts.

## 5. Gates (03ef584, Node v24.21.0)
- `npm run lint` exit 0.
- `npx tsc --noEmit -p .` exit 0.
- `npx vitest run tests/unit` exit 1: 467 files / 6468 tests, 1 failed. The failure is tests/unit/sec-c-csrf-sweep.test.ts › "/api/account/login-email as owner", which timed out at 30 s on the route's first dynamic import while the sweep and probes ran. Re-run alone: 426/426, exit 0.
- `npm run build` exit 0, BUILD_ID AAk3Mz2mm0dH7UYfSvAfh.
- `npm audit --omit=dev`: 0 vulnerabilities.

Sweep (exit code captured from the substitution, one file at a time): 30/30 exit 0. That is 15 files × 2 roles:
- sec-a2-* (5 files)
- sec-a3-lockout-oracle-db (2/2, 2400 s ceiling)
- sec-a4-lockout-burst-db 4/4
- sec-c3-rate-limit-atomic-db 6/6
- sec-c4-rate-limit-saturation-db 5/5
- sec-d2-deletion-provenance-db 16/16
- sec-d2-import-attacker-model-db 12 + 6 expected-fail
- sec-d3-deletion-race-db 8/8
- sec-d3-provenance-forgery-db 16 + 1 expected-fail
- sec-f3-signing-secret-db 2/2
- attendance-import-engine 19/19

## 6. Refusals, not run
Refusals: none from any permission layer.

Worktree removal: `git worktree remove --force` deregistered both worktrees but failed to delete them ("Filename too long" — a git error, not a hook). The directories were then deleted with PowerShell Remove-Item -LiteralPath on the literal \\?\ path, then `git worktree prune`. Recorded for the lead.

Not run:
- MR3 against A4's own unit and DB suites (the worktree was gone when the result was read).
- A production-mode page fetch (the class inventory was used instead).
- A browser pass.
- Anything in production.

## Owed, in order
1. A4: adopt R7-4b (address already capped + burst from the known network → ≤PAIR_MAX verdicts) into sec-a4-lockout-burst-db. Re-run MR3 (`pw.n < PAIR_MAX OR exempt`) against A4's suites; they did not cover it.
2. A4 / SF-118: a fail-closed refusal of a right password under a burst answers like a wrong password. Consider answering rate_limited for a reservation failure, and bound the 10 s wait.
3. C4 / R7-N1: a pool-saturating burst on one bucket refuses every security bucket on the instance. Wait on the bucket lock without holding a pooled connection (try-lock + retry, or a separate small pool).
4. C4 / R7-N2 (pre-existing): log only the family in the over-limit warning.
5. D3: tail truncation (R6-4b) stays on SF-57 v2.
6. Lead: review a2bc56a..1417b86 (docs-only, landed during R7).
