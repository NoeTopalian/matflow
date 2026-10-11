# Lane PA report - defect 1: wrong-account checkout path

Branch payments/stripe-defects-2026-10, base a0ff39c. Started 11 Oct 2026.

## Log
- Step 0: read RULES.md and BRIEF-PA.md; report folder created.
- Step 1: `node --version` -> v24.21.0 (PATH prefixed with scratchpad/security/node24/node-v24.21.0-win-x64).
- Step 2 baseline: 21 existing unit test files that import the lane routes or mock lib/stripe-account-status (list in PA/affected-tests.txt): `npx vitest run <21 files>` exit 0, 21 files / 260 tests passed (log PA/baseline.log).

## Defect reproduced (RED, before any fix)

- `tests/unit/pay-pa-route-guard-matrix.test.ts` — "F2 regression: deauthorised club, cache expired, permission error on refresh > never creates a Checkout Session on the platform account". Command: `npx vitest run tests/unit/pay-pa-route-guard-matrix.test.ts -t "F2 regression"` -> **exit 1**. Excerpt:
  `[stripe-account-status] CONFIG: STRIPE_SECRET_KEY lacks the accounts read scope ... Treating as chargeable to avoid blocking all gyms' revenue.`
  `AssertionError: checkout session created without stripeAccount = platform account: expected undefined to be 'acct_club_pa_1'`
  i.e. the old route created the Checkout Session with NO `stripeAccount` option = on MatFlow's platform account. Defect confirmed in code, not only by reading.
- Full matrix on the old code (16 route handlers x 8-10 cases): `npx vitest run tests/unit/pay-pa-route-guard-matrix.test.ts` -> **exit 1**, 132 failed / 34 passed of 166 (log PA/red-matrix.log). Examples: shop checkout, ad-hoc charge and refund with `stripeConnected=false` answered **200** (expected 409); 12 routes answered **200** on a stale status + permission error (fail-open); every refusal lacked a structured `reason`.

Cause: (1) `lib/stripe-account-status.ts:68-84` mapped a `StripePermissionError` on `accounts.retrieve` to `chargesEnabled: true` (fail-open); (2) `app/api/member/checkout/route.ts:220,294` passed `{ stripeAccount }` only when `stripeConnected` was true, so a disconnected-but-id-kept club fell through to `undefined` options; (3) each of the other routes checked its own subset of `stripeAccountId` / `stripeConnected` / status (charge and refund: id only; hold/resume/cancel/portal: id + flag, no status; plans/class-packs: id + flag).
