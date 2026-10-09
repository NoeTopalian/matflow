# Asset inventory: MatFlow

Built 9 Oct 2026 by security campaign lane E from the code and manifests at candidate **`2a6487e`** (source and
lockfile equal to the tested build `c837e38`, BUILD_ID `xP9P9cHvx9xkgqHPXnOa9`). It is supplemented by read-only
Vercel and GitHub control-plane listings. Production currently serves **`e8afb6a`** (4 Oct). Where this file states
something about production, it gives the source. Anything marked UNKNOWN has not been measured.
Reproduce: `node scripts/readiness/asset-inventory.mjs --json <out> --markdown <out>` (routes),
`node scripts/readiness/supply-chain-check.mjs --audit --osv` (dependencies), `node scripts/readiness/secret-scan.mjs`
(secrets). Evidence: `docs/security/evidence/E/`.

## 1. Runtime and hosting
| Asset | Value | Source |
|---|---|---|
| Framework | Next.js **16.3.8** (candidate; production 16.3.3), React 19.2.3, NextAuth v5 beta (`next-auth ^5.0.0-beta.30`, JWT sessions, 30-day maxAge), Prisma client 7.4.2 + `@prisma/adapter-pg` (query compiler, no native query engine), `pg` 8.20.0 | package.json, lockfile, `auth.ts:274-276`, `prisma --version` |
| Host | Vercel project `matflow` (team "noetopalian's projects"), region `lhr1`, Node **24.x**, install command default (`npm install`), build `npm run build` = `node scripts/maybe-migrate.mjs && next build` | `vercel project inspect`, `vercel.json`, package.json |
| Edge/middleware | `proxy.ts` (Next 16 proxy): maintenance switch, public-path list, MFA gates, request ids | `proxy.ts` |
| Security headers | CSP (no `unsafe-eval` in production), HSTS 2 years with includeSubDomains and preload, XFO DENY, COOP/COEP/CORP, Permissions-Policy, `no-store` on auth, admin, `/api/me`, `/api/settings` and magic-link | `next.config.ts` |
| Production URLs | `https://matflow.studio` (custom, public); `matflow-nine.vercel.app`, `matflow-noetopalians-projects.vercel.app`, `matflow-git-main-noetopalians-projects.vercel.app` (behind Vercel SSO) | `vercel alias ls` |
| Retained deployments | **63 old production deployments** (61 Ready, 2 Error) plus the serving one. **10 dangling branch aliases**. 0 preview deployments | E-04 |
| Domain and DNS | `matflow.studio` registered at Vercel (expires 29 Apr 2027), Vercel DNS, **wildcard `*` ALIAS**, Resend `send.` MX/SPF + DKIM, default CAA; **no DMARC, no apex SPF** | E-07 |
| Node elsewhere | CI Node 22, developer machine Node **25.9.0 (EOL)** | E-03 |

