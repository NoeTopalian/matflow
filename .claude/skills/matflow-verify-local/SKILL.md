---
name: matflow-verify-local
description: Use before claiming a MatFlow code change is done — runs focused tests, lint, the full suite, test-branch database suites (both roles) and a production build on Node 24, never against production.
---

# MatFlow — local verification

Run from the root of the git worktree you changed, never the main checkout (its `.env` is production). Scripts are in `.claude/skills/matflow-verify-local/scripts` (`$L`). They refuse a worktree containing `.env` and any database other than the Neon test branch (`ep-hidden-salad`), read `.env.test` from the main checkout (found through git) and never print it. Output goes to `%LOCALAPPDATA%\matflow-verify\<worktree>` (outside git).

**Machine prerequisites.** Node 24 (`package.json` engines `>=24.18.1 <25`) with its folder in the user variable `MF_NODE24`; the system `node` may be another version — the scripts find Node 24 themselves and print the executable they use. `.env.test` in the main checkout. Git for Windows (git, openssl). For npm commands in PowerShell put Node 24 first:
`$env:Path = [Environment]::GetEnvironmentVariable("MF_NODE24","User") + ";" + $env:Path` — then `node -v` must print v24. On Windows run builds from PowerShell (Turbopack under the Bash tool fails with 0xc0000142). A new worktree needs a real `npm ci` (a node_modules junction breaks Turbopack).

## Steps, in order — record each command, exit code and commit

1. **Focused tests** for what changed: `npx vitest run tests/unit/<file>.test.ts …`. Add or adjust a test that fails without the change.
2. **Lint:** `npm run lint` (0 errors).
3. **Full suite:** `npm test`. Database files skip without `TEST_DATABASE_URL` — expected; report the skip count, never call them passed.
4. **Database suites, if data access, RLS, migrations or a route's queries changed:** `node $L/db-tests.mjs tests/integration/<file>.test.ts` — runs as the owner role and as the restricted `matflow_app` role. Both must pass.
5. **Production build:** `node $L/server.mjs build` — `next build` with no database URL in its environment, so it cannot migrate anything; prints `BUILD EXIT <n> commit <sha> tree clean|DIRTY`. Never `npm run build` locally: its `scripts/maybe-migrate.mjs` migrates whatever `DATABASE_URL`/`MIGRATION_DATABASE_URL` the shell holds.
6. `git status --short` and `git rev-parse HEAD`: results only count for the commit they ran on, on a clean tree.

Schema change: `npx prisma migrate dev --name <change>` in the worktree with `DATABASE_URL` set in the shell from `.env.test` (`prisma.config.ts` loads `.env`, which is production in the main checkout); apply to the test branch with `node scripts/migrate-test-branch.mjs`. Never `db push`.

After pushing (only with approval): `gh pr checks <n>` and report each check by name.

## Not this skill
User journeys in a browser → `matflow-verify-browser`. Writing the result up → `matflow-completion-report`.
