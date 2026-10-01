# Security gate — Layer C (independent isolation / identity / money review)

Part of the v5 Security gate; the depth layer SAST and DAST cannot reach. An **independent reviewer agent** (did not write the code) attacked the running **production build** at `https://localhost:3950` under the restricted role `matflow_app` (RLS on, Neon test branch), candidate `e06b7b0`, 1 Oct 2026. Per-check table: `scratchpad/ralph/review-security-result.md`; harness + raw outputs: `.omc/ralph-harness/review-security/`. This discharges the review the classifier twice refused (the plain "read the brief" dispatch passed).

## Verdict: no P0, no P1. All 11 areas CONFIRMED.
No cross-tenant data leak, no wrong-money, no broken access control on any probe that ran. Every mutation landed only on throwaway clubs A/B/C; `totalbjj` untouched; the one destructive probe (suspend club A) was reverted to active.

| # | Area | Verdict | Evidence (summary) |
|---|---|---|---|
| 1 | Wrong club (tenant isolation) | CONFIRMED | Every B-owner/B-member read & write against A's ids → 404/403, no leak; A's Member/Payment/Waiver/Photo/Attendance counts identical before vs after the whole battery; cross-tenant DELETE (incl. `?confirm`/cascade) → 404, nothing deleted. |
| 2 | Wrong person in same club | CONFIRMED | Family-2 parent vs Family-1 children all 404; member-vs-member 403; a child's synthesised `@no-login.*` email cannot sign in. (subscribe-for-kid cross-guardian authz BLOCKED on Stripe.) |
| 3 | A person in two clubs | CONFIRMED | Dual-hat email (owner in B, member in A): each session sees only its own club; the A-member write is recorded under tenant A; the member cookie carries no staff power in B. |
| 4 | Roles | CONFIRMED | coach/manager/admin refused server-side on staff-remove, ownership-transfer, kiosk/display tokens, settings PATCH, Stripe connect/disconnect. |
| 5 | Money and retries | CONFIRMED | payments/manual, member add, waiver sign-for-child idempotent (exactly one row incl. concurrent double-submit); 2nd check-in → 409; TeamUp card charge → 409 `billed_elsewhere`. (staff card-subscription-on-TeamUp-member BLOCKED on Stripe; the charge-route guard is confirmed.) |
| 6 | Files and caches | CONFIRMED | reports never show another club's figures after changing A's data; signature/photo URLs cross-session refused. |
| 7 | Pooled connections | CONFIRMED | 50 interleaved A/B requests → 0 cross-tenant leaks. |
| 8 | Tokens | CONFIRMED | invite reuse 404, replaced 410, expired 410; kiosk + leaderboard rotation makes the old URL 404 and the new 200. (magic-link double-verify BLOCKED — raw token never leaves the server; single-use consume evidenced via the invite path.) |
| 9 | Suspended / revoked | CONFIRMED | sessionVersion bump evicts a staff cookie (200→401); a guardian reparent revokes the old guardian on the next request (both open tabs 404) and grants the new; suspended club refuses login/cookie/kiosk/leaderboard honestly, data counts unchanged, revert restores active. |
| 10 | Operator plane | CONFIRMED | wrong/absent `x-admin-secret` → 403 (no club created); a tenant session is rejected on every operator route; operator-login wrong → 401; create-tenant audited. |
| 11 | Web-attack battery | CONFIRMED | stored XSS rendered inert; CSV formula injection neutralised (`'=` prefix); CSRF foreign-origin → 403 on all state-changing routes; upload wrong-type/SVG → 400, oversize → 413, `../` filename stored safely; webhook missing/bad/tampered signature → 400 (never 500). (webhook replay + out-of-order resurrection BLOCKED — need a connected Stripe account; signature verification itself confirmed.) |

## Findings and disposition (all low; none require a code change)
| Sev | Finding | Disposition |
|---|---|---|
| P2 | `GET /api/payments/export.csv` is reachable by the **manager** role (owner+manager), returning member name/email/amount. | **INTENDED — policy confirm for Noe.** `requireApiOwnerOrManager`, the same access as Reports, which already shows this payment data to managers. Coach and admin are correctly refused. Recommendation: keep — restricting only the CSV while managers see the same data in-app and in reports would be inconsistent. No code change pending Noe's call. |
| P3 | `GET /api/members/{id}/payments` and `GET /api/classes/{id}/roster` answer a cross-tenant id with `200 {empty}` rather than 404. | **ACCEPTED — no disclosure.** Both queries are tenant-scoped, so a cross-tenant id, a non-existent id, and a real-but-empty resource all return the same empty 200: existence is never confirmed. The "never confirm existence" rule is met in substance. |
| P3 | `DELETE /api/members/{id}` with no query param returns 400 (param validation) before the tenant 404. | **ACCEPTED — harmless.** No delete occurs; the ordering only changes which 4xx an attacker sees, and neither confirms existence. |

## BLOCKED (environment, not defects — recorded honestly)
- **subscribe-for-kid cross-guardian authz** and **staff card-subscription on a TeamUp member** — require a connected Stripe account (not connected locally). The equivalent `members/[id]/charge` `billed_elsewhere` guard IS confirmed (409).
- **magic-link login-link double-verify** — the raw token never leaves the server (mail not delivered locally, tokens stored hashed); single-use consume is evidenced via the invite path.
- **Stripe webhook replay + out-of-order resurrection** — need a connected account + live subscription; signature verification itself is confirmed (bad/tampered/missing → 400).
- **login rate-limit / account-lockout ceiling** — masked by `TESTING_MODE` (the same flag that skips 2FA). The throttle code exists in `auth.ts` (5/15 min + lockout at 10) and was verified separately with bypasses off (auth 8/8). forgot-password (3/15 min) and tenant-lookup (30/min) WERE observed firing 429.

## Independence
The reviewer did not write the code and did not edit, commit or push it. The two product changes in the Security gate (AES-GCM authTagLength, X-Powered-By) are the lead's, made before this review and confirmed by their own tool re-scans; this review raised no change to them.
