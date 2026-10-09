# E-06 Secret scan: history, tree, client and server bundles (SEC-062, SEC-067)

Lane E, 9 Oct 2026. Tool: `scripts/readiness/secret-scan.mjs` (new; 17 rules; output carries rule, location, length,
public prefix and a 12-hex SHA-256 fingerprint, **never the value**). Summary JSON:
`secret-scan-summary-2026-10-09.json`. No secret value appears in any file lane E wrote. A masking helper printed
candidate lines as character shapes (`a`/`A`/`9`) for triage.

| Scope | Command | Scanned | Non-placeholder candidates | Exit |
|---|---|---|---|---|
| Full git history (all refs; the repository is public) | `node scripts/readiness/secret-scan.mjs --history` | 5,949 unique blobs | 10 (7 unique) | 1 |
| Tracked tree at 2a6487e | `--tree` | 1,749 files | 5 (2 unique values) | 1 |
| Client bundles `.next/static` (build xP9P9cHvx9xkgqHPXnOa9) | `--dir .next/static` | 119 files | **0** | 0 |
| Server output `.next/server` | `--dir .next/server` | 4,279 files | 2: the PEM private-key header literal (redacted here so this evidence file does not itself trip the scanner) inside the jose `importPKCS8` source in `@auth/core` server source maps. A library string, **not a key** | 1 |

## Triage
1. **`docs/SECURITY-AUDIT-2026-05-07.md`, original version `fa3c460` (7 May; superseded by `2ee3bfb`, 9 May), public
   history.** It holds a Neon role password (`npg_` form), a Resend API key (`re_` format, 36 characters), a
   64-hex CRON_SECRET and a truncated Stripe restricted-key prefix (`rk_live_` + 17). The file's own incident note
   says the DB password was rotated on 7 May and the Resend key, Stripe key and CRON_SECRET on 9 May, after a
   GitGuardian alert. History was deliberately not rewritten. **Lane E cannot verify the rotation read-only.** Checking
   would mean using the credential, which is out of scope. Indirect evidence: `vercel env ls` shows DATABASE_URL created
   163 days ago (late April, before the leak), so the Vercel entry was not re-created on 7 May. It may have been
   edited in place, since `vercel env ls` shows creation and not modification. CRON_SECRET is not set in Vercel at all
   today. Disposition: **UNKNOWN (rotation unverified)**. Required: Noe confirms in the Neon, Resend and Stripe
   dashboards that the leaked credentials are revoked (each shows creation dates of active keys). Lane E does not ask
   for any value.
2. The truncated Stripe live-key prefix (fingerprint `7d3bddd6e499`) is **re-used as a fixture** in
   `tests/unit/stripe-connect-health-readiness.test.ts:111` and `tests/unit/stripe-key-mode.test.ts:18,107` (tree and
   history). It is a prefix only, so it cannot authenticate, but it repeats the real account's key prefix in a public
   repository. Low. Recommend a synthetic value (`rk_live_` + a run of `0`, which the scanner already classifies as a
   placeholder). This is outside lane E's file scope, so it is proposed, not edited.
3. Everything else is a placeholder or fixture (`.env.example` "replace-with-…", `sk_live_guardwiringprobe`,
   `sk_live_deadbeef`, localhost Postgres URLs, `ci-test-secret-not-real…`). The `.env*` files other than
   `.env.example` were never committed (`git log --all -- .env` is empty, as the 7 May note says).
4. No browser source maps are emitted (`find .next/static -name "*.map"` → 0; `productionBrowserSourceMaps` unset).
   Server-side `.map` files (1,319) are not publicly served. The client bundle references only
   `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_VERCEL_ENV` and `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH`. All are public by design.
5. Logs: lane E did not read Vercel runtime or build logs (lead-only production inspection). CI logs were not
   downloaded. The workflow env blocks hold only literal CI-only values. Log-sink secret disclosure is lane F (SEC-082).

## Configuration findings (Vercel env, names only)
- **BLOB_READ_WRITE_TOKEN is stored as "Non-sensitive"** and scoped to Production, Preview **and Development**. Anyone
  with project access can read it, and `vercel env pull` writes it into developer `.env` files. It grants read/write on
  the private member-photo and waiver store. Recommend: regenerate the token, store it as Sensitive, and scope it to
  Production only, with a separate store for Preview. (`vercel env ls` itself prints a truncated prefix of
  non-sensitive values. Lane E removed that column from its evidence.)
- **Preview scope holds production-grade secrets**: NEXTAUTH_SECRET, STRIPE_SECRET_KEY, RESEND_API_KEY,
  MATFLOW_ADMIN_SECRET and STRIPE_WEBHOOK_SECRET are on Production **and** Preview, with TESTING_MODE also on Preview.
  The repository is public, but only collaborators (1) can push branches that create Preview deployments, so the
  exposure is "any branch Noe pushes runs with production signing and payment keys". Whether the Preview values
  equal the Production values is **UNKNOWN** (sensitive values cannot be read). If NEXTAUTH_SECRET is shared, a session
  minted by a preview build verifies in production. Recommend distinct Preview values (test-mode Stripe, a separate
  signing key, no Resend key).
- Variables the code reads that are absent in Vercel: CRON_SECRET (every cron returns 503; retention purge not
  running), RESEND_WEBHOOK_SECRET (webhook 503 in production, fail closed), OPERATOR_ALLOWED_IDS (prerequisite 2 of the
  release), ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID/SECRET, VAPID keys (those features are inert). AUTH_SECRET is absent,
  and NEXTAUTH_SECRET is used.

SEC-062: **APPLICABLE**; historical leak present in public history, rotation **UNKNOWN**; no live secret in tree or
client bundles found by these patterns (a pattern scan is not proof of absence). SEC-067: **APPLICABLE, OPEN** (Blob
token classification, shared Preview secrets, old deployments holding live credentials, E-04).
