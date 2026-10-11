# Targeted production-mode rehearsal of 704ab57 — human hand-off (drafted by lane CR, 12 Oct 2026; not executed)

Purpose: the decision document's §3 "required review" — re-run the admin-hub production-mode browser rehearsal on the executable `704ab579ed42cef497bc38136982502aca153b75`, on the TEST branch only, both database roles, mail off. Nothing here touches production, Stripe, Vercel or Neon settings. This file is a procedure; nothing in it has been run.

`SP` below = `<scratchpad>`. `MAIN` = `C:/Users/NoeTo/Desktop/matflow`. Run every long-lived process detached with output to a file (never piped through `head`/`grep`).

## 0. What the 9 Oct rehearsal actually used (read this first)

The admin-hub FINAL-REPORT (`MAIN/docs/readiness/admin-hub-2026-10-09/FINAL-REPORT.md:55-58`) has no procedure section; it summarises lane G. Lane G's evidence (`SP/adminhub/report-G-browser.md`) shows the instrument was **not** `tests/e2e/campaign/**`: it was the scratchpad drivers `SP/adminhub/e2e/{glib,g-setup,g-control,g-flows,g-release,launch,tls-proxy}.mjs` + `stop.ps1`, against `SP/att/prod-server.mjs start 3971 nobypass,isolated[,restricted] https://localhost:3972` behind the TLS proxy on 3972, with the release-verify mail interceptor on 4599 (`SP/adminhub/e2e/rerun-*.start.txt`). The targeted re-run on c837e38 ran flows 4, 6b, 7 + release-verify under both roles. **Those drivers live outside the repository.**

The repository's campaign specs that touch these areas (`tests/e2e/campaign/assess/lg-1-operator-plane.spec.ts`, `lg-2-impersonation.spec.ts`, `la-2-identity.spec.ts`) were written for a development-mode server: they use the shared-secret door `MATFLOW_ADMIN_SECRET` (`lg-shared.ts:10-22`), insert operators that are not allow-listed (`lg-1…spec.ts:1056-1068`), send `x-vercel-forwarded-for` themselves (`:1054`; the TLS proxy strips it), and default passwords to `E2E_BYPASS_TOKEN` (`la-shared.ts:26`). In a production-mode process the shared secret is closed and an unset/other allow-list means nobody (`lib/operator-auth.ts:369-372`), and `la-2` J04 still expects the pre-SF-35 row lock copy "temporarily locked" (`la-2-identity.spec.ts:198-262`). They are not usable as the acceptance instrument for this rehearsal without changes; see the GAP list.

Since c837e38 the hub-specific files are byte-identical (`app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts`, `…/login-email/check/route.ts`, `lib/login-email.ts`); the owner route changed only by `z.strictObject` (3+/3−). What changed and is exercised by the hub journey: `auth.ts` (+394/−168), `proxy.ts` (+134 lines changed), `lib/session-revocation.ts`, `lib/operator-step-up.ts` (revoke-all target; `expired` label on spend), `lib/key-contexts.ts`. Because the session, proxy and step-up paths moved, run **all flows 1–9 plus 5x**, not only 4, 6b, 7.

## 1. Preconditions (record each)

