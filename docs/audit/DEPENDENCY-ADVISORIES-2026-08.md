# Dependency advisories — triage and remediation, August 2026

Date: 2026-08-18
Scope: `npm audit` on `main` working tree. Supersedes `docs/NPM-AUDIT-BASELINE.md` (2026-04-30).

| | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| Before | 3 | 14 | 13 | 2 | **32** |
| After | 0 | 4 | 0 | 0 | **4** |

`package.json` is **unchanged**. Every fix applied was inside the already-declared semver
ranges, so the entire remediation is a `package-lock.json` diff. The one exception is a
targeted `npm update brace-expansion` (also lockfile-only).

**Verification run:** `npx tsc --noEmit` → exit 0, no diagnostics. `npm run lint` → 0 errors,
64 pre-existing warnings, all UI-RULES ratchets at or below baseline. Build and test suite
were **not** run by this pass — see "What still needs a build" at the bottom.

---

## Method note on reachability

"Reachable" here means: the vulnerable code can be entered by a request that hits the
deployed application, or by data an attacker can influence. A package that only exists
because a CLI is listed in `dependencies` (e.g. `shadcn`) is *not* reachable — Next.js only
bundles what is actually imported, and nothing in `app/`, `lib/` or `components/` imports it.
A `devDependency` is not a production risk.

Reachability was checked with `npm ls <pkg> --all` for the dependency path and `grep` over
the source tree for the import, both cited per advisory below.

---

## CRITICAL

### 1. `next-auth` — configuration errors make existence-based auth checks fail open
**GHSA-8fpg-xm3f-6cx3** · critical · vulnerable `>=5.0.0-beta.0 <=5.0.0-beta.31` · was on `5.0.0-beta.30`

**Reachable: YES. This was the most serious advisory in the set.**

The advisory is that on a configuration error, Auth.js populates the `auth` object with an
error rather than leaving it null, so a check that only tests for *existence* passes. This
codebase does exactly that, in the route gate:

`proxy.ts:171`
```ts
if (!req.auth) {
  return NextResponse.redirect(new URL("/login", req.url));
}
```

and again at `lib/authz.ts:16` (`const session = await auth(); if (!session) redirect("/login")`).
`proxy.ts` is the single gate in front of every non-excluded route — `/dashboard/**`,
`/member/**`, and all tenant-scoped APIs — because the matcher at `proxy.ts:222` covers
everything except webhooks, cron, kiosk, health and static. A fail-open here is an
unauthenticated-access bug across the whole staff dashboard.

**Done:** `next-auth` 5.0.0-beta.30 → **5.0.0-beta.32** (in-range, lockfile only).
**Remaining action:** none. Consider hardening `proxy.ts` to check `req.auth?.user?.id`
rather than object existence, as defence in depth against a recurrence — that is a code
change, not applied here.

### 2. `@auth/core` — email normaliser validates before Unicode normalisation (homoglyph `@` bypass)
**GHSA-7rqj-j65f-68wh** · critical · vulnerable `>=0.1.0 <0.41.3` · was on `0.41.0` and `0.41.1` (two copies)

**Reachable: NO — the vulnerable code path is not wired up in this app.**

The vulnerable normaliser is only ever called from the Auth.js **Email (magic link)
provider**. Verified in the installed package: `normalizeIdentifier` appears only in
`@auth/core/providers/email.d.ts` and `@auth/core/lib/actions/signin/send-token.js:11`
(`const normalizer = provider.normalizeIdentifier ?? defaultNormalizer`).

This app registers only two providers (`auth.ts:128`): `Credentials` and `Google`. The
Email provider is not configured, so `send-token.js` is never entered. MatFlow's own
magic-link feature is a separate hand-rolled implementation under `app/api/magic-link/**`
that does not go through `@auth/core`'s token sender.

**Done:** upgraded anyway — `@auth/core` → **0.41.3**, and the two duplicate copies
deduplicated to one. `@auth/prisma-adapter` 2.11.1 → **2.11.3**.
**Remaining action:** none for the advisory.

