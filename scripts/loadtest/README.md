# Load-test kit (K1)

The load test that proves the scale target in `.omc/specs/deep-interview-scale-security.md` (Step 5 and the Acceptance Criteria): 5,000 members with 500 active in the same minute. It never runs against production.

| Target | Where it is measured |
|---|---|
| check-in p95 < 0.5 s | S2, `http_req_duration{kind:checkin}` |
| page p95 < 1 s | S3, S4, `http_req_duration{kind:page}` |
| API p95 < 400 ms | S1 to S4, `http_req_duration{kind:api}` |
| errors < 0.5%, intended 429s not counted | every scenario, `unexpected_errors` |
| no P2028 and no pool timeouts | the server-log scan (`monitor.mjs logs`) |
| attendance never over capacity, no duplicates | S2, then a database check after it |
| under a bot flood, real-user p95 within 2× baseline | S5, `floodToBaselineRatio` |

## Noe's one step

In the Neon console, open the MatFlow project, select the **test branch** (`ep-hidden-salad`) and create a **child branch** from it, from its current state. On the new branch, choose **Connect**, select **Pooled connection** (its host contains `-pooler`) and copy the string. Then paste it into `scripts/loadtest/.env.loadtest` as one line:

```
LOADTEST_DATABASE_URL=postgresql://neondb_owner:<password>@ep-<new-branch>-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

That is the whole of Noe's part: paste the child branch's **pooled** URL there. The file is gitignored by the root `.env*` rule (`git check-ignore scripts/loadtest/.env.loadtest` prints it). When the run is finished, the child branch can be deleted in the console. Delete it rather than reusing it for anything else.

## Everything else is one command

From the root of a MatFlow git worktree with no `.env` file and `npm ci` done, using Node 24:

```
node scripts/loadtest/run.mjs --child-branch --members 5000 --scenarios all
```

`--child-branch` is the operator's statement that the configured URL is the throwaway child branch; without it any host other than the test branch is refused. First run `--members 1000`, then `--members 5000`. The spec's run order is: a baseline before the fixes, then after Step 2, then after Step 3.

`run.mjs` does the following, in order:

1. **Guard** (`guard.mjs`). It works from the URLs and the connections themselves and never writes anything to the shared test branch. It refuses:
   - anything that mentions `ep-bold-wave` (production), anywhere;
   - the shared test branch (`ep-hidden-salad`) unless you pass `--allow-shared-test-branch`, and then only for a tiny `--smoke` run (at most 50 members, 3 clubs, 30 s per scenario and 20 virtual users);
   - any other host unless you pass `--child-branch`, and a host that is not different from both;
   - a host that is not pooled, or not in the test branch's region;
   - credentials that are not the test branch's own roles (a Neon branch inherits its parent's roles and passwords);
   - a database outside the test branch's Neon project, or on the test branch's own timeline under another name. Two read-only queries (`neon.tenant_id`, `neon.timeline_id`), one on the child and one on the test branch, decide this.
2. **Migrate** the child branch with `prisma migrate deploy` (owner role, nothing else in the environment). On the shared branch it runs `migrate status` only.
3. **Build.** If there is no production build of a clean HEAD, it builds one with `matflow-verify-local`'s `server.mjs build`. That build has no database variable, so it cannot migrate anything. Commit first: a dirty tree is refused.
4. **Seed** (`seed.mjs`): 10 clubs on `example.test` addresses, with slugs and addresses that carry a random run stamp. Each club gets:
   - an owner and a manager, both with an authenticator enrolled;
   - two coaches;
   - two plans;
   - a weekly timetable with sessions for today and the next six days;
   - 12 weeks of past sessions with attendance (for Reports);
   - two S2 "class start" sessions that are open now;
   - a kiosk token.

   Club 1 is the big club with a quarter of the members. Sessions are minted for every account with the test branch's auth secret, exactly as the app re-issues them after its TOTP step, so k6 can browse without 5,000 sign-ins. S1 measures real sign-ins.
5. **Serve.** It runs 4 × `next start` (each with production's pool of 5, as each Vercel instance has) behind `proxy.mjs`, a TLS front on `https://localhost:4091` that turns each virtual user's lane address into the only `x-forwarded-for` hop. The server's database role is the restricted `matflow_app`, as in production.
6. **Scenarios** (k6, one file each). `monitor.mjs sample` records `pg_stat_activity` by state and wait event every 5 s throughout:
   - `s1-signin-burst.js`: 500 real password sign-ins in one minute (90% members, 10% coaches).
   - `s2-class-start.js`, two doors into club 1 at once:
     - (a) one kiosk token on one device address, 150 check-ins in 120 s;
     - (b) 150 members checking in from the app to one session. Its capacity (120) is below the 150 who try, and every tenth member double-taps.
   - `s3-browse-mix.js`: 90% members and 10% staff, ramping to 1,000 users and holding, then to 5,000 and holding, with 10–30 s of think time.
   - `s4-reports.js`: 50 owners on Reports at once for 2 minutes.
   - `s5-bot-flood.js`: the S3 mix at 200 users, then 200 junk requests a second from 20 bot addresses.
