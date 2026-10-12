# E-04 Old-deployment retirement: read-only inventory and remediation plan (SEC-066, SEC-067, ledger AH-07)

Lane E, 9 Oct 2026, ~10:45 UTC. Read-only Vercel CLI 59.1.4 listings only: `vercel ls matflow --prod` (all 4 pages),
`vercel ls matflow`, `vercel alias ls`, `vercel project ls`, `vercel project inspect matflow`, `vercel env ls` (names
and environments only; the value column is dropped from the evidence file), `vercel domains ls`/`inspect`,
`vercel dns ls matflow.studio`. **Nothing was deleted, changed or retried.** The earlier bulk-deletion denial stands,
and this lane did not attempt deletion by any route. No request was sent to any deployment URL. Protection settings
are carried from the lead's earlier read (`scratchpad/adminhub/release-notes-draft.md`). They were not re-read here,
because the project document returned by the API also carries environment-variable entries.

## Inventory (now)
- Production deployments: **64** (62 Ready, 2 Error), oldest 28 days. The URL set is **identical** to the lead's 9 Oct
  02:30 inventory (`deployment-inventory.json` diff: no change). Preview deployments: **0**. `vercel-ls-prod-2026-10-09.txt`.
- Serving: `matflow-1ye6aej1o…` (e8afb6a, 4 Oct). It carries the four production aliases: `matflow.studio` (custom, public),
  `matflow-noetopalians-projects.vercel.app`, `matflow-nine.vercel.app`, `matflow-git-main-noetopalians-projects.vercel.app`.
- **63 old production deployments remain** (61 Ready + 2 Error). The release package says 2 more were deleted earlier.
- **10 dangling aliases** with no source deployment (`vercel alias ls`, source "–"):
  `matflow-git-<branch>-noetopalians-projects.vercel.app` for 10 old feature branches, aged 50–125 days.
  `vercel-alias-ls-2026-10-09.txt`. These are in Vercel's team-scoped `vercel.app` namespace, so they are hygiene,
  not a takeover vector.
- Protection (lead's read, 9 Oct 02:30): `ssoProtection.deploymentType = all_except_custom_domains` (Standard
  Protection); no password protection, no trusted IPs, **no protection-bypass tokens**, no OPTIONS allowlist. Sampled
  protection: 2 old URLs observed returning 302 → vercel.com/sso-api on 8 Oct. The other 61 are covered by the same
  project setting but were not individually tested.
- Project: Node 24.x, framework Next.js, **install command = default (`npm install`, not `npm ci`)**, region lhr1.
- Domain: `matflow.studio`, registrar Vercel, expires 29 Apr 2027, nameservers ns1/ns2.vercel-dns.com. DNS records
  (passive): `*` ALIAS → Vercel (wildcard, a Vercel default), apex ALIAS, `send` MX/SPF for Resend (Amazon SES),
  `resend._domainkey` DKIM, default CAA (letsencrypt, pki.goog, sectigo). **No `_dmarc` TXT record and no apex SPF.**
  See E-07.

## What an old deployment retains
Vercel deployments are immutable. Each one keeps the environment variables **as they were when it was built**, and
later edits apply only to new deployments. Comparing variable ages (`vercel env ls`) with the oldest deployment (28 days):
| Variable (Production) | Age | Held by all 63 old deployments? | What rotation does to an old deployment |
|---|---|---|---|
| DATABASE_URL | 163 d | **yes, the same live credential as production** | Provider-side rotation (Neon role password) cuts them off. A Vercel-only edit does not |
| NEXTAUTH_SECRET | 168 d | **yes, the same signing key**: a production session JWT verifies on an old build | Only deletion (or an incompatible rotation plus re-login for everyone) removes it |
| STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CLIENT_ID | 155 / 50 / 155 d | yes | Rolling the key at Stripe cuts them off |
| RESEND_API_KEY, RESEND_FROM | 155 d | yes, **and none of them has EMAIL_DELIVERY=off** | Revoking the key at Resend cuts them off |
| BLOB_READ_WRITE_TOKEN | 162 d | yes (read/write on the private member-photo and waiver store) | Regenerating it at Vercel Blob cuts them off |
| MATFLOW_ADMIN_SECRET | 50 d | yes | **Not reachable by rotation.** The old build compares against its own copy. Deletion is the only fix |
| TESTING_MODE, AUTH_TRUST_HOST, NEXTAUTH_URL | 159–165 d | yes | n/a. `isTestingMode()` refuses on VERCEL_ENV=production. The guard has been in `lib/testing-mode.ts` since 40c2cb5 (5 May), which is older than every remaining deployment (the oldest is c6a1774, 11 Sep) |
| EMAIL_DELIVERY | 12 h | **no** (not even the serving e8afb6a build) | It takes effect only on the next deployment |
| ALLOW_ADMIN_SECRET_HEADER | 4 d | **no** (not even the serving build) | Same |
| OPERATOR_ALLOWED_IDS, CRON_SECRET, RESEND_WEBHOOK_SECRET | absent | no | The crons answer 503 and the Resend webhook answers 503 in production (fail closed). See E-07 |
So 63 old builds run superseded code (next 16.3.3 and older, without the operator allowlist, step-up v2 or mail-dark),
with the **current** database, Stripe, Resend and Blob credentials and the current session-signing key. Their only
barrier is Vercel Authentication (team members only). Anyone with Vercel team access, a leaked Vercel session, a
future protection-setting change or a bypass token would reach them.

## Remediation for Noe, in order (prepared, NOT performed)
1. Push and verify the candidate per RELEASE-PACKAGE §3–4 first. Keep the serving deployment until the new one passes
   `release-verify.mjs --target production`.
2. In the Vercel dashboard → Deployments, delete the 63 old production deployments (all except the new serving one).
   This is the same action that was denied to the agent earlier. It is Noe's own action and was not retried by any route.
3. Remove the 10 dangling branch aliases (dashboard → Domains/Aliases, or Noe runs `vercel alias rm <alias>` for each
   name in `vercel-alias-ls-2026-10-09.txt`).
4. Rotate at the provider every credential that old builds hold. Do this after step 2, or immediately if step 2
   slips, coordinated with a fresh deployment so production gets the new values: Neon role password (then update
   `DATABASE_URL` and redeploy), Resend API key, Stripe restricted key, Blob read/write token. The release package
   already requires rotating `MATFLOW_ADMIN_SECRET`. Note that it does not reach old builds, so step 2 is what retires the old value.
5. Settings → Deployment Protection: keep Standard Protection, create no Protection Bypass for Automation token and no
   shareable links. Set a Deployment Retention policy so superseded production deployments expire automatically.
6. Never Instant Rollback or Promote an old deployment (RELEASE-PACKAGE §7). Rollback means rebuilding fresh.
7. Read-only re-check after the steps (lead): `vercel ls matflow --prod` shows 1 deployment, and `vercel alias ls`
   shows only the 4 production aliases.

Status: SEC-066 **APPLICABLE, OPEN (FAIL)**: 63 stale deployments and 10 dangling aliases, mitigated only by SSO.
SEC-067 **APPLICABLE, OPEN**: old builds hold live credentials; rotation plan above.