**Adjacent observation, not this advisory, unverified:** MatFlow does not apply Unicode
NFKC normalisation to email addresses anywhere in its own code — `grep` for
`normalize("NFKC"|"NFKD"|…)` across the tree returns nothing. Emails are only lowercased and
trimmed (e.g. `lib/operator-auth.ts:184`) and validated with `z.string().email()`
(`lib/schemas/member.ts`, `app/api/apply/route.ts`). Whether the per-tenant unique-email
constraint can be confused by a homoglyph or a full-width `＠` is **not something this pass
tested**, and I am not claiming it is exploitable. It is worth a deliberate test, because the
failure mode would be two "different" member records that a human reads as the same address.

---

## HIGH — fixed

### 3. `next` — middleware/proxy bypass, Server Action SSRF and DoS (9 advisories)
**GHSA-6gpp-xcg3-4w24** (middleware/proxy bypass, App Router + Turbopack + single locale),
**GHSA-p9j2-gv94-2wf4** (SSRF via rewrites), **GHSA-89xv-2m56-2m9x** (SSRF in Server Actions
on custom servers), **GHSA-m99w-x7hq-7vfj** (Server Action DoS), plus 5 moderate cache/DoS
issues · vulnerable `>=16.0.0 <16.2.11` · was on `16.2.6`

**Reachable: treat as YES for the proxy bypass.** The app is App Router and `next.config.ts`
declares no `i18n`/locale configuration at all — i.e. the single-locale condition in the
advisory holds. The Turbopack condition I could not confirm without running a build: the
`build` script is a bare `next build` with no bundler flag and no `turbopack` key in
`next.config.ts`, so it inherits whatever Next 16 defaults to. Assume reachable.
Authorisation is enforced in `proxy.ts`,
so bypassing middleware bypasses the auth redirect, the role split (`role === "member"`
blocked from `/dashboard`, `proxy.ts:198`), the TOTP-pending gate and the `MAINTENANCE_MODE`
kill switch.

**Not reachable:** the two SSRF advisories. `next.config.ts` declares no `rewrites()` (only
`headers()` and one static `redirects()` entry at line 136), and the app deploys on Vercel
rather than a custom Node server.

**Done:** `next` 16.2.6 → **16.3.1**. This is a *minor* bump, not a patch — see the blast
radius note at the bottom.
**Remaining action:** the build must pass before this is trusted.

### 4. `sharp` / libvips — *NOT FIXED, see the HIGH-remaining section below*

### 5. `undici` — TLS cert-validation bypass and 11 related issues
**GHSA-vmh5-mc38-953g** (SOCKS5 `requestTls` dropped → TLS validation bypass),
**GHSA-4cwx-7wf7-3272** (cross-user disclosure via private cache directives),
**GHSA-vxpw-j846-p89q** (WebSocket DoS), plus cookie/CRLF/desync issues

Two independent copies:

| Path | Before | After | Production? |
|---|---|---|---|
| `@vercel/blob@2.3.3 → undici` | 6.25.0 | **6.28.0** | yes — server routes |
| `jsdom@29.1.0 → undici` | 7.25.0 | **7.29.0** | no — devDependency (Vitest DOM) |

**Reachable: partially.** The `@vercel/blob` copy is genuinely on a server path —
`put`/`del`/`head` are called from `app/api/upload/route.ts`,
`app/api/admin/import/upload/route.ts`, `app/api/admin/dsar/erase/route.ts`,
`app/api/cron/retention/route.ts`, `app/api/blob-image/route.ts` and others. However the
**TLS bypass advisory specifically requires a SOCKS5 `ProxyAgent`**, which this app never
configures; and all traffic goes to a single fixed trusted host (`*.vercel-storage.com`)
with no attacker-controlled URL. So the critical-shaped part was not exploitable; the
cache/cookie issues were the live ones and are academic against one trusted host.
The `jsdom` copy is test-only.

**Done:** both upgraded. **Remaining action:** none. This closes the one HIGH that
`docs/NPM-AUDIT-BASELINE.md` (April) flagged as "the next target".

### 6. `postcss` — arbitrary file read via attacker-controlled `sourceMappingURL`
**GHSA-6g55-p6wh-862q**, **GHSA-r28c-9q8g-f849** (high) + 2 moderate · was on 8.4.31 (nested in `next`) and 8.5.12 (via `@tailwindcss/postcss`)

