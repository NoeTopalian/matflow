# C2-00 Commands, environment, exit codes (lane C2, 9 Oct 2026)

Runtime for every gate: Node v24.21.0 (`<scratchpad>/security/node24/node-v24.21.0-win-x64` first on PATH). Tree: HEAD af803d5 + lane C2 changes (lane D2's uncommitted edits to members/[id], member/children/[id], staff/[id], lib/attendance-import.ts present and untouched). No production access, nothing pushed, nothing staged.

| Step | Command (repo root unless stated) | Exit | Result |
|---|---|---|---|
| Baseline sec-c | `SEC_C_SWEEP_OUT=<scratch>/baseline-canary.json npx vitest run tests/unit/sec-c-` | 0 | 10 files, 793/793; canary 262 cells, 5xx/throw 5 (pending-tenant 503 ×2 by design, classes/[id]/instances + instances/generate throw, profile-picture DELETE 500 — all pre-pinned) |
| Body inventory | `node docs/security/evidence/C/scripts/body-inventory.cjs <repo> --md <out>` (before / after) | 0 / 0 | no-schema body routes 15 → 5 |
| Query inventory | `node docs/security/evidence/C2/scripts/query-inventory.mjs . --md <out>` (before / after) | 0 / 0 | query routes without zod 27 → 25 |
| CSP red | HEAD proxy.ts + app/layout.tsx swapped in, `npx vitest run tests/unit/sec-c2-csp.test.ts`, files restored | 1 | 14 failed / 21 (02-csp-red-green.log) |
| CSP green | `npx vitest run tests/unit/sec-c2-csp.test.ts tests/unit/sec-c2-csp-report.test.ts tests/unit/proxy-matcher.test.ts` | 0 | 67/67 |
| Validation red | HEAD versions of the 6 JSON routes swapped in, `npx vitest run tests/unit/sec-c2-request-validation.test.ts`, restored | 1 | 28 failed / 58 (03-validation-red-green.log) |
| Validation green | same + member-hold | 0 | 76/76 |
| Upload red | HEAD versions of the 5 route files swapped in, `npx vitest run tests/unit/sec-c2-upload-controls.test.ts tests/unit/sec-c2-blob-image-inline.test.ts`, restored | 1 | 20 failed (04-upload-red-green.log) |
| Upload green | same | 0 | 46/46 |
| Build ×2 | `node <scratchpad>/att/prod-server.mjs build` | 0, 0 | all pages dynamic; BUILD_ID -tRCZZQmRvjvDCn8RmTzj is what .next now holds |
| Server | `node <scratchpad>/security/C/prod-server-c.mjs start 3964 isolated` (report-only), then with `MATFLOW_CSP_ENFORCE=1` | — | 127.0.0.1 only; stopped by port after each run |
| Browser | `node docs/security/evidence/C2/scripts/csp-browser-probe.mjs http://127.0.0.1:3964 <private-c2.json> <out.json> <label>` ×3 | 0 | 02-browser-*.json; see 02-csp-browser.md |
| Fixtures | `node <scratchpad>/security/C2/fixtures.mjs setup` / `teardown` (TEST branch guard) | 0 / 0 | teardown Member 1, User 1, Tenant 1, LoginEvent 2; leftover scan {} |
| After sec-c | `SEC_C_SWEEP_OUT=<scratch>/after-canary.json npx vitest run tests/unit/sec-c-` | 0 | 795/795 (+2 = csrf sweep cells for /api/csp-report, exempt); canary 262 cells, same 5 5xx/throw cells; one change: POST /api/members/[id]/hold owner 200 + 1 write → 400 + 0 (strict schema) (05-canary-sweep-before/after.json) |
| Types | `npx tsc --noEmit -p .` | 0 | 0 errors (whole project) |
| Lint | `npm run lint` | 0 | eslint clean, UI-RULES ratchet at/below baseline; `npx eslint --no-ignore docs/security/evidence/C2/scripts/*.mjs` 0 |
| Units | sec-c2-*, sec-c-*, proxy-*, sec-a2-proxy-outage-cookie, operator-allowlist, support-session*, upload/blob/import/totp/hold suites (61 files) | 0 | 1977/1977 |