1. Nobody else is using the TEST branch, ports 3971/3972/4599, or building in either checkout (parallel-session hazard; shared TEST data breaks fixtures).
2. `git -C MAIN status --porcelain` noted; `git -C MAIN diff --stat 704ab579ed42cef497bc38136982502aca153b75 HEAD -- tests/e2e playwright.config.ts scripts/readiness scripts/operator-access.mjs` → **must print nothing** (true at 12 Oct; it lets the drivers, checker and release-verify run from MAIN unchanged).
3. `MAIN/.env.test` `DATABASE_URL` and `RESTRICTED_DATABASE_URL` both contain `ep-hidden-salad` and neither contains `ep-bold-wave` (the launcher and runners refuse otherwise).
4. The six hub migrations are applied on TEST (the decision document says so; g-release's `migrations.applied` row will prove it — `--expect-migrations local` checks all 100 names of the tree, `release-verify.mjs:182-216`).

## 2. Build the 704ab57 worktree (production build, TEST env, no migrations)

```bash
git -C "$MAIN" worktree add "$SP/hub/rh-wt" 704ab579ed42cef497bc38136982502aca153b75
git -C "$SP/hub/rh-wt" rev-parse HEAD            # must print 704ab579ed42cef497bc38136982502aca153b75
cd "$SP/hub/rh-wt" && npm ci > "$SP/hub/rh/npm-ci.log" 2>&1; echo "npm ci exit $?"   # postinstall = prisma generate
```

The worktree has no `.env`, `.env.local` or `.env.test` (only the `*.example` files are tracked), so no production value can be loaded from disk by Next.

Launcher: copy `SP/att/prod-server.mjs` to `SP/hub/rh/prod-server-704.mjs` and change only:
- `const ROOT = "<SP>/hub/rh-wt"` (build and start the worktree, not MAIN — the original hard-codes MAIN, `prod-server.mjs:9`);
- read the env file from `MAIN/.env.test` explicitly (the original reads `${ROOT}/.env.test`, `:11`);
- in `start`, always set `env.CRON_SECRET = ""` and `env.E2E_AUTH_BYPASS = ""` (the original only prints CRON_SECRET's presence, `:47`).
Everything else keeps its semantics: refuse a non-`ep-hidden-salad` URL (`:15`); delete `VERCEL_ENV` (`:16`); `nobypass` → `TESTING_MODE=false`, `E2E_BYPASS_TOKEN=""` (`:31`); `restricted` → `DATABASE_URL = RESTRICTED_DATABASE_URL` after the same host check (`:33-36`); `isolated` → VAPID/BLOB/ANTHROPIC blank, Stripe and Resend keys deliberately invalid, `RESEND_FROM` blank (`:40-51`); `NEXTAUTH_URL`/`AUTH_URL` = the public URL, `AUTH_TRUST_HOST=true` (`:53-56`).

```bash
node "$SP/hub/rh/prod-server-704.mjs" build > "$SP/hub/rh/build-704.log" 2>&1; echo "build exit $?"
cat "$SP/hub/rh-wt/.next/BUILD_ID"                       # record
git -C "$SP/hub/rh-wt" status --porcelain                # record; must be empty (.next is ignored)
```
This is `npx next build` only — `scripts/maybe-migrate.mjs` does not run, so no migration is attempted. Do not run any other build until the rehearsal ends (the 9 Oct run was corrupted by a concurrent build replacing `.next`).

## 3. Drivers

Copy `SP/adminhub/e2e/{glib.mjs,g-setup.mjs,g-control.mjs,g-flows.mjs,g-release.mjs,launch.mjs,tls-proxy.mjs,stop.ps1}` to `SP/hub/rh-e2e/` and change only:
- `glib.mjs`: `E2E` → `SP/hub/rh-e2e` (so `PRIV` becomes the fresh `SP/hub/rh-private`; do not reuse `adminhub/g-private/state.json`). `REPO` stays MAIN (node_modules, `.env.test`, and scripts identical to 704ab57 per precondition 2).
- `launch.mjs`: spawn `../rh/prod-server-704.mjs` instead of `../../att/prod-server.mjs`.
- `g-release.mjs`: `--sha 704ab579ed42cef497bc38136982502aca153b75` literally (it otherwise records MAIN's HEAD, `g-release.mjs:13`).
`tls-proxy.mjs` keeps reading the key/cert from `SP/att`.

## 4. Server environment per pass

| Variable | Control pass | Owner-role pass (`eng`) | Restricted pass (`res`) |
|---|---|---|---|
| Launcher flags | `nobypass,isolated` | `nobypass,isolated` | `nobypass,isolated,restricted` |
| `EMAIL_DELIVERY` | `on` (positive control only) | `off` | `off` |
| `OPERATOR_ALLOWED_IDS` | both synthetic operators | `op-allowed` only | `op-allowed` only |
| `RESEND_BASE_URL` | `http://127.0.0.1:4599` | same | same |
| `RESEND_API_KEY` / Stripe keys | invalid dummies (isolated) | same | same |
| `TESTING_MODE` | `false` | `false` | `false` |
| `E2E_BYPASS_TOKEN` / `E2E_AUTH_BYPASS` | empty / empty | empty / empty | empty / empty |
| `CRON_SECRET` | empty | empty | empty |
| `MATFLOW_CSP_ENFORCE` | unset (report-only, as production unless Noe has set it — record which) | same | same |
| `NODE_TLS_REJECT_UNAUTHORIZED` | **never in the server env** (`launch.mjs:14`) | same | same |
| DB role | owner URL | owner URL | `matflow_app` via `RESTRICTED_DATABASE_URL`; confirm with `pg_stat_activity` |

**Every journey runs without the bypass.** `TESTING_MODE=false` disables both the E2E password bypass (`auth.ts:243-246`) and the TESTING_MODE suppression of the owner's authenticator challenge (`auth.ts:706`); with it on, owner login, revocation and recovery would not exercise the second factor, and the operator plane would not be production-like. There is no journey in this rehearsal that needs the bypass.

## 5. Commands, in order

```bash
cd "$MAIN"; node scripts/readiness/release-verify.mjs mail-interceptor --port 4599 > "$SP/hub/rh/interceptor.log" 2>&1 &   # detached
node "$SP/hub/rh-e2e/tls-proxy.mjs" > "$SP/hub/rh/tls-proxy.log" 2>&1 &                                                     # detached
cd "$SP/hub/rh-e2e"
node g-setup.mjs operators;          echo "exit $?"
node g-setup.mjs fixtures control;   echo "exit $?"
node launch.mjs on nobypass,isolated rh-control-on      # wait for health: GET https://localhost:3972/api/health → 200 {status:"ok",db:"ok"}
node g-control.mjs;                  echo "exit $?"     # positive control: interceptor count +1, EmailLog sent
powershell -File stop.ps1 -Ports 3971
node g-setup.mjs fixtures eng;       echo "exit $?"
node launch.mjs off nobypass,isolated rh-eng-off        # wait for health
node g-flows.mjs eng 1,2,3,4,5,6,6b,7,8,9,9m,5x;  echo "exit $?"
node g-release.mjs eng;              echo "exit $?"
powershell -File stop.ps1 -Ports 3971
node g-setup.mjs fixtures res;       echo "exit $?"
node launch.mjs off nobypass,isolated,restricted rh-res-off   # wait for health; confirm the session user is matflow_app
node g-flows.mjs res 1,2,3,4,5,6,6b,7,8,9,9m,5x;  echo "exit $?"
node g-release.mjs res;              echo "exit $?"
powershell -File stop.ps1 -Ports 3971,3972,4599
node g-setup.mjs teardown;           echo "exit $?"
```
`5x` is the natural expiry of the flow-5 grant (5-minute TTL; the driver waits, `g-flows.mjs:520-528`). The second checker baseline in a pass needs `--overwrite` (the driver passes it in 6b, per the 9 Oct notes).

## 6. Which flow covers which case

| Case | Instrument (flow / file) | In the repository? |
|---|---|---|
| Operator MFA challenge (password alone starts a challenge; code opens the plane; code single-use) | `glib.mjs` `operatorSignIn` (`/admin/login` → `#totpCode`), flows 1 and every grant; repo spec `lg-1-operator-plane.spec.ts` "J60 · the operator's own second factor" (`:1047-1214+`) exists but assumes a dev-mode server (unlisted operator, own forwarded header) | Driver: no. Spec: yes, **not usable as-is** |
| Allow-list refusal (enrolled, MFA-valid operator not in `OPERATOR_ALLOWED_IDS` → 403 + refusal row at session mint) | flow 1 ("op-other 403 + one refused row at session_mint") | **GAP** — no repo spec |
| Support-session refusal on the operator plane (403 on `/api/admin/*`, `/admin` → `/dashboard`, club writes 403) | flow 1 | **GAP** — no repo spec (`lg-2-impersonation.spec.ts` covers attribution and eviction, not plane refusal) |
| Hub conflict journey (check → member contact change with step-up → re-check → owner change with fresh step-up → checker verify) | flows 3, 4 (+ checker baseline/verify inside flow 4) | **GAP** — journey J83 exists only as a manifest row (`tests/e2e/campaign/assess/journeys.ts:144`) |
| Lost-response replay (member and owner re-send → 200 `alreadyApplied`, one row; concurrent replays) | flows 6, 6b | **GAP** — no repo spec |
| Partial two-step / stale (409 with grant unspent, resume, fresh code) | flow 7 | **GAP** — no repo spec |
| Owner login after the change (old address refused; new address + same password + authenticator reaches `/dashboard`) | flow 4 | **GAP** — no repo spec in production mode |
| Owner revocation (every session out, `sessionVersion` +1 exactly) | flow 4 (sv +1), flow 9 (member self-change → next request 401) | Repo `la-2-identity.spec.ts` J09 (`:1152-1247`) — dev-mode assumptions (bypass-token passwords) |
| Owner recovery (recovery code redemption on `/api/auth/totp/recover`) | **none** — g-flows does not redeem a staff recovery code | **GAP** — e2e exists only for members (`tests/e2e/auth/member-totp-recovery.spec.ts`); integration only for staff (`tests/integration/owner-recovery-revocation-db.test.ts`, `sec-a-recovery-code-race-db.test.ts`) |
| Step-up expiry and replay (wrong action/change, reuse → 401 used, wrong session, natural expiry → `expired`) | flows 5, 5x | **GAP** — no repo e2e; integration `tests/integration/sec-a-step-up-expiry-db.test.ts` |
| Mass assignment / CSRF / cross-tenant | flow 8 | partial (`tests/e2e/campaign/operator-csrf.spec.ts`, dev-mode) |
| Legacy transports closed; zero sends; migrations; operator access | flow 2; end-of-pass mail check; `g-release.mjs` (release-verify `--target test`) | release-verify yes; drivers no |

To make the owner-recovery case part of this rehearsal, add one driver step after flow 4 on a fresh owner fixture with recovery codes: redeem one code, expect `sessionVersion` +1, `totpEnabled` false, one fewer code, and a concurrent second redemption refused (SF-27).

## 7. Recording rule (per command)

- Record the **exit code of every command directly** (`echo $?` / `$LASTEXITCODE`), never through a pipe.
- `g-flows.mjs` and `g-control.mjs` do **not** set a failing exit code on a FAIL row (they write `ledger-<pass>.json`; only `g-setup.mjs` exits 1, `:31`). A pass is PASS only when: process exit 0 **and** zero `FAIL` rows **and** no `run.aborted` row in `SP/hub/rh-e2e/ledger-<pass>.json`. Count the rows mechanically and record the counts.
- Any unhandled-rejection line in the server log or a driver's output is recorded as FAIL for that run even if every row passed (SF-76 standard); note SF-135 can produce `⨯ unhandledRejection` lines at 704ab57 under load.
- Record `release-verify-<pass>.json` `exit` and every check row; INCONCLUSIVE is a fail.
- Record the server log line counts for `session-revocation check failed — request REFUSED` (expected 0; at 704ab57 a DB blip gives a 503, not an admission) and for `sign-in refused: failure lockout`.
- If a run is interrupted (network, DNS to Neon), re-run the whole pass on fresh fixtures and keep both records.

## 8. Persisted-state checks (each pass, from the ledger rows plus SQL on TEST)

Member row: same id, `externalRef`, status, credentials digest, memberships and attendance digests, guardian links; `email` = new contact address; `sessionVersion` +1 **if and only if** it had a password (not checked by the checker — check by SQL); sign-in tokens for old and new address 0 live (waiver links untouched).
Owner row: same id, role, club, `passwordHash`, `totpSecret`, `totpEnabled`, recovery codes, `mustChangePassword`, password-history ids; `email` = target; `loginEmailProvisionalSince` set and later than baseline; `sessionVersion` = baseline + 1 exactly.
Holders: exactly one User and zero Members hold the target address in the club.
Audit: exactly one `admin.member.contact_email.changed` and one `admin.owner.login_email.changed`, each with `operatorId` = op-allowed and a request id held by one row, distinct from each other; keyed digests match; no raw address in any metadata; and `admin.login_email.checked` rows present with the operator recorded (**not checked by the checker** — check by SQL).
Checker: `owner-login-change-check.mjs baseline` exit 0, `verify --path operator --operator-id <op-allowed>` exit 0 with every check PASS (38 on 9 Oct; record the count at 704ab57).
Mail: interceptor count unchanged over each mail-off pass; no EmailLog row queued/sent/delivered.

## 9. Cleanup (count-checked)

`node g-setup.mjs teardown` must print zeros for: tenants, members, users, audit rows for the synthetic clubs and operators, refusal rows for the synthetic operators (tenantId null), EmailLog, sign-in tokens, operators (`g-setup.mjs:100-140`). Then: delete the checker baselines (`%LOCALAPPDATA%\matflow-readiness\owner-login-change-<slug>-<ownerId>.json`) and every file in `SP/hub/rh-private`; stop ports 3971, 3972, 4599 and confirm none is listening; `git -C MAIN worktree remove --force "$SP/hub/rh-wt"` (removes `.next` and `node_modules` with it); scan `SP/hub/rh-e2e` evidence for addresses, codes and secrets (ledger rows are scrubbed by `glib.mjs:75`; screenshots are masked by `shot`).
