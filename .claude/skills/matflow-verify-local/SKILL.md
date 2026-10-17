---
name: matflow-verify-local
description: Use before claiming a MatFlow code change is done — runs focused tests, lint, the full suite, test-branch database suites (both roles) and a production build on Node 24, never against production.
---

# MatFlow — local verification

Run from the root of the git worktree you changed, never the main checkout (its `.env` is production). Scripts are in `.claude/skills/matflow-verify-local/scripts` (`$L` below — set it: `$L = ".claude/skills/matflow-verify-local/scripts"`). They refuse a worktree containing any `.env*` file other than the examples, and any database other than the Neon test branch (`ep-hidden-salad`); they read `.env.test` from the main checkout (found through git) and never print it. Every script runs itself on Node 24 and prints the executable and version it used — quote that line in the report. Output goes to `%LOCALAPPDATA%\matflow-verify\<worktree>` (outside git).

**Machine prerequisites (once per machine).** Node 24 (`>=24.18.1 <25`) with its folder in the user variable `MF_NODE24`; the system `node` may be another version. `.env.test` in the main checkout. Git for Windows (git; its openssl makes the localhost certificate). Playwright's Chromium for browser runs: `npx playwright install chromium`. For npm commands in PowerShell put Node 24 first, then check `node -v` prints v24:
`$env:Path = [Environment]::GetEnvironmentVariable("MF_NODE24","User") + ";" + $env:Path`
On Windows run builds from PowerShell (Turbopack under the Bash tool fails with 0xc0000142). A new worktree needs a real `npm ci` (a node_modules junction breaks Turbopack).

## Steps, in order — record each command, exit code and commit

1. **Focused tests** for what changed: `npx vitest run tests/unit/<file>.test.ts …`. Add or adjust a test that fails without the change.
2. **Lint:** `npm run lint` (0 errors). It does not cover `.claude/`; after editing a skill script also run `node --check <file>`.
3. **Full suite:** `npm test`. Database files skip without `TEST_DATABASE_URL` — expected; report the skip count, never call them passed.
4. **Database suites, if data access, RLS, migrations or a route's queries changed:** `node $L/db-tests.mjs tests/integration/<file>.test.ts` — runs as the owner role and as the restricted `matflow_app` role. Both must pass.
5. **Production build:** `node $L/server.mjs build` — `next build` with no database variable in its environment, so nothing in it can migrate; prints `BUILD EXIT <n> commit <sha> tree clean|DIRTY`. Never `npm run build` locally: its `scripts/maybe-migrate.mjs` first runs `prisma migrate deploy` against the database URL in the shell — it refuses the production endpoint outside a Vercel production deploy, but migrates any other database, including the shared test branch.
6. `git status --short` and `git rev-parse HEAD`: results only count for the commit they ran on, on a clean tree.

**Schema change:** `node $L/migrate-test.mjs dev <snake_case_name>` (creates the migration in this worktree and applies it to the test branch), `node $L/migrate-test.mjs status` to check, `deploy` to apply this worktree's pending migrations. Never `db push`; never `prisma` commands from the main checkout (`prisma.config.ts` loads its production `.env`).

After pushing (only with approval): `gh pr checks <n>` and report each check by name.

## Not this skill
User journeys in a browser → `matflow-verify-browser`. Writing the result up → `matflow-completion-report`.
