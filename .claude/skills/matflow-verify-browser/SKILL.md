---
name: matflow-verify-browser
description: Use when a MatFlow change affects anything a person sees or does — walks the real journey on a production build against the Neon test branch with a synthetic club, at desktop and phone width, by keyboard, with forced failed saves and retries.
---

# MatFlow — browser verification

Production build of your worktree, served over HTTPS on localhost, against the Neon **test** branch, with Stripe, Resend, blob and push keys disabled and `EMAIL_DELIVERY=off`. Synthetic data only (`mfv-…` club on `example.test`). Never production, never a real club or person. Run from the worktree root, in PowerShell, with the prerequisites in `matflow-verify-local`. Set `$L = ".claude/skills/matflow-verify-local/scripts"` (server) and `$B = ".claude/skills/matflow-verify-browser/scripts"` (journeys). `MF_PORT` (default 3991, proxy +2) must be private to this session — never 3847. Every script runs on Node 24 and prints the executable it used.

## Steps

1. Build: `node $L/server.mjs build` — it stamps the build with its commit.
2. Start: `node $L/server.mjs start` — refuses a port already in use and a build that is not of the current clean commit, waits up to 120 s for `health 200` (stopping both processes if it fails) and prints the worktree and the build's commit. `node $L/server.mjs status` shows the same at any time. The first start makes a localhost certificate with openssl.
3. Fixture: `node $B/fixture.mjs create` (add `--onboarding` for a club still in first setup). Owner has password and authenticator enrolled; its credentials stay in the output folder's `fixture-state.json`, never in git.
4. Journey: copy `$B/smoke.mjs` to `$B/journeys/<feature>.mjs` (gitignored, so it never makes the tree dirty; change its import to `../lib.mjs`; move it to `$B` and commit it only if the journey is worth keeping) and replace its journey with the feature under test. Keep these checks wherever they apply:
   - **the real path** a user takes, starting from sign-in, asserting what is on screen *and* what is in the database;
   - **phone width** (390×844, `isMobile`): no horizontal page scroll, the primary action reachable, tap targets measured;
   - **keyboard only**: Tab order reaches each control, Enter/Space activates it, focus is visible;
   - **failed saves**: force a network failure (`route.abort`) and a server error (`route.fulfill` 4xx/5xx) — the message stays beside the action, typed values are kept, nothing is saved;
   - **retries**: the retry sends exactly one request, the error clears, reload shows the saved value;
   - no uncaught page errors.
   `node $B/smoke.mjs` itself is the reference run (contact email in Settings): it proves the harness works, not your change. The journey you report must drive the screens and actions the change touches and assert the changed behaviour on screen and in the database.
5. Teardown: `node $B/fixture.mjs teardown` (prints rows left; must be 0) and `node $L/server.mjs stop`.

Results: PASS/FAIL/NOTE ledger and screenshots (addresses masked) in `%LOCALAPPDATA%\matflow-verify\<worktree>`. A NOTE is a measurement, not a pass. Report the commit the build was made from. Anything not exercised (real email, Stripe, blob storage, push) is **unverified** — say so.
