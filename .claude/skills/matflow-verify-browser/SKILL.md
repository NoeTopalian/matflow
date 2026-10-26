---
name: matflow-verify-browser
description: Use when a MatFlow change affects anything a person sees or does — walks the real journey on a production build against the Neon test branch with a synthetic club, at desktop and phone width, by keyboard, with forced failed saves and retries.
---

# MatFlow — browser verification

Production build of your worktree, served over HTTPS on localhost, against the Neon **test** branch, with Stripe, Resend, blob and push keys disabled and `EMAIL_DELIVERY=off`. Synthetic data only (`mfv-…` club on `example.test`). Never production, never a real club or person. Run from the worktree root, in PowerShell, with the prerequisites in `matflow-verify-local`. Set `$L = ".claude/skills/matflow-verify-local/scripts"` (server) and `$B = ".claude/skills/matflow-verify-browser/scripts"` (journeys). `MF_PORT` (default 3991, proxy +2) must be private to this session — never 3847. Every script runs on Node 24 and prints the executable it used.

## One lock, owned fixtures

Every journey, `smoke.mjs` and `fixture.mjs` joins one lock (`%LOCALAPPDATA%\matflow-verify\journeys.lock`, see `$B/harness.mjs`): started by the runner it runs under the runner's lock; started by hand it takes the lock for its own lifetime, or refuses (exit 3) while a run holds it. A lock whose holder is gone, or whose pid now belongs to another process (pid and start time are both recorded), is reclaimed, and the run it belonged to is recovered first: its surviving children killed by tree, its open fixtures torn down. Fixture slugs embed the run id (`mfv-<runId>-<n>`), fixture state is per run (`…\matflow-verify\runs\<runId>\fixture-state.json`) and every create and teardown is a line in the append-only ledger `…\matflow-verify\fixtures-ledger.jsonl`. Teardown deletes only a tenant whose id, slug and ledger entry agree, refuses (exit 4) otherwise, and never sweeps other `mfv-` clubs. Nothing under `%LOCALAPPDATA%\matflow-verify` is committed.

## Steps

1. Build: `node $L/server.mjs build` — it stamps the build with its commit.
2. Run: `node $B/run-journeys.mjs <journey …>` (names under `$B/journeys/`, `smoke` for the reference run; no names = the standard list). It takes the lock, recovers earlier runs, refuses while other test-branch node processes run (`--allow-foreign` overrides), starts the server and stops if it is not a build of HEAD, writes the manifest (`runs\<runId>\manifest.json`: sha256 of every harness file, the build commit, the worktree's migrations and those applied on the test branch) before the first journey, then for each journey creates a fresh fixture, runs it and tears it down, and stops the server. Logs and the run record are in `runs\<runId>\`. Stop it with Ctrl+C, or kill it any way at all: the next start recovers it. `--no-server` runs fixture-only journeys (`selftest-stub`, the harness self-test).
3. By hand instead (one journey while writing it): `node $L/server.mjs start`, `node $B/fixture.mjs create` (add `--onboarding` for a club still in first setup), the journey, `node $B/fixture.mjs teardown`, `node $L/server.mjs stop`. A hand session's fixtures belong to a stable per-worktree run id (or `MF_RUN_ID`), and only that session tears them down; `node $B/fixture.mjs status` shows them. The owner has a password and an authenticator enrolled; the credentials stay in the run's `fixture-state.json`, never in git.
4. Journey: copy `$B/smoke.mjs` to `$B/journeys/<feature>.mjs` (change its import to `../lib.mjs`) and replace its journey with the feature under test. Journeys are tracked: commit one that is worth keeping, with no credentials, real addresses or production data in it. Keep these checks wherever they apply:
   - **the real path** a user takes, starting from sign-in;
   - **phone width** (390×844, `isMobile`): no horizontal page scroll, the primary action reachable, tap targets measured;
   - **keyboard only**: Tab order reaches each control, Enter/Space activates it, focus is visible;
   - **failed saves**: force a network failure (`route.abort`) and a server error (`route.fulfill` 4xx/5xx) — the message stays beside the action, typed values are kept, nothing is saved;
   - **retries**: the retry sends exactly one request, the error clears, reload shows the saved value;
   - no uncaught page errors.
   **The journey must exercise and assert the changed behaviour.** For changes that persist data, also verify the saved result through reload and an appropriate API or database check. For purely visual changes, browser and screenshot checks are sufficient. The reference smoke run (`smoke`, contact email in Settings) verifies the harness, not feature acceptance.

Results: PASS/FAIL/NOTE ledger and screenshots (addresses masked) in `%LOCALAPPDATA%\matflow-verify\<worktree>`. A NOTE is a measurement, not a pass. Report the commit the build was made from and the run's manifest. Anything not exercised (real email, Stripe, blob storage, push) is **unverified** — say so.
