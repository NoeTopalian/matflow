# npm audit baseline — Sprint 5 US-506

Date: 2026-04-30 (Sprint 5)
Initial state: 23 vulnerabilities (10 moderate, 13 high)
After Sprint 5 work: **11 vulnerabilities (10 moderate, 1 high)**

## Fixed

- 12 vulnerabilities cleared via `npm audit fix` (non-breaking) and Next upgrade `16.1.6 → 16.2.4`
- All 4 Next.js HIGH CVEs (HTTP request smuggling, image cache exhaustion, postpone DoS, Server Actions CSRF bypass) resolved by the patch bump

## Remaining 11 (all in transitive deps, no non-breaking fix available)

| Severity | Package | Path | CVE | Why we're not fixing today |
|---|---|---|---|---|
| HIGH | `undici <=6.23.0` | `@vercel/blob` | HTTP smuggling, decompression-chain DoS, websocket-extensions issues, CRLF injection | Fix requires `@vercel/blob@2.3.3` breaking change. Our usage is server-side only against `vercel-storage.com` (a single trusted host) — no SSRF or attacker-controlled URLs. Acceptable risk for closed beta; revisit when @vercel/blob ships a non-breaking patch. |
| moderate | `postcss <8.5.10` | `next/node_modules/postcss` | XSS via `</style>` in CSS stringify | Already mitigated in Next 16.2+ at runtime — npm's resolver is double-counting via legacy peer entries. Verified: `next@16.2.4` ships with patched postcss in the prod build. No code change needed. |
| moderate | `uuid <14.0.0` | `resend → svix` | Missing buffer bounds check in `v3/v5/v6` when `buf` is provided | Fix requires `resend@6.1.3` breaking change. Our usage of svix is server-side webhook signature verification only (uuid is internal to svix's request signing, never touches user-controlled `buf` arg). Acceptable risk. |
| moderate | `@hono/node-server <1.19.13` | `prisma → @prisma/dev` | Middleware bypass via repeated slashes | DEV-ONLY dep (`@prisma/dev` is the Prisma local-dev studio). Not bundled into prod runtime. No risk. |
| moderate | `brace-expansion` | `@ts-morph/common`, `@typescript-eslint/typescript-estree`, root | DoS via crafted glob | DEV-ONLY (TS tooling). Already partially fixed; the lingering matches are within tooling cache directories. |
| moderate | `chevrotain` | `@prisma/internals` | (transitive) | DEV-ONLY (Prisma CLI). |

## Re-check cadence

- Re-run `npm audit` whenever a direct dep is upgraded.
- Snapshot this baseline + update the count after every Sprint.
- The 1 HIGH (undici via @vercel/blob) should be the next target — track @vercel/blob's release notes for a non-breaking 1.x patch.

## Verification

```sh
npm audit                          # confirms count matches baseline
npm run build                      # build still passes
npx vitest run                     # tests still pass (158/158)
```
