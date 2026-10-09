# C2-02 Nonce CSP — build, headers and browser pass (lane C2, 9 Oct 2026)

## Implementation
- `lib/csp.ts`: policy builder, `cspMode()` (report-only unless `MATFLOW_CSP_ENFORCE` is `1`/`true`), 128-bit nonce, `isTokenDocumentPath`.
- `proxy.ts` (on top of lane A2's 75da8b5; the SF-44 503 path is untouched): every pass-through of a non-API request goes through `passThrough()`, which drops any client-sent CSP/x-nonce request header, mints a nonce, forwards the policy on the request (Next stamps the nonce while rendering) and sets it on the response with `Reporting-Endpoints`. The default export now routes `/kiosk/*` and `/leaderboard/*` (newly inside the matcher) to `passThrough` without the next-auth wrapper; everything else goes through the wrapper as before. `api/csp-report` is excluded from the matcher.
- `app/layout.tsx`: `await connection()` — every page renders per request (build output: the only static `○` entries are icon.png, manifest, robots, sitemap).
- `app/api/csp-report/route.ts` + `lib/csp-report.ts`: anonymous sink, ≤16 KB (Content-Length and streamed cap), ≤50 reports per request, ≤64 keys per instance, logs `directive|class|disposition` counts only — never a URL (page addresses here are often tokens).
- `instrumentation-client.ts`: `z.config({ jitless: true })` — see run 1.
- The static `next.config.ts` policy is unchanged. Observed on the production build: in report-only mode a page carries BOTH the static enforcing policy (with `'unsafe-inline'`) and the nonce report-only policy; in enforce mode the proxy's `Content-Security-Policy` REPLACES the static one on documents (one header, no `'unsafe-inline'`); API responses keep the static policy.

Policy (production, report-only): `default-src 'self'; script-src 'self' 'nonce-<128-bit>' 'strict-dynamic' https://va.vercel-scripts.com https://js.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' <7 hosts as next.config.ts>; frame-src 'self' https://js.stripe.com https://hooks.stripe.com; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; report-uri /api/csp-report; report-to csp-endpoint` (+ `upgrade-insecure-requests` when enforcing).

## Environment
Two production builds (`node <scratchpad>/att/prod-server.mjs build`, Node v24.21.0, exit 0; BUILD_IDs `xXtYJIiCdVWGqFykW-LFB` then `-tRCZZQmRvjvDCn8RmTzj` after the zod fix), served by `node <scratchpad>/security/C/prod-server-c.mjs start 3964 isolated` (`next start -H 127.0.0.1`, TEST branch, providers blanked), stopped by port after each run. Headless Chromium (Playwright from node_modules). Signed in through the real login form with lane C2's own synthetic owner and member (`secC2-*` tenant created on the TEST branch, torn down afterwards: Member 1, User 1, Tenant 1, LoginEvent 2 deleted; leftover scan of every tenantId/userId/memberId/bucket/email column = 0). No other lane's rows touched.

## Pages (24 per run)
Anonymous: `/`, `/login`, `/login?club=<slug>`, `/<slug>` (→ /login), `/apply`, `/legal/privacy`, `/legal/terms`, `/admin/login`, `/waiver/<bogus>` (404 page), `/kiosk/<bogus>` (404 page), `/leaderboard/<bogus>` (404 page), `/set-password` (→ /login). Staff (owner): `/dashboard`, `/dashboard/members`, `/dashboard/timetable`, `/dashboard/settings`, `/dashboard/reports`, `/dashboard/payments`, `/dashboard/scan` (→ /dashboard/checkin) + one client-side navigation. Member: `/member/home`, `/member/schedule`, `/member/shop` (the checkout page — checkout itself is a redirect to Stripe-hosted Checkout, outside our CSP), `/member/profile`, `/member/progress`. Not covered: a kiosk/leaderboard page with a VALID token (404 pages render the same framework scripts), the waiver signing page with a valid token, the Stripe redirect itself.

## Results
| Run | Mode | Pages with policy | Server-rendered scripts without nonce | `securitypolicyviolation` events | Console CSP messages | Evidence |
|---|---|---|---|---|---|---|
| 1 | report-only | 24/24 | 0 | **10** on 5 pages (`/login`, `/login?club`, `/<slug>`, `/apply`, `/set-password`): `script-src` / `eval`, each twice — once `enforce` (the STATIC policy, so this fires in production today) and once `report` | 5 | 02-browser-report-only-run1.json |
| — | cause | — | — | `_next/static/chunks/…js` col 6072: zod v4's `allowsEval` probe `try { Function("") }` (caught; zod falls back to its interpreter) | — | evalsrc probe |
| 2 | report-only, after `z.config({ jitless: true })` | 24/24 | 0 | **0** | 0 | 02-browser-report-only-run2.json |
| 3 | **enforce** (`MATFLOW_CSP_ENFORCE=1`) | 24/24 | 0 | **0**; owner and member sign-in, client navigation all work | 0 | 02-browser-enforce-run.json |

"scriptsWithoutNonce" in the JSON (1–5 on dashboard/kiosk/leaderboard pages) counts scripts the framework inserts at runtime after load; none are server-rendered (curl of the HTML: every `<script>` carries the header's nonce — `/login` 17/17, `/` 13/13, `/kiosk/x` 9/9, `/leaderboard/x` 9/9, `/legal/privacy` 15/15, `/admin/login` 15/15) and they are trusted by `'strict-dynamic'` (0 violations).

Detector controls (same JSON, `controls`):
- Server-side injection model — the real `/login` response with headers kept and `<script>window.__secC2p=true</script>` + `<img onerror>` spliced into the HTML: report-only → both ran, violations `script-src-elem|inline|report` and `script-src-attr|inline|report`; **enforce → neither ran**, violations `…|enforce`. This is the XSS class the policy closes (SF-30).
- Inline handler injected into the DOM: report-only ran + 1 violation; enforce did not run + 1 violation.
- `createElement('script')` with inline text, appended by page script: runs with NO violation in both modes. `'strict-dynamic'` trusts non-parser-inserted scripts by design, so DOM-XSS sinks that create script elements are NOT covered by this policy (residual; Trusted Types would be the next step).

Report endpoint on the production build: `curl` legacy format → 204, Reporting-API format → 204, 20 KB body → 413, GET → 405; server log shows `[csp-report] {"script-src-elem|inline|report":1}` and `{"script-src-elem|external|report":1}`; the synthetic token in the posted page address appears 0 times in the log. Chromium `report-uri` path (report-to stripped by interception): POST `application/csp-report` → 204, logged. Chromium `report-to` path: CDP shows the report Queued → Pending → Queued for `csp-endpoint` (delivery attempted, not received) on plain-http 127.0.0.1 within 100 s — **UNKNOWN on https/Vercel**; verify on a preview deployment before relying on Chrome reports (Chrome ignores report-uri when report-to is present).