**Reachable: NO in any meaningful sense.** PostCSS runs at **build time only**, over CSS
this repo authors (`app/globals.css` and Tailwind v4 output). The vulnerability requires the
attacker to control a `/*# sourceMappingURL=... */` comment in CSS fed to PostCSS. Nothing
in the app pipes user-supplied CSS through PostCSS at runtime. Exploiting it would require
commit access, at which point arbitrary file read is not the interesting attack.

**Done:** 8.4.31 → **8.5.23** (nested in `next`), 8.5.12 → **8.5.26** (top level). Free ride
with the other bumps.

### 7. `nanoid` — infinite loop on zero/negative size
**GHSA-2v37-7h3g-55p8**, **GHSA-28wg-ghj8-5hjv** · was 3.3.11 → **3.3.18**

**Reachable: NO.** Only reached through `postcss` (build time). MatFlow generates its own
IDs with `crypto.randomUUID()` (`proxy.ts:11`) and `randomBytes` (`app/api/upload/route.ts:3`),
not nanoid.

### 8. `ip-address` — SSRF / trust-boundary bypass via octal-vs-decimal octet decoding
**GHSA-mwp4-54f8-5fhr** (high) + 2 moderate · was 10.2.0 → **10.5.0**

**Reachable: NO.** The only path is
`shadcn@4.0.0 → @modelcontextprotocol/sdk@1.27.1 → express-rate-limit@8.5.1 → ip-address`.
`shadcn` is a **component-scaffolding CLI** (`npx shadcn add …`); it is listed in
`dependencies` but nothing imports it — `grep -rn "shadcn"` over `.ts`/`.tsx` returns only
`components.json` (a config file) and `package.json`. There is no Express server here and no
`express-rate-limit` in the request path; MatFlow's own rate limiting is `checkRateLimit`
in `auth.ts`, DB-backed and keyed on `x-forwarded-for`.

**See "Recommended, not applied" below** — `shadcn` belongs in `devDependencies`, and moving
it would remove `ip-address`, `express-rate-limit`, `hono`, `@babel/core`, `js-yaml` and
`fast-uri` from the production dependency tree entirely.

### 9. `js-yaml`, `fast-uri`, `brace-expansion`, `@babel/core`, `vite`, `hono`
All **build/dev/CLI-only**, all fixed as a side effect. Paths verified with `npm ls --all`:

| Package | Path | Before → After | Why not production |
|---|---|---|---|
| `js-yaml` | `eslint → @eslint/eslintrc`; `shadcn → cosmiconfig` | 4.1.1 → **4.3.1** | lint-time config parsing |
| `fast-uri` | `@sentry/webpack-plugin → webpack → ajv`; `prisma → @prisma/dev`; `shadcn → MCP SDK` | 3.1.2 → **3.1.5** | build tooling / CLI |
| `brace-expansion` | `eslint → minimatch@3` (1.x) and Sentry/TS-ESLint globs (5.x) | 1.1.14 → **1.1.18**, 5.0.5 → **5.0.9** | glob DoS in lint tooling |
| `@babel/core` | `shadcn`, `@sentry/bundler-plugin-core`, `eslint-plugin-react-hooks` | 7.29.0 → **7.29.7** | build/lint only |
| `vite` | `vitest`, `@vitejs/plugin-react` — **devDependency** | 8.0.8 → **8.2.1** | test runner; the `server.fs.deny` bypass needs a running dev Vite server |
| `hono` / `@hono/node-server` | `prisma → @prisma/dev` (Prisma Studio); `shadcn → MCP SDK` | 4.12.18 → **4.13.2**, 1.19.11/1.19.14 → **1.19.17** | Prisma Studio is a local-dev tool, never deployed |

`vite`'s `server.fs.deny` bypass (GHSA-fx2h-pf6j-xcff) and the `launch-editor` NTLMv2 hash
disclosure (GHSA-v6wh-96g9-6wx3) are Windows-specific and require an exposed dev server.
Local dev binds `--port 3847` on localhost. Not a production concern, but worth knowing if
anyone ever tunnels the dev server.

