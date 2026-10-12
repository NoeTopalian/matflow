# E-07 Hosting, DNS, TLS, storage, database exposure and debug surface (SEC-065, SEC-068 to SEC-072)

Lane E, 9 Oct 2026. Passive and read-only only: DNS through the Google DNS-over-HTTPS resolver (no request reached
MatFlow hosts), the Vercel CLI listings in E-04, and code and config at 2a6487e. **No HTTP request was sent to
production.** Live TLS and header checks are production read-only inspection, which is the lead's job (commands below).

## DNS (SEC-070), `dns-passive-2026-10-09.json`, `vercel dns ls matflow.studio`
- NS: Vercel DNS. Registrar: Vercel; expiry 29 Apr 2027 (202 days). Apex: ALIAS → Vercel (A 64.29.17.1, 216.198.79.65).
- **Wildcard `*` ALIAS → `cname.vercel-dns-017.com`** (Vercel default record). Every label resolves to Vercel,
  including a random label, `_dmarc`, `mail`, `app` and `www`. Only `matflow.studio` is assigned to the project, so other
  hosts reach Vercel's edge and no MatFlow deployment. **Dangling-record takeover: none found.** There are no CNAMEs to
  third-party services that could be released (MX/SPF for `send` point at Amazon SES through Resend).
  Residual: the wildcard lets any subdomain appear valid in DNS. Claiming one in another Vercel team requires Vercel's
  domain verification. That is vendor-enforced and not tested here (UNKNOWN, low). Recommend removing the wildcard if
  no subdomain is used.
- **No DMARC record (`_dmarc` has no TXT) and no SPF at the apex.** Resend signs as `resend._domainkey` with the
  `send.` return-path. With no DMARC policy, mail forged as `@matflow.studio` is not rejected by receivers. That is a
  phishing aid against members and gym owners (SEC-091/SEC-095). Recommend apex `v=spf1 -all` (if the apex never sends)
  and `_dmarc` `v=DMARC1; p=quarantine; rua=…`, tightened to `p=reject` after alignment is confirmed.
  **E-F8 (Medium).**
- CAA restricts issuance to letsencrypt.org, pki.goog and sectigo.com (Vercel defaults).

## TLS and transport (SEC-071)
- Code/config: HSTS `max-age=63072000; includeSubDomains; preload` on every response (`next.config.ts`); CSP
  `upgrade-insecure-requests` in production; the Postgres client uses `ssl: { rejectUnauthorized: true }` in the
  readiness scripts. Certificates and protocol versions are Vercel-managed.
