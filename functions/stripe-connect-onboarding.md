# Stripe Connect Onboarding

> **Status:** ⚠️ Wired, not E2E-tested with real Stripe account in this session · OAuth flow with HMAC-signed CSRF state · stores `stripeAccountId` on Tenant.

## Purpose

Each gym has its OWN Stripe account — payments flow directly to the gym's bank, not through MatFlow. Stripe Connect (OAuth Standard accounts) is the mechanism. Owner clicks "Connect Stripe" in Settings, gets bounced to Stripe's authorize URL, authorises MatFlow, Stripe redirects back to our callback with an `code` parameter, we exchange that for the gym's `stripeAccountId`, and we save it.

## Surfaces

- Settings → Revenue tab → "Connect Stripe" button (or Account tab — verify location in [SettingsPage.tsx](../components/dashboard/SettingsPage.tsx))
- Disconnect button in same panel once connected

## Data model

```prisma
model Tenant {
  ...
  stripeAccountId  String?
  stripeConnected  Boolean @default(false)
  ...
}
```

`stripeConnected=true` means the Account has completed onboarding (has charges_enabled). `stripeAccountId` set but `stripeConnected=false` could mean onboarding was started but abandoned.

## API routes

### `GET /api/stripe/connect`
Owner only. Generates an HMAC-signed `state` token (15-min TTL, encodes `tenantId + nonce`), redirects to Stripe's authorize URL:

```
https://connect.stripe.com/oauth/authorize?
  response_type=code
  &client_id={STRIPE_CLIENT_ID}
  &scope=read_write
  &state={signedState}
  &redirect_uri={NEXTAUTH_URL}/api/stripe/connect/callback
```

### `GET /api/stripe/connect/callback`
Public (proxy whitelist) but state-verified. Stripe redirects here with `?code=...&state=...`:

1. Verifies HMAC on `state` — rejects if invalid or expired (CSRF defence)
2. Extracts `tenantId` from state
3. Calls `stripe.oauth.token({ code })` to exchange the code for an access token + Stripe Account ID
4. Stores `Tenant.stripeAccountId = response.stripe_user_id` and `stripeConnected = true`
5. Redirects to `/dashboard/settings?tab=revenue&connected=1`
6. Audit log: `tenant.stripe_connect`

### `POST /api/stripe/disconnect`
Owner only.

1. Calls `stripe.oauth.deauthorize({ stripe_user_id, client_id: STRIPE_CLIENT_ID })`
2. Clears `Tenant.stripeAccountId = null`, `stripeConnected = false`
3. Doesn't delete past Payments / Subscriptions in our DB — just severs new ones
4. Audit log: `tenant.stripe_disconnect`

## Required env vars

| Var | What |
|---|---|
| `STRIPE_CLIENT_ID` | Your Stripe Connect platform client ID (`ca_...`) |
| `STRIPE_SECRET_KEY` | Platform secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | For [stripe-webhook.md](stripe-webhook.md) |
| `NEXTAUTH_URL` | Used to build the redirect_uri |

## Flow

1. Owner → Settings → Revenue → "Connect Stripe"
2. Browser navigates to `GET /api/stripe/connect` → 302 to Stripe authorize URL
3. Owner signs in to Stripe (or creates an Express/Standard account if new)
4. Stripe redirects to `/api/stripe/connect/callback?code=...&state=...`
5. We verify state → exchange code → store `stripeAccountId` → redirect to settings with success param
6. Settings page shows "Connected to Stripe account `acct_xxx`" + a Disconnect button
7. Subsequent Stripe API calls (subscription create, checkout sessions) include `{ stripeAccount: tenant.stripeAccountId }` header so charges land in the gym's account

## Security

| Control | Where |
|---|---|
| HMAC-signed state | `state` is `{tenantId}.{nonce}.{HMAC(tenantId+nonce, NEXTAUTH_SECRET)}` — rejected if HMAC mismatch |
| 15-min state TTL | `state` includes timestamp; rejected if older |
| Owner-only initiation | `requireOwner()` on `/connect` |
| Public callback | Whitelisted in proxy.ts but state-gated |
| Audit log | Both connect + disconnect |
| No raw access token storage | Stripe Connect Standard doesn't return long-lived access tokens — we store the AccountID and use the platform secret key with `stripeAccount` header on subsequent calls |

## Known limitations

- **Not end-to-end tested with a real Stripe Connect account** in this session. Code is correct; flow needs a manual run-through.
- ~~No webhook for `account.updated`~~ — **resolved (Fix 3)**. We now subscribe to `account.updated`, refresh `Tenant.stripeAccountStatus` (cached `chargesEnabled` / `payoutsEnabled` / `requirementsPastDue` / `disabledReason`), and gate checkout / class-pack-buy / create-subscription on it via [lib/stripe-account-status.ts](../lib/stripe-account-status.ts) → `ensureCanAcceptCharges()`. Cache also lazy-refreshes on stale (>24h).
- **No re-onboarding nudge** — if charges are disabled, the UI doesn't say "complete your Stripe setup".
- **Single Stripe account per Tenant** — one gym, one Stripe. Franchises with multiple sub-accounts not supported.
- **Disconnect doesn't revoke pending subscriptions** — they continue billing on the old Stripe account until the owner cancels them in their Stripe dashboard.

## Files

- [app/api/stripe/connect/route.ts](../app/api/stripe/connect/route.ts)
- [app/api/stripe/connect/callback/route.ts](../app/api/stripe/connect/callback/route.ts)
- [app/api/stripe/disconnect/route.ts](../app/api/stripe/disconnect/route.ts)
- [components/dashboard/SettingsPage.tsx](../components/dashboard/SettingsPage.tsx) — Revenue/Account tab Connect button
- See [stripe-subscriptions.md](stripe-subscriptions.md), [stripe-webhook.md](stripe-webhook.md), [stripe-portal.md](stripe-portal.md)