7. **Evidence:**
   - the S2 database check (attendance ≤ capacity, nobody twice, and the k6 successes match the rows written);
   - the top 20 `pg_stat_statements` (the extension is created on the child branch if missing, and reset before the scenarios);
   - a scan of the server logs for pool timeouts, `P2028`, `55P03`, `57014` and `revocation check failed`.
8. **Teardown** (`seed.mjs --teardown`). It deletes only the tenants whose slug carries the run stamp and that the run's state names. It also deletes the rate-limit rows of the run's lane addresses (`198.18.0.0/15`, the benchmarking range). It then proves that 0 rows are left in every table with a `tenantId`. Pass `--keep` to skip it, and it prints the teardown command.
9. **Report:** `docs/readiness/loadtest/<date>-load-<members>m-<stamp>.md`, with p50/p95/p99 per scenario and request kind, errors and 429s, outcomes, invariants, database peaks, top statements and the log scan. Raw k6 summaries, server logs and samples stay outside git in `%LOCALAPPDATA%/matflow-loadtest/<stamp>/`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | every target and check met |
| 1 | the run completed, but a target or check failed (the report says which) |
| 3 | refused by the guard |
| 4 | the kit itself could not run a step |

### Where to run it

The best place is a machine or VM in **eu-west-2** (London), next to the Neon branch, with k6 on the same machine. That is the spec's setup, and the only one whose latency figures are evidence about the target.

A local machine is fine for a smoke run, but its figures include the round trip to London. From Bali that is about 200 ms on every database query, so pages miss the target for reasons that have nothing to do with MatFlow.

On a VM, clone the repo, run `npm ci` with Node 24, and copy `.env.test` into the main checkout (it holds the test branch's auth secret and role passwords, which the guard compares against). Then add `scripts/loadtest/.env.loadtest`.

### k6

k6 is not an npm dependency and is not in `package.json`. `run.mjs` finds it in one of these places:

- `K6_BIN`;
- `k6` on `PATH`;
- an official release unzipped under `%LOCALAPPDATA%/matflow-loadtest/k6/<version>/`.

To get it, use any of these:

- `winget install k6 --source winget`;
- on Linux, Grafana's apt or yum repository;
- download the release zip and its checksums file and verify them:

```
gh release download v2.3.0 --repo grafana/k6 --pattern "k6-v2.3.0-windows-amd64.zip" --pattern "k6-v2.3.0-checksums.txt"
grep windows-amd64.zip k6-v2.3.0-checksums.txt | sha256sum -c
```

The kit was built and smoke-run with k6 v2.3.0. k6 passes scripts only the variables given with `-e`, so the scenarios need `run.mjs`. Each one refuses a `BASE` that is not `localhost`.

### Smoke run (proves the kit, not the target)

```
node scripts/loadtest/run.mjs --smoke --members 20 --clubs 2 --seconds 10 --allow-shared-test-branch
```

This is a tiny run on the shared test branch: 1 server, a handful of virtual users and 10 s per scenario, followed by a teardown. Its verdict asks that:

- every scenario ran;
- every response was one the scenario expects (latency is not judged);
- S2 kept capacity, with no duplicates;
- the logs are clean;
- the teardown left zero rows.

Only run it when nobody else is using the shared branch.

## Pieces

| File | What it does |
|---|---|
| `guard.mjs` | Target checks, imported first by every script (`node scripts/loadtest/guard.mjs --child-branch` prints the verdict for the configured target). Unit tests: `tests/unit/loadtest-guard.test.ts`. |
| `seed.mjs` | `--members N [--clubs 10] [--history-weeks 12]`, `--teardown --stamp S`, `--status --stamp S`, each with `--child-branch` or `--allow-shared-test-branch`. Idempotent per stamp: a seeded stamp only re-mints sessions, and a partial seed is refused until teardown. |
| `run.mjs` | The one command. |
| `proxy.mjs` | The TLS front with round robin and lane addresses. |
| `monitor.mjs` | `sample`, `statements` and `logs`. Its queries are in `collect.sql`. |
| `k6-common.js`, `k6-browse.js` | Shared k6 helpers and the browse mix. |
| `s1`…`s5` | The scenarios. |

The kiosk scenario (S2a) sends every check-in from one device address, as a real tablet does. The kiosk's per-device limits (30 check-ins and 60 name searches a minute, in `app/api/kiosk/[token]/*`) are below 150 check-ins in 2 minutes. A full run is therefore expected to show 429s at the kiosk. That is a finding about the limits, which the report shows as `checkin_rate_limited`, not a fault in the kit.
