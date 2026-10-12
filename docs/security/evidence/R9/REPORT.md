# Review R9 — saved by the coordinator as REPORT.md (identical to review.txt, the reviewer-written copy)

Review R9 — lane M2 (SF-128, SF-129, SF-130) at 704ab57, 10 Oct 2026 (UTC 22:05–22:50)

Reviewed: committed tree 704ab57 only, two detached scratch worktrees (wt: gates + sweep, clean; wtm: probes + mutants),
node_modules robocopied (exit 1 = copied), .env.test copied. Node v24.21.0 on every run. TEST (ep-hidden-salad) only via
R9 copies of the guarded runners (run-owner-*.sh = neondb_owner; run-restricted-*.sh = matflow_app, RLS_ENFORCED=1); role
printed by the tool per run. Fixture prefix secr9-; leftover count both roles 0 (secr9- and secm1-). No production, nothing
applied/pushed/deployed, no lane file edited (mutants restored, sha256-verified, git clean after each), no secret or
password printed; address tags and run ids redacted in evidence. No gate-ON live retention sweep. No refusals.

| # | Item | Verdict |
| 1 | SF-128 lg-3 gate + reason token | APPROVED WITH RESIDUALS |
| 2 | SF-129 tool hardening + db-target | APPROVED WITH RESIDUALS (one real gap: project= prefix) |
| 3 | SF-130 literal-family static test + widened M1 cell | APPROVED WITH RESIDUALS |
| 4 | Gates on 704ab57 | lint/tsc/build/audit PASS; unit 6532/6534 (1 load timeout, passes alone); DB sweep see below |

1. SF-128. The spec never sets the gate (grep + diff read): it reads process.env through retentionGateOn (playwright
   loads .env.test with override; webServer inherits). No tracked env file carries RETENTION_CRON_ENABLED (.env.example,
   .env.test.example); the copied and the main-tree .env.test have none; the only setter is .github/workflows/e2e.yml job
   env, whose DATABASE_URL is the job's postgres:16 service (ephemeral). Planted responses (item1-sf128-probe.json): gate
   believed OFF → only 503 "retention cron disabled" passes; 503 "CRON_SECRET not configured", "Retention cron disabled",
   200 live, 200 dry-run-shaped, 401, 500, null body all fail with a reason. Gate believed ON → only a live 200 with
   dryRun false, retentionEnabled true and rules. Dry-run verdict: the REAL route's dry run passes gate off and on; 503s,
   a deletion, and a gate mismatch fail; 0 deleteMany/updateMany. Real route call lines differ only in the token:
   reason=disabled vs reason=not_configured. M2's tests 13/13; probe 6/6. Mutants: R9-M1 same reason for both → red
   (3 failed); R9-M2 matcher accepts /not configured/ → red; R9-M3 gate-off accepts 200 → red; R9-M6 literal dotted
   assignment in spec → red. SURVIVED: R9-M4 process.env["RETENTION_CRON_ENABLED"]="true" and R9-M5
   Object.assign(process.env,{RETENTION_CRON_ENABLED:"true"}) in the spec — the static "never sets the gate" cell is a
   regex for the dotted form only. Residuals: (a) that static cell is narrow (above); (b) the spec detects a server/spec
   gate disagreement only AFTER the live bearer call (test order: the bearer cell at spec line 161 runs before the dry-run
   cell; reuseExistingServer is true locally, so a server started with the gate on would sweep the shared TEST branch
   once, then the spec fails) — ask the server first (?dryRun=1 reports retentionEnabled) and refuse the live call on a
   mismatch; (c) lg-3 e2e itself still not run (needs CRON_SECRET in a server env; class-instances runs live on TEST).

