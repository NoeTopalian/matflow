# C-03 Lane C commands, environment and exit codes (9 Oct 2026)

Environment: Windows 11, Node 25.9.0 (local; CI is 22, Vercel 24.x), vitest 4.1.11, zod 4.3.6, next 16.3.8,
react 19.2.3, @vercel/blob from the lockfile. Working tree on `5680c5d`, then `3deb7c7` (lead commits of lanes E/B
landed during the run; neither touched lane C files). No database was written. No build was made.

| Step | Command (repo root) | Exit | Notes |
|---|---|---|---|
| Body inventory | `node docs/security/evidence/C/scripts/body-inventory.cjs <repoRoot> --md docs/security/evidence/C/C-01-json-body-inventory.md` | 0 | 120 body-reading routes (112 JSON, 4 form, 4 text) |
| Canary sweep | `SEC_C_SWEEP_OUT=<file> npx vitest run tests/unit/sec-c-body-canary-sweep.test.ts` | 0 | 238/238; log `C-run-body-canary-sweep.log`, results `C-body-canary-sweep-results.json` |
| Owner login-email | `npx vitest run tests/unit/sec-c-owner-login-email-body.test.ts` | 0 | 23/23 |
| CSRF sweep | `SEC_C_CSRF_OUT=<file> npx vitest run tests/unit/sec-c-csrf-sweep.test.ts` | 0 | 424/424 (SF-C3 pinned); results `C-csrf-sweep-results.json` |
| Blob store pin (red) | `npx vitest run tests/unit/sec-c-blob-store-pin.test.ts` before the fix | 1 | 5 failing — `C-red-blob-store-pin.log` |
| Blob store pin (green) | same + `blob-url`, `blob-image-proxy`, `upload-blob`, `member-delete-photo-blobs`, `supervised-waiver-tenant-scope`, `initiative-attachment-validation-order`, `onboarding-csv-handoff`, `import-storage` suites | 0 | 96/96 |
| Export cache (red) | `npx vitest run tests/unit/sec-c-export-cache.test.ts` before the fix | 1 | 2 failing — `C-red-export-cache.log` |
| Export cache (green) | same + `payments-export-cap`, `payments-export-audit`, `csv-export-fidelity` | 0 | 33/33 |
| Mail templates | `npx vitest run tests/unit/sec-c-email-template-escaping.test.ts` | 0 | 22 templates |
| Prototype keys | `npx vitest run tests/unit/sec-c-prototype-keys.test.ts` | 0 | SF-C2 pinned (5 cases assert the current wrong intent) |
| Static guards / XSS sinks / origin-host | `npx vitest run tests/unit/sec-c-static-guards.test.ts tests/unit/sec-c-xss-sinks.test.tsx tests/unit/sec-c-origin-host.test.ts` | 0 | 13 + 12 + 16 |
| Types | `npx tsc --noEmit -p tsconfig.json` | 2 | 0 errors in lane C files; 2 errors in lane E's committed `tests/unit/sec-e-asset-inventory.test.ts:21` and `sec-e-secret-scan.test.ts:42` |
| Lint | `npx eslint lib/blob-url.ts app/api/payments/export.csv/route.ts tests/unit/sec-c-*.ts tests/unit/sec-c-*.tsx docs/security/evidence/C/scripts/*.mjs` | 0 | |
| Server (no build) | `node <scratchpad>/security/C/prod-server-c.mjs start 3963 nobypass,isolated` (copy of `att/prod-server.mjs` adding `-H 127.0.0.1`; refuses a non-test DB) | — | existing build `xP9P9cHvx9xkgqHPXnOa9`; stopped by port afterwards |
| HTTP probe | `node docs/security/evidence/C/scripts/http-probe.mjs http://127.0.0.1:3963` | 0 | ~40 unauthenticated requests → `C-http-probe-c837e38-build.json` |
| Browser probe | `node docs/security/evidence/C/scripts/browser-probe.mjs http://127.0.0.1:3963` | 0 | headless Chromium, hostile origin on 127.0.0.1:4613 → `C-browser-probe-c837e38-build.json` |

## Mutation proofs (disposable worktree at `5680c5d`, node_modules junction; removed afterwards)
| Mutation | Expected | Observed |
|---|---|---|
| login-email: `mark_provisional` variant `z.looseObject` + body spread into the write | owner login-email test red | 3 failing |
| login-email: all three variants `z.strictObject` (the recommended change) | lane C + existing route tests green | 44/44 passed |
| products/[id]: `patchSchema` → `z.looseObject` | canary sweep red | 2 failing (route sweep + positive control) |
| products/[id] PATCH: `assertSameOrigin` removed | CSRF sweep red | 1 failing |
| attachments DELETE: `assertSameOrigin` added (SF-C3 fix) | pinned gap flips red ("fixed? remove it") | 1 failing, as designed |
| importer: `Object.hasOwn` lookups (SF-C2 fix) with `SF_C2_FIXED = true` | prototype tests + existing attendance tests green | 288/288 |