- `includeSubDomains` together with the wildcard is consistent: all subdomains are served by Vercel over HTTPS.
- Live verification **BLOCKED for lane E** (production inspection is the lead's). Commands for the lead:
  `curl -sI https://matflow.studio | grep -i "strict-transport\|content-security"` and
  `openssl s_client -connect matflow.studio:443 -servername matflow.studio -tls1_1 </dev/null` (expect handshake failure).

## Database and storage exposure (SEC-068, SEC-069)
- Neon: the production host is a `-pooler` endpoint (RELEASE-PACKAGE §4 expects `ep-bold-wave-abt39t7x`). Neon
  endpoints accept connections from the internet with password plus TLS unless the IP Allow feature is configured.
  IP Allow status is **UNKNOWN** (Neon console, Noe).
- **Inference for the lead (SEC-021/SEC-068):** Vercel has **no `MIGRATION_DATABASE_URL`**, so
  `scripts/maybe-migrate.mjs` runs `prisma migrate deploy` with **`DATABASE_URL`** on every production build. The
  runtime role must therefore hold DDL rights on `public` (CREATE TABLE, ALTER and CREATE POLICY need ownership or
  equivalent), which points to the table owner, typically `neondb_owner`, a member of `neon_superuser` with BYPASSRLS
  on Neon. FORCE ROW LEVEL SECURITY is set by `20260503200000_activate_rls_enforcement`, but FORCE does not bind a
  BYPASSRLS role. This is a configuration-derived expectation, **not a measurement**. The lead's
  `scripts/readiness/db-role-inspect.mjs` result decides it.
- Vercel Blob: all five `put()` call sites write `access: "private"` (`app/api/upload`,
  `app/api/initiatives/[id]/attachments`, `app/api/onboarding/csv-handoff`, `lib/import-storage.ts`,
  `lib/waiver-signature-upload.ts`). Reads go through auth-gated proxies (`/api/blob-image`,
  `/api/waiver/[id]/signature`). Whether **historic public blobs** (the August "public CSV blobs" finding) still sit in
  the store is UNKNOWN: listing needs the Blob token, which is a production credential. Token handling: E-06.
- Backups: the GitHub logical-backup workflow has never succeeded (E-05). Neon PITR window and plan are UNKNOWN.
  Lane F.

## Debug and management surface (SEC-072)
- No Prisma Studio, debug or seed route ships. Route inventory (`route-inventory.json`, 210 routes at 2a6487e): 15 routes carry
  no identity marker. All are deliberate anonymous entry points (login, MFA verify and recover, magic-link and disown
  tokens, `/api/apply`, `/api/tenant/[slug]`, `/api/waiver/open|kiosk-status`, `/api/health`). `/api/health` returns
  only `{status, db, timestamp}` (no version, no SHA, no error text).
- Test and debug switches are guarded in code: `DEMO_MODE` throws at boot in production (`auth.ts:57`);
  `isTestingMode()` refuses on `VERCEL_ENV=production` and on the production Neon endpoint (`lib/testing-mode.ts`); the
  E2E password bypass needs `isTestingMode() && isLocalhost` **and** `E2E_BYPASS_TOKEN`, which is not set in Vercel;
  the shared-secret admin tab renders only when `NODE_ENV !== "production"`; demo tenants in `/api/tenant/[slug]` only
  outside production. `TESTING_MODE` is nonetheless **set on Production and Preview** in Vercel. Production refuses it,
  but Preview honours it (MFA off on preview deployments; Preview has no DATABASE_URL, so preview builds have no data).
  Recommend deleting it from Production.
- Cron endpoints: 4 routes, 3 scheduled (`vercel.json`). **CRON_SECRET is not set**, so every cron answers 503 and does
  nothing (fail closed). Consequence: the **retention purge, class-instance generation and monthly reports do not run
  in production** (`lib/env-guards.ts` already warns). Availability and privacy-retention impact, handed to lane F.
  **E-F9 (Medium, compliance).**
- Operator plane: `/api/admin/*` (38 routes at 2a6487e, of which 15 are tenant-owner import/DSAR/email routes) and `/admin/*` pages. Legacy shared-secret header governed by
  `ALLOW_ADMIN_SECRET_HEADER` (set 4 days ago, so not in the serving build) and `MATFLOW_ADMIN_SECRET` (Production and
  Preview). Lane A owns its tests.
- Sentry: DSN only; no auth token; no source-map upload (next.config is not wrapped). Vercel Analytics script allowed by CSP.

## Cloud and repository account takeover (SEC-065)
Single human identity for GitHub (admin), Vercel (team "noetopalian's projects"), Neon, Stripe, Resend, the Vercel
registrar and DNS. The developer machine holds authenticated `gh` and `vercel` CLIs and a `.env` with production
credentials (known hazard) on an EOL Node (E-03). 2FA state of GitHub and Vercel: **UNKNOWN** (not readable with
current scopes). Takeover of that one identity equals full production control, because push deploys and migrates.
Recommend: confirm hardware-key or TOTP 2FA on GitHub, Vercel, Neon, Stripe and Resend; protect `main`; remove
production credentials from the laptop `.env` (memory notes `.env` is production). Status: **UNKNOWN, manual**.