2. SF-129. Real-filesystem attacks (item2-sf129-probe.json; decoy .env files with an unresolvable .invalid TEST-shaped
   URL under <scratchpad>/security/R9/envlab and a transient decoy at the worktree root; the repo's real .env never
   touched): .ENV, .Env, .eNV, ".env.", ".env ", ".env. .", .env::$DATA → refused by name; the 8.3 short name ENV~1
   (8.3 names ARE enabled on C: — the repo's own .env has ENV~1) → refused by real path; "<.env>\." and "<.env>/." →
   refused by real path; junction→dir then /.env, /.ENV, /ENV~1 → refused; hard link (direct and via junction) → refused
   by file identity; file symlink NOT CREATED (EPERM, no Developer Mode — same as M2; covered by the injected-resolver
   cell). Spawned tool, cwd = worktree, nine aliases → exit 2 with the .env refusal and no "target:" line; control
   (ordinary env file) reaches the host guard instead. --confirm without --ids → exit 2 "requires --ids", no target;
   --ids "" and "," refused. PGOPTIONS, PgOptions, pgoptions, pghost, pgsslmode → exit 2. db-target: endpoint= raw ($ and
   ;), %3D-encoded, %65ndpoint, Endpoint=, ENDPOINT%3D…%3B → all refused; through the tool exit 2, no target.
   FINDING R9-F1 (gap in the SF-129(c) fix): Neon's proxy accepts TWO password prefixes — parse_endpoint_param in
   neondatabase/neon proxy/src/auth/password_hack.rs strips "project=" OR "endpoint=" (fetched 10 Oct 2026 from the main
   branch). db-target refuses only endpoint=; project=<prod-id>$pw, project%3D…%24pw and project=…;pw on the TEST host
   are ADMITTED by resolveDbTarget and by the tool's vetTarget. Practical effect believed nil while TLS with SNI is forced
   (the proxy uses the password hack only when SNI gives no endpoint) — untested, same caveat R8 gave; refuse
   /^\s*(endpoint|project)=/i. FINDING R9-F2 (low): Node 24.21 scans argv for --env-file even AFTER the script name: it
   does not apply the file to process.env (marker absent) but OPENS it and exits 9 "<path>: not found" when it is missing
   or unreadable (proved with a deny-read ACL). So `--confirm --env-file <missing>` exits 9, not 2, and Node opens the
   named file before the tool's guard runs (content not applied). Rename the tool's option (e.g. --test-env-file).
   DB, both roles, own fixtures (3 demo rows with first characters s, z, Q incl. a mixed-case domain, 1 non-demo
   control): dry run exit 0 "would rotate 3"; confirm --ids exit 0; 3 audit rows, metadata keys exactly {addressTag,
   runId, sessionVersionBumped, target, tool}; runId matches the printed run; tags differ between runs; 0 hits for
   local=<c>, <c>***, any local part, or any 8/10/12/16/64-hex window of the unsalted SHA-256 of the address (as stored,
   lower-cased, trimmed) or of the local part — in the dry-run output, the confirm output and the audit rows; teardown
   0/0/0 (item2-rotate-db-*.json). Regression: sec-r-db-target-guard + sec-e3-ops-guards + sec-b2-rls-test-target +
   sec-f2-restore-verify-compare 65/65; sec-m1-demo-rotate-db 6/6 owner, 6/6 restricted (twice: wtm and the sweep);
   M2 hardening + M1 guard 28 passed, 1 skipped (symlink). Mutants all red: R9-M7 case-sensitive basename (1 failed);
   R9-M8 --ids optional (unit 3 failed; DB owner 2 failed); R9-M9 endpoint= refusal removed (2 failed); R9-M10 unsalted
   SHA-256 restored (unit 2 failed; DB owner 5 failed incl. R9's own cell); R9-M11 HMAC under a constant key (1 failed).

3. SF-130. Static test 3/3 on 704ab57. Planted in lib/zz-r9-planted.ts: checkRateLimit(req, key) → red; "x" + id + ":"
   → red. SURVIVED (scanner gaps, none present in the tree today — 0 aliased imports, namespace imports or element
   access of checkRateLimit outside tests): R9-P3 `import { checkRateLimit as rl }` then rl(email, …); R9-P4 a module
   const b = `login:…` shadowed by a parameter b at the call (the scanner resolves the name to the outer const). Note
   bucketFamily returns "-" for a bucket with no colon, so a key-first bucket WITH a colon (`${email}:x`) is the case
   that would leak through an aliased call. Widened M1 static cell: R8-MC2 (R9-M12, `${bucket.split(":")…}` on the
   store-failure path) → static cell red + both store-failure dynamic cells red; helper r9tail(bucket) (R9-M13) → same;
   derived local `const r9rest = bucket.slice(…)` (R9-M14) → static cell GREEN (cannot follow a derived variable, as M2
   said), dynamic cells red — killed overall.

4. Gates (wt, clean 704ab57, Node 24): lint exit 0 (0 errors, 77 warnings); tsc exit 0; unit exit 1 — 475 files,
   6532 passed, 1 skipped, 1 failed: sec-c-csrf-sweep "/api/account/login-email as owner" timed out at 30 s under load
   (same cell R8 saw); alone 426/426 exit 0. build exit 0, BUILD_ID LrEgzWQuvDyry3ajefPcw; npm audit --omit=dev 0
   vulnerabilities. DB sweep (direct exit codes, item4-db-sweep-summary.txt): sec-m1-demo-rotate-db 6/6 + 6/6 exit 0;
   sec-c4-saturation 5/5 + 5/5 exit 0; attendance-import-engine 19/19 + 19/19 exit 0; sec-c3-rate-limit-atomic-db owner
   exit 1 (burst timed out 30 s, then a row count 33≠28), restricted exit 1 (beforeAll "Connection terminated due to
   connection timeout"); reruns: 6/6 + 6/6 but exit 1 (unhandled "Connection terminated unexpectedly" in a Prisma
   interactive transaction), then both exit 1 at beforeAll (connection timeout); sec-a4-lockout-burst-db 5/5 both roles
   but exit 1 (unhandled ConnectionClosed), rerun restricted exit 0 clean, owner exit 1 twice (5/5 + unhandled). TEST
   connectivity degraded during the run (the lead was running gates against the same branch); M2 changed nothing in
   lib/ or in these two test files. These are NOT clean passes and are owed a quiet-branch rerun.

Refusals: none. Not run: lg-3 e2e; gate-ON live sweep / cron-smoke (forbidden on shared TEST); file-symlink attack
(EPERM); a real Neon connection with a project= password (would be a connection attempt; recorded as untested).
Cleanup: envlab emptied, decoy .env removed, junctions removed (rmdir of the link only), planted file removed.

Owed, in order:
1. db-target: refuse /^\s*(endpoint|project)=/i in the password (R9-F1) + a unit cell + mutant.
2. Rotation tool: rename --env-file so Node's own argv scan never opens the named file (R9-F2); keep the exit-2 contract.
3. lg-3: consult ?dryRun=1's retentionEnabled before any live bearer call and refuse on mismatch; widen the static cell
   to bracket/Object.assign/defineProperty forms (R9-M4/M5).
4. SF-130 scanner: follow import aliases / namespace imports / element access, and resolve identifiers by scope, not by
   name (R9-P3/P4).
5. Rerun sec-c3-rate-limit-atomic-db and sec-a4-lockout-burst-db both roles when TEST is quiet; investigate the
   unhandled "Connection terminated unexpectedly" in interactive transactions (R7-N1 family).
6. Still open from R8: gate-ON live sweep on an isolated branch or the e2e database.

M2 approved: YES, WITH RESIDUALS — every claimed fix holds and every claimed mutant is red; R9-F1 (project=) is a gap
in SF-129(c)'s coverage, not a regression, and should be closed before the tool is relied on.
