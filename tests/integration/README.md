# Integration tests

These tests hit a real Postgres database. They MUST run against a Neon BRANCH,
never the production main branch.

## Why a separate branch?

`.env` has `DATABASE_URL` pointing at production. Without a separate
`TEST_DATABASE_URL`, integration tests would seed fixtures into Total BJJ's
real tenant. `tests/setup-test-db.ts` refuses to run if `TEST_DATABASE_URL`
contains the production endpoint identifier.

## One-time setup

1. Provision a Neon test branch — pick one of:

   **Via Neon console:**
   matflow project → Branches → "Create branch" → name "test" → use main as parent.

   **Via CLI:**
   ```bash
   npm i -g neonctl
   neonctl auth   # one-time
   neonctl branches create --project-id <PROJECT_ID> --name test
   ```

2. Copy the connection string for the new branch (NOT main).

3. Create `.env.test` (gitignored — see `.env.test.example` for template):
   ```
   TEST_DATABASE_URL=postgresql://user:pass@ep-test-xxxx.neon.tech/neondb?sslmode=require
   ```

## Running

```bash
# Load .env.test, then run integration tests
TEST_DATABASE_URL="$(grep TEST_DATABASE_URL .env.test | cut -d= -f2-)" \
  npx vitest run tests/integration/
```

Or in PowerShell:
```powershell
$env:TEST_DATABASE_URL = (Get-Content .env.test | Select-String 'TEST_DATABASE_URL=').ToString().Split('=', 2)[1]
npx vitest run tests/integration/
```

## What happens without TEST_DATABASE_URL

`setup-test-db.ts` strips `DATABASE_URL` from the env if it points at production.
Integration tests then skip via their `describe.skipIf(!HAS_DB)` guards, and
unit tests run normally. No production touch.

## Cost

A Neon branch is ~$0.16/hour of active compute + ~$0.000164/GB-hour storage.
A 1 GB test branch left on for 24h = ~$3.85. Drop the branch when you're done:

```bash
neonctl branches delete test
```

Or schedule auto-suspend in the Neon console.
