# CLAUDE.md — MatFlow

Next.js 16 + TypeScript + Tailwind v4 (CSS-first) + Prisma 7 (`@prisma/adapter-pg`) + Neon Postgres + NextAuth v5. Multi-tenant. Installable web app (push delivery not live — do not claim it).

## Runtime and commands

- **Node 24** (`package.json` engines `>=24.18.1 <25`). The system `node` may be another version; Node 24's folder is in the user variable `MF_NODE24` — put it first on `Path` for npm commands. Run builds from PowerShell (Turbopack fails under the Bash tool with 0xc0000142).
- **Work in a git worktree without `.env`** (`git worktree add …`, then a real `npm ci`). The main checkout's `.env` is **production** (Neon `ep-bold-wave`, live Stripe/Resend/auth secrets).
- Lint `npm run lint` · all tests `npm test` · one file `npx vitest run <path>` · e2e `npx playwright test <spec>` (loads `.env.test`).
- **Start:** never `npm run dev` or bare `next dev` in the main checkout — it loads production `.env`. Use the `matflow-verify-browser` skill's server (production build on the test branch).
- **Build:** `npm run build` runs `scripts/maybe-migrate.mjs` first: `prisma migrate deploy` against the `DATABASE_URL`/`MIGRATION_DATABASE_URL` in the shell (it refuses production outside a Vercel production deploy, but migrates any other database, including the shared test branch). Locally use the `matflow-verify-local` skill's build, which has no database URL and cannot migrate.

## Test environment

- Neon **test branch** `ep-hidden-salad`, configured in `.env.test` in the main checkout (gitignored): `DATABASE_URL`, `TEST_DATABASE_URL`, `RESTRICTED_DATABASE_URL` (`matflow_app` role).
- Guards that refuse production: `tests/setup-test-db.ts`, `playwright.config.ts`, `scripts/migrate-test-branch.mjs`, `scripts/reset-test-branch-auth.mjs`. Details: [`tests/integration/README.md`](tests/integration/README.md).
- Without `TEST_DATABASE_URL` the database test files skip. Skipped is not passed.
- Synthetic data only (`example.test` addresses, fixture clubs created and torn down by the run). Never real clubs, members or production.

## Verification workflow (project skills in [`.claude/skills/`](.claude/skills/))

1. `matflow-verify-local` — **before saying any code change is done**: focused tests, lint, full suite, DB suites as both roles, production build, with the commit each ran on.
2. `matflow-verify-browser` — **whenever a change affects what someone sees or does**: a journey written for the changed behaviour (the reference smoke run alone verifies nothing) on the test branch — desktop and phone width, keyboard, forced failed saves, retries.
3. `matflow-completion-report` — **at the end of every coding task**: what changed, what was tested, what is unverified, exact release state.

## Tenant isolation (essential)

- `import { prisma } from "@/lib/prisma"` — never `new PrismaClient()`.
- Tenant data goes through `withTenantContext(ctx.tenantId, (tx) => …)` (`lib/prisma-tenant.ts`) **and** every query filters `where: { tenantId }`. RLS is the backstop, not the defence.
- Authorise first (`lib/authz.ts`): `requireSession()` any signed-in user · `requireStaff()` owner, manager, coach or admin · `requireOwnerOrManager()` · `requireOwner()`.
- Rules and safe patterns: [`docs/TENANT-SCOPE-CONVENTION.md`](docs/TENANT-SCOPE-CONVENTION.md).
- Reports: extend `lib/reports.ts` `getReportsData`; never fabricate numbers.

## Database

Production uses Neon's `-pooler` host; pool size is capped in `lib/prisma.ts`. Schema changes: the `matflow-verify-local` skill's `migrate-test.mjs dev <name>` (worktree migrations, test branch only), never `db push`, never against production from local. Raw SQL only in a script under `scripts/`, never psql against production.

## Approval boundaries — Noe approves each action; approval for one does not cover the next

- **Push** any branch (branch pushes create Vercel preview builds). **Open or update a PR** only as approved (draft unless told otherwise).
- **Merge** only on explicit approval: `gh pr merge <n> --merge --match-head-commit <sha>`. A push or merge to `main` auto-deploys **and migrates production**.
- **Noe runs** Vercel actions, production env vars, anything against production Postgres, credential rotation, and enters all credentials and MFA codes. No production data writes or customer account changes by the agent.
- **Never Vercel Instant Rollback or Promote** — fix forward (adopted in PR #27, 12 Oct 2026; procedure in [`docs/security/INCIDENT-AND-RESTORE-RUNBOOK.md`](docs/security/INCIDENT-AND-RESTORE-RUNBOOK.md) §4).
- Never print secrets or connection strings. Never `git add -A` (sensitive files in the repo root). Never commit `.env`.

## Detail

[`docs/RULES.md`](docs/RULES.md) (product rules) · [`docs/UI-RULES.md`](docs/UI-RULES.md) — read before any UI change; overrides existing patterns · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) and [`docs/runbooks/`](docs/runbooks/) (deploy, DB role, restore, account editing) · [`docs/readiness/`](docs/readiness/) — dated evidence; facts there hold as of their date, re-check before relying on them. British English in user-facing copy. Tests in `tests/{unit,integration}/`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
