# E-01 Candidate equivalence: 2a6487e versus the tested build c837e38

Checked 9 Oct 2026 (~10:35 UTC) by lane E. Read-only git inspection only; no build run.

## Identity
- `git rev-parse HEAD` on branch `security/assurance-2026-10` = `2a6487e6691ce7ff906fa1022f2d5b8cc616e35a`.
- Tested build: `c837e38ad26154570e0d52f5d736d97d0a87e693`, BUILD_ID `xP9P9cHvx9xkgqHPXnOa9`. The local `.next/BUILD_ID`
  still reads `xP9P9cHvx9xkgqHPXnOa9` (directory mtime 09:45 local), so the `.next` output inspected by lane E (E-03, E-06) is that build.
- Commits between them: `7ac814a` and `2a6487e`, both `docs(readiness): …`.

## Commands and results
```
git diff --name-status c837e38 2a6487e
A  docs/readiness/admin-hub-2026-10-09/FINAL-REPORT.md
M  docs/readiness/admin-hub-2026-10-09/LEDGER.md
M  docs/readiness/admin-hub-2026-10-09/RELEASE-PACKAGE.md
(3 files, +132 −6)

diff <(git ls-tree c837e38) <(git ls-tree 2a6487e)   # top-level trees
only the `docs` tree id differs (fa81b48… → bd48e42…)
```
Tree/blob ids identical in both commits: `package.json` (7a43119), `package-lock.json` (ddf84f4), `prisma/` (f2faca9,
includes all 101 migration entries and `schema.prisma`), `next.config.ts`, `vercel.json`, `proxy.ts`, `auth.ts`,
`tsconfig.json`, `app/`, `lib/`, `components/`, `scripts/`, `public/`, `tests/`. `middleware.ts` exists in neither.

## Are the changed files build or runtime inputs?
- `grep -rn "admin-hub-2026-10-09|FINAL-REPORT|RELEASE-PACKAGE"` over `app lib scripts tests` returns no hits. Other
  `docs/readiness/...` references in source are comments, plus `scripts/readiness/function-register.mjs`, which WRITES
  `docs/readiness/FUNCTION-REGISTER.md` (not one of the changed files) and is not part of `npm run build`.
- `npm run build` = `node scripts/maybe-migrate.mjs && next build`; `postinstall` = `prisma generate`. Neither reads
  `docs/`. Markdown is not compiled by `tsconfig.json`, and no `.mdx` or markdown loader is configured.
- The installed tree matches the lockfile: `node_modules/.package-lock.json` versus `package-lock.json` shows 0 version
  differences and 0 missing non-optional packages. The 127 entries not installed are platform-specific optional and dev-optional packages.

## Verdict
**EQUIVALENT.** The only difference between 2a6487e and c837e38 is three Markdown files under `docs/readiness/`. No
executable file, dependency manifest, lockfile, migration, schema, build configuration or test changed. Nothing needs
to be rebuilt for this delta, and the exact tested build identity (c837e38 / xP9P9cHvx9xkgqHPXnOa9) carries over.
Limits: a Vercel build also depends on environment variables and on the platform image (Node version and OS
packages). Neither is in git. See E-03 for the Node version.