## 2. Entry points (210 route handlers at 2a6487e, 57 pages, 0 Server Action files)
The full table is in `evidence/E/route-inventory.md` (URL, methods, area, guard markers, integrations).
| Area | Routes | Notes |
|---|---|---|
| Staff/tenant API (`/api/*` default, incl. `/api/members/*`) | 112 | occurrences in route files: `assertSameOrigin` 298, `requireApiOwner` 91, `requireApiOwnerOrManager` 68, `requireApiStaff` 27, `requireStepUp` 23 (imports included) |
| Operator plane `/api/admin/*` | 38 (39 in the working tree with lane A's uncommitted `revoke-access`) | Operator session plus MFA plus allowlist (`getOperatorContext`, `isAdminAuthed`). **15 tenant-owner routes also live under `/api/admin/`** (12 `import/*`, 2 `dsar/*`, `email/test`). The path prefix is not the trust plane |
| Member `/api/member/*` + self `/api/me` | 31 + 1 | Member session; family/guardian authority (`lib/family-authority.ts`) |
| Auth `/api/auth/*`, `/api/magic-link/*` | 14 | NextAuth credentials, TOTP setup/verify/recover, password reset, magic link, disown-login token |
| Kiosk `/api/kiosk/[token]/*`, `/api/checkin*` | 6 | Kiosk token (HMAC), card token, staff session |
| Cron `/api/cron/*` | 4 (3 scheduled in `vercel.json`) | Bearer `CRON_SECRET`. **Unset in Vercel, so all answer 503** |
| Webhooks | 2 | `/api/stripe/webhook` (Stripe signature; 400 without a secret), `/api/webhooks/resend` (svix; 503 in production without `RESEND_WEBHOOK_SECRET`, which is unset) |
| Public, no identity | 15 | login and MFA verify/recover, magic-link and disown tokens, `/api/apply` (rate-limited), `/api/tenant/[slug]`, `/api/waiver/open`, `/api/waiver/kiosk-status`, `/api/health` (`{status, db, timestamp}` only) |
| Pages | 57 | dashboard 21, member 10, admin 8, legal 4, login 4, kiosk, waiver, apply, onboarding, set-password, leaderboard, print, preview (static demo branding), `[slug]` |

## 3. Background jobs
| Job | Trigger | Authority | State today |
|---|---|---|---|
| `/api/cron/monthly-reports` (Anthropic causal report) | `0 2 1 * *` | CRON_SECRET | inert (503: secret unset; `ANTHROPIC_API_KEY` unset) |
| `/api/cron/retention` (purge, blob delete, Stripe) | `30 3 * * *` | CRON_SECRET | **inert: retention purge not running** |
| `/api/cron/class-instances` | `40 2 * * *` | CRON_SECRET | inert (generated from the UI instead) |
| `/api/cron/stripe-reconcile` | not scheduled | CRON_SECRET | manual only |
| Build-time migration | every production build | `DATABASE_URL` (no `MIGRATION_DATABASE_URL` in Vercel) | runs `prisma migrate deploy` on push to `main` |
| GitHub Actions: CI, nightly e2e, weekly `pg_dump` | push/PR, cron | none / none / Actions secrets (none exist) | **CI red on main since 2 Oct; e2e red; backup has never succeeded** |

## 4. Parsers and untrusted-input processors
| Parser | Input source | Code | Bounds |
|---|---|---|---|
| Image decode and re-encode (**native libvips**: png, jpeg, webp loaders; exif, lcms) | `/api/upload` (members for their own photo; staff; owners for branding) | `app/api/upload/route.ts` | 4 MB, declared type plus magic bytes, default sharp pixel limit |
| CSV (TeamUp members and attendance exports, onboarding hand-off, chunked uploads) | owner and operator uploads | `lib/csv.ts`, `lib/importers/{teamup,attendance,sniff,teamup-exceptions,teamup-refresh}.ts`, `lib/import-upload.ts`, `/api/admin/import/uploads/*` | 10 MB hand-off; chunked upload (`ImportUpload`/`ImportUploadChunk`) |
| CSV export (formula-injection surface) | DB → owner download | `lib/csv.ts`, attendance export, DSAR export | lane D (SEC-052) |
| File attachments (stored, **not parsed**) | initiatives | `/api/initiatives/[id]/attachments` | png/jpeg/webp/pdf, magic bytes, 10 MB |
| Signature PNG | waiver signing | `lib/waiver-signature-upload.ts` | — |
| JSON bodies | all API routes | zod schemas (`zod ^4.3.6`) | strictness varies (AH-G6, lane C) |
| Multipart | upload, attachments, csv-handoff | `req.formData()` | Vercel ~4.5 MB body limit on functions |
| Webhook payloads | Stripe, Resend (svix) | signature verified before parse | — |
| QR decode | device camera (client side) | `jsqr` | client only |
| Third-party API responses | Stripe, Google Drive (`googleapis`), Anthropic, Resend, Vercel Blob | `lib/stripe*`, `lib/google-drive.ts`, `lib/ai-causal-report.ts`, `lib/email.ts` | Drive and Anthropic inactive (keys unset) |
No XML, archive (zip), PDF or office-document parser runs server-side. That is verified by dependency and import
search; the libvips archive and xml2 libraries ship in the binary but are unreachable from the upload path.

## 5. Identities, credentials and tokens
| Identity / token | Store | Notes |
|---|---|---|
| Staff `User` (roles owner, manager, coach, admin) | `User` (bcryptjs hashes, TOTP, recovery codes, `sessionVersion`, `PasswordHistory`) | Elevated roles require MFA (`lib/mfa-policy.ts`) |
| `Member` (+ guardian/children links) | `Member` (optional password, TOTP) | noLogin and managed records (lane A/B) |
| Platform `Operator` | `Operator` (password, TOTP, enrolment ticket, step-up grants v2) | Allowlist `OPERATOR_ALLOWED_IDS`, **not yet set in Vercel**: nobody is admitted after the release until it is set |
| Session JWT | cookie (NextAuth), signed with `NEXTAUTH_SECRET` | Shared by the 63 old deployments; also set on Preview |
| Operator session, support session, impersonation | `lib/operator-auth.ts`, `lib/support-session.ts`, `lib/impersonation.ts` | lane A |
| Magic link, password reset, activation, disown tokens | `MagicLinkToken`, `PasswordResetToken` (hashed, `lib/token-hash.ts`) | AH-D2 subject binding (lane A) |
| Kiosk token, card token | HMAC (`lib/kiosk-token.ts`, `lib/card-token.ts`) | — |
| Shared admin secret | `MATFLOW_ADMIN_SECRET` (Production and Preview), header switch `ALLOW_ADMIN_SECRET_HEADER` | rotation planned. Old builds keep the old value |
| Cron secret | `CRON_SECRET` | **unset** |
| Service credentials | `DATABASE_URL`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_CLIENT_ID`, `RESEND_API_KEY`, `BLOB_READ_WRITE_TOKEN` (**stored Non-sensitive; Production, Preview and Development**), `SENTRY_DSN` | `vercel env ls` (names only) |
| E2E bypass | `E2E_BYPASS_TOKEN` (.env.test only), honoured only with TESTING_MODE on localhost | not set in Vercel |

## 6. Trust boundaries
1. Internet → Vercel edge → `proxy.ts` → route handlers (anonymous, member, staff, operator).
2. Tenant boundary inside one database: application `where: { tenantId }` plus RLS through `withTenantContext`
   (FORCE RLS since `20260503200000`). **The effective production role is UNKNOWN** (lead, SEC-021/068). Config implies
   it is the DDL-capable owner (E-07).
3. Operator plane versus tenant plane (allowlist plus MFA plus step-up).
4. Kiosk device (token) versus staff session.
5. Build machine (Vercel build, holds production DATABASE_URL, runs install scripts and migrations) versus runtime.
6. Third parties: Stripe Connect (Standard; gyms carry their own liability), Resend (mail, currently dark),
   Vercel Blob (private), Neon, Sentry (EU ingest), Google Drive and Anthropic (inactive), Vercel Analytics.
7. Developer endpoint (Windows, Node 25 EOL, `.env` holding production credentials, authenticated `gh` and `vercel`
   CLIs) → production through push-to-deploy.
8. GitHub (public repository, unprotected `main`) → Vercel production through the Git integration.

## 7. Storage
| Store | What | Access |
|---|---|---|
| Neon Postgres (production endpoint `ep-bold-wave-…`, pooled host) | 52 Prisma models (Tenant, User, Member, AttendanceRecord, SignedWaiver, AuditLog, ImportJob, Payment, Operator, …) | password + TLS. IP allow-list UNKNOWN |
| Neon TEST branch `ep-hidden-salad-…` | synthetic campaign data | guarded runners (owner role, `matflow_app` restricted) |
| Vercel Blob | member photos, branding, signatures, initiative attachments, import CSVs | all writes `access: "private"`; served by auth-gated proxies. Historic public blobs UNKNOWN |
| Browser | session cookie, PWA service worker (`app/sw.ts`) | push not live |
| Sentry | error events (scrubbed, `lib/sentry-scrub.ts`) | DSN public |

## 8. Database roles and backups
- Production runtime role: **UNKNOWN**, pending the lead's `scripts/readiness/db-role-inspect.mjs` result.
  Migrations run with the same `DATABASE_URL`.
- TEST: the owner role (engine runner) and `matflow_app` (NOBYPASSRLS; `scripts/create-restricted-role.ts`).
- CI: stock `postgres` superuser plus `matflow_app` created by `scripts/ci-create-restricted-role.sql`.
- Backups: Neon PITR (window and plan UNKNOWN). GitHub `pg_dump` → S3 workflow **never succeeded** (no Actions
  secrets). No restore drill evidence in lane E (lane F).

## 9. Privileged people and service accounts
One human (Noe) holds every privileged role: GitHub owner/admin (1 collaborator), Vercel team owner, domain
registrant, Neon, Stripe, Resend, and the platform Operator. Sean Coates is the owner of the totalbjj tenant (tenant
plane only). Service identities: the Vercel GitHub App (deploys), Vercel cron (CRON_SECRET, unset), Stripe and Resend
webhooks (signing secrets), and the CI runners (no secrets). 2FA on GitHub and Vercel is **UNKNOWN**.

## 10. Dependencies and native code
1,173 lockfile entries, all from registry.npmjs.org with sha512. Install scripts: `@prisma/engines`, `prisma`,
`@sentry/cli`, `fsevents`, `unrs-resolver` (dev). Native at runtime: sharp/libvips only. Native at build time:
`@next/swc`, the Prisma schema engine (downloaded by postinstall), lightningcss and tailwind oxide (dev). See
`ADVISORY-REGISTER.md` and evidence E-02/E-03.