---

## MODERATE — fixed

- **`@sentry/*` → `@opentelemetry/core` unbounded memory in W3C Baggage** (GHSA-8988-4f7v-96qf).
  *Reachable in production* — `@sentry/nextjs` instruments the server runtime, and Baggage
  headers arrive with inbound requests. Fixed: `@opentelemetry/core` 2.7.1 → **2.10.0**,
  `@sentry/*` 10.51.0 → **10.70.0** across the board (in-range minor).
- **`resend → svix → uuid` missing buffer bounds check** (GHSA-w5hq-g745-h8pq). April's
  baseline deferred this as needing a breaking `resend` bump; it no longer does.
  `resend` 6.12.2 → **6.20.0**, and the vulnerable nested `svix`/`uuid` pair is gone from the
  tree entirely (`uuid` no longer installed).
- **`valibot`, `@prisma/dev`, `qs`, `body-parser`** — all Prisma-CLI / tooling paths.
  Fixed: `valibot` 1.2.0 → **1.4.2**, `@prisma/dev` 0.24.3 → **0.24.17**, `qs` → **6.15.3**,
  `body-parser` → **2.3.0**.

---

## HIGH — REMAINING, NOT FIXED

### R1. `sharp` < 0.35.0 — inherited libvips CVEs · **the top residual risk**
**GHSA-f88m-g3jw-g9cj** — CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591
Installed: **0.34.5** (direct dependency, `^0.34.5`)

**Reachable: YES, with attacker-influenced input. This is the one that should worry you.**

`app/api/upload/route.ts:4` imports sharp directly and, at lines 176–185, decodes and
re-encodes a **user-supplied image buffer**:

```ts
const pipeline = sharp(uploadBuffer).rotate(); // honour EXIF orientation
…
const out = await resized.webp({ quality: … }).toBuffer();
const meta = await sharp(out).metadata();
```

That is libvips parsing hostile bytes inside the server process. The uploader must be
authenticated, but "authenticated" here includes any staff member of any tenant and — for
`profile-pic` / `member-photo` purposes — **the member themselves** (`MEMBER_SCOPED_PURPOSES`,
same file). For a multi-tenant app holding payment data and children's records, a
memory-corruption class bug reachable by any gym member is not something to leave open
indefinitely.

Existing mitigations, which reduce but do not eliminate this: a `ALLOWED_TYPES` allowlist,
a magic-byte header check (`MAGIC_BYTES`), a 2 MB cap (`MAX_BYTES`), and a `try/catch` that
returns 400 on decode failure. None of these stop a well-formed file whose *interior*
triggers a libvips bug.

**Deliberately not applied: the fix is a semver-major bump and the test suite could not be
run in this pass.** The exact command:

```sh
npm i sharp@0.35.3      # then: npm run lint && npm test && npm run build
```

**Expected blast radius:** sharp 0.35 raises its engine floor from
`^18.17.0 || ^20.3.0 || >=21.0.0` to **`>=20.9.0`** — check the Node version pinned on Vercel
before shipping. It also ships a new libvips and new prebuilt native binaries, so the risk is
(a) install//native-binary failure on the deploy platform and (b) subtle output differences in
`.rotate()`, `.resize({fit:"cover"/"inside"})` and `.webp()`. `tests/unit/upload-blob.test.ts`
imports sharp directly and is the test that will catch behaviour drift.

**Note — a partial fix already landed by accident.** Because `next` moved to 16.3.1, Next now
installs its **own** nested `sharp@0.35.3` at `node_modules/next/node_modules/sharp`. So the
**Image Optimization API is already on patched libvips**; only MatFlow's own `import sharp`
in `app/api/upload/route.ts` still resolves to the vulnerable hoisted 0.34.5. Two libvips
copies now ship. Bumping the direct dependency to 0.35.3 would also collapse them back to one.

**Recommendation: do this one, deliberately, with the full test suite and a preview deploy.**
It is the only remaining advisory with a genuine attacker-reachable path.

