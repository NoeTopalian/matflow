# E-05 CI workflows, repository controls and artifact provenance (SEC-059, SEC-060, SEC-061, SEC-063, SEC-065)

Lane E, 9 Oct 2026. Read-only: the workflow files at 2a6487e, plus `gh run list/view`, `gh api` (repository,
branch-protection, collaborator, key, hook, Actions-secret-name, environment and secret-scanning metadata; no secret
values requested).

## Repository facts
- `NoeTopalian/matflow` is **PUBLIC** (`visibility: public`). Its full history is world-readable, including
  everything E-06 found.
- `main`: **not protected** (`branches/main/protection` → 404 "Branch not protected"), and there are **0 rulesets**. A
  push (or force-push) to `main` deploys to production and runs `prisma migrate deploy` with production DATABASE_URL
  inside the Vercel build (memory: "push deploys prod"). There is no review, status-check or signed-commit requirement.
- Collaborators: 1 (owner, admin). Deploy keys 0. Repository webhooks 0 (the Vercel integration is a GitHub App).
  Actions secrets: **none**. Environments: Preview, Production (created by Vercel).
- Default `GITHUB_TOKEN` permission is `read`, and Actions cannot approve PRs. Secret scanning is enabled with push
  protection; non-provider patterns and validity checks are disabled; Dependabot security updates are **disabled**.
  The secret-scanning alert list returns **0 alerts**, even though the 7 May incident was flagged externally
  (GitGuardian). The GitHub alert list is therefore not evidence of a clean history (see E-06).
- The account's 2FA state cannot be read with this token scope (`two_factor_authentication: null`): **UNKNOWN**
  (SEC-065). The Vercel account's 2FA is also UNKNOWN.

## Workflow review (`.github/workflows/*.yml` at 2a6487e)
| Workflow | Triggers | Token permissions | Secrets in scope | Injection review | Pinning |
|---|---|---|---|---|---|
| ci.yml | push main, pull_request | not declared (repo default `read`) | none. Only literal CI-only values: `ci-test-secret-not-real…`, `postgres:postgres@localhost` | no `${{ github.event.* }}` / `head_ref` / PR title or body interpolated into `run:`. No `pull_request_target` or `workflow_run` | actions pinned by SHA (checkout v4.2.2, setup-node v4.4.0). **`pipx install semgrep` unpinned**, and the Semgrep rule packs are fetched from the registry at run time (`scripts/security-scan.mjs`) |
| db-backup.yml | schedule (Sun 03:00 UTC), workflow_dispatch | `contents: read` | DATABASE_URL_DIRECT, AWS keys and bucket via `env:` (not interpolated into scripts) | none | apt key fetched over HTTPS from postgresql.org and verified through a signed-by keyring. The `aws` CLI comes from the runner image |
| e2e.yml | schedule (daily 03:00), workflow_dispatch | not declared (default `read`) | none. `TESTING_MODE=true` only against the job's own ephemeral Postgres | none | SHA-pinned, including upload-artifact v4.6.2 |
Fork PRs run `ci.yml` with a read-only token and no secrets. No workflow can be triggered by an untrusted actor with
secrets in scope. **SEC-061: no injection path found (C-level review). PASS for the files reviewed**, with two
hardening gaps: no top-level `permissions:` block in ci.yml/e2e.yml (they rely on the repository default), and an
unpinned Semgrep install.

## Is CI actually gating anything? (SEC-063)
`gh run list` on 9 Oct 2026:
- **ci.yml on main has FAILED on the last 4 pushes, including the production SHA e8afb6a** (failed step: "Vitest
  (full suite) — gating"). The last green run was ac2fcb8 (23 Sep). Vercel deployed e8afb6a anyway: nothing connects
  CI status to deployment.
- **db-backup.yml has FAILED every week** (6 of 6 listed, back to 30 Aug) at "Validate secrets". The repository has no
  Actions secrets, so **no logical backup has ever been taken**. Neon PITR is the only backup. Handed to lane F (SEC-085/086).
- e2e.yml has FAILED every night shown (6 of 6).
- Provenance: Vercel builds from the GitHub commit with its own install (`npm install`, the default install command;
  not `npm ci`) on its own image. The only artifact identity is the deployment's commit SHA. There is no attestation,
  no SBOM, no build-to-test link, and the BUILD_ID of the build certified locally (xP9P9cHvx9xkgqHPXnOa9) will not
  equal the production build's id. "Tested build = deployed build" can only be argued from identical source plus
  identical lockfile plus `npm ci`-equivalent install. With `npm install` the argument is weaker: it is honoured only
  while package.json and the lockfile agree, which they do today (E-01).

## Findings
- E-F4 (High, SEC-063/SEC-065): public repo, unprotected `main`, auto-deploy plus auto-migrate on push. A
  compromise of one GitHub credential is a production compromise. Recommend: branch protection or a ruleset on `main`
  (require the CI status check, block force-push and deletion), and Vercel "Ignored Build Step" or Deployment Checks
  wired to the CI check.
- E-F5 (Medium, SEC-063): production shipped from red CI (e8afb6a). The CI suite failure on main is not triaged
  (lane F/lead).
- E-F6 (Medium, SEC-085, lane F): the backup workflow has never succeeded.
- E-F7 (Low, SEC-060/061): unpinned Semgrep in CI; no `permissions:` block in ci.yml and e2e.yml; Vercel install command
  is not `npm ci`; Dependabot alerts and updates are disabled.
- Proposal (new file, inert until pushed): `.github/workflows/security-supply-chain.yml`. It runs the lockfile policy,
  the redacted secret scan and the audit-with-expiring-exceptions gate on every PR and daily, plus OSV correlation.
  **It is not running**: it exists only on this unpushed branch.
