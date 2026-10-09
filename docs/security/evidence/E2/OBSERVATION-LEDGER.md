# Lane E — which claims rest on observations, and when (for reviewer R)

Lane E2, 9 Oct 2026. Lane E does not re-review its own iteration-1 work (E-01…E-07); this ledger lists every
iteration-1 claim that depends on an observation of a live system rather than on repository content, when that
observation was made, and whether lane E2 re-observed it. All times UTC. "Repo-derived" claims (code, lockfile, git
history) are not listed; they are reproducible from the SHA.

| # | Iteration-1 claim (file) | Observed by / when | Re-observed in E2 (source, UTC) | Result |
|---|---|---|---|---|
| 1 | 64 production deployments, 62 Ready + 2 Error, 0 preview (E-04) | lane E, Vercel CLI text listing, ~10:45 on 9 Oct; lead inventory file written 00:29 UTC | `vercel ls --prod/--all --format json`, 17:28:58 | CONFIRMED: same 64 URLs, same SHAs, 0 non-production |
| 2 | Serving build = e8afb6a, holds the 4 production aliases (E-04) | lane E listing ~10:45 | `vercel inspect` serving, 17:29:36 | CONFIRMED |
| 3 | 10 dangling branch aliases with no source deployment (E-04) | `vercel alias ls` text ~10:45 ("–") | alias JSON + `vercel inspect <deploymentId>` ×10, 17:29–17:30 | CONFIRMED, refined: each alias still names a deployment id; all 10 ids are not found (deleted) |
| 4 | Every old build holds the current DATABASE_URL, NEXTAUTH_SECRET, Stripe, Resend, Blob values (E-04 table) | inferred from `vercel env ls` creation ages ~10:45 | env JSON incl. updatedAt, 17:31:56, compared with each deployment's createdAt | CONFIRMED for those five; CORRECTED for MATFLOW_ADMIN_SECRET: updated 2026-10-03T11:56, so 62 of 64 builds hold an OLDER value and 2 hold the current one |
| 5 | None of the builds has EMAIL_DELIVERY or ALLOW_ADMIN_SECRET_HEADER (E-04) | env ages ~10:45 | env JSON 17:31:56 | CONFIRMED (created 8 Oct 23:08 and 5 Oct 15:12; newest build 4 Oct 02:32) |
| 6 | Deployment Protection = Standard (all_except_custom_domains), no bypass tokens, no password, no trusted IPs (E-04) | carried from the lead's read ("9 Oct 02:30" in E-04, zone not stated) | project API (fields picked in-pipe), 17:37:02 | CONFIRMED; new: deployment retention 30 days (production, preview, canceled, errored), deploymentsToKeep 10; plan Hobby |
| 7 | Node 24.x project setting; install command default `npm install` (E-03, E-04) | project inspect ~10:45 | project inspect 17:36; serving build log | CONFIRMED; new: functions run `nodejs24.x`; patch level still not exposed |
| 8 | "The production host is a -pooler endpoint" (E-07, SEC-068) | NOT observed — taken from RELEASE-PACKAGE expectation | serving build log, Prisma datasource line, fetched ~17:30 (log written 2026-10-04T02:32:46) | CORRECTED: the Production DATABASE_URL names the DIRECT host (no `-pooler`); variable unchanged since 2026-05-07T13:59 |
| 9 | Vercel runs dependency install scripts with production env (E-03, SEC-060) | inference from package metadata | serving build log | CORRECTED for the serving build: npm reported 5 dependency install scripts "not yet covered by allowScripts" and did not run them; only the root `postinstall` (prisma generate) ran. Earlier builds not checked |
| 10 | No DMARC, no apex SPF, Resend `send` SPF/MX and DKIM present, wildcard ALIAS (E-07) | Google DoH ~11:02 | Google DoH 17:35:43 | CONFIRMED; new: no apex MX (a DMARC rua on the domain would bounce) |
| 11 | BLOB_READ_WRITE_TOKEN non-sensitive, on Production+Preview+Development (E-06) | env text listing ~10:45 | env JSON 17:31:56; stores API ~17:40 | CONFIRMED; new: 3 Blob stores, 2 public stores empty, the connected private store in iad1 |
| 12 | TESTING_MODE present on Production and Preview (E-06/E-07) | env text ~10:45 | env JSON 17:31:56 | CONFIRMED (value Sensitive, unreadable); all 64 builds contain the production refusal (ed3e146 ancestor check) |
| 13 | CRON_SECRET absent, so crons answer 503 (E-07) | env text ~10:45 | env JSON 17:31:56 | Absence CONFIRMED for today's variables. The 503 behaviour of the serving build is an INFERENCE (a deleted variable leaves no trace); the Vercel cron log decides |
| 14 | Repository public, `main` unprotected (E-05) | gh metadata ~11:00 | gh API 17:38 | CONFIRMED; new: 0 rulesets; secret scanning + push protection enabled, validity checks disabled, 0 secret-scanning alerts (open or resolved) |
| 15 | e8afb6a shipped while CI on main was failing (E-05) | gh runs ~11:00 | gh runs 17:39 | CONFIRMED: CI run for e8afb6a = failure (2026-10-04T02:32:30) |
| 16 | Backup workflow never succeeded (E-05/SF-19) | gh runs ~11:00 | gh runs 17:39 | CONFIRMED for the last 3 runs (failure) |
| 17 | 7 May leak rotated? (E-06: UNKNOWN) | — | env updatedAt vs leak commit time | Still UNKNOWN; new contradiction recorded in CONTAINMENT-CHECKLIST §3 |
| 18 | Live TLS/headers, Neon IP Allow, PITR window, GitHub/Vercel 2FA (E-07) | never observed | not observed (lead/Noe only) | UNKNOWN |