### R2. `prisma` → `@prisma/config` → `deepmerge-ts` < 8.0.0 — stack exhaustion
**GHSA-ggr8-5vv4-36mx** · high · installed `deepmerge-ts@7.1.5` under `prisma@7.9.1`

**Reachable: NO.** `deepmerge-ts` is used by `@prisma/config` to merge `prisma.config.ts`
with defaults — a **build/CLI-time** operation (`prisma generate` in `postinstall`,
`prisma migrate`, `scripts/maybe-migrate.mjs`). The runtime client is `@prisma/client`,
which does not depend on it. The attack requires feeding a recursive object graph into
Prisma's own config merge; the config is a file in this repo.

**Deliberately not applied, and it must not be.** npm's "fix" is nonsense here:

```sh
npm audit fix --force   # would install prisma@6.12.0 — a MAJOR DOWNGRADE
```

`@prisma/client` is on 7.4.2 and the schema uses the `@prisma/adapter-pg` driver adapter with
migrations under `prisma/migrations/`. Downgrading the CLI from 7.9.1 to 6.12.0 would
desynchronise the CLI from the client, very likely break `prisma generate` and
`prisma migrate`, and is a strictly worse security position. **Do not run
`npm audit fix --force` on this repo.**

**Remaining action:** none now. Wait for Prisma to ship `@prisma/config` on `deepmerge-ts@8`.
Re-check on the next Prisma bump. Residual risk: negligible.

---

## Recommended, not applied

### Move `shadcn` from `dependencies` to `devDependencies`

```sh
npm uninstall shadcn && npm i -D shadcn@^4.0.0
```

`shadcn` is a scaffolding CLI. Nothing imports it (`grep -rn "shadcn" --include=*.ts
--include=*.tsx` → only `components.json`). Listing it under `dependencies` drags
`@modelcontextprotocol/sdk`, `express-rate-limit`, `ip-address`, `hono`, `@babel/core`,
`ts-morph`, `js-yaml`, `cosmiconfig` and `ajv`/`fast-uri` into the **production** dependency
tree — which is why six of the advisories above had to be triaged at all. It changes nothing
about what Next bundles, and Vercel installs devDependencies at build time, so `npx shadcn add`
keeps working.

**Blast radius:** low, but non-zero — it breaks any install that runs with `--omit=dev`, and
it is a `package.json` change rather than a lockfile one. Left for the owner to decide.

### Harden the auth-existence checks in `proxy.ts` / `lib/authz.ts`

Advisory 1 above was a fail-open triggered by *existence* checks. `proxy.ts:171` and
`lib/authz.ts:16` still test for object existence rather than for a usable identity. Changing
them to assert on `req.auth?.user?.id` / `session?.user?.id` would make the app immune to a
recurrence of that bug class. Code change, out of scope for a dependency pass.

---

## What still needs a build

`npx tsc --noEmit` is clean and `npm run lint` has 0 errors, but **neither the test suite nor
`next build` was run** in this pass. The changes that a build could plausibly break, in
descending order of risk:

1. **`next` 16.2.6 → 16.3.1** — a *minor* bump, not a patch. The advisories were fixed in
   16.2.11, so if the build or tests break, the minimal-change fallback is:
   ```sh
   npm i next@16.2.12      # patched, stays on the 16.2 line
   ```
   That is fully advisory-clean and a far smaller delta.
2. **`@sentry/*` 10.51.0 → 10.70.0** — restructured internals (`@sentry-internal/*` packages
   replaced, OpenTelemetry instrumentation reorganised). Watch that server-side error capture
   and source-map upload still work after deploy.
3. **`prisma` CLI 7.8.0 → 7.9.1** — engines bumped. `postinstall` already ran
   `prisma generate` successfully during the fix. `@prisma/client` is unchanged at 7.4.2.
4. **`resend` 6.12.2 → 6.20.0** — check `lib/email.ts` still sends. Note `lib/email.ts` has
   uncommitted changes from a parallel session, so read it before assuming.

## Re-check cadence

Re-run `npm audit` after any direct-dependency bump, and re-snapshot this file. The two
open items to track are **`sharp@0.35.3`** (act on it) and **Prisma shipping `deepmerge-ts@8`**
(wait for it).
